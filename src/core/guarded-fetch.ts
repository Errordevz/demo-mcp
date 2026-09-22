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

export type UrlGuard = (url: string) => Promise<string>;

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
