/**
 * MCP surface for the Laya decision provider.
 *
 * One tool and one resource, both read-only and free (they report configuration
 * presence, never spend a decision call):
 *
 *  - `laya_capabilities` — whether this deployment routes typed decisions to an
 *    external Laya server, the routing mode and chain, the budgets and the safety
 *    boundary. Also served as the `demo://capabilities/laya` resource and as
 *    `GET /capabilities/laya`, mirroring the Jev surfaces.
 *
 * Decisions themselves stay in the existing `jev_decide` tool, which gained an
 * optional `provider` argument (`auto` | `laya` | `jev`) instead of DEMO growing a
 * second decide tool. The credential is never reported — presence only.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { textResult, type ToolResult } from "./results.js";
import { redactValue, safeLog } from "../core/redact.js";
import { resolveLayaConfig } from "../laya/config.js";
import { describeLayaCapabilities, LAYA_CAPABILITIES_URI, LAYA_SCHEMA } from "../laya/capabilities.js";

export const LAYA_TOOL_NAMES = ["laya_capabilities"] as const;
export type LayaToolName = (typeof LAYA_TOOL_NAMES)[number];

export interface LayaToolContext {
  env: Record<string, unknown>;
  requestUrl?: string | null;
}

async function run(work: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return textResult(redactValue(await work()));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string })?.code ?? "internal";
    safeLog("warn", "laya-tool-error", { code, message }, "laya");
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: code, message, retryable: Boolean((error as { retryable?: boolean })?.retryable) }, null, 2) }],
    };
  }
}

export function registerLayaTools(mcp: McpServer, ctx: LayaToolContext): void {
  mcp.registerResource(
    "laya_capabilities",
    LAYA_CAPABILITIES_URI,
    {
      title: "DEMO Laya Decision Provider Capabilities",
      description:
        "Whether this deployment routes typed decisions to an external Laya server, the routing mode and fallback chain, the request budgets and the safety boundary. Presence-only: no credential value, and the endpoint is reported as a hostname.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(layaCapabilitiesReport(ctx.env), null, 2) }],
    }),
  );

  mcp.registerTool(
    "laya_capabilities",
    {
      title: "Laya Decision Provider Capabilities",
      description:
        "Report whether this deployment routes typed decisions to an external Laya server (enabled/configured/reachable configuration, routing mode auto|laya|jev with the fallback chain, budgets, and the safety boundary). DEMO never hosts the Laya model; the endpoint is reported as a hostname and no credential value is ever included. Also available as the demo://capabilities/laya resource and as flags in demo_ping, /health and /platform/stats.",
      annotations: { title: "Laya Decision Provider Capabilities", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({}),
    },
    async () => run(async () => ({ ...layaCapabilitiesReport(ctx.env), resources: [LAYA_CAPABILITIES_URI] })),
  );
}

/**
 * Shared capability report for the MCP resource/tool and `GET /capabilities/laya`.
 * Synchronous and credential-free by construction.
 */
export function layaCapabilitiesReport(env: Record<string, unknown> | undefined) {
  return describeLayaCapabilities({ config: resolveLayaConfig(env), env });
}

export { LAYA_CAPABILITIES_URI, LAYA_SCHEMA };
