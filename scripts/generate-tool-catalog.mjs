/**
 * Generates src/ui/tool-catalog.ts from the *real* MCP tool registrations.
 *
 * The inspector UI needs a per-tool catalog (title, description, inputs,
 * group) without inventing anything: this script parses the Worker sources
 * with the TypeScript compiler API and extracts the literal metadata passed
 * to `mcp.registerTool(name, { title, description, inputSchema }, handler)`
 * in index.ts and src/mcp/*.ts. Tool *names* are validated against
 * DEMO_TOOL_NAMES at test time (tests/tool-catalog.test.ts), so the catalog
 * can never silently drift from the live tool list.
 *
 * Usage: node scripts/generate-tool-catalog.mjs
 * Never prints or embeds secret values — it only reads static registration
 * literals. Descriptions that are not statically resolvable become null and
 * the UI then shows only the title.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Mirrors groupTools() in src/commands/mcp-command.ts (the /mcp command grouping). */
function groupFor(name) {
  if (name === "demo_ping" || name.startsWith("http_") || name.startsWith("json_") || name.startsWith("hash_") || name.startsWith("generate_")) return "Core";
  if (name.startsWith("browser_") || name === "screenshot_diff") return "Browser";
  if (name === "inspect_video" || name.startsWith("video_")) return "Video";
  if (name.startsWith("youtube_")) return "YouTube";
  if (name.startsWith("roblox_")) return "Roblox";
  if (name.startsWith("jev_")) return "JEV";
  if (name.startsWith("laya_")) return "Laya";
  if (name.startsWith("skills_") || name.startsWith("skill_")) return "Skills";
  if (name === "git_repository") return "Git";
  if (name.startsWith("archive_") || name === "wayback") return "Internet Archive";
  if (name === "feed_read") return "Feeds";
  if (name === "pdf_document" || name === "image_analyze") return "Documents";
  if (name === "web_extract" || name === "web_diff" || name === "web_monitor") return "Web Intelligence";
  if (name === "web_research") return "Research";
  if (name === "openapi_inspect" || name === "net_diagnose" || name === "url_inspect") return "Network";
  return "Utilities";
}

/**
 * Availability key per group/tool: which field of /health+/platform/stats
 * gates this capability. "always" means the tool works without optional
 * providers. "oauth" means the tool is protected by DEMO per-tool OAuth.
 */
function availabilityFor(name) {
  if (name.startsWith("roblox_account_")) return "oauth";
  if (name === "jev_decide") return "oauth";
  if (name.startsWith("browser_")) return "browser";
  if (name === "screenshot_diff") return "browser";
  if (name.startsWith("youtube_")) return "youtube";
  if (name.startsWith("jev_")) return "jev";
  if (name.startsWith("laya_")) return "laya";
  if (name === "video_transcribe") return "transcription";
  if (name === "video_analyze" || name === "video_react" || name === "inspect_video") return "vision";
  if (name === "video_extract_frames" || name === "browser_video_frames") return "frames";
  if (name === "video_fetch" || name === "video_extract_audio" || name === "video_ingest" || name === "video_get_frame") return "artifacts";
  if (name === "web_monitor") return "snapshots";
  if (name === "web_research") return "always";
  return "always";
}

const files = ["index.ts"]
  .filter((f) => ts.sys.fileExists(path.join(ROOT, f)))
  .concat(
    ts.sys.readDirectory(path.join(ROOT, "src/mcp"), ".ts", undefined, ["*.ts"]).map((f) => path.relative(ROOT, f)),
  )
  .sort();

/** Statically initialise a string-ish expression: literal, concatenation, template without substitutions. */
function evalString(node, checker) {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      out += "…"; // dynamic interpolation: keep structure, never evaluate
      out += span.literal.text;
    }
    return out.includes("…") ? out : out;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evalString(node.left);
    const right = evalString(node.right);
    if (typeof left === "string" && typeof right === "string") return left + right;
    return null;
  }
  if (ts.isIdentifier(node) && checker) {
    // Resolve `const x = "…"` in the same file when possible.
    const decl = resolveConst(node);
    if (decl && decl.initializer) return evalString(decl.initializer);
  }
  return null;
}

let CURRENT_SOURCE = null;
function resolveConst(identifier) {
  if (!CURRENT_SOURCE) return null;
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === identifier.text && node.initializer) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(CURRENT_SOURCE);
  return found;
}

function objectKeysOf(node) {
  if (!node) return [];
  if (ts.isObjectLiteralExpression(node)) {
    const keys = [];
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop) && prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
        keys.push(prop.name.text);
      } else if (ts.isSpreadAssignment(prop)) {
        // e.g. ...sessionFields — resolve a same-file const object literal.
        if (ts.isIdentifier(prop.expression)) {
          const decl = resolveConst(prop.expression);
          if (decl?.initializer && ts.isObjectLiteralExpression(decl.initializer)) keys.push(...objectKeysOf(decl.initializer));
        }
      }
    }
    return keys;
  }
  if (ts.isCallExpression(node)) {
    const arg = node.arguments[0];
    if (arg) return objectKeysOf(arg);
  }
  if (ts.isIdentifier(node)) {
    const decl = resolveConst(node);
    if (decl?.initializer) return objectKeysOf(decl.initializer);
  }
  return [];
}

const catalog = new Map();
const seen = [];

for (const rel of files) {
  const full = path.join(ROOT, rel);
  const text = readFileSync(full, "utf8");
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.ESNext, true);
  CURRENT_SOURCE = source;
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "registerTool") {
      const nameArg = node.arguments[0];
      if (nameArg && ts.isStringLiteral(nameArg)) {
        const config = node.arguments[1];
        let title = null;
        let description = null;
        let inputs = [];
        if (config && ts.isObjectLiteralExpression(config)) {
          for (const prop of config.properties) {
            if (!ts.isPropertyAssignment(prop) || !prop.name) continue;
            const key = prop.name.getText().replace(/["']/g, "");
            if (key === "title") title = evalString(prop.initializer);
            else if (key === "description") description = evalString(prop.initializer);
            else if (key === "inputSchema") inputs = objectKeysOf(prop.initializer);
          }
        }
        const name = nameArg.text;
        if (description) {
          description = description.replace(/\s+/g, " ").trim();
        }
        const entry = {
          name,
          title: title || name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
          description,
          group: groupFor(name),
          availability: availabilityFor(name),
          inputs: [...new Set(inputs)].filter((k) => k !== "undefined"),
        };
        if (catalog.has(name)) {
          const prev = catalog.get(name);
          // Keep the richest record if a tool is registered in a shared helper.
          if (!prev.description && entry.description) catalog.set(name, entry);
        } else {
          catalog.set(name, entry);
        }
        seen.push(rel);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

const entries = [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name));
const groups = [...new Set(entries.map((e) => e.group))];

const body = entries
  .map(
    (e) =>
      `  { name: ${JSON.stringify(e.name)}, title: ${JSON.stringify(e.title)}, group: ${JSON.stringify(e.group)}, availability: ${JSON.stringify(e.availability)}` +
      (e.description ? `, description: ${JSON.stringify(e.description)}` : "") +
      (e.inputs.length ? `, inputs: [${e.inputs.map((i) => JSON.stringify(i)).join(", ")}]` : "") +
      " },",
  )
  .join("\n");

const out = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Tool catalog for the DEMO inspector UI, extracted from the real MCP tool
 * registrations (index.ts + src/mcp/*.ts) by scripts/generate-tool-catalog.mjs.
 * tests/tool-catalog.test.ts pins this list against DEMO_TOOL_NAMES so it can
 * never drift from the live tool surface. Contains no secrets and no values —
 * only static registration metadata.
 */

export interface DemoToolCatalogEntry {
  name: string;
  title: string;
  group: string;
  /** Which live capability gates this tool: browser | youtube | jev | laya |
   * transcription | vision | frames | artifacts | snapshots | oauth | always.
   * "oauth" = protected tool requiring a user-bound DEMO OAuth grant. */
  availability: string;
  description?: string;
  inputs?: string[];
}

export const TOOL_CATALOG_VERSION = ${JSON.stringify(process.env.CATALOG_VERSION || "1.0.0")};

export const TOOL_CATALOG: DemoToolCatalogEntry[] = [
${body}
];

export const TOOL_GROUPS: string[] = ${JSON.stringify(groups)};

export const TOOL_CATALOG_COUNT = TOOL_CATALOG.length;
`;

writeFileSync(path.join(ROOT, "src/ui/tool-catalog.ts"), out);
console.log(`wrote src/ui/tool-catalog.ts — ${entries.length} tools, groups: ${groups.join(", ")}`);
if (entries.length < 80) console.warn("WARNING: unusually few tools extracted — check registerTool parsing.");
