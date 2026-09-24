/**
 * SSRF-hardened fetch helper for the `http_fetch` tool.
 *
 * Two properties the plain `fetch(url, { redirect: "follow" })` version lacked:
 *
 *  1. **Every redirect hop is re-validated.** A public URL that answers
 *     `302 → http://169.254.169.254/…` (or any internal address) used to be
 *     followed blindly and its body returned to the model. Each hop now goes
 *     through the same navigable-URL guard as the first one.
 *  2. **The body is bounded.** The old code read the whole response with
 *     `r.text()` and only truncated afterwards, so a huge or streaming body
 *     could balloon Worker memory. The read now stops at `maxBytes`.
 *
 * Behavior is otherwise unchanged: GET/HEAD, 2xx/3xx hop following, status and
 * content-type reported, body text truncated for the tool result.
 */

import { BrowserError } from "./errors.js";
import { assertNavigableUrl, createDohResolver, type DnsResolver } from "./url-guard.js";

export type UrlGuard = (url: string) => Promise<string>;

/**
 * Build the standard DEMO SSRF guard from Worker env.
 *
 * Unlike the legacy `http_fetch` tool (whose guard is operator-switchable for
 * backwards compatibility), the extended capabilities always guard: this
 * helper exists so every new capability routes through the exact same
 * `assertNavigableUrl` policy — scheme allow-list, private/link-local/metadata
 * block-list, DoH resolution and per-redirect-hop revalidation — and nobody is
 * tempted to hand-roll a weaker one.
 */
export function createSsrfGuard(env: Record<string, unknown> | undefined): UrlGuard {
  const dnsCheck = String(env?.SSRF_DNS_CHECK ?? "true").toLowerCase() !== "false";
  const dns: DnsResolver | null = dnsCheck ? createDohResolver() : null;
  return async (candidate: string) =>
    (
      await assertNavigableUrl(candidate, {
        allowInsecureHttp: true,
        dns,
        dnsFailOpen: String(env?.SSRF_DNS_FAIL_OPEN ?? "true").toLowerCase() === "true",
      })
    ).url;
}

/** Guard that rejects plain `http://` (used where content must not cross the network unencrypted). */
export function createHttpsOnlyGuard(env: Record<string, unknown> | undefined): UrlGuard {
  const dnsCheck = String(env?.SSRF_DNS_CHECK ?? "true").toLowerCase() !== "false";
  const dns: DnsResolver | null = dnsCheck ? createDohResolver() : null;
  return async (candidate: string) => {
    const verdict = await assertNavigableUrl(candidate, {
      allowInsecureHttp: false,
      dns,
      dnsFailOpen: String(env?.SSRF_DNS_FAIL_OPEN ?? "true").toLowerCase() === "true",
    });
    return verdict.url;
  };
}

export interface GuardedFetchOptions {
  method: "GET" | "HEAD";
  /** Validates (and normalises) every hop before it is fetched. */
  guard: UrlGuard;
  /** Maximum number of redirect hops to follow. */
  maxRedirects?: number;
  /** Hard cap on how many body bytes are read from the origin. */
  maxBodyBytes?: number;
  fetchImpl?: typeof fetch;
}

export interface GuardedFetchResult {
  status: number;
  contentType: string | null;
  /** Final URL after redirects (validated like every hop). */
  finalUrl: string;
  redirects: number;
  /** `true` when the body was cut off at `maxBodyBytes`. */
  truncated: boolean;
  body: string;
}

/** Reasonable defaults: same shape as the browser redirect budget. */
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BODY_BYTES = 2_000_000;
/** Text longer than this is useless for the model anyway. */
const RESULT_BODY_CHARS = 1_000_000;

export async function guardedFetchText(rawUrl: string, options: GuardedFetchOptions): Promise<GuardedFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  let currentUrl = await options.guard(rawUrl);
  let redirects = 0;

  for (;;) {
    const response = await fetchImpl(currentUrl, { method: options.method, redirect: "manual" });

    // 3xx: validate the next hop exactly like the first URL, then follow it.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return { status: response.status, contentType: response.headers.get("content-type"), finalUrl: currentUrl, redirects, truncated: false, body: "" };
      }
      let next: string;
      try {
        next = new URL(location, currentUrl).toString();
      } catch {
        throw new BrowserError("blocked_url", `A redirect from ${currentUrl} pointed at an unparsable location and was not followed.`, { retryable: false });
      }
      if (redirects + 1 > maxRedirects) {
        throw new BrowserError("blocked_url", `More than ${maxRedirects} redirects from ${rawUrl}; not following further.`, { retryable: false });
      }
      // Re-validate every hop: a public URL must not bounce into a private
      // network, a non-http scheme or a blocked hostname.
      await options.guard(next);
      redirects += 1;
      currentUrl = next;
      continue;
    }

    const contentType = response.headers.get("content-type");
    const declaredLength = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
      throw new BrowserError("size_limit_exceeded", `The response body is ${declaredLength} bytes, above the ${(maxBodyBytes / 1_000_000).toFixed(0)} MB fetch limit.`, {
        hint: "Fetch a smaller resource.",
        retryable: false,
      });
    }

    if (options.method === "HEAD" || response.body === null) {
      return { status: response.status, contentType, finalUrl: currentUrl, redirects, truncated: false, body: "" };
    }

    // Bounded read: stop pulling from the stream as soon as the cap is hit.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
        if (received >= maxBodyBytes) {
          truncated = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
    const merged = new Uint8Array(Math.min(received, maxBodyBytes));
    let offset = 0;
    for (const chunk of chunks) {
      if (offset >= merged.length) break;
      merged.set(chunk.subarray(0, Math.min(chunk.length, merged.length - offset)), offset);
      offset += Math.min(chunk.length, merged.length - offset);
    }
    const body = new TextDecoder("utf-8", { fatal: false }).decode(merged).slice(0, RESULT_BODY_CHARS);
    return { status: response.status, contentType, finalUrl: currentUrl, redirects, truncated, body };
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Binary / JSON variants used by the extended public capabilities (feeds,
 * PDFs, images, OpenAPI, monitoring, Internet Archive). Same guarantees as
 * `guardedFetchText`: every redirect hop is re-validated, the body read is
 * bounded, and oversized or timed-out resources fail with a stable
 * `BrowserError` — never a partial success dressed up as one.
 * ────────────────────────────────────────────────────────────────────────── */

export interface GuardedBinaryOptions {
  method?: "GET" | "HEAD";
  /** Validates (and normalises) every hop before it is fetched. Required: the
   * extended capabilities must not be able to run without the guard. */
  guard: UrlGuard;
  maxRedirects?: number;
  /** Hard cap on bytes read from the origin. */
  maxBytes: number;
  timeoutMs?: number;
  /** Extra request headers (never Authorization/Cookie — those are stripped). */
  headers?: Record<string, string>;
  /** Optional MIME prefixes the caller accepts (e.g. ["image/", "application/pdf"]).
   * Checked against the response `content-type`; `null` disables the check. */
  acceptContentTypes?: string[] | null;
  fetchImpl?: typeof fetch;
}

export interface GuardedBinaryResult {
  status: number;
  contentType: string | null;
  finalUrl: string;
  redirects: number;
  bytes: Uint8Array;
  /** Response header snapshot with credential-shaped headers removed (safe for logs and tool results). */
  headers: Record<string, string>;
}

/** Headers that must never be echoed back into a tool result or a log. */
const STRIPPED_RESPONSE_HEADERS = new Set(["set-cookie", "authorization", "proxy-authorization", "www-authenticate"]);

function snapshotHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (STRIPPED_RESPONSE_HEADERS.has(lower) || /(api[-_]?key|token|secret|session)/i.test(lower)) return;
    out[lower] = value.slice(0, 400);
  });
  return out;
}

function contentTypeAllowed(contentType: string | null, accepted: string[] | null | undefined): boolean {
  if (!accepted || accepted.length === 0) return true;
  if (!contentType) return false;
  const type = contentType.split(";")[0].trim().toLowerCase();
  return accepted.some((entry) => (entry.endsWith("/") ? type.startsWith(entry) : type === entry.toLowerCase()));
}

export async function guardedFetchBytes(rawUrl: string, options: GuardedBinaryOptions): Promise<GuardedBinaryResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const method = options.method ?? "GET";
  const maxRedirects = Math.max(0, Math.min(options.maxRedirects ?? 5, 8));
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 30_000, 120_000));
  const maxBytes = Math.max(1, options.maxBytes);

  let currentUrl = await options.guard(rawUrl);
  let redirects = 0;

  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      const headers = new Headers(options.headers ?? {});
      headers.delete("cookie");
      headers.delete("authorization");
      response = await fetchImpl(currentUrl, { method, headers, redirect: "manual", signal: controller.signal });
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new BrowserError("timeout", `The request to ${redactHost(currentUrl)} exceeded the ${timeoutMs}ms timeout.`, { retryable: true });
      }
      throw error instanceof BrowserError ? error : new BrowserError("navigation_failed", `The public request failed: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`, { retryable: true, cause: error });
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      clearTimeout(timer);
      if (!location) {
        throw new BrowserError("navigation_failed", `A redirect from ${redactHost(currentUrl)} carried no Location header.`, { retryable: false });
      }
      let next: string;
      try {
        next = new URL(location, currentUrl).toString();
      } catch {
        throw new BrowserError("blocked_url", `A redirect pointed at an unparsable location and was not followed.`, { retryable: false });
      }
      if (redirects + 1 > maxRedirects) {
        throw new BrowserError("blocked_url", `More than ${maxRedirects} redirects from the original URL; not following further.`, { retryable: false });
      }
      // Re-validate every hop so a public URL cannot bounce into an internal target.
      await options.guard(next);
      redirects += 1;
      currentUrl = next;
      continue;
    }

    try {
      if (response.status === 429) {
        throw new BrowserError("rate_limited", `The source returned HTTP 429 (too many requests) for ${redactHost(currentUrl)}.`, { retryable: true });
      }
      if (response.status === 509 || response.status === 503) {
        throw new BrowserError("rate_limited", `The source is busy or throttling (HTTP ${response.status}) for ${redactHost(currentUrl)}.`, { retryable: true });
      }
      if (response.status === 401 || response.status === 403) {
        throw new BrowserError("blocked_url", `The source refused access (HTTP ${response.status}). The resource may be private, login-restricted or blocked.`, { retryable: false, data: { status: response.status } });
      }
      const contentType = response.headers.get("content-type");
      if (contentType && /text\/html/i.test(contentType) && options.acceptContentTypes && !contentTypeAllowed(contentType, options.acceptContentTypes)) {
        // An HTML response where a document was requested usually means a wall,
        // a redirect page or a wrong URL — say so instead of parsing junk.
        throw new BrowserError("unsupported", `Expected ${options.acceptContentTypes.join(" or ")} but the source returned an HTML page (likely a login wall, interstitial or wrong URL).`, { retryable: false });
      }
      if (!contentTypeAllowed(contentType, options.acceptContentTypes)) {
        throw new BrowserError(
          "unsupported",
          `The response content-type ${contentType ? `"${contentType.split(";")[0]}"` : "is missing"} is not one of: ${options.acceptContentTypes?.join(", ") ?? "any"}.`,
          { retryable: false },
        );
      }
      const declared = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new BrowserError("size_limit_exceeded", `The response is ${declared} bytes, above the ${Math.round(maxBytes / 1024)} KB limit for this tool.`, { hint: "Pick a smaller resource.", retryable: false });
      }
      if (method === "HEAD" || !response.body) {
        return { status: response.status, contentType, finalUrl: currentUrl, redirects, bytes: new Uint8Array(), headers: snapshotHeaders(response.headers) };
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          received += value.byteLength;
          if (received > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new BrowserError("size_limit_exceeded", `The response exceeded the ${Math.round(maxBytes / 1024)} KB limit while streaming.`, { retryable: false });
          }
        }
      }
      const merged = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { status: response.status, contentType, finalUrl: currentUrl, redirects, bytes: merged, headers: snapshotHeaders(response.headers) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** URL without credentials or query noise for error messages (host + path only). */
function redactHost(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`.slice(0, 160);
  } catch {
    return "the requested URL";
  }
}

/** JSON convenience over `guardedFetchBytes` with size + content-type checks. */
export async function guardedFetchJson<T = unknown>(
  rawUrl: string,
  options: Omit<GuardedBinaryOptions, "acceptContentTypes" | "maxBytes"> & { maxBytes?: number },
): Promise<{ status: number; json: T; finalUrl: string; redirects: number }> {
  const result = await guardedFetchBytes(rawUrl, {
    ...options,
    maxBytes: options.maxBytes ?? 4_000_000,
    acceptContentTypes: ["application/json", "text/json", "application/feed+json", "application/hal+json", "application/xml", "text/xml", "text/plain"],
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(result.bytes));
  } catch {
    throw new BrowserError("unsupported", `The source at ${redactHost(result.finalUrl)} did not return valid JSON.`, { retryable: false });
  }
  return { status: result.status, json: parsed as T, finalUrl: result.finalUrl, redirects: result.redirects };
}
