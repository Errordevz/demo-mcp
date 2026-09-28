/**
 * Bounded, redaction-safe HTTP diagnostics for the deploy smoke checks.
 *
 * A failing smoke check has to explain itself, but the explanation is printed
 * into a CI log that everyone with repo access can read — and a deployed Worker
 * can answer with anything at all (an Access login redirect, an HTML error
 * page, a proxy body, a hostile payload). So every response body and header
 * reported through this module is:
 *
 *   1. byte-bounded while streaming, so a huge or hostile body is never
 *      buffered in full (`readBoundedBody` stops reading at the cap);
 *   2. character-bounded for printing, with an explicit truncation marker;
 *   3. redacted — Authorization, CF-Access-Jwt-Assertion, cookies, bearer
 *      tokens, JWTs, API keys, private keys, credentials in URLs, e-mail
 *      addresses, signed-URL parameters and secret-looking key/value pairs all
 *      become markers;
 *   4. re-checked after redaction: if a credential-shaped string somehow
 *      survives, the whole preview collapses to a marker instead of printing.
 *
 * Redirect targets are reported as origin + pathname only. An OAuth redirect
 * carries `state` and `code_challenge` in its query string, so the query is
 * never printed.
 *
 * The redaction patterns deliberately mirror `src/core/redact.ts`. That module
 * cannot be imported here: it is TypeScript that gets bundled into the Worker,
 * while these scripts run under plain Node with no loader. Keep the two lists
 * in sync when a new secret shape shows up.
 */

/** Bytes read from a response body when building a diagnostic message. */
export const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
/** Characters of that body actually printed. */
export const MAX_DIAGNOSTIC_CHARS = 600;
/** Bytes read when a body is expected to be parsed (public JSON routes). */
export const MAX_PAYLOAD_BYTES = 512 * 1024;

/**
 * Response headers that are useful for diagnosing a deploy failure and carry no
 * credential material. Anything not listed here is simply not reported.
 */
const REPORTABLE_HEADERS = [
  "content-type",
  "content-length",
  "cache-control",
  "referrer-policy",
  "x-content-type-options",
  "allow",
  "retry-after",
  "server",
  "cf-ray",
];

/**
 * Headers that may carry a credential. Never reported, not even as a redacted
 * value — only their presence (for `set-cookie`) is acknowledged.
 */
export const FORBIDDEN_HEADER =
  /^(authorization|proxy-authorization|cf-access-jwt-assertion|cf-access-client-id|cf-access-client-secret|cf-access-authenticated-user-at|cookie|set-cookie|x-api-key|x-auth-token|www-authenticate)$/i;

const REPLACEMENTS = [
  // PEM private keys / certificates with keys.
  [/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]{0,4000}?-----END[A-Z ]*PRIVATE KEY-----/g, "[private-key-redacted]"],
  // JSON Web Tokens — this is the shape of a Cloudflare Access assertion.
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{0,200}/g, "[jwt-redacted]"],
  // Credentials embedded in a URL: https://user:pass@host
  [/\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@"],
  // Authorization-style header values.
  [/\b(bearer|basic|digest|negotiate)\s+[A-Za-z0-9\-._~+/=]{8,}/gi, "$1 [redacted]"],
  // Cookie headers in a body or a dumped header map.
  [/\b(set-cookie|cookie)("?)\s*:\s*[^\r\n}]*/gi, "$1$2: [redacted]"],
  // Provider style keys. The separator is `[-_]`: GitHub tokens are `ghp_…`
  // and Stripe keys are `sk_live_…`, not just the hyphenated shapes.
  [/\b(?:sk|pk|rk|api|ghp|gho|ghu|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}/g, "[api-key-redacted]"],
  [/\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{12,20}\b/g, "[aws-key-redacted]"],
  // Env-style `SCREAMING_SNAKE=value` assignments, which is how Worker secrets
  // are named (`ROBLOX_TOKEN_KEY=…`, `ROBLOX_CLIENT_SECRET=…`,
  // `CLOUDFLARE_API_TOKEN=…`). Deliberately case-sensitive and limited to
  // secret-bearing words so ordinary configuration stays readable.
  [
    /\b([A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD|CREDENTIAL|ASSERTION|JWT|COOKIE|APIKEY)[A-Z0-9_]*)(["']?)(\s*[=:]\s*)(["']?)(?!\[[a-z-]*redacted\])([^"'\s,;}]{3,})(["']?)/g,
    "$1$2$3$4[redacted]$6",
  ],
  // Secret-looking key/value pairs, including the Access assertion headers and
  // every credential name the smoke check must never echo. The leading
  // `(?<![A-Za-z0-9])` (rather than `\b`) matters: `_` is a word character, so
  // `\b` would skip exactly the env-style names worth protecting most, e.g.
  // `ROBLOX_CLIENT_SECRET=…` or `ROBLOX_TOKEN_KEY=…`.
  [
    /(?<![A-Za-z0-9])(cf[-_]?access[-_]?jwt[-_]?assertion|cf[-_]?access[-_]?client[-_]?secret|cf[-_]?access[-_]?client[-_]?id|authorization|proxy-authorization|x-api-key|x-auth-token|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|private[_-]?key|passphrase|password|passwd|pwd|secret|token|assertion|jwt|session[_-]?id|sessionid|csrf[_-]?token|xsrf[_-]?token|otp|one[_-]?time[_-]?code|verification[_-]?code|link[_-]?code|roblosecurity)(["']?)(\s*[:=]\s*)(["']?)(?!\[[a-z-]*redacted\])([^"'\s,;}]{3,})(["']?)/gi,
    "$1$2$3$4[redacted]$6",
  ],
  // E-mail addresses (an Access assertion subject can look like one).
  [/\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{2,255}\.[A-Za-z]{2,24}\b/g, "[email-redacted]"],
  // Signed media URL query parameters: short-lived credentials.
  [/([?&])(x-signature|signature|sig|hdnts|hdntl|hdnea|token|auth|se|sp|sr|sc|state|code|code_challenge)(=[^&#\s"]{6,})/gi, "$1$2=[signed-url-redacted]"],
  // Long opaque hex blobs (session ids, hashes, signatures).
  [/\b[0-9a-fA-F]{32,}\b/g, "[hex-redacted]"],
];

/**
 * Credential shapes that must never reach a log line. Checked *after*
 * redaction; a match means the preview is withheld entirely rather than
 * risking a partial leak. Already-redacted markers are excluded so a correct
 * redaction is not mistaken for a survivor.
 */
const SURVIVORS = [
  /\beyJ[A-Za-z0-9_-]{4,}/i,
  /\b(?:bearer|basic|digest|negotiate)\s+[A-Za-z0-9\-._~+/=]{8,}/i,
  /-----BEGIN[A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/i,
  /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{12,20}\b/i,
  /\b(?:sk|pk|rk|api|ghp|gho|ghu|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}/i,
  /\b[A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD|CREDENTIAL|ASSERTION|JWT|COOKIE|APIKEY)[A-Z0-9_]*["']?\s*[:=]\s*(?!["']?\[(?:[a-z-]*redacted|withheld:))[^\s,;}]{3,}/,
  // A secret-named key whose value is not already one of our markers. The
  // optional quote sits *inside* the lookahead on purpose: an optional group
  // after it can backtrack to a position where `[redacted]` looks like a live
  // value, which would withhold every correctly redacted body.
  /(?:authorization|cf-access-jwt-assertion|cookie|client_secret|access_token|refresh_token|id_token|password|secret|token|assertion|roblosecurity)["']?\s*[:=]\s*(?!["']?\[(?:[a-z-]*redacted|withheld:))[^\s,;}]{3,}/i,
];

/**
 * Replace every credential shape in `value` with a marker, then bound the
 * result to `maxLength` characters.
 */
export function redactSecrets(value, maxLength = MAX_DIAGNOSTIC_CHARS) {
  if (typeof value !== "string") return "";
  let out = value;
  for (const [pattern, replacement] of REPLACEMENTS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, replacement);
  }
  for (const pattern of SURVIVORS) {
    pattern.lastIndex = 0;
    if (pattern.test(out)) return "[withheld: credential-shaped content survived redaction]";
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > maxLength ? `${out.slice(0, maxLength)}…[truncated ${out.length - maxLength} chars]` : out;
}

/**
 * Read at most `maxBytes` of a response body without buffering the rest.
 * Returns the decoded text plus what happened, so callers can say whether the
 * preview is complete.
 */
export async function readBoundedBody(response, maxBytes = MAX_DIAGNOSTIC_BYTES) {
  if (!response.body) return { text: "", bytesRead: 0, truncated: false };
  let reader;
  try {
    reader = response.body.getReader();
  } catch (error) {
    // An already-consumed body throws synchronously here; report that instead
    // of turning a diagnostic into a second, unrelated failure.
    return {
      text: `[body already consumed: ${redactSecrets(error instanceof Error ? error.message : String(error), 160)}]`,
      bytesRead: 0,
      truncated: true,
    };
  }
  const chunks = [];
  let bytesRead = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (bytesRead + value.byteLength > maxBytes) {
        const room = Math.max(0, maxBytes - bytesRead);
        if (room > 0) chunks.push(value.subarray(0, room));
        bytesRead += value.byteLength;
        truncated = true;
        break;
      }
      chunks.push(value);
      bytesRead += value.byteLength;
      if (bytesRead >= maxBytes) {
        // There may be more; find out without buffering it.
        const next = await reader.read();
        if (!next.done) truncated = true;
        break;
      }
    }
  } catch (error) {
    return {
      text: `[body unreadable: ${redactSecrets(error instanceof Error ? error.message : String(error), 160)}]`,
      bytesRead,
      truncated: true,
    };
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Cancelling an already-finished stream can throw; nothing to report.
    }
  }
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Non-fatal: a truncated stream can end mid multi-byte character.
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(merged), bytesRead, truncated };
}

/** True when the response tried to set a cookie. The value is never read. */
export function setsCookie(response) {
  for (const name of ["set-cookie", "Set-Cookie"]) {
    if (response.headers.get(name)) return true;
  }
  // `getSetCookie` is the spec way to see multiple Set-Cookie headers.
  const getter = response.headers.getSetCookie;
  if (typeof getter === "function") {
    try {
      if (getter.call(response.headers).length > 0) return true;
    } catch {
      // Older runtimes may not support it; the checks above are enough.
    }
  }
  return false;
}

/** Allowlisted, redacted `name: value` header pairs safe to print. */
export function safeHeaderSummary(response) {
  const parts = [];
  for (const name of REPORTABLE_HEADERS) {
    const value = response.headers.get(name);
    if (value === null || FORBIDDEN_HEADER.test(name)) continue;
    parts.push(`${name}=${redactSecrets(value, 120)}`);
  }
  if (setsCookie(response)) parts.push("set-cookie=[present, value withheld]");
  return parts;
}

/**
 * A redirect target with its query string removed. OAuth redirects carry
 * `state`/`code_challenge` in the query, so only origin + pathname is safe.
 */
export function safeRedirectTarget(response) {
  const location = response.headers.get("location");
  if (!location) return null;
  try {
    const url = new URL(location, "https://invalid.example/");
    return `${url.origin}${url.pathname}${url.search ? "?[query withheld]" : ""}`;
  } catch {
    return "[unparsable location withheld]";
  }
}

/**
 * One-line, bounded, redacted description of a response whose body has already
 * been read by `readBoundedBody` (a Response body can only be consumed once).
 */
export function formatResponseSummary(response, read, { label } = {}) {
  const pieces = [`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`];
  if (label) pieces.unshift(label);
  const headers = safeHeaderSummary(response);
  if (headers.length) pieces.push(`headers{${headers.join(", ")}}`);
  const redirect = safeRedirectTarget(response);
  if (redirect) pieces.push(`redirects-to=${redirect} (not followed)`);
  const preview = redactSecrets(read.text);
  const bound = `${read.bytesRead}B read${read.truncated ? ", truncated at cap" : ""}`;
  pieces.push(preview ? `body[${bound}]: ${preview}` : `body[${bound}]: <empty>`);
  return pieces.join(" | ");
}

/** Convenience wrapper: bounded read + formatted summary in one call. */
export async function describeResponse(response, { label, maxBytes = MAX_DIAGNOSTIC_BYTES } = {}) {
  const read = await readBoundedBody(response, maxBytes);
  return formatResponseSummary(response, read, { label });
}

/**
 * Describe a secret without revealing it, matching `fingerprintSecret` in
 * `src/core/redact.ts`: `«1234 chars, sha256:9f2a3b…»`.
 */
export function fingerprintSecret(value, sha256Hex) {
  if (typeof value !== "string" || !value) return "«absent»";
  const digest = sha256Hex(value);
  return `«${value.length} chars, sha256:${digest.slice(0, 12)}…»`;
}
