/** Per-tool OpenAI/MCP security metadata and wire-level SDK compatibility. */

import type { McpOAuthScope } from "./oauth-config.js";

export type McpSecurityScheme =
  | { type: "noauth" }
  | { type: "oauth2"; scopes: McpOAuthScope[] };

const PUBLIC: McpSecurityScheme[] = [{ type: "noauth" }];
const READ: McpSecurityScheme[] = [{ type: "oauth2", scopes: ["roblox:read"] }];
const LINK: McpSecurityScheme[] = [{ type: "oauth2", scopes: ["roblox:link"] }];
const DISCONNECT: McpSecurityScheme[] = [{ type: "oauth2", scopes: ["roblox:disconnect"] }];
const DECISION: McpSecurityScheme[] = [{ type: "oauth2", scopes: ["decision:use"] }];
const COLLAB: McpSecurityScheme[] = [{ type: "oauth2", scopes: ["collab:write"] }];
const BYOX_ADMIN: McpSecurityScheme[] = [{ type: "oauth2", scopes: ["collab:admin"] }];

/** Tools that require the shared-workspace grant. */
const COLLAB_TOOLS = new Set([
  "collab_workspace",
  "collab_task",
  "collab_patch",
  "collab_review",
  "collab_tests",
  "collab_delegate",
  "collab_history",
]);

function cloneSchemes(schemes: McpSecurityScheme[]): McpSecurityScheme[] {
  return schemes.map((scheme) => scheme.type === "oauth2"
    ? { ...scheme, scopes: [...scheme.scopes] }
    : { ...scheme });
}

export function securitySchemesForTool(name: string): McpSecurityScheme[] {
  switch (name) {
    case "roblox_account_status":
    case "roblox_account_profile":
    case "roblox_account_inventory":
    case "roblox_account_avatar_thumbnail":
    case "roblox_account_capabilities":
      return cloneSchemes(READ);
    case "roblox_account_link_start":
      return cloneSchemes(LINK);
    case "roblox_account_unlink":
      return cloneSchemes(DISCONNECT);
    case "jev_decide":
      return cloneSchemes(DECISION);
    case "byox_refresh_index":
      return cloneSchemes(BYOX_ADMIN);
    default:
      return COLLAB_TOOLS.has(name) ? cloneSchemes(COLLAB) : cloneSchemes(PUBLIC);
  }
}

/**
 * The installed MCP 2.0 SDK schema does not yet include per-tool
 * `securitySchemes`; unknown registration fields are dropped. Add the supported
 * OpenAI metadata after the SDK has serialized `tools/list`, at the actual HTTP
 * boundary, for both JSON and Streamable HTTP SSE responses.
 */
export async function addToolSecuritySchemes(request: Request<any, any>, response: Response): Promise<Response> {
  if (response.status < 200 || response.status >= 300 || !response.body) return response;
  let rpcRequest: unknown;
  try {
    rpcRequest = await request.clone().json();
  } catch {
    return response;
  }
  if (!isToolsListRequest(rpcRequest)) return response;

  const contentType = (response.headers.get("Content-Type") ?? "").toLowerCase();
  try {
    const original = await response.text();
    if (original.length > 2_000_000) return responseWithBody(response, original);
    const modified = contentType.includes("text/event-stream")
      ? transformSse(original)
      : transformJson(original);
    if (modified === original) return responseWithBody(response, original);
    return responseWithBody(response, modified);
  } catch {
    return response;
  }
}

function isToolsListRequest(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => isToolsListRequest(entry));
  return (value as { method?: unknown }).method === "tools/list";
}

function transformJson(text: string): string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  let changed = false;
  const visit = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(visit);
    if (!entry || typeof entry !== "object") return entry;
    const object = entry as Record<string, unknown>;
    if (Array.isArray(object.tools)) {
      changed = true;
      return { ...object, tools: object.tools.map(annotateTool) };
    }
    if (object.result && typeof object.result === "object") {
      return { ...object, result: visit(object.result) };
    }
    return entry;
  };
  const next = visit(value);
  return changed ? JSON.stringify(next) : text;
}

function transformSse(text: string): string {
  // Keep the exact blank-line separators between SSE events.
  const chunks = text.split(/(\r?\n\r?\n)/);
  let changed = false;
  for (let i = 0; i < chunks.length; i += 2) {
    const block = chunks[i] ?? "";
    if (!block.includes("data:")) continue;
    const lines = block.split(/\r?\n/);
    const dataIndexes: number[] = [];
    const data: string[] = [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex] ?? "";
      if (!line.startsWith("data:")) continue;
      dataIndexes.push(lineIndex);
      data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!dataIndexes.length) continue;
    const originalData = data.join("\n");
    const transformed = transformJson(originalData);
    if (transformed === originalData) continue;
    const first = dataIndexes[0]!;
    for (let j = dataIndexes.length - 1; j >= 0; j--) lines.splice(dataIndexes[j]!, 1);
    lines.splice(first, 0, `data: ${transformed}`);
    chunks[i] = lines.join("\n");
    changed = true;
  }
  return changed ? chunks.join("") : text;
}

function annotateTool(value: unknown): unknown {
  if (!value || typeof value !== "object" || typeof (value as { name?: unknown }).name !== "string") return value;
  const tool = value as Record<string, unknown>;
  return { ...tool, securitySchemes: securitySchemesForTool(tool.name as string) };
}

function responseWithBody(response: Response, body: string): Response {
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  headers.delete("Content-MD5");
  headers.delete("ETag");
  headers.delete("Last-Modified");
  headers.set("Cache-Control", "no-store");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
