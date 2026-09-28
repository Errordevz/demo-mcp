/**
 * Configuration resolution for the Roblox OAuth integration.
 *
 * Endpoints are pinned in code (never configurable), so a mistyped or hostile
 * environment variable cannot point the Worker — and with it the client secret —
 * at someone else's server. Values verified against the official reference:
 * https://create.roblox.com/docs/cloud/auth/oauth2-reference
 */

import { robloxAuthError } from "./errors.js";
import type { RobloxAuthEnv, RobloxOAuthConfig } from "./types.js";

/** OAuth base URL from the Roblox Open Cloud authentication reference. */
export const ROBLOX_OAUTH_BASE = "https://apis.roblox.com/oauth/v1";
/** Open Cloud API base used for account-scoped reads. */
export const ROBLOX_OPEN_CLOUD_BASE = "https://apis.roblox.com/cloud/v2";

export const ROBLOX_AUTHORIZE_ENDPOINT = `${ROBLOX_OAUTH_BASE}/authorize`;
export const ROBLOX_TOKEN_ENDPOINT = `${ROBLOX_OAUTH_BASE}/token`;
export const ROBLOX_INTROSPECT_ENDPOINT = `${ROBLOX_OAUTH_BASE}/token/introspect`;
export const ROBLOX_RESOURCES_ENDPOINT = `${ROBLOX_OAUTH_BASE}/token/resources`;
export const ROBLOX_REVOKE_ENDPOINT = `${ROBLOX_OAUTH_BASE}/token/revoke`;
export const ROBLOX_USERINFO_ENDPOINT = `${ROBLOX_OAUTH_BASE}/userinfo`;

export const OAUTH_PATHS = {
  link: "/oauth/roblox/link",
  start: "/oauth/roblox/start",
  callback: "/oauth/roblox/callback",
  logout: "/oauth/roblox/logout",
  status: "/oauth/roblox/status",
} as const;

/** Minimum scope set that satisfies the status/profile requirements. */
export const DEFAULT_SCOPES = ["openid", "profile"] as const;

/**
 * Scopes documented by Roblox for third-party apps (identity scopes from the
 * OIDC discovery document, plus the Open Cloud scopes DEMO can actually use).
 * Anything else is accepted (the dashboard is the source of truth) but reported
 * as unrecognized instead of being silently requested forever.
 */
export const KNOWN_SCOPES: Readonly<Record<string, string>> = {
  openid: "Returns the `sub` (Roblox user id) claim and an ID token.",
  profile: "Display name, username, profile URL and headshot from /oauth/v1/userinfo. Requires openid.",
  email: "Account e-mail (only for approved app categories).",
  verification: "Verified status.",
  credentials: "Credential status.",
  age: "Age bracket.",
  premium: "Premium status.",
  roles: "App roles for creator contexts.",
  "user.advanced:read": "Open Cloud `GET /cloud/v2/users/{id}` — advanced profile fields.",
  "user.social:read": "Open Cloud `GET /cloud/v2/users/{id}` — social profile fields.",
  "user.inventory-item:read": "Open Cloud `GET /cloud/v2/users/{id}/inventory-items` (BETA).",
  "asset:read": "Open Cloud Assets API read (published assets).",
  "asset:write": "Open Cloud Assets API write. DEMO never performs writes.",
};

/** Account actions with no official OAuth/Open Cloud endpoint (documented, not guessed). */
export const UNSUPPORTED_ACCOUNT_ACTIONS: ReadonlyArray<{ action: string; note: string }> = [
  {
    action: "list the authenticated user's experiences (My games / created universes)",
    note: "Roblox has no OAuth scope or Open Cloud endpoint that lists a user's own universes; the documented universes API is API-key/creator scoped and only covers universes the caller owns as a creator. This is a known gap requested on the Developer Forum (a `universe:read` scope for OAuth). DEMO will not scrape roblox.com to work around it.",
  },
  {
    action: "Robux balance, earnings, payout or transaction history",
    note: "No OAuth scope exposes account finances to a third-party app.",
  },
  {
    action: "friends / followers list, private messages, chat",
    note: "friends.roblox.com and privatemessages.roblox.com are website APIs that require the .ROBLOSECURITY session cookie, which this integration refuses to request or store.",
  },
  {
    action: "avatar configuration and outfit editing for the signed-in user",
    note: "avatar.roblox.com v4 is cookie-authenticated. Open Cloud exposes thumbnail generation only, which DEMO does support.",
  },
  {
    action: "inventory prices, resale data, or trading",
    note: "Only item ownership listing is exposed to OAuth (user.inventory-item:read). Catalog/trade endpoints are not OAuth-enabled.",
  },
  {
    action: "playing a game, joining a server, or any account write action",
    note: "Roblox OAuth does not permit third-party apps to act on an account. Nothing is attempted.",
  },
];

function numberFrom(value: string | number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), min), max) : fallback;
  const text = String(value).trim();
  // An unset variable arrives as "" (or "undefined"): that means "use the default",
  // never "clamp to the minimum" - the difference decides whether the OAuth state
  // window is 10 minutes or one minute.
  if (!text || text === "undefined" || text === "null") return fallback;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

export function normalizeScopes(raw: string | undefined | null): { scopes: string[]; unrecognized: string[] } {
  const requested = (raw ?? DEFAULT_SCOPES.join(" "))
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const scopes: string[] = [];
  const unrecognized: string[] = [];
  for (const scope of requested) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{1,63}$/.test(scope)) {
      throw robloxAuthError("not_configured", `ROBLOX_OAUTH_SCOPES contains an invalid scope name: ${JSON.stringify(scope)}.`);
    }
    const lower = scope.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    scopes.push(scope);
    if (!(scope in KNOWN_SCOPES)) unrecognized.push(scope);
  }
  if (scopes.length === 0) scopes.push(...DEFAULT_SCOPES);
  if (scopes.includes("profile") && !scopes.includes("openid")) {
    // Documented rule: profile requires openid. Fix the order rather than fail the flow.
    scopes.unshift("openid");
  }
  if (!scopes.includes("openid")) {
    throw robloxAuthError(
      "not_configured",
      "ROBLOX_OAUTH_SCOPES must include openid.",
      { hint: "openid is what makes the callback prove which Roblox account is connected (the `sub` claim). Use `openid profile`." },
    );
  }
  return { scopes, unrecognized };
}

function hostAllowed(host: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const bare = host.replace(/:(443|80)$/, "");
  return allowlist.some((entry) => {
    const allowed = entry.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "");
    if (!allowed) return false;
    if (allowed.startsWith("*.")) return bare === allowed.slice(2) || bare.endsWith(`.${allowed.slice(2)}`);
    return bare === allowed;
  });
}

export interface ResolveOptions {
  /** Overrides for tests; defaults come from the Worker env. */
  now?: number;
}

/**
 * Resolve and validate everything the flow needs for one request.
 *
 * The redirect URI is the exact string that must be registered on the Roblox
 * app, so it is derived from the *request* unless the operator pinned it, and the
 * request host is checked against `ROBLOX_ALLOWED_HOSTS` to stop a poisoned
 * `Host` header from minting a flow that sends the authorization code somewhere
 * else.
 */
export function resolveRobloxConfig(env: RobloxAuthEnv, requestUrl: string, options: ResolveOptions = {}): RobloxOAuthConfig {
  void options;
  const clientId = (env.ROBLOX_CLIENT_ID ?? "").trim();
  const clientSecret = (env.ROBLOX_CLIENT_SECRET ?? "").trim();
  const request = new URL(requestUrl);
  const requestOrigin = request.origin && request.origin !== "null" ? request.origin : `${request.protocol}//${request.host}`;
  const configuredOrigin = (env.MCP_PUBLIC_ORIGIN ?? "").trim();
  let canonicalOrigin: string | null = null;
  if (configuredOrigin) {
    try {
      const parsedOrigin = new URL(configuredOrigin);
      if ((parsedOrigin.protocol === "https:" || ((parsedOrigin.hostname === "localhost" || parsedOrigin.hostname === "127.0.0.1") && parsedOrigin.protocol === "http:")) && !parsedOrigin.username && !parsedOrigin.password && !parsedOrigin.search && !parsedOrigin.hash && (!parsedOrigin.pathname || parsedOrigin.pathname === "/")) {
        canonicalOrigin = parsedOrigin.origin;
      }
    } catch {
      canonicalOrigin = null;
    }
    if (!canonicalOrigin) throw robloxAuthError("not_configured", "MCP_PUBLIC_ORIGIN must be the canonical HTTPS origin for this Worker.", { status: 503 });
  }
  const origin = canonicalOrigin ?? requestOrigin;
  const derivedRedirectUri = `${origin}${OAUTH_PATHS.callback}`;
  const pinned = (env.ROBLOX_REDIRECT_URI ?? "").trim();
  const allowlist = (env.ROBLOX_ALLOWED_HOSTS ?? "").split(",").map((value) => value.trim()).filter(Boolean);

  let redirectUri = pinned || derivedRedirectUri;
  let staleRedirectOverride: string | null = null;
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw robloxAuthError("not_configured", "ROBLOX_REDIRECT_URI is not an absolute URL.");
  }
  const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(isLocalhost && parsed.protocol === "http:")) {
    throw robloxAuthError("not_configured", "The OAuth redirect URI must be HTTPS.", {
      hint: "Roblox only accepts plain HTTPS redirect URLs (plus localhost for debugging). Deploy on workers.dev or a custom domain with TLS.",
    });
  }
  if (canonicalOrigin && parsed.origin !== canonicalOrigin) {
    // A canonical origin is pinned, so the redirect URI derived from it is
    // authoritative and just as poisoning-proof: it never depends on the request
    // Host. A stale ROBLOX_REDIRECT_URI left over in the dashboard therefore must
    // not hard-block the flow (the live regression this fixes); it is ignored and
    // surfaced as a diagnostic instead of being honoured or silently accepted.
    staleRedirectOverride = "ignored-stale-redirect-override";
    redirectUri = derivedRedirectUri;
    parsed = new URL(redirectUri);
  }
  if (canonicalOrigin && requestOrigin !== canonicalOrigin) {
    throw robloxAuthError("host_not_allowed", "This request did not arrive on the pinned MCP_PUBLIC_ORIGIN.", { status: 403 });
  }
  if (!hostAllowed(parsed.hostname, allowlist)) {
    throw robloxAuthError("host_not_allowed", `The redirect host ${parsed.hostname} is not listed in ROBLOX_ALLOWED_HOSTS.`);
  }
  if (allowlist.length > 0 && !hostAllowed(request.host, allowlist)) {
    throw robloxAuthError("host_not_allowed", `This request arrived on ${request.host}, which is not listed in ROBLOX_ALLOWED_HOSTS.`, {
      hint: "Add your Worker hostname (for example demo-mcp.<your-subdomain>.workers.dev) to ROBLOX_ALLOWED_HOSTS.",
    });
  }
  if (!pinned && !isLocalhost && request.protocol !== "https:") {
    throw robloxAuthError("not_configured", "Cannot derive a secure redirect URI; set ROBLOX_REDIRECT_URI.", { status: 503 });
  }

  const { scopes, unrecognized } = normalizeScopes(env.ROBLOX_OAUTH_SCOPES);
  const hasClientSecret = clientSecret.length > 0;
  const enabled = clientId.length > 0 && hasClientSecret;
  // Effective storage keeps /health (robloxFlags) and /oauth/roblox/status (vault) consistent:
  // durable storage is only effective when the binding exists *and* encryption is available,
  // otherwise the vault degrades to isolate memory and reports "memory"/"none".
  const hasTokenKey = String(env.ROBLOX_TOKEN_KEY ?? "").trim().length > 0;
  const effectiveStorage: RobloxOAuthConfig["storageMode"] = env.ROBLOX_AUTH && hasTokenKey ? "durable-object" : "memory";
  const effectiveEncryption: RobloxOAuthConfig["encryption"] = hasTokenKey ? "aes-gcm-256" : "none";
  const effectiveReason = hasTokenKey
    ? null
    : env.ROBLOX_AUTH
      ? "ROBLOX_TOKEN_KEY is not configured, so Roblox token storage is unavailable. Protected account operations fail closed."
      : "The ROBLOX_AUTH Durable Object binding is not deployed, so protected account operations fail closed.";

  return {
    enabled,
    disabledReason: enabled
      ? null
      : !clientId
        ? "ROBLOX_CLIENT_ID is not configured on this Worker."
        : "ROBLOX_CLIENT_SECRET is not configured on this Worker (it must be a secret, not a plain variable).",
    clientId: clientId || null,
    hasClientSecret,
    scopes,
    unrecognizedScopes: unrecognized,
    redirectUri,
    staleRedirectOverride,
    stateTtlSeconds: numberFrom(env.OAUTH_STATE_TTL_SECONDS, 600, 60, 900),
    rateLimitPerMinute: numberFrom(env.ROBLOX_RATE_LIMIT_PER_MINUTE, 20, 1, 300),
    openCloudRatePerMinute: numberFrom(env.ROBLOX_OPEN_CLOUD_RATE_PER_MINUTE, 10, 1, 20),
    tokenSkewSeconds: numberFrom(env.ROBLOX_TOKEN_SKEW_SECONDS, 60, 0, 300),
    storageMode: effectiveStorage,
    // Filled in by the vault factory once the cipher is resolved; keep an effective
    // default here so callers that don't await createVault still see the consistent value.
    encryption: effectiveEncryption,
    encryptionReason: hasTokenKey ? null : effectiveReason,
  };
}

/** Roblox documents these limits per OAuth authorization; DEMO stays under them. */
export const OPEN_CLOUD_LIMITS = {
  inventoryItemsPerMinute: 20,
  getUserPerMinute: 10,
  maxPageSize: 100,
} as const;

export function configuredNumber(value: string | number | undefined, fallback: number, min: number, max: number): number {
  return numberFrom(value, fallback, min, max);
}
