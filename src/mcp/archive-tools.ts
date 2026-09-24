/**
 * Internet Archive / Wayback Machine tools (`archive_search`, `archive_item`,
 * `wayback`) — grouped capabilities over DEMO's existing HTTP + extraction
 * stack. No API key is used or required; results always preserve the original
 * URL and capture timestamps; "no snapshot exists" is a first-class outcome.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { BrowserError } from "../core/errors.js";
import { LIMITS } from "../core/limits.js";
import { runTool, textResult } from "./results.js";
import {
  archiveItem,
  archiveSearchItems,
  waybackClosest,
  waybackRetrieve,
  waybackSnapshots,
} from "../archive/client.js";

export const ARCHIVE_TOOL_NAMES = ["archive_search", "archive_item", "wayback"] as const;

export interface ArchiveToolContext {
  env: Record<string, unknown>;
}

export function registerArchiveTools(mcp: McpServer, ctx: ArchiveToolContext): void {
  mcp.registerTool(
    "archive_search",
    {
      title: "Search the Internet Archive",
      description:
        "Search the Internet Archive. scope=items searches public archive.org items (texts, audio, movies, software, web collections…); scope=web searches *archived webpages* for a URL/host through the Wayback CDX index and lists captures. No API key required. Returns original URLs and archive timestamps — and when nothing is archived it says so plainly instead of inventing results.",
      inputSchema: {
        scope: z.enum(["items", "web"]).default("items").describe("items = archive.org catalog; web = Wayback captures for a URL/host."),
        query: z.string().min(1).max(400).describe("Search text (items) or a URL / hostname (web)."),
        limit: z.number().int().min(1).max(50).default(10),
        page: z.number().int().min(1).max(100).default(1).describe("items scope: result page."),
        mediatype: z.string().max(40).optional().describe("items scope: filter by mediatype (texts, audio, movies, software, image, web…)."),
        from: z.string().max(40).optional().describe("web scope: earliest capture date (ISO-8601 or YYYYMMDDhhmmss)."),
        to: z.string().max(40).optional().describe("web scope: latest capture date."),
        match_type: z.enum(["exact", "prefix", "host"]).default("exact").describe("web scope: how the URL matches archived captures."),
      },
      annotations: { title: "Search the Internet Archive", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(async () => {
        const scope = (args.scope ?? "items") as "items" | "web";
        if (scope === "items") {
          const result = await archiveSearchItems(ctx.env, args.query, {
            limit: args.limit,
            page: args.page,
            mediatype: args.mediatype,
          });
          return textResult({ ok: true, ...result });
        }
        // Web scope: a URL-shaped query is expected; bare hostnames are allowed
        // and expanded to https:// so "search archived webpages of example.com" works.
        let target = args.query.trim();
        if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
        const listing = await waybackSnapshots(ctx.env, target, {
          from: args.from,
          to: args.to,
          limit: args.limit,
          matchType: args.match_type,
        });
        return textResult({ ok: true, scope: "web", query: args.query, total: listing.snapshots.length, ...listing });
      }),
  );

  mcp.registerTool(
    "archive_item",
    {
      title: "Internet Archive Item",
      description:
        "Retrieve metadata and the available file listing for an archive.org item by identifier (structured item layout). Reports restricted/unavailable items explicitly (access_restricted) instead of pretending they can be fetched. No API key required.",
      inputSchema: {
        identifier: z.string().min(1).max(200).describe("archive.org item identifier (e.g. 'goodytwoshoes00newy')."),
        max_files: z.number().int().min(1).max(500).default(100),
      },
      annotations: { title: "Internet Archive Item", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(async () => {
        const item = await archiveItem(ctx.env, args.identifier, { maxFiles: args.max_files });
        return textResult({ ok: true, ...item });
      }),
  );

  mcp.registerTool(
    "wayback",
    {
      title: "Wayback Machine",
      description:
        "Wayback Machine operations on a public URL. mode=availability finds the closest snapshot to a timestamp (or now); mode=snapshots lists captures around a date/window; mode=retrieve fetches an archived page and extracts its content (title, text, links) with the capture timestamp preserved. If a URL was never archived, the result says snapshot: null with a clear message — DEMO never pretends every URL has an archived copy.",
      inputSchema: {
        mode: z.enum(["availability", "snapshots", "retrieve"]).default("availability"),
        url: z.string().url().max(2_000).describe("The original public URL (not the archive URL)."),
        timestamp: z.string().max(40).optional().describe("ISO-8601 or YYYYMMDDhhmmss; closest capture to this time (default: now)."),
        from: z.string().max(40).optional().describe("snapshots mode: window start."),
        to: z.string().max(40).optional().describe("snapshots mode: window end."),
        limit: z.number().int().min(1).max(LIMITS.archiveCdxMaxRowsCap).default(50).describe("snapshots mode: max rows (one capture per day by default)."),
        match_type: z.enum(["exact", "prefix", "host"]).default("exact"),
        extract: z.enum(["text", "structured", "none"]).default("text").describe("retrieve mode: extraction style for the archived page."),
      },
      annotations: { title: "Wayback Machine", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(async () => {
        const mode = (args.mode ?? "availability") as "availability" | "snapshots" | "retrieve";
        switch (mode) {
          case "availability": {
            const result = await waybackClosest(ctx.env, args.url, args.timestamp);
            return textResult({ ok: true, mode, ...result });
          }
          case "snapshots": {
            const result = await waybackSnapshots(ctx.env, args.url, {
              from: args.from,
              to: args.to,
              limit: args.limit,
              matchType: args.match_type,
              collapse: "day",
            });
            return textResult({ ok: true, mode, ...result });
          }
          case "retrieve": {
            const result = await waybackRetrieve(ctx.env, args.url, { timestamp: args.timestamp, extract: args.extract });
            return textResult({ ok: true, mode, ...result });
          }
          default:
            throw new BrowserError("invalid_input", `Unknown wayback mode "${String(mode)}".`, { hint: "Valid modes: availability, snapshots, retrieve" });
        }
      }),
  );
}
