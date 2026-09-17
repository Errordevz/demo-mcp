/**
 * Roblox OAuth 2.0 protocol layer.
 *
 * Everything Roblox-specific and network-shaped lives here: URL construction,
 * the code exchange, refresh, revocation and `userinfo`. No storage, no HTTP
 * routing, no cookies — those are `store.ts` and `routes.ts`.
 *
 * Documented behaviour this implementation relies on (Roblox OAuth 2.0
 * reference, `create.roblox.com/docs/cloud/auth/oauth2-reference`):
 *
 *  - authorization codes live ~1 minute and are redeemable once;
 *  - access tokens are valid 15 minutes;
 *  - refresh tokens are valid 90 days and are **single use** (a refresh returns
 *    a new refresh token, which is why rotation is persisted atomically);
 *  - `POST v1/token` accepts `client_secret_post` or `client_secret_basic`;
 *  - PKCE (`S256`) is supported and recommended for confidential clients.
 *
 * The client secret is therefore only ever sent in a POST body to a pinned
 * `apis.roblox.com` URL — never in a query string, never to a browser, never in
 * a log line.
 *
 * No `nonce` is sent: DEMO never treats the ID token as proof of identity. It
 * calls `GET /oauth/v1/userinfo` with the access token instead, which is both
 * authoritative and free of JWT signature/JWKS verification to get wrong.
 */

import { ROBLOX_AUTHORIZE_ENDPOINT, ROBLOX_REVOKE_ENDPOINT, ROBLOX_TOKEN_ENDPOINT, ROBLOX_USERINFO_ENDPOINT } from "./config.js";
import { fromHttpResponse, robloxAuthError } from "./errors.js";
import type { RobloxOAuthConfig, RobloxTokenResponse } from "./types.js";

export type FetchLike = (input: string, init?: any) => Promise<Response>;

export const TOKEN_TIMEOUT_MS = 15_000;
export const READ_TIMEOUT_MS = 15_000;
export const MAX_RETRY_AFTER_MS = 5_000;

/** Valid values for the documented `prompt` parameter. */
const ALLOWED_PROMPTS = new Set(["login", "consent", "select_account", "consent login", "login consent"]);

export function normalizePrompt(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim().toLowerCase().replace(/[+]/g, " ").replace(/\s+/g, " ");
  if (!value) return null;
  if (!ALLOWED_PROMPTS.has(value)) {
    throw robloxAuthError("invalid_input", `Unsupported prompt value ${JSON.stringify(raw)}.`, {
      hint: "Roblox accepts login, consent, select_account, or `consent login`.",
    });
  }
  return value;
}

export interface AuthorizeUrlInput {
  config: RobloxOAuthConfig;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  prompt: string | null;
}

/**
 * Build the Roblox consent URL.
 *
 * Note what is *not* here: the client secret. Roblox documents it as a parameter
 * only for non-PKCE flows; with PKCE it is omitted from the authorization request
 * entirely, which is what keeps a secret out of a URL, a browser history entry and
 * the Referer header.
 */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(ROBLOX_AUTHORIZE_ENDPOINT);
  url.searchParams.set("client_id", input.config.clientId ?? "");
  url.searchParams.set("redirect_uri", input.config.redirectUri);
  url.searchParams.set("scope", input.config.scopes.join(" "));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", input.codeChallengeMethod);
  if (input.prompt) url.searchParams.set("prompt", input.prompt);
  return url.toString();
}

export interface CallbackParams {
  code: string | null;
  state: string | null;
  error: string | null;
  errorDescription: string | null;
}

/** Parse and sanity-check the redirect Roblox sends back. */
export function readCallbackParams(url: string): CallbackParams {
  const parsed = new URL(url);
  const code = parsed.searchParams.get("code");
  const state = parsed.searchParams.get("state");
  const error = parsed.searchParams.get("error");
  return {
    code: code && /^[A-Za-z0-9_-]{8,2048}$/.test(code) ? code : null,
    state: state && /^[A-Za-z0-9_-]{16,256}$/.test(state) ? state : null,
    error: error ? error.slice(0, 64) : null,
    errorDescription: parsed.searchParams.get("error_description")?.slice(0, 200) ?? null,
  };
}

/** Scopes actually granted, as reported by the token endpoint. */
export function grantedScopes(response: RobloxTokenResponse, requested: string[]): { scopes: string[]; source: "granted" | "requested" } {
  const raw = typeof response.scope === "string" ? response.scope.trim() : "";
  if (!raw) return { scopes: [...requested], source: "requested" };
  const scopes = raw
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  // Roblox reports API scopes here and sometimes omits the identity scopes, so
  // merge the requested identity scopes back in rather than pretending openid was
  // not granted; non-identity scopes stay exactly as granted.
  const identity = requested.filter((scope) => scope === "openid" || scope === "profile");
  const merged = [...new Set([...scopes, ...identity.filter((scope) => !scopes.includes(scope))])];
  return { scopes: merged, source: "granted" };
}

export interface NormalizedTokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  scopes: string[];
  scopesSource: "granted" | "requested";
  expiresAt: number;
  expiresIn: number;
}

function normalizeTokenResponse(body: RobloxTokenResponse, requested: string[]): NormalizedTokens {
  const accessToken = typeof body?.access_token === "string" ? body.access_token.trim() : "";
  if (!accessToken) {
    throw robloxAuthError("token_exchange_failed", "Roblox returned a token response without an access token.");
  }
  const expiresIn = Number.isFinite(Number(body.expires_in)) && Number(body.expires_in) > 0 ? Math.trunc(Number(body.expires_in)) : 900;
  const { scopes, source } = grantedScopes(body, requested);
  return {
    accessToken,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token.trim() ? body.refresh_token.trim() : null,
    idToken: typeof body.id_token === "string" && body.id_token.trim() ? body.id_token.trim() : null,
    scopes,
    scopesSource: source,
    expiresAt: Date.now() + expiresIn * 1000,
    expiresIn,
  };
}

async function postForm(endpoint: string, form: Record<string, string>, fetchImpl: FetchLike, context: "token" | "refresh" | "revoke"): Promise<Response> {
  const body = new URLSearchParams(form).toString();
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": "DEMO-MCP/0.8.2 (Cloudflare Workers)" },
      body,
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (error) {
    // Network/TLS/timeout: nothing was necessarily delivered, so the caller must
    // not assume the code or refresh token was consumed.
    throw robloxAuthError("network_error", `Could not reach ${new URL(endpoint).host}.`, {
      retryable: true,
      hint:
        context === "revoke"
          ? "DEMO cleared the local session anyway; Roblox may still hold the authorization until the refresh token expires (90 days). You can also revoke it from Roblox account settings."
          : "Roblox's OAuth service may be unavailable. Start /oauth/roblox/start again — the authorization code is single-use, so a retry needs a fresh code.",
      data: { cause: error instanceof Error ? error.name : "FetchFailure" },
    });
  }
  return response;
}

/**
 * Cut a provider message down to something safe to show a user and log.
 *
 * Roblox error text is not trusted input: it can contain an echoed code, verifier or
 * token. Anything long enough to be an opaque credential is masked, control characters
 * are dropped, and the result is capped.
 */
export function sanitizeProviderError(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[A-Za-z0-9_+/=-]{20,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/**
 * Read the provider's failure reason — never the raw body.
 *
 * Two shapes are seen in the wild from Roblox: the OAuth-style `{ error,
 * error_description }` documented for the token endpoint, and the standard web-API
 * envelope `{ errors: [{ code, message }] }` that the platform returns for everything
 * else (including a request that never reaches an OAuth handler). Both are handled so a
 * real misconfiguration says what is wrong instead of surfacing a bare status code.
 */
async function readOauthError(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    const parsed = JSON.parse(text) as { error?: unknown; error_description?: unknown; errors?: unknown };
    if (typeof parsed?.error === "string") return sanitizeProviderError(parsed.error);
    const first = Array.isArray(parsed?.errors) ? (parsed.errors as unknown[])[0] : undefined;
    if (first && typeof first === "object") {
      const entry = first as { code?: unknown; message?: unknown };
      const message = typeof entry.message === "string" ? sanitizeProviderError(entry.message) : "";
      if (message) return message;
      // A numeric Roblox error code with no text is still worth reporting verbatim:
      // it is stable, public and searchable in Roblox's status pages.
      if (typeof entry.code === "number") return `roblox_error_${entry.code}`;
      if (typeof entry.code === "string") return sanitizeProviderError(entry.code);
    }
    return null;
  } catch {
    return null;
  }
}

async function readJsonBody<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw robloxAuthError("api_error", "Roblox returned a non-JSON response from the token endpoint.", { status: 502 });
  }
}

export interface TokenExchangeInput {
  config: RobloxOAuthConfig;
  /** Passed in by the caller for this one request; never stored on the config, a
   * response body, an error, or a log line. */
  clientSecret: string;
  code: string;
  codeVerifier: string;
  fetchImpl?: FetchLike;
}

/**
 * Exchange the authorization code for tokens. Deliberately **not retried**:
 * codes are single-use, so a retry after a lost response would burn the code.
 */
export async function exchangeAuthorizationCode(input: TokenExchangeInput): Promise<NormalizedTokens> {
  const fetchImpl: FetchLike = input.fetchImpl ?? ((url, init) => fetch(url, init as never));
  const config = input.config;
  if (!config.clientId || !input.clientSecret) {
    throw robloxAuthError("not_configured", "ROBLOX_CLIENT_ID and ROBLOX_CLIENT_SECRET are required to exchange an authorization code.");
  }
  const response = await postForm(
    ROBLOX_TOKEN_ENDPOINT,
    {
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: config.redirectUri,
    },
    fetchImpl,
    "token",
  );
  if (!response.ok) {
    throw fromHttpResponse(response.status, await readOauthError(response), "token");
  }
  const body = await readJsonBody<RobloxTokenResponse>(response);
  const tokens = normalizeTokenResponse(body, config.scopes);
  // Roblox issues a refresh token for this grant. If one is ever missing the caller
  // still gets a working 15-minute session and `canRefresh: false`, so the status
  // surfaces the limitation instead of a silent expiry surprise.
  return tokens;
}

export interface RefreshInput {
  config: RobloxOAuthConfig;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: FetchLike;
}

/** Refresh. Also never retried: refresh tokens are single-use. */
export async function refreshAuthorizationTokens(input: RefreshInput): Promise<NormalizedTokens> {
  const fetchImpl: FetchLike = input.fetchImpl ?? ((url, init) => fetch(url, init as never));
  if (!input.config.clientId || !input.clientSecret) {
    throw robloxAuthError("not_configured", "Refreshing a Roblox authorization requires ROBLOX_CLIENT_ID and ROBLOX_CLIENT_SECRET.");
  }
  const response = await postForm(
    ROBLOX_TOKEN_ENDPOINT,
    { grant_type: "refresh_token", refresh_token: input.refreshToken, client_id: input.config.clientId, client_secret: input.clientSecret },
    fetchImpl,
    "refresh",
  );
  if (!response.ok) {
    throw fromHttpResponse(response.status, await readOauthError(response), "refresh");
  }
  const body = await readJsonBody<RobloxTokenResponse>(response);
  const tokens = normalizeTokenResponse(body, input.config.scopes);
  if (!tokens.refreshToken) {
    throw robloxAuthError(
      "reauthorization_required",
      "Roblox refreshed the access token but returned no replacement refresh token.",
      { hint: "Roblox refresh tokens are single-use, so DEMO cannot keep a usable session without the new one. Reconnect from /oauth/roblox/start." },
    );
  }
  return tokens;
}

export interface RevokeInput {
  config: RobloxOAuthConfig;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: FetchLike;
}

/**
 * Revoke the authorization session (documented endpoint: `POST v1/token/revoke`
 * with the *refresh* token). Returns false when Roblox could not be reached; the
 * caller always clears local state regardless.
 */
export async function revokeAuthorization(input: RevokeInput): Promise<{ attempted: boolean; revoked: boolean; oauthError?: string }> {
  const fetchImpl: FetchLike = input.fetchImpl ?? ((url, init) => fetch(url, init as never));
  if (!input.config.clientId || !input.clientSecret) {
    return { attempted: false, revoked: false };
  }
  try {
    const response = await postForm(
      ROBLOX_REVOKE_ENDPOINT,
      { token: input.refreshToken, client_id: input.config.clientId, client_secret: input.clientSecret },
      fetchImpl,
      "revoke",
    );
    if (response.ok) return { attempted: true, revoked: true };
    // 400 invalid_grant on an already-expired or rotated token is not worth
    // surfacing as a failure: the end state the user asked for is already true.
    return { attempted: true, revoked: false, oauthError: (await readOauthError(response)) ?? undefined };
  } catch {
    // Revocation is best-effort: the caller has already dropped the local session,
    // and failing the logout round-trip would strand the user in a broken state.
    return { attempted: true, revoked: false };
  }
}

export interface RobloxUserInfo {
  sub: string | null;
  name: string | null;
  nickname: string | null;
  preferred_username: string | null;
  created_at: number | null;
  profile: string | null;
  picture: string | null;
}

/**
 * `GET /oauth/v1/userinfo` — the only endpoint that proves which account the
 * tokens belong to. Public claims only; no e-mail, no birthday, no token material.
 */
export async function fetchUserInfo(accessToken: string, fetchImpl: FetchLike = (url, init) => fetch(url, init as never)): Promise<RobloxUserInfo> {
  if (!accessToken) throw robloxAuthError("unauthenticated", "No access token is available for this request.");
  let response: Response;
  try {
    response = await fetchImpl(ROBLOX_USERINFO_ENDPOINT, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (error) {
    throw robloxAuthError("network_error", "Could not reach the Roblox user information endpoint.", {
      retryable: true,
      data: { cause: error instanceof Error ? error.name : "FetchFailure" },
    });
  }
  if (!response.ok) {
    throw fromHttpResponse(response.status, null, "resource");
  }
  const body = await readJsonBody<Record<string, unknown>>(response);
  return {
    sub: typeof body.sub === "string" ? body.sub : null,
    name: typeof body.name === "string" ? body.name : null,
    nickname: typeof body.nickname === "string" ? body.nickname : null,
    preferred_username: typeof body.preferred_username === "string" ? body.preferred_username : null,
    created_at: Number.isFinite(Number(body.created_at)) && body.created_at != null ? Math.trunc(Number(body.created_at)) : null,
    profile: typeof body.profile === "string" ? body.profile : null,
    picture: typeof body.picture === "string" ? body.picture : null,
  };
}

/** Test seam: expose the shape used by the token endpoint so the URL is assertable. */
export const TOKEN_ENDPOINT = ROBLOX_TOKEN_ENDPOINT;
export const REVOKE_ENDPOINT = ROBLOX_REVOKE_ENDPOINT;
export const USERINFO_ENDPOINT = ROBLOX_USERINFO_ENDPOINT;
