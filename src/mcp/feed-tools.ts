/**
 * `feed_read` — generic RSS 2.x / Atom support over DEMO's HTTP + SSRF stack.
 * No API key, malformed-feed tolerant, configurable entry limits.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { BrowserError } from "../core/errors.js";
import { LIMITS } from "../core/limits.js";
import { runTool, textResult } from "./results.js";
import { fetchFeed } from "../feeds/client.js";
import { parseFeed } from "../feeds/parse.js";

export const FEED_TOOL_NAMES = ["feed_read"] as const;

export interface FeedToolContext {
  env: Record<string, unknown>;
}

export function registerFeedTools(mcp: McpServer, ctx: FeedToolContext): void {
  mcp.registerTool(
    "feed_read",
    {
      title: "Read RSS / Atom Feed",
      description:
        "Fetch and parse an RSS 2.x, Atom or RDF feed (or parse inline XML) into feed metadata + entries: titles, links, GUIDs/ids, publication and update dates, authors, categories/tags, descriptions/content and enclosures. Accepts a feed URL — or a page URL whose <link rel=alternate> advertises feeds (they are returned as suggestions). Malformed feeds degrade gracefully with warnings; entry limits are configurable. No API key; content is fetched read-only through DEMO's SSRF-guarded HTTP client and never stored.",
      inputSchema: {
        url: z.string().url().max(2_000).optional().describe("Public feed (or page) URL. Provide url or xml."),
        xml: z.string().max(2_000_000).optional().describe("Inline RSS/Atom XML to parse instead of fetching (offline/testing)."),
        limit: z.number().int().min(1).max(LIMITS.feedMaxEntriesCap).default(LIMITS.feedMaxEntriesDefault).describe("Maximum entries to return."),
        timeout_ms: z.number().int().min(1_000).max(LIMITS.publicFetchTimeoutMaxMs).optional(),
      },
      annotations: { title: "Read RSS / Atom Feed", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(async () => {
        if (!args.url && !args.xml) throw new BrowserError("invalid_input", "Provide either url (fetch a feed) or xml (parse inline).");
        if (args.xml) {
          const parsed = parseFeed(args.xml, { limit: args.limit });
          return textResult({ ok: true, source: "inline", ...parsed });
        }
        const result = await fetchFeed(ctx.env, args.url!, { limit: args.limit, timeoutMs: args.timeout_ms });
        return textResult({ ok: true, source: "url", ...result });
      }),
  );
}
