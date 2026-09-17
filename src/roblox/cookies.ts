/**
 * Cookies for the Roblox OAuth flow.
 *
 * Two cookies, both `HttpOnly` so no script — including DEMO's own status page —
 * can read them:
 *
 *  - `roblox_oauth_state` (short, `Path=/oauth/roblox`): binds a pending
 *    authorization to *this browser*. The callback requires both the stored
 *    state and this cookie, which is what stops login-CSRF (an attacker who
 *    completes their own flow cannot have its result land in the victim's
 *    browser, and vice versa).
 *  - `roblox_session` (long, `Path=/oauth/roblox`): holds only an opaque session
 *    id. The tokens stay on the Worker; nothing here is a token.
 *
 * `SameSite=Lax` is deliberate: the return trip from Roblox is a top-level GET
 * navigation, which Lax permits, while every cross-site subrequest (and any
 * cross-site POST) is refused. On iOS Safari this is the configuration that
 * survives Intelligent Tracking Prevention without needing third-party cookies.
 */

export const SESSION_COOKIE = "roblox_session";
export const STATE_COOKIE = "roblox_oauth_state";
export const OAUTH_PATH = "/oauth/roblox";

export interface CookieOptions {
  maxAgeSeconds: number;
  path?: string;
  secure?: boolean;
  expiresAt?: number;
}

export function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(value);
  }
  return out;
}

/** Opaque ids only ever contain [A-Za-z0-9_-]; reject anything else rather than reflect it. */
export function readCookieValue(header: string | null, name: string): string | null {
  const value = parseCookies(header)[name];
  if (!value) return null;
  return /^[A-Za-z0-9_-]{16,128}$/.test(value) ? value : null;
}

export function buildCookie(name: string, value: string, options: CookieOptions): string {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  segments.push(`Path=${options.path ?? OAUTH_PATH}`);
  segments.push(`Max-Age=${Math.max(0, Math.trunc(options.maxAgeSeconds))}`);
  const expires = options.expiresAt ?? (options.expiresAt === undefined ? Date.now() + Math.max(0, Math.trunc(options.maxAgeSeconds)) * 1000 : undefined);
  if (expires) segments.push(`Expires=${new Date(expires).toUTCString()}`);
  segments.push("HttpOnly");
  if (options.secure !== false) segments.push("Secure");
  segments.push("SameSite=Lax");
  return segments.join("; ");
}

export function clearCookie(name: string, options: { path?: string; secure?: boolean } = {}): string {
  const segments = [`${name}=`, `Path=${options.path ?? OAUTH_PATH}`, "Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT", "HttpOnly"];
  if (options.secure !== false) segments.push("Secure");
  segments.push("SameSite=Lax");
  return segments.join("; ");
}

/**
 * Cross-site request forgery check for the state-changing `POST /logout`.
 *
 * A browser-initiated cross-site POST always reveals itself in `Sec-Fetch-Site`
 * and/or `Origin`; a non-browser client (curl, tests) sends neither and is
 * allowed through only because it must already present the HttpOnly session
 * cookie to do anything at all.
 */
export function sameSiteRequestAllowed(request: Request): boolean {
  const site = (request.headers.get("Sec-Fetch-Site") ?? "").toLowerCase();
  if (site === "cross-site") return false;
  if (site === "same-origin" || site === "same-site" || site === "none") return true;
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}
