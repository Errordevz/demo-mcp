/**
 * Shared types for the Roblox OAuth 2.0 integration.
 *
 * Everything that touches a Roblox token lives here, and the shapes are
 * deliberately split in two:
 *
 *  - `AccountRecord` — the *safe* part of an account (public profile metadata,
 *    granted scopes, bookkeeping). It may be read from status endpoints.
 *  - `TokenSecrets` — access/refresh/ID material. It is only ever held
 *    encrypted at rest and only ever decrypted inside the Worker. It must never
 *    appear in a response body, an MCP tool result, an error message or a log.
 */

/** Minimal KV-ish surface the vault is built on (Durable Object storage compatible). */
export interface KvLike {
  get<T = unknown>(key: string): Promise<T | null | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean | void>;
  /** Optional; used by the expiry sweep. Durable Object storage supports `list`. */
  list?(options: { prefix: string; limit?: number }): Promise<Array<{ key: string; value: unknown }>>;
}

export interface RobloxAuthEnv {
  ROBLOX_CLIENT_ID?: string;
  ROBLOX_CLIENT_SECRET?: string;
  /** Secret used to AES-GCM encrypt tokens at rest. Absent = memory-only mode. */
  ROBLOX_TOKEN_KEY?: string;
  /** Exact value registered on the Roblox app. Defaults to the request origin + /oauth/roblox/callback. */
  ROBLOX_REDIRECT_URI?: string;
  /** Comma-separated hosts allowed to mint/complete a flow (anti host-header poisoning). */
  ROBLOX_ALLOWED_HOSTS?: string;
  /** Space- or comma-separated scope list. Defaults to the minimum: `openid profile`. */
  ROBLOX_OAUTH_SCOPES?: string;
  OAUTH_STATE_TTL_SECONDS?: string | number;
  ROBLOX_RATE_LIMIT_PER_MINUTE?: string | number;
  ROBLOX_OPEN_CLOUD_RATE_PER_MINUTE?: string | number;
  ROBLOX_TOKEN_SKEW_SECONDS?: string | number;
  /** Durable Object namespace (`RobloxAuth`). Required for durable, encrypted Roblox grants and OAuth state. */
  ROBLOX_AUTH?: unknown;
  /** DEMO -> Roblox identity-link codes and ChatGPT OAuth grants. */
  MCP_AUTH?: unknown;
  MCP_PUBLIC_ORIGIN?: string;
  MCP_AUTH_ACCESS_TEAM_DOMAIN?: string;
  MCP_AUTH_ACCESS_AUD?: string;
  MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS?: string | number;
  MCP_AUTH_RATE_LIMIT_PER_MINUTE?: string | number;
}

/** Resolved, validated configuration for one request. */
export interface RobloxOAuthConfig {
  enabled: boolean;
  /** Why the integration is unavailable when `enabled` is false. */
  disabledReason: string | null;
  clientId: string | null;
  hasClientSecret: boolean;
  scopes: string[];
  /** Scopes whose syntax is fine but which Roblox does not document (surfaced, never sent blindly). */
  unrecognizedScopes: string[];
  redirectUri: string;
  stateTtlSeconds: number;
  rateLimitPerMinute: number;
  openCloudRatePerMinute: number;
  tokenSkewSeconds: number;
  storageMode: "durable-object" | "memory";
  encryption: "aes-gcm-256" | "none";
  encryptionReason: string | null;
}

/** A live authorization request: minted at /start, consumed exactly once at /callback. */
export interface PendingAuthorization {
  version: 1;
  /** SHA-256 of the state value. The state itself is never persisted. */
  stateHash: string;
  /** SHA-256 of the browser binding cookie, so a state cannot be redeemed by another browser. */
  bindingHash: string;
  accountKey: string;
  /** Verified principal hash that requested this Roblox link; always set for new flows. */
  principalHash?: string;
  redirectUri: string;
  scopes: string[];
  /** Encrypted PKCE code verifier (never persisted in the clear). */
  codeVerifierSealed: string | null;
  /** Plaintext verifier only in memory-only mode; null whenever it is sealed. */
  codeVerifier: string | null;
  createdAt: number;
  expiresAt: number;
  /** Origin that minted the flow; the callback must come from the same one. */
  host: string;
}

/** Raw token material as returned by `POST /oauth/v1/token`. */
export interface RobloxTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

/** Encrypted-at-rest envelope stored alongside the safe account record. */
export interface TokenSecrets {
  version: 1;
  /** Cipher key id, so a rotated `ROBLOX_TOKEN_KEY` is detected instead of silently failing. */
  kid: string;
  algorithm: "AES-GCM";
  /** base64url(iv).base64url(ciphertext); null only in memory-only mode. */
  sealed: string | null;
  /** Plaintext material, present only in memory-only mode. */
  plain?: {
    accessToken: string;
    refreshToken: string | null;
    idToken: string | null;
    scopes: string[];
    expiresAt: number;
  };
}

/** Safe, non-secret account state. Mirrors what `/oauth/roblox/status` returns. */
export interface AccountRecord {
  version: 1;
  /** Server-derived hash of the Cloudflare Access subject this Roblox grant belongs to. */
  principalHash: string;
  accountKey: string;
  connectedAt: number;
  updatedAt: number;
  /** Roblox user id (`sub`). Public identifier, safe to return. */
  userId: string | null;
  displayName: string | null;
  username: string | null;
  profileUrl: string | null;
  headshotUrl: string | null;
  accountCreatedAt: number | null;
  scopes: string[];
  /** Whether `scopes` came from Roblox's token response or from what we requested. */
  scopesSource: "granted" | "requested";
  /** Epoch ms when the cached access token expires. */
  expiresAt: number;
  hasRefreshToken: boolean;
  /** Set when Roblox rejected the refresh token: the user must re-consent. */
  reauthorizationRequired: boolean;
  reauthorizationReason: string | null;
  lastRefreshAt: number | null;
  lastApiCallAt: number | null;
  /** Client id the record was minted for; a changed client id invalidates it. */
  clientIdHash: string;
  token: TokenSecrets | null;
}

/** Legacy browser-session pointer; new Roblox linking is identity-bound and does not issue these. */
export interface SessionRecord {
  version: 1;
  accountKey: string;
  createdAt: number;
  expiresAt: number;
}

export interface RateLimitOutcome {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

/** Result of consuming a pending authorization at the callback. */
export type StateOutcome =
  | { status: "ok"; pending: PendingAuthorization }
  | { status: "unknown" }
  | { status: "replayed" }
  | { status: "expired"; expiresAt: number }
  | { status: "binding_mismatch" };

/** What `GET /oauth/roblox/status` reports. No token material, ever. */
export interface AccountStatusPayload {
  connected: boolean;
  account?: {
    userId: string | null;
    displayName: string | null;
    username: string | null;
    profileUrl: string | null;
    headshotUrl: string | null;
    grantedScopes: string[];
    connectedAt: string;
    updatedAt: string;
    accessTokenExpiresAt: string;
    canRefresh: boolean;
    reauthorizationRequired: boolean;
    reauthorizationReason: string | null;
  };
  configuration: {
    enabled: boolean;
    disabledReason: string | null;
    clientIdConfigured: boolean;
    clientSecretConfigured: boolean;
    redirectUri: string;
    requestedScopes: string[];
    storage: "durable-object" | "memory";
    tokenEncryption: "aes-gcm-256" | "none";
    tokenEncryptionReason: string | null;
    pkce: "S256";
  };
  endpoints: { start: string; callback: string; logout: string };
  /** Seconds until the cached access token needs refreshing. */
  tokenExpiresIn?: number;
  /** Human-readable connection state. */
  message?: string;
  security: {
    passwordOrCookieRequested: false;
    tokensExposedToClient: false;
    stateValidation: "single-use, expiring, browser-bound" | "single-use, expiring, browser-bound; link code bound to verified Access subject";
    cookieFlags: string;
  };
}

/** One row of the honest support matrix used by tools and the setup guide. */
export interface SupportEntry {
  action: string;
  status: "supported" | "scope_required" | "not_supported";
  /** Official endpoint, when one exists. */
  endpoint: string | null;
  /** OAuth scope the action needs, when applicable. */
  scope: string | null;
  /** Roblox-side rate limit for OAuth authorizations, when documented. */
  rateLimit: string | null;
  note: string;
}
