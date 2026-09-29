/**
 * /mcp command — Demo's main status/capability command.
 *
 * Shows:
 *  - Status (online / limited / offline)
 *  - Version
 *  - Capabilities (only those that actually exist)
 *  - Tools (all registered MCP tools, grouped logically)
 *  - Commands (available commands)
 *  - Health (real subsystem health)
 *
 * The tool listing is generated dynamically from the actual MCP tool registry,
 * so when a new tool is added, /mcp automatically reflects it.
 */

import type { ToolResult } from "../mcp/results.js";
import type { CommandHandler } from "./router.js";
import { resolveYouTubeConfig } from "../youtube/config.js";
import { resolveJevConfig } from "../jev/config.js";
import { resolveLayaConfig } from "../laya/config.js";
import { resolveDecisionRoutingMode } from "../decisions/provider.js";

interface McpCommandDeps {
  version: string;
  toolNames: readonly string[];
  commands: CommandHandler[];
}

/**
 * Determine the overall Demo status based on subsystem health.
 */
function determineStatus(env: Record<string, unknown>): "online" | "limited" | "offline" {
  const jevConfig = resolveJevConfig(env);
  const ytConfig = resolveYouTubeConfig(env);
  const hasBrowser = Boolean(env.BROWSER);
  const hasScreenshots = Boolean(env.SCREENSHOTS);

  // Core requirements: MCP itself always works (it's the endpoint)
  // "online" = all major subsystems are configured
  // "limited" = some subsystems unavailable but core works
  if (hasBrowser && hasScreenshots) return "online";
  if (jevConfig.available || ytConfig.available) return "limited";
  return "limited"; // MCP itself is always at least "limited" online
}

function statusEmoji(status: "online" | "limited" | "offline"): string {
  switch (status) {
    case "online": return "🟢 Online";
    case "limited": return "🟡 Limited";
    case "offline": return "🔴 Offline";
  }
}

/**
 * Group tools logically based on their names.
 */
function groupTools(toolNames: readonly string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {
    Core: [],
    Browser: [],
    Video: [],
    YouTube: [],
    Roblox: [],
    JEV: [],
    Laya: [],
    Skills: [],
    Git: [],
    "Internet Archive": [],
    Feeds: [],
    Documents: [],
    "Web Intelligence": [],
    Research: [],
    Network: [],
    "Build Your Own X": [],
    Collaboration: [],
    Utilities: [],
  };

  for (const name of toolNames) {
    if (name === "demo_ping" || name.startsWith("http_") || name.startsWith("json_") || name.startsWith("hash_") || name.startsWith("generate_")) {
      groups.Core.push(name);
    } else if (name.startsWith("browser_") || name === "screenshot_diff") {
      groups.Browser.push(name);
    } else if (name === "inspect_video" || name.startsWith("video_")) {
      groups.Video.push(name);
    } else if (name.startsWith("youtube_")) {
      groups.YouTube.push(name);
    } else if (name.startsWith("roblox_")) {
      groups.Roblox.push(name);
    } else if (name.startsWith("jev_")) {
      groups.JEV.push(name);
    } else if (name.startsWith("laya_")) {
      groups.Laya.push(name);
    } else if (name.startsWith("skills_") || name.startsWith("skill_")) {
      groups.Skills.push(name);
    } else if (name === "git_repository") {
      groups.Git.push(name);
    } else if (name.startsWith("archive_") || name === "wayback") {
      groups["Internet Archive"].push(name);
    } else if (name === "feed_read") {
      groups.Feeds.push(name);
    } else if (name === "pdf_document" || name === "image_analyze") {
      groups.Documents.push(name);
    } else if (name === "web_extract" || name === "web_diff" || name === "web_monitor") {
      groups["Web Intelligence"].push(name);
    } else if (name === "web_research") {
      groups.Research.push(name);
    } else if (name === "openapi_inspect" || name === "net_diagnose" || name === "url_inspect") {
      groups.Network.push(name);
    } else if (name.startsWith("byox_")) {
      groups["Build Your Own X"].push(name);
    } else if (name.startsWith("collab_")) {
      groups.Collaboration.push(name);
    } else if (name === "schema_validate" || name === "jwt_inspect" || name === "cron_explain" || name === "text_diff") {
      groups.Utilities.push(name);
    } else {
      groups.Utilities.push(name);
    }
  }

  // Remove empty groups
  for (const key of Object.keys(groups)) {
    if (groups[key].length === 0) delete groups[key];
  }

  return groups;
}

/**
 * Determine health of each subsystem.
 */
function subsystemHealth(env: Record<string, unknown>): Record<string, { status: "online" | "limited" | "offline"; detail: string }> {
  const health: Record<string, { status: "online" | "limited" | "offline"; detail: string }> = {};

  // Cloudflare Worker (always online if we're responding)
  health.Cloudflare = { status: "online", detail: "Worker is responding" };

  // MCP (always available — it's the endpoint)
  health.MCP = { status: "online", detail: "MCP endpoint active" };

  // Browser
  health.Browser = {
    status: env.BROWSER ? "online" : "limited",
    detail: env.BROWSER ? "Cloudflare Browser Rendering available" : "No Browser Rendering binding",
  };

  // Video
  const hasR2 = Boolean(env.SCREENSHOTS || env.VIDEO_ARTIFACTS);
  const hasAi = Boolean(env.AI && typeof (env.AI as { run?: unknown }).run === "function");
  health.Video = {
    status: hasR2 ? "online" : "limited",
    detail: hasR2
      ? `R2 storage available${hasAi ? ", Workers AI configured" : ", no Workers AI"}`
      : "No R2 storage binding",
  };

  // YouTube
  const ytConfig = resolveYouTubeConfig(env);
  health.YouTube = {
    status: ytConfig.available ? "online" : "offline",
    detail: ytConfig.available ? "YouTube Data API configured" : (ytConfig.disabledReason ?? "Not configured"),
  };

  // Roblox
  const robloxClientId = String(env.ROBLOX_CLIENT_ID ?? "").trim();
  const robloxSecret = String(env.ROBLOX_CLIENT_SECRET ?? "").trim();
  health.Roblox = {
    status: robloxClientId && robloxSecret ? "online" : "limited",
    detail: robloxClientId && robloxSecret ? "OAuth 2.0 configured" : "Not fully configured",
  };

  // JEV / TypeSafe
  const jevConfig = resolveJevConfig(env);
  health["JEV / TypeSafe"] = {
    status: jevConfig.available ? "online" : "limited",
    detail: jevConfig.available ? `TypeSafe ${jevConfig.model} configured` : (jevConfig.disabledReason ?? "Not configured"),
  };

  // Laya (external typed-decision provider)
  const layaConfig = resolveLayaConfig(env);
  health.Laya = {
    status: layaConfig.available ? "online" : "limited",
    detail: layaConfig.available ? `Laya ${layaConfig.model} at ${layaConfig.endpointHost ?? "configured host"}` : (layaConfig.disabledReason ?? "Not configured"),
  };

  // DEMO 0.9 expanded capabilities (public read-only; presence only).
  health["Public Git"] = { status: "online", detail: "Public repositories over Git smart-HTTP (no API key; private repos refused)" };
  health["Internet Archive"] = { status: "online", detail: "Wayback + archive.org public APIs (no key)" };
  health["Feeds"] = { status: "online", detail: "RSS 2.x / Atom / RDF parsing (no key)" };
  const hasAiVision = Boolean(env.AI && typeof (env.AI as { run?: unknown }).run === "function");
  health["PDF & Images"] = {
    status: hasAiVision ? "online" : "limited",
    detail: hasAiVision ? "Parsing + Workers AI vision (OCR/describe)" : "Parsing + metadata only (no Workers AI binding for OCR/vision)",
  };
  health["Web intelligence"] = {
    status: env.SCREENSHOTS || env.WEB_SNAPSHOTS ? "online" : "limited",
    detail: env.SCREENSHOTS || env.WEB_SNAPSHOTS ? "Extraction, diff, monitoring (R2 snapshots)" : "Extraction and diff (no R2 binding for snapshots/monitoring)",
  };
  health["Network & safety"] = { status: "online", detail: "DNS/HTTP/TLS diagnostics + URL safety over the shared SSRF guard" };
  health["Local utilities"] = { status: "online", detail: "JSON Schema, JWT decoding, cron, text diff (fully local)" };
  health["Web research"] = { status: "online", detail: "Evidence-backed research with preserved provenance" };

  return health;
}

export function createMcpCommand(deps: McpCommandDeps): CommandHandler {
  return {
    name: "mcp",
    description: "Show Demo status, version, capabilities, tools, and commands.",
    execute: async (_args, env) => {
      const status = determineStatus(env);
      const health = subsystemHealth(env);
      const toolGroups = groupTools(deps.toolNames);

      const output: Record<string, unknown> = {
        command: "/mcp",
        name: "DEMO MCP",
        status: statusEmoji(status),
        version: deps.version,
        capabilities: buildCapabilitiesList(env),
        decision_routing: {
          mode: resolveDecisionRoutingMode(env),
          chain: "auto: Laya → Jev (TypeSafe) → DEMO deterministic rules",
          safety: "Typed-decision providers are advisory only; DEMO's permissions, confirmations and security policy stay authoritative.",
        },
        tools: toolGroups,
        tool_count: deps.toolNames.length,
        commands: deps.commands.map((cmd) => ({
          name: `/${cmd.name}`,
          description: cmd.description,
        })),
        health: Object.fromEntries(
          Object.entries(health).map(([name, info]) => [name, `${statusEmoji(info.status)} — ${info.detail}`]),
        ),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    },
  };
}

function buildCapabilitiesList(env: Record<string, unknown>): string[] {
  const caps: string[] = [];
  if (env.BROWSER) caps.push("Browser", "Screenshots", "Live browser view", "Video inspection", "Frame extraction");
  if (env.SCREENSHOTS || env.VIDEO_ARTIFACTS) caps.push("Video artifacts");
  const hasAi = Boolean(env.AI && typeof (env.AI as { run?: unknown }).run === "function");
  if (hasAi || env.TRANSCRIPTION_ENDPOINT) caps.push("Audio extraction", "Transcription", "Vision");
  if (resolveYouTubeConfig(env).available) caps.push("YouTube");
  const robloxClientId = String(env.ROBLOX_CLIENT_ID ?? "").trim();
  const robloxSecret = String(env.ROBLOX_CLIENT_SECRET ?? "").trim();
  if (robloxClientId && robloxSecret) caps.push("Roblox");
  if (resolveJevConfig(env).available) caps.push("JEV");
  if (resolveLayaConfig(env).available) caps.push("Laya");
  caps.push(
    "HTTP fetching", "JSON utilities", "Hashing", "UUID generation",
    "Public Git (no API key)", "Internet Archive / Wayback", "RSS / Atom feeds",
    "PDF intelligence", "Image analysis", "Web extraction", "Web diff", "Website monitoring",
    "OpenAPI inspection", "Network diagnostics", "URL safety", "JSON Schema validation",
    "JWT decoding", "Cron parsing", "Text/document diff", "Screenshot comparison", "Structured web research",
  );
  return caps;
}
