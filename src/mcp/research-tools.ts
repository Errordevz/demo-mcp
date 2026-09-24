/**
 * `web_research` — structured research orchestration combining DEMO's existing
 * search-fetch-extract-archive capabilities into evidence-backed findings with
 * preserved provenance. The tool gathers and compares; the connected AI
 * answers from the findings and cites the source URLs.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { BrowserError } from "../core/errors.js";
import { LIMITS } from "../core/limits.js";
import { runTool, textResult } from "./results.js";
import { runResearch } from "../research/orchestrator.js";

export const RESEARCH_TOOL_NAMES = ["web_research"] as const;

export interface ResearchToolContext {
  env: Record<string, unknown>;
}

export function registerResearchTools(mcp: McpServer, ctx: ResearchToolContext): void {
  mcp.registerTool(
    "web_research",
    {
      title: "Structured Web Research",
      description:
        "Run structured research on a question: discover relevant public sources, retrieve them (live, or via the Wayback Machine when the live page is gone), extract useful content, compare multiple sources, and return evidence-backed findings with FULL provenance (every statement carries source URLs + retrieval timestamps). Findings separate quoted facts from labelled inference, conflicts between sources are reported as conflicts (never resolved by guessing) and confidence reflects corroboration depth — never a claim of truth. Configurable depth (quick/standard/deep), maximum sources, timeout and domain allow/deny lists. Sources needing CAPTCHA, login or other human interaction are reported with the existing human-handoff hint (browser_captcha_handoff / browser_pause_for_human) — protections are never bypassed. Never fabricate citations: answer from findings and cite their sources.",
      inputSchema: {
        question: z.string().min(3).max(500).describe("The research question or topic."),
        depth: z.enum(["quick", "standard", "deep"]).default("standard"),
        max_sources: z.number().int().min(1).max(LIMITS.researchMaxSourcesCap).default(5),
        timeout_ms: z.number().int().min(5_000).max(LIMITS.researchTimeoutMaxMs).default(LIMITS.researchTimeoutDefaultMs),
        allowed_domains: z.array(z.string().max(200)).max(20).optional().describe("Restrict sources to these domains (e.g. ['who.int'])."),
        blocked_domains: z.array(z.string().max(200)).max(20).optional(),
        include_archive_fallback: z.boolean().default(true).describe("Try the Wayback Machine when a live source is unavailable."),
      },
      annotations: { title: "Structured Web Research", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(async () => {
        if (args.allowed_domains?.length && args.blocked_domains?.length) {
          const clash = args.allowed_domains.filter((domain) => args.blocked_domains!.includes(domain));
          if (clash.length) throw new BrowserError("invalid_input", `Domains appear in both lists: ${clash.join(", ")}`, { retryable: false });
        }
        const result = await runResearch({
          env: ctx.env,
          query: args.question,
          depth: args.depth,
          maxSources: args.max_sources,
          timeoutMs: args.timeout_ms,
          allowedDomains: args.allowed_domains,
          blockedDomains: args.blocked_domains,
          includeArchiveFallback: args.include_archive_fallback,
        });
        return textResult({ ok: true, ...result });
      }),
  );
}
