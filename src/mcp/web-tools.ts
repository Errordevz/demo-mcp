/**
 * Web intelligence tools: `web_extract` (clean webpage → text/Markdown/JSON),
 * `web_diff` (current page vs supplied/stored snapshot), `screenshot_diff`
 * (visual comparison on the existing browser + screenshot store) and
 * `web_monitor` (bounded R2-backed change monitors).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { BrowserError } from "../core/errors.js";
import { createSsrfGuard, guardedFetchBytes } from "../core/guarded-fetch.js";
import { LIMITS } from "../core/limits.js";
import { toMarkdown, toJsonView, toPlainText } from "../web/extract.js";
import { fetchPublicPage } from "../web/fetch-page.js";
import { computeWebDiff, storePageSnapshot } from "../web/diff.js";
import { addMonitor, checkMonitor, getMonitor, listMonitors, removeMonitor } from "../web/monitor.js";
import { diffThreshold, mergeChangedRegions, metadataSimilarity, requireDistinct, runCanvasDiff, type ScreenshotDiffStats } from "../browser/compare.js";
import { ScreenshotManager } from "../browser/screenshot.js";
import { resolveScreenshotBase } from "../session/factory.js";
import { imageDimensions } from "../video/probe.js";
import { runTool, textResult } from "./results.js";

export const WEB_TOOL_NAMES = ["web_extract", "web_diff", "screenshot_diff", "web_monitor"] as const;

export interface WebToolContext {
  env: Record<string, unknown> & { SCREENSHOTS?: unknown; BROWSER?: unknown; SNAPSHOT_RETENTION_SECONDS?: string; WEB_MONITOR_SCHEDULED_CHECKS?: string };
  requestUrl?: string | null;
  /** One-shot raw page access (from SessionManager) — used by screenshot_diff. */
  withRawPage?: <T>(fn: (page: unknown) => Promise<T>) => Promise<T>;
}

function screenshotManager(ctx: WebToolContext): ScreenshotManager {
  return new ScreenshotManager(ctx.env.SCREENSHOTS as never, resolveScreenshotBase(ctx.env as never, ctx.requestUrl ?? null));
}

async function loadScreenshotBytes(ctx: WebToolContext, reference: string): Promise<{ bytes: Uint8Array; source: string; sha: string | null }> {
  const id = reference.trim();
  if (/^[A-Za-z0-9_-]{16,100}$/.test(id) && !/^https?:/i.test(id)) {
    const bucket = ctx.env.SCREENSHOTS as { get?: (key: string) => Promise<{ arrayBuffer?(): Promise<ArrayBuffer>; body?: ReadableStream<Uint8Array> } | null> } | undefined;
    if (!bucket?.get) throw new BrowserError("capability_unavailable", "Screenshot storage is not configured; screenshot references cannot be read.", { capability: "screenshot_storage" });
    const object = await bucket.get(`screenshots/${id}`);
    if (!object) throw new BrowserError("page_not_found", "No stored screenshot with that id (references expire with the artifact TTL).", { retryable: false });
    const bytes = object.arrayBuffer ? new Uint8Array(await object.arrayBuffer()) : await readStream(object.body);
    return { bytes, source: `screenshot:${id}`, sha: null };
  }
  if (!/^https?:\/\//i.test(id)) throw new BrowserError("invalid_input", "Pass a screenshot reference (id) or a public image URL.");
  const guard = createSsrfGuard(ctx.env);
  const result = await guardedFetchBytes(id, {
    guard,
    timeoutMs: 15_000,
    maxBytes: LIMITS.imageMaxBytes,
    acceptContentTypes: ["image/", "application/octet-stream"],
    headers: { accept: "image/*" },
  });
  return { bytes: result.bytes, source: result.finalUrl, sha: null };
}

async function readStream(body: ReadableStream<Uint8Array> | undefined): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function registerWebTools(mcp: McpServer, ctx: WebToolContext): void {
  /* ----------------------------------------------------------- web_extract */

  mcp.registerTool(
    "web_extract",
    {
      title: "Extract Webpage Content",
      description:
        "Fetch a public webpage and extract clean content: title, description, author, publication date, headings, paragraphs, links, images, tables, metadata and JSON-LD structured data. format=text (clean text), format=markdown (headings/lists/tables/links preserved), format=metadata (structured JSON). Runs on fetched HTML through DEMO's shared extractor — for JS-rendered pages use the existing browser_* tools instead. Nothing is stored or tracked; SSRF, size and timeout limits apply.",
      inputSchema: {
        url: z.string().url().max(2_000),
        format: z.enum(["text", "markdown", "metadata", "json"]).default("markdown").describe("json = the full structured extraction."),
        include_links: z.boolean().default(true),
        max_chars: z.number().int().min(1_000).max(LIMITS.webpageExtractMaxChars).default(LIMITS.webpageExtractMaxChars),
        store_snapshot: z.boolean().default(false).describe("Also store a normalized snapshot (returns snapshot_key) for later web_diff comparisons."),
        timeout_ms: z.number().int().min(1_000).max(LIMITS.publicFetchTimeoutMaxMs).optional(),
      },
      annotations: { title: "Extract Webpage Content", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(async () => {
        const fetched = await fetchPublicPage(args.url, {
          env: ctx.env,
          scope: "web_extract",
          maxChars: args.max_chars,
          includeAllLinks: args.include_links,
          timeoutMs: args.timeout_ms,
        });
        const format = (args.format ?? "markdown") as "text" | "markdown" | "metadata" | "json";
        const body =
          format === "markdown"
            ? toMarkdown(fetched.page)
            : format === "text"
              ? toPlainText(fetched.page)
              : format === "json"
                ? toJsonView(fetched.page).text
                : JSON.stringify({ title: fetched.page.title, description: fetched.page.description, author: fetched.page.author, publishedTime: fetched.page.publishedTime, siteName: fetched.page.siteName, language: fetched.page.language, canonicalUrl: fetched.page.canonicalUrl, wordCount: fetched.page.wordCount }, null, 2);
        const stored = args.store_snapshot
          ? await storePageSnapshot(ctx.env, { url: args.url, finalUrl: fetched.finalUrl, status: fetched.status, page: fetched.page, source: "manual" })
          : null;
        return textResult({
          ok: true,
          url: args.url,
          finalUrl: fetched.finalUrl,
          status: fetched.status,
          format,
          content: body,
          ...(format === "metadata"
            ? { headings: fetched.page.headings.slice(0, 60), links: fetched.page.links.slice(0, 60), images: fetched.page.images.slice(0, 40), tables: fetched.page.tables.slice(0, 10), jsonLd: fetched.page.jsonLd }
            : {}),
          truncated: fetched.page.truncated,
          warnings: fetched.page.warnings,
          snapshot: stored,
        });
      }),
  );

  /* -------------------------------------------------------------- web_diff */

  mcp.registerTool(
    "web_diff",
    {
      title: "Web Content Diff",
      description:
        "Compare a webpage's content against a baseline: previous_text (supplied snapshot text), snapshot_key (a snapshot stored by web_extract/web_diff/web_monitor), or none (store the current page as a fresh baseline). Detects added, removed and changed content after normalizing obvious dynamic noise (timestamps, counters, tokens), and returns a structured diff + unified diff. Optionally stores the current page as a new snapshot. Screenshot-level visual comparison is screenshot_diff. Storage reuses DEMO's existing R2 artifact bucket with TTL cleanup — no new storage system.",
      inputSchema: {
        url: z.string().url().max(2_000),
        previous_text: z.string().max(2_000_000).optional().describe("Baseline content (e.g. from a previous web_extract)."),
        snapshot_key: z.string().max(300).optional().describe("snapshot_key returned by an earlier store_snapshot/check."),
        normalize: z.enum(["web-noise", "whitespace", "none"]).default("web-noise"),
        store_snapshot: z.boolean().default(false),
        include_unified_diff: z.boolean().default(true),
        timeout_ms: z.number().int().min(1_000).max(LIMITS.publicFetchTimeoutMaxMs).optional(),
      },
      annotations: { title: "Web Content Diff", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(async () => {
        const result = await computeWebDiff({
          env: ctx.env,
          url: args.url,
          previousText: args.previous_text ?? null,
          snapshotKey: args.snapshot_key ?? null,
          normalization: args.normalize,
          storeSnapshot: args.store_snapshot,
          includeUnifiedDiff: args.include_unified_diff,
          timeoutMs: args.timeout_ms,
        });
        return textResult({ ok: true, ...result });
      }),
  );

  /* --------------------------------------------------------- screenshot_diff */

  mcp.registerTool(
    "screenshot_diff",
    {
      title: "Screenshot Comparison",
      description:
        "Compare two screenshots visually using DEMO's existing browser + screenshot infrastructure. Inputs are screenshot references (from browser_screenshot/browser_workflow) or public image URLs. Runs a real pixel comparison in the Cloudflare browser (canvas work in-page) and returns changed-pixel ratio, changed-region bounding boxes and a stored difference image (same link format and TTL as screenshots). Without the browser binding it degrades to an honest metadata-only comparison — never a fabricated pixel diff.",
      inputSchema: {
        a: z.string().max(2_000).describe("First screenshot reference (id) or public image URL."),
        b: z.string().max(2_000).describe("Second screenshot reference (id) or public image URL."),
        threshold: z.number().int().min(1).max(128).default(16).describe("Per-channel delta (0-255-ish) above which a pixel counts as changed."),
        grid: z.number().int().min(4).max(64).default(24).describe("Region-detection grid resolution."),
        store_diff_image: z.boolean().default(true),
      },
      annotations: { title: "Screenshot Comparison", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(async () => {
        requireDistinct(args.a, args.b);
        const [first, second] = await Promise.all([loadScreenshotBytes(ctx, args.a), loadScreenshotBytes(ctx, args.b)]);
        const metaA = imageDimensions(first.bytes);
        const metaB = imageDimensions(second.bytes);
        const meta: ScreenshotDiffStats["meta"] = {
          a: { width: metaA?.width ?? null, height: metaA?.height ?? null, bytes: first.bytes.byteLength },
          b: { width: metaB?.width ?? null, height: metaB?.height ?? null, bytes: second.bytes.byteLength },
          sameBytes: first.bytes.byteLength === second.bytes.byteLength && first.bytes.every((byte, index) => byte === second.bytes[index]),
        };

        if (!ctx.withRawPage) {
          const similarity = metadataSimilarity({ ...meta.a, sha: null }, { ...meta.b, sha: null });
          return textResult({
            ok: true,
            mode: "metadata",
            pixel: null,
            regions: [],
            similarity: meta.sameBytes ? 1 : similarity,
            identical: meta.sameBytes,
            meta,
            diffImageUrl: null,
            message: meta.sameBytes
              ? "The two images are byte-identical."
              : "No browser binding in this deployment: only metadata comparison was possible. Pixel comparison requires the Cloudflare Browser Rendering binding (screenshot infrastructure).",
          });
        }

        const toDataUrl = (bytes: Uint8Array) => `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
        const result = await ctx.withRawPage(async (page) => {
          const raw = (await runCanvasDiff(page as never, toDataUrl(first.bytes), toDataUrl(second.bytes), diffThreshold(args.threshold), args.grid, args.grid)) as {
            stats?: ScreenshotDiffStats["pixel"];
            grid?: boolean[][];
            diffDataUrl?: string | null;
            error?: string;
          };
          return raw;
        });
        if (!result.stats || !result.grid) {
          throw new BrowserError("FRAMES_UNAVAILABLE", `The browser could not decode one of the images (${result.error ?? "unknown decode error"}).`, { retryable: true });
        }
        const regions = mergeChangedRegions(result.grid, Math.ceil(result.stats.width / args.grid), Math.ceil(result.stats.height / args.grid));
        let diffImageUrl: string | null = null;
        if (args.store_diff_image && result.diffDataUrl) {
          const diffBytes = dataUrlToBytes(result.diffDataUrl);
          const stored = await screenshotManager(ctx).store(diffBytes, "png", { source: "screenshot_diff", a: first.source.slice(0, 200), b: second.source.slice(0, 200) }, { prefix: "screenshots" });
          diffImageUrl = stored.url;
        }
        const stats: ScreenshotDiffStats = {
          pixel: result.stats,
          regions,
          similarity: 1 - (result.stats.differenceRatio ?? 0),
          identical: result.stats.changedPixels === 0,
          meta,
          diffImageUrl,
          mode: "pixel",
          message: result.stats.changedPixels === 0 ? "No visual differences above the threshold." : `${result.stats.differenceRatio * 100}% of pixels differ across ${regions.length} region(s).`,
        };
        return textResult({ ok: true, ...stats });
      }),
  );

  /* ------------------------------------------------------------- web_monitor */

  mcp.registerTool(
    "web_monitor",
    {
      title: "Website Change Monitor",
      description:
        "Register a URL for content-change monitoring on DEMO's existing R2 bucket (expiring objects; TTL cleanup like every artifact). mode=add (register + store baseline snapshot), mode=check (fetch now and report added/removed/changed content with a change summary), mode=list, mode=remove, mode=history (recent check versions). Checks run only when you ask (or via the opt-in scheduled sweep WEB_MONITOR_SCHEDULED_CHECKS=true) — registering never silently creates an unbounded recurring job. Every check respects SSRF protection, timeouts, size limits and rate limits. Retention is configurable per monitor.",
      inputSchema: {
        mode: z.enum(["add", "check", "list", "remove", "history"]).default("list"),
        url: z.string().url().max(2_000).optional().describe("add mode: the URL to monitor."),
        monitor_id: z.string().max(64).optional().describe("check/remove/history mode: id returned by add."),
        interval_seconds: z.number().int().min(LIMITS.monitorMinCheckIntervalSeconds).max(7 * 24 * 3600).default(3600).describe("add mode: minimum gap between checks."),
        max_versions: z.number().int().min(1).max(LIMITS.monitorMaxVersionsCap).default(LIMITS.monitorMaxVersionsDefault).describe("add mode: retained check history."),
        retention_seconds: z.number().int().min(3_600).max(LIMITS.snapshotRetentionMaxSeconds).optional().describe("add mode: record/snapshot retention (default: deployment SNAPSHOT_RETENTION_SECONDS)."),
        normalize: z.enum(["web-noise", "whitespace", "none"]).default("web-noise"),
        force: z.boolean().default(false).describe("check mode: check even when the interval has not elapsed."),
      },
      annotations: { title: "Website Change Monitor", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(async () => {
        const mode = (args.mode ?? "list") as "add" | "check" | "list" | "remove" | "history";
        switch (mode) {
          case "add": {
            if (!args.url) throw new BrowserError("invalid_input", "add mode requires url.");
            const result = await addMonitor({
              env: ctx.env,
              url: args.url,
              intervalSeconds: args.interval_seconds,
              maxVersions: args.max_versions,
              retentionSeconds: args.retention_seconds,
              normalize: args.normalize,
            });
            return textResult({ ok: true, mode, ...result });
          }
          case "check": {
            if (!args.monitor_id) throw new BrowserError("invalid_input", "check mode requires monitor_id.");
            const result = await checkMonitor({ env: ctx.env, id: args.monitor_id, force: args.force });
            return textResult({ ok: true, mode, ...result });
          }
          case "list": {
            const result = await listMonitors(ctx.env);
            return textResult({ ok: true, mode, ...result });
          }
          case "remove": {
            if (!args.monitor_id) throw new BrowserError("invalid_input", "remove mode requires monitor_id.");
            const result = await removeMonitor(ctx.env, args.monitor_id);
            return textResult({ ok: true, mode, ...result });
          }
          case "history": {
            if (!args.monitor_id) throw new BrowserError("invalid_input", "history mode requires monitor_id.");
            // History only reads the stored record — it never triggers a fetch.
            const monitor = await getMonitor(ctx.env, args.monitor_id);
            return textResult({ ok: true, mode, monitor, message: "Version history is the trimmed check log (fingerprint + change summary per check)." });
          }
          default:
            throw new BrowserError("invalid_input", `Unknown web_monitor mode "${String(mode)}".`, { hint: "Valid modes: add, check, list, remove, history" });
        }
      }),
  );
  /* Scheduled sweep hook: platform-entry.ts calls `checkDueMonitors` from the
   * existing hourly cron ONLY when WEB_MONITOR_SCHEDULED_CHECKS=true — so a
   * registered URL never silently becomes an unlimited recurring job. */
}
