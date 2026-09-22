/**
 * Small shared HTTP hardening helpers for the two Worker entrypoints.
 *
 * Privacy note: these headers are static, per-response values. Nothing here
 * reads, hashes or stores request metadata such as IP addresses or user agents.
 */

/** Applied to every JSON/asset response from both entrypoints. */
export function securityHeaders(): Record<string, string> {
  return {
    // Never let a browser sniff a JSON/error body into executable content.
    "X-Content-Type-Options": "nosniff",
    // The Worker never needs referrer data; do not leak URLs back to pages.
    "Referrer-Policy": "no-referrer",
  };
}

/** Additional locks for the one HTML surface (the inspector UI). */
export function uiSecurityHeaders(): Record<string, string> {
  return {
    ...securityHeaders(),
    // The UI is static, self-contained HTML with two inline blocks and no
    // third-party resources: lock it down to same-origin connections only.
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "X-Frame-Options": "DENY",
  };
}

/**
 * Reject request bodies that are obviously oversized before any handler runs.
 *
 * The MCP transport accepts ordinary JSON-RPC (a 40-action browser workflow is
 * a few KB). A multi-megabyte body is abuse, not a client: answering 413 early
 * protects Worker CPU/memory without affecting any real client. When the
 * content-length header is absent the body is allowed through — Workers cap
 * request sizes at the platform layer anyway, and streaming MCP clients must
 * keep working.
 */
export function oversizedBody(request: Request, maxBytes: number): Response | null {
  if (request.method !== "POST" && request.method !== "PUT") return null;
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return new Response(
      JSON.stringify({ error: "request_too_large", message: `Request body exceeds the ${Math.round(maxBytes / 1_000_000)} MB limit.`, retryable: false }),
      { status: 413, headers: { "content-type": "application/json; charset=utf-8", ...securityHeaders(), "Cache-Control": "no-store" } },
    );
  }
  return null;
}
