/**
 * The honest Roblox capability report — the account-side twin of
 * `src/video/capabilities.ts`.
 *
 * Its whole purpose is to let the connected AI say what is possible *before* it
 * promises anything, and to record in code which Roblox account actions have no
 * official OAuth/Open Cloud endpoint at all. The "not supported" rows are as
 * important as the supported ones: they are what stops a model from trying to
 * reach `inventory.roblox.com` with a session cookie when the OAuth path runs out.
 *
 * Reports names and presence only — never a key, token or binding value.
 */

import { KNOWN_SCOPES, UNSUPPORTED_ACCOUNT_ACTIONS } from "./config.js";
import type { SupportEntry } from "./types.js";

export const ROBLOX_CAPABILITIES_URI = "demo://capabilities/roblox";

export const ROBLOX_SCHEMA = "demo.roblox-capabilities/1";

/** Rows describing what DEMO can do with the *authorized user's* token. */
export const ACCOUNT_SUPPORT_MATRIX: SupportEntry[] = [
  {
    action: "identify the connected account (user id)",
    status: "supported",
    endpoint: "GET https://apis.roblox.com/oauth/v1/userinfo",
    scope: "openid",
    rateLimit: null,
    note: "`sub` is the stable identifier; usernames and display names can change, so DEMO keys nothing off them.",
  },
  {
    action: "read profile basics (display name, username, profile URL, headshot, account creation date)",
    status: "scope_required",
    endpoint: "GET https://apis.roblox.com/oauth/v1/userinfo",
    scope: "profile",
    rateLimit: null,
    note: "Requires the `profile` identity scope (which itself requires `openid`) to be ticked on the Roblox app.",
  },
  {
    action: "read extended account information (about text, verification-dependent fields)",
    status: "scope_required",
    endpoint: "GET https://apis.roblox.com/cloud/v2/users/{user_id}",
    scope: "user.advanced:read or user.social:read",
    rateLimit: "10 requests/minute per OAuth authorization",
    note: "Open Cloud `Get User`. Only the connected user's own id is used as `user_id`.",
  },
  {
    action: "list the connected user's inventory items, or verify ownership of given asset/badge/pass ids",
    status: "scope_required",
    endpoint: "GET https://apis.roblox.com/cloud/v2/users/{user_id}/inventory-items",
    scope: "user.inventory-item:read",
    rateLimit: "20 requests/minute per OAuth authorization",
    note: "BETA endpoint. Results also depend on the user's Settings → Privacy → “Who can see my inventory?” setting.",
  },
  {
    action: "generate the connected user's avatar thumbnail",
    status: "supported",
    endpoint: "GET https://apis.roblox.com/cloud/v2/users/{user_id}:generateThumbnail",
    scope: "openid",
    rateLimit: "10 requests/minute per OAuth authorization",
    note: "Long-running operation: DEMO polls the returned operation until it is done, bounded by a timeout.",
  },
  {
    action: "check whether the authorization is still valid",
    status: "supported",
    endpoint: "POST https://apis.roblox.com/oauth/v1/token/introspect",
    scope: null,
    rateLimit: null,
    note: "Documented caveat: introspection reports an access token as active until its 15-minute lifetime ends even after the user revokes, so DEMO treats `active: false` as final and a live `true` as advisory.",
  },
  {
    action: "revoke this app's authorization on logout",
    status: "supported",
    endpoint: "POST https://apis.roblox.com/oauth/v1/token/revoke",
    scope: null,
    rateLimit: null,
    note: "Uses the refresh token, per the documented revocation endpoint. Best effort: local state is cleared even if Roblox cannot be reached.",
  },
  ...UNSUPPORTED_ACCOUNT_ACTIONS.map((entry) => ({
    action: entry.action,
    status: "not_supported" as const,
    endpoint: null,
    scope: null,
    rateLimit: null,
    note: entry.note,
  })),
];

export interface RobloxCapabilityReport {
  schema: typeof ROBLOX_SCHEMA;
  generatedAt: string;
  configured: boolean;
  disabledReason: string | null;
  /** Which side of the boundary each surface lives on. */
  separation: {
    publicTools: { names: string[]; authenticated: false; note: string };
    accountTools: { names: string[]; authenticated: true; note: string };
  };
  endpoints: Record<string, string>;
  requestedScopes: string[];
  scopeGuidance: Record<string, string>;
  unrecognizedScopes: string[];
  storage: {
    mode: "durable-object" | "memory";
    /** Named `encryption`, not `tokenEncryption`: safe fields must not collide
     * with the redaction layer's sensitive-key list, or they get masked for nothing. */
    encryption: "aes-gcm-256" | "none";
    note: string | null;
    stateTtlSeconds: number;
    sessionTtlSeconds: number;
  };
  flow: {
    grantType: "authorization_code";
    pkce: "S256";
    stateValidation: string;
    secretsInUrls: false;
    passwordOrCookieFlow: false;
    accessTokenLifetimeSeconds: number;
    refreshTokenLifetimeDays: number;
  };
  limits: { oauthRoutesPerMinute: number; openCloudCallsPerMinute: number; maxInventoryPageSize: number };
  support: SupportEntry[];
  /** Explicitly not implemented, with the reason, so nothing is guessed at later. */
  refusals: string[];
}

export interface BuildReportInput {
  config: {
    enabled: boolean;
    disabledReason: string | null;
    scopes: string[];
    unrecognizedScopes: string[];
    redirectUri: string;
    stateTtlSeconds: number;
    sessionTtlSeconds: number;
    rateLimitPerMinute: number;
    openCloudRatePerMinute: number;
    storageMode: "durable-object" | "memory";
    encryption: "aes-gcm-256" | "none";
    encryptionReason: string | null;
  };
  account?: {
    connected: boolean;
    grantedScopes: string[];
  } | null;
}

export function describeRobloxCapabilities(input: BuildReportInput): RobloxCapabilityReport {
  const granted = new Set(input.account?.grantedScopes ?? []);
  const support = ACCOUNT_SUPPORT_MATRIX.map((entry) => {
    if (entry.status !== "scope_required") return entry;
    const needed = (entry.scope ?? "").split(/\s+or\s+/).map((scope) => scope.trim()).filter(Boolean);
    if (!input.account?.connected) return { ...entry, status: "scope_required" as const };
    const satisfied = needed.length === 0 || needed.some((scope) => granted.has(scope));
    return satisfied ? { ...entry, status: "supported" as const } : entry;
  });

  const scopeGuidance: Record<string, string> = {};
  for (const scope of input.config.scopes) {
    scopeGuidance[scope] = KNOWN_SCOPES[scope] ?? "Not documented in DEMO's allowlist; ticked on the Roblox app, so it is passed through and reported.";
  }

  return {
    schema: ROBLOX_SCHEMA,
    generatedAt: new Date().toISOString(),
    configured: input.config.enabled,
    disabledReason: input.config.disabledReason,
    separation: {
      publicTools: {
        names: ["roblox_user", "roblox_game", "roblox_oauth_status", "roblox_oauth_capabilities"],
        authenticated: false,
        note: "Public Roblox lookups send no credentials of any kind and never touch a stored token. `roblox_user` is a username lookup against Roblox's public users API.",
      },
      accountTools: {
        names: ["roblox_account_status", "roblox_account_profile", "roblox_account_inventory", "roblox_account_thumbnail", "roblox_account_unlink"],
        authenticated: true,
        note: "Account tools resolve a server-side token for one named account slot and return public claims only. They require DEMO_API_KEY to be set on the Worker so the /mcp surface cannot be read by a stranger.",
      },
    },
    endpoints: {
      authorize: "https://apis.roblox.com/oauth/v1/authorize",
      token: "https://apis.roblox.com/oauth/v1/token",
      introspect: "https://apis.roblox.com/oauth/v1/token/introspect",
      resources: "https://apis.roblox.com/oauth/v1/token/resources",
      revoke: "https://apis.roblox.com/oauth/v1/token/revoke",
      userinfo: "https://apis.roblox.com/oauth/v1/userinfo",
      openCloud: "https://apis.roblox.com/cloud/v2",
      redirectUri: input.config.redirectUri,
    },
    requestedScopes: input.config.scopes,
    scopeGuidance,
    unrecognizedScopes: input.config.unrecognizedScopes,
    storage: {
      mode: input.config.storageMode,
      encryption: input.config.encryption,
      note: input.config.encryptionReason,
      stateTtlSeconds: input.config.stateTtlSeconds,
      sessionTtlSeconds: input.config.sessionTtlSeconds,
    },
    flow: {
      grantType: "authorization_code",
      pkce: "S256",
      stateValidation: "cryptographic state, hashed at rest, single-use, expiring, browser-bound via HttpOnly cookie",
      secretsInUrls: false,
      passwordOrCookieFlow: false,
      accessTokenLifetimeSeconds: 900,
      refreshTokenLifetimeDays: 90,
    },
    limits: {
      oauthRoutesPerMinute: input.config.rateLimitPerMinute,
      openCloudCallsPerMinute: input.config.openCloudRatePerMinute,
      maxInventoryPageSize: 100,
    },
    support,
    refusals: [
      "No password field and no .ROBLOSECURITY handling exists anywhere in this integration.",
      "No CAPTCHA solving, no bot-protection bypass, no scraping of roblox.com pages for account data.",
      "No token, cookie or secret is ever returned by an MCP tool, written to a log, or embedded in the served HTML.",
      "Account actions with no official OAuth endpoint return not_supported instead of an unofficial workaround.",
    ],
  };
}

/** Flat status flags for `demo_ping` / `/health`, so every surface agrees. */
export function robloxStatusFlags(config: BuildReportInput["config"], account: { connected: boolean; reauthorizationRequired?: boolean } | null) {
  return {
    robloxOAuthConfigured: config.enabled,
    robloxOAuthReason: config.disabledReason,
    robloxBrowserConnected: Boolean(account?.connected),
    robloxReauthorizationRequired: Boolean(account?.reauthorizationRequired),
    robloxTokenStorage: config.storageMode,
    robloxTokenEncryption: config.encryption,
  };
}
