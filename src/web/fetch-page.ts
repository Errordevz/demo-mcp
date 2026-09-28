/**
 * One public webpage fetch + extraction pipeline, reused by `web_extract`,
 * `web_diff`, `web_monitor`, `web_research` and the Internet Archive snapshot
 * reader. It wires DEMO's existing pieces together instead of duplicating them:
 *
 *   SSRF guard (core/url-guard via core/guarded-fetch) → bounded bytes read →
 *   html-lite parse → web/extract content model → optional rate charge.
 *
 * Nothing here executes scripts, sends cookies, or stores anything; storage is
 * the caller's business.
 */

import { BrowserError } from "../core/errors.js";
import { createSsrfGuard, guardedFetchBytes } from "../core/guarded-fetch.js";
import { LIMITS, clamp } from "../core/limits.js";
import { publicToolRateLimiter } from "../core/rate-limit.js";
import { extractPage, type ExtractedPage } from "./extract.js";

export interface FetchPageOptions {
  env: Record<string, unknown> | undefined;
  /** Rate-limit scope, e.g. "web_extract" — charged per target URL. */
  scope: string;
  maxBytes?: number;
  timeoutMs?: number;
  maxChars?: number;
  includeAllLinks?: boolean;
  /** Extra Accept header (feeds use this to negotiate content type). */
  accept?: string;
  /** Content-type prefixes accepted (null → permissive text/html+text/plain). */
  acceptContentTypes?: string[] | null;
  /** Skip the rate charge (callers that already charged). */
  skipRateCharge?: boolean;
}

export interface FetchedPage {
  page: ExtractedPage;
  status: number;
  contentType: string | null;
  finalUrl: string;
  redirects: number;
  headers: Record<string, string>;
  bytes: number;
}

const PAGE_ACCEPT = "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5,*/*;q=0.1";

export async function fetchPublicPage(url: string, options: FetchPageOptions): Promise<FetchedPage> {
  if (!options.skipRateCharge) publicToolRateLimiter.charge(options.env, options.scope, url);
  const guard = createSsrfGuard(options.env);
  const timeoutMs = clamp(options.timeoutMs ?? LIMITS.publicFetchTimeoutDefaultMs, 1_000, LIMITS.publicFetchTimeoutMaxMs);
  const maxBytes = clamp(options.maxBytes ?? LIMITS.webpageMaxHtmlBytes, 16_384, LIMITS.publicFetchMaxBytes);
  let result;
  try {
    result = await guardedFetchBytes(url, {
      guard,
      timeoutMs,
      maxBytes,
      headers: { accept: options.accept ?? PAGE_ACCEPT, "user-agent": "DEMO-MCP/1.0.0 (+public read-only fetch)" },
      acceptContentTypes:
        options.acceptContentTypes === null
          ? null
          : options.acceptContentTypes ?? ["text/html", "application/xhtml", "text/plain", "text/xml", "application/xml", "text/markdown", "text/css"],
    });
  } catch (error) {
    if (error instanceof BrowserError && (error.code === "unsupported" || error.code === "blocked_url")) {
      // Re-throw as-is: stable, machine-readable error codes.
    }
    if (error instanceof TypeError) throw new BrowserError("navigation_failed", `The page could not be fetched: ${String(error.message).slice(0, 160)}`, { retryable: true, cause: error });
    throw error;
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(result.bytes);
  if (result.status === 404) throw new BrowserError("page_not_found", `The page returned HTTP 404 at ${result.finalUrl}`, { data: { finalUrl: result.finalUrl } });
  if (!result.status || result.status >= 400) {
    throw new BrowserError(
      "navigation_failed",
      `The page could not be fetched (HTTP ${result.status}).`,
      { retryable: result.status >= 500, data: { status: result.status, finalUrl: result.finalUrl } },
    );
  }
  const page = extractPage(text, { url: result.finalUrl, maxChars: options.maxChars, includeAllLinks: options.includeAllLinks });
  return { page, status: result.status, contentType: result.contentType, finalUrl: result.finalUrl, redirects: result.redirects, headers: result.headers, bytes: result.bytes.byteLength };
}
