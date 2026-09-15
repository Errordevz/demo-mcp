/**
 * Redaction helpers.
 *
 * Nothing in the browser subsystem may log or return raw passwords, tokens,
 * cookies, e-mail addresses or phone numbers. Every log line and every free
 * form string that crosses a tool boundary is passed through `redactText`
 * first.
 *
 * The patterns are intentionally simple (no nested quantifiers) to stay
 * linear-time and ReDoS-safe.
 */

const REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  // PEM private keys / certificates with keys.
  [/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]{0,4000}?-----END[A-Z ]*PRIVATE KEY-----/g, "[private-key-redacted]"],
  // JSON Web Tokens.
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{0,200}/g, "[jwt-redacted]"],
  // Credentials embedded in a URL: https://user:pass@host
  [/\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@"],
  // Authorization headers, cookie headers.
  [/\b(bearer|basic|digest|negotiate)\s+[A-Za-z0-9\-._~+/=]{8,}/gi, "$1 [redacted]"],
  [/\b(set-cookie|cookie)("?)\s*:\s*[^\r\n}]*/gi, "$1$2: [redacted]"],
  // Provider style keys.
  [/\b(?:sk|pk|rk|api|ghp|gho|ghu|ghs|github_pat|xox[baprs])-[A-Za-z0-9_-]{16,}/g, "[api-key-redacted]"],
  [/\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{12,20}\b/g, "[aws-key-redacted]"],
  [
    /\b(authorization|proxy-authorization|x-api-key|x-auth-token|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|private[_-]?key|passphrase|password|passwd|pwd|secret|token|session[_-]?id|sessionid|csrf[_-]?token|xsrf[_-]?token|otp|one[_-]?time[_-]?code|verification[_-]?code)(["']?)(\s*[:=]\s*)("?)([^"'\s,;}]{3,})("?)/gi,
    "$1$2$3$4[redacted]$6",
  ],
  // E-mail addresses.
  [/\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{2,255}\.[A-Za-z]{2,24}\b/g, "[email-redacted]"],
  // Phone numbers (international and NANP shapes only, to avoid mangling ids).
  [/\+\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{2,4}[\s.-]?\d{2,6}\b/g, "[phone-redacted]"],
  [/\b\(\d{3}\)\s*\d{3}[-.\s]?\d{4}\b/g, "[phone-redacted]"],
  [/\b\d{3}[-.]\d{3}[-.]\d{4}\b/g, "[phone-redacted]"],
  // Long opaque hex/base64 blobs (session ids, hashes, signatures).
  [/\b[0-9a-fA-F]{32,}\b/g, "[hex-redacted]"],
];

export function redactText(value: string, maxLength = 2000): string {
  if (typeof value !== "string") return "";
  let out = value;
  for (const [pattern, replacement] of REPLACEMENTS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, replacement);
  }
  return out.length > maxLength ? `${out.slice(0, maxLength)}…[truncated]` : out;
}

function isPrimitive(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value) || typeof value === "bigint";
}

/**
 * Deep redaction of any JSON-ish value. Anything that looks like a secret key
 * has its value replaced; object keys themselves are kept so the shape of the
 * payload stays readable.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return redactText(value);
  if (typeof value !== "object") return value;
  if (depth > 6) return "[deep-object-redacted]";
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redactValue(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redactValue(entry, depth + 1);
  }
  return out;
}

const SENSITIVE_KEY =
  /(password|passwd|pwd|secret|token|api[-_]?key|apikey|authorization|cookie|set-cookie|session[-_]?id|csrf|xsrf|otp|credit[-_]?card|cvv|ssn|private[-_]?key)/i;

/**
 * Structured, redaction-safe console logging. Used instead of raw
 * `console.log` everywhere in the browser subsystem.
 */
export function safeLog(level: "log" | "warn" | "error", label: string, data?: unknown): void {
  const payload = data === undefined ? "" : data;
  const text =
    typeof payload === "string"
      ? redactText(payload)
      : JSON.stringify(
          redactValue(payload),
          (_key, value) => (typeof value === "bigint" ? value.toString() : value),
        );
  const line = `[DEMO][browser:${label}]${text ? ` ${text}` : ""}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Describe a secret without revealing it: `«12 chars, sha256:9f2a…»`. */
export async function fingerprintSecret(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `«${value.length} chars, sha256:${hex.slice(0, 12)}…»`;
}
