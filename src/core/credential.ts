/**
 * Constant-time-ish credential comparison for the private MCP tools.
 *
 * `roblox_account_*` and `jev_decide` authenticate each call against the
 * `DEMO_API_KEY` secret. A plain `===` on attacker-controlled strings lets an
 * adversary in principle measure response-time differences character by
 * character. Comparing SHA-256 digests of both sides instead gives two
 * properties: the comparison always works on a fixed 32-byte value (no length
 * leak), and digest comparison itself branches only on bytes an attacker cannot
 * steer towards the secret.
 *
 * No credential value is ever written to a log or an error here.
 */

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time equality of two equal-length hex digests. */
function digestEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

/**
 * True when `authorization` is exactly `Bearer <expected>` for the configured
 * secret. Never throws, never logs, and leaks no timing information about the
 * secret beyond "one request came in".
 */
export async function bearerCredentialMatches(authorization: string | null | undefined, expected: string | null | undefined): Promise<boolean> {
  const key = String(expected ?? "").trim();
  if (!key) return false;
  const header = String(authorization ?? "").trim();
  const prefix = "bearer ";
  if (header.length < prefix.length || !header.slice(0, prefix.length).toLowerCase().startsWith(prefix)) return false;
  const [presented, expectedDigest] = await Promise.all([sha256Hex(header.slice(prefix.length).trim()), sha256Hex(key)]);
  return digestEquals(presented, expectedDigest);
}
