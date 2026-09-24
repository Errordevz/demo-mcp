/**
 * Feed retrieval (DEMO 0.9) over the shared SSRF-guarded fetch. Accepts a URL
 * of a feed or a page that points at one (feed auto-discovery), and inline XML
 * for offline parsing. No API key; nothing is cached or stored.
 */

import { BrowserError } from "../core/errors.js";
import { createSsrfGuard, guardedFetchBytes } from "../core/guarded-fetch.js";
import { findAll, parseHtml } from "../core/html-lite.js";
import { LIMITS, clamp } from "../core/limits.js";
import { publicToolRateLimiter } from "../core/rate-limit.js";
import { parseFeed, type ParsedFeed, type ParseFeedOptions } from "./parse.js";

const FEED_ACCEPT = "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.4, */*;q=0.2";

export interface FeedFetchResult extends ParsedFeed {
  sourceUrl: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  /** Feed URLs advertised by the page when the target was HTML (auto-discovery). */
  discoveredFeeds: string[];
  bytes: number;
}

export async function fetchFeed(env: Record<string, unknown> | undefined, url: string, options: ParseFeedOptions & { timeoutMs?: number } = {}): Promise<FeedFetchResult> {
  publicToolRateLimiter.charge(env, "feed_read", url);
  const guard = createSsrfGuard(env);
  const result = await guardedFetchBytes(url, {
    guard,
    timeoutMs: clamp(options.timeoutMs ?? LIMITS.publicFetchTimeoutDefaultMs, 1_000, LIMITS.publicFetchTimeoutMaxMs),
    maxBytes: LIMITS.feedMaxBytes,
    acceptContentTypes: null,
    headers: { accept: FEED_ACCEPT, "user-agent": "DEMO-MCP/0.9.0 (+feed reader; public read-only)" },
  });
  const text = new TextDecoder("utf-8", { fatal: false }).decode(result.bytes);
  const looksLikeFeed = /<(?:rss|feed|rdf:RDF)\b/i.test(text.slice(0, 4_000));
  const discoveredFeeds = looksLikeFeed ? [] : discoverFeedLinks(text, result.finalUrl);
  if (!looksLikeFeed) {
    throw new BrowserError(
      "unsupported",
      discoveredFeeds.length
        ? `That URL returned an HTML page, not a feed. The page advertises feed(s): ${discoveredFeeds.slice(0, 5).join(", ")} — pass one of those to feed_read.`
        : "That URL returned neither an RSS/Atom feed nor a page that advertises one. Check the URL — many sites use /feed, /rss, /atom.xml or an <link rel=\"alternate\"> entry.",
      { retryable: false },
    );
  }
  const parsed = parseFeed(text, { limit: options.limit, baseUrl: result.finalUrl });
  return {
    ...parsed,
    sourceUrl: url,
    finalUrl: result.finalUrl,
    status: result.status,
    contentType: result.contentType,
    discoveredFeeds,
    bytes: result.bytes.byteLength,
    warnings: [...parsed.warnings, ...(result.bytes.byteLength >= LIMITS.feedMaxBytes ? ["feed-truncated-by-size-limit"] : [])],
  };
}

function discoverFeedLinks(html: string, baseUrl: string): string[] {
  const root = parseHtml(html, { maxNodes: 8_000 });
  const out: string[] = [];
  for (const link of findAll(root, "link", 20)) {
    const rel = (link.attrs.rel ?? "").toLowerCase();
    const type = (link.attrs.type ?? "").toLowerCase();
    if (rel !== "alternate") continue;
    if (!/rss|atom|xml/.test(type)) continue;
    const href = link.attrs.href;
    if (!href) continue;
    try {
      out.push(new URL(href, baseUrl).toString());
    } catch {
      /* ignore unusable hrefs */
    }
    if (out.length >= 10) break;
  }
  return out;
}
