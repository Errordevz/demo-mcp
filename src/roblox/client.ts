/**
 * `RobloxAccountClient` — the only thing allowed to hold a Roblox access token.
 *
 * Responsibilities:
 *
 *  - resolve the encrypted token material for one verified DEMO identity;
 *  - refresh it before it expires (Roblox access tokens live 15 minutes) and
 *    persist the rotated refresh token atomically, because theirs are single use;
 *  - serialize concurrent refreshes with a lease so a race cannot burn a token;
 *  - map 401/403/429/5xx onto stable codes, retrying only idempotent reads, once;
 *  - keep DEMO under Roblox's published per-authorization rate limits instead of
 *    discovering them;
 *  - hand back API payloads after a redaction pass.
 *
 * The access token never leaves this module: callers get data, not
 * `Authorization` headers.
 */

import { OPEN_CLOUD_LIMITS, ROBLOX_OPEN_CLOUD_BASE } from "./config.js";
import { MAX_RETRY_AFTER_MS, fetchUserInfo, refreshAuthorizationTokens, revokeAuthorization, type FetchLike, type RobloxUserInfo } from "./oauth.js";
import { asRobloxAuthError, fromHttpResponse, robloxAuthError } from "./errors.js";
import { AccountVault, type VaultMode } from "./store.js";
import { redactValue, safeLog } from "../core/redact.js";
import type { AccountRecord, RobloxAuthEnv, RobloxOAuthConfig } from "./types.js";

export interface AccountClientDeps {
  env: RobloxAuthEnv;
  config: RobloxOAuthConfig;
  vault: AccountVault;
  fetchImpl?: FetchLike;
  /** Injectable clock, used by tests to move past a token expiry. */
  now?: () => number;
}

export interface ResolvedSession {
  record: AccountRecord;
  accessToken: string;
  grantedScopes: string[];
  /** True when this call refreshed the token. */
  refreshed: boolean;
}

export interface ApiCallOptions {
  /** Path under `https://apis.roblox.com/cloud/v2`, e.g. `/users/123`. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  method?: "GET";
  /** All of these must be granted, or the call is refused before it is made. */
  requiredScopes?: string[];
  /** Any one of these satisfies the call (Open Cloud documents OR-groups). */
  anyOfScopes?: string[];
  timeoutMs?: number;
  /** Refuse to wait longer than this for a 429/5xx retry window. */
  maxRetryAfterMs?: number;
}

export interface DisconnectResult {
  disconnected: boolean;
  revocationAttempted: boolean;
  revoked: boolean;
}

const REFRESH_LEASE_MS = 30_000;

export class RobloxAccountClient {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(private readonly deps: AccountClientDeps) {
    this.fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init as never));
    this.now = deps.now ?? (() => Date.now());
  }

  private requireConfigured(): void {
    const { config } = this.deps;
    if (!config.enabled || !config.clientId) {
      throw robloxAuthError("not_configured", config.disabledReason ?? "Roblox OAuth is not configured on this Worker.", {
        hint: "Set ROBLOX_CLIENT_ID and the ROBLOX_CLIENT_SECRET secret. Then call roblox_account_link_start and submit its one-time code at /oauth/roblox/link.",
        status: 503,
      });
    }
  }

  /** Safe account snapshot for status surfaces. Token material is never read here. */
  async inspect(accountKey: string): Promise<{ record: AccountRecord; usable: boolean; expired: boolean } | null> {
    const record = await this.deps.vault.getAccount(accountKey);
    if (!record) return null;
    const tokens = await this.deps.vault.openTokens(record.token);
    const expired = !tokens || this.now() >= tokens.expiresAt;
    const usable = Boolean(tokens?.accessToken) && !(record.reauthorizationRequired || expired);
    return { record, usable, expired };
  }

  /** Load the record plus usable access token, refreshing when close to expiry. */
  async authorize(accountKey: string, options: { forceRefresh?: boolean } = {}): Promise<ResolvedSession> {
    this.requireConfigured();
    const { vault, config } = this.deps;
    const record = await vault.getAccount(accountKey);
    if (!record) {
      throw robloxAuthError("unauthenticated", "No Roblox account is linked to this verified DEMO identity.", {
        hint: "Call roblox_account_link_start, then paste its one-time code into /oauth/roblox/link in a browser signed in with this same Access identity.",
        status: 401,
      });
    }
    if (record.reauthorizationRequired) {
      throw robloxAuthError("reauthorization_required", record.reauthorizationReason ?? "This Roblox authorization needs to be granted again.", {
        hint: "Call roblox_account_link_start and submit its one-time code at /oauth/roblox/link to approve a fresh Roblox authorization.",
        status: 401,
      });
    }
    const loaded = await vault.openTokens(record.token);
    let stored = loaded;
    if (!stored?.accessToken) {
      throw robloxAuthError("reauthorization_required", "The stored Roblox token could not be read.", {
        hint:
          vault.mode === "memory"
            ? "Protected Roblox operations require the ROBLOX_AUTH Durable Object and ROBLOX_TOKEN_KEY; configure both before reconnecting."
            : "ROBLOX_TOKEN_KEY may have been rotated. Configure the original key or start a fresh link from ChatGPT.",
        status: 401,
      });
    }

    let recordNow = record;
    const needsRefresh = options.forceRefresh || this.now() >= stored.expiresAt - config.tokenSkewSeconds * 1000;
    let refreshed = false;
    if (needsRefresh) {
      if (!stored.refreshToken) {
        if (options.forceRefresh || this.now() >= stored.expiresAt) {
          throw robloxAuthError("reauthorization_required", "The Roblox access token expired and no refresh token is stored.", {
            hint: "Call roblox_account_link_start and submit its one-time code at /oauth/roblox/link to reconnect this Access identity.",
            status: 401,
          });
        }
      } else {
        stored = await this.refreshAndPersist(accountKey, recordNow, stored.refreshToken);
        refreshed = true;
        // Re-read: the record now carries the rotated token envelope. Returning the
        // pre-refresh copy here is how a later write would silently roll the
        // rotation back and burn the new single-use refresh token.
        recordNow = (await vault.getAccount(accountKey)) ?? recordNow;
      }
    }

    return { record: recordNow, accessToken: stored.accessToken, grantedScopes: recordNow.scopes ?? [], refreshed };
  }

  /**
   * Refresh once, under a lease, and persist the rotated pair before returning.
   *
   * If another isolate holds the lease this call waits briefly and then reads the
   * token that isolate wrote, instead of issuing a second refresh that would
   * invalidate the first.
   */
  private async refreshAndPersist(accountKey: string, record: AccountRecord, refreshToken: string) {
    const { vault, config, env } = this.deps;
    const owner = `${this.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const clientSecret = (env.ROBLOX_CLIENT_SECRET ?? "").trim();
    const lease = await vault.acquireLease(accountKey, owner, REFRESH_LEASE_MS);
    if (!lease.acquired) {
      await delay(Math.min(lease.retryAfterMs || 400, 3_000));
      const reread = await vault.getAccount(accountKey);
      const tokens = reread ? await vault.openTokens(reread.token) : null;
      if (tokens && this.now() < tokens.expiresAt - config.tokenSkewSeconds * 1000) return tokens;
      throw robloxAuthError("rate_limited", "Another refresh is already in flight for this Roblox account.", {
        retryable: true,
        hint: "Retry in a couple of seconds.",
        data: { retryAfterSeconds: 3 },
      });
    }
    try {
      const tokens = await refreshAuthorizationTokens({ config, clientSecret, refreshToken, fetchImpl: this.fetchImpl });
      const sealed = await vault.sealTokens({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        idToken: tokens.idToken,
        scopes: tokens.scopes,
        expiresAt: tokens.expiresAt,
      });
      await vault.putAccount({
        ...record,
        scopes: tokens.scopes,
        scopesSource: tokens.scopesSource,
        token: sealed,
        expiresAt: tokens.expiresAt,
        hasRefreshToken: Boolean(tokens.refreshToken),
        lastRefreshAt: this.now(),
        reauthorizationRequired: false,
        reauthorizationReason: null,
      });
      // Deliberately no token material in the log line: identity + timing only.
      safeLog("log", `token-refreshed:${accountKey}`, { expiresAt: new Date(tokens.expiresAt).toISOString(), rotated: true }, "roblox");
      return { ...tokens, scopes: tokens.scopes };
    } catch (error) {
      const authError = asRobloxAuthError(error);
      if (authError.code === "reauthorization_required") {
        // Keep the safe profile metadata, drop the credential material, and say why.
        await vault
          .putAccount({ ...record, token: null, hasRefreshToken: false, reauthorizationRequired: true, reauthorizationReason: authError.message })
          .catch(() => undefined);
      }
      throw authError;
    } finally {
      await vault.releaseLease(accountKey, owner).catch(() => undefined);
    }
  }

  /** Scope gate that runs before any network call, so a missing scope never becomes a 403. */
  private assertScopes(record: AccountRecord, options: ApiCallOptions): void {
    const required = [...(options.requiredScopes ?? [])];
    const anyOf = options.anyOfScopes ?? [];
    if (required.length === 0 && anyOf.length === 0) return;
    const granted = new Set(record.scopes ?? []);
    if (required.some((scope) => !granted.has(scope))) {
      throw robloxAuthError("insufficient_scope", `This account action needs the Roblox scope ${required.join(", ")}, which this authorization does not have.`, {
        hint: `Add the scope to the Roblox app and deployment, then call roblox_account_link_start and submit its fresh code at /oauth/roblox/link to consent and reconnect. Requested scopes on this deployment: ${record.scopes.join(", ")}.`,
        data: { required, granted: record.scopes, scopesSource: record.scopesSource },
        status: 403,
      });
    }
    if (anyOf.length > 0 && !anyOf.some((scope) => granted.has(scope))) {
      throw robloxAuthError("insufficient_scope", `This account action needs one of: ${anyOf.join(", ")}.`, {
        hint: "Grant one of the required scopes to the Roblox app, then create a fresh link code in ChatGPT and consent to it on Roblox.",
        data: { anyOf, granted: record.scopes },
        status: 403,
      });
    }
  }

  /**
   * Authenticated Open Cloud GET. One retry for 429/5xx/network on a single call,
   * with a bounded wait; a second 401 after a forced refresh is reported as is.
   */
  async call<T>(accountKey: string, options: ApiCallOptions): Promise<{ data: T; status: number }> {
    this.requireConfigured();
    let session = await this.authorize(accountKey);
    this.assertScopes(session.record, options);
    await this.chargeOpenCloud(accountKey);

    const url = buildOpenCloudUrl(options.path, options.query);
    const attempt = async (accessToken: string) => this.rawGet(url, accessToken, options.timeoutMs ?? 15_000);

    let response = await attempt(session.accessToken);
    if (response.status === 401 && !session.refreshed) {
      // Expired early (clock skew or a revocation): refresh once and retry once.
      session = await this.authorize(accountKey, { forceRefresh: true });
      this.assertScopes(session.record, options);
      response = await attempt(session.accessToken);
    }
    if (response.status === 429 || response.status >= 500) {
      const retryAfterMs = Math.min(parseRetryAfterMs(response.headers.get("retry-after")), options.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS);
      if (retryAfterMs > 0 && retryAfterMs <= (options.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS)) {
        await delay(retryAfterMs);
        response = await attempt(session.accessToken);
      } else {
        throw fromHttpResponse(response.status, null, "resource");
      }
    }
    if (!response.ok) {
      throw fromHttpResponse(response.status, await readOauthErrorCode(response), "resource");
    }
    const payload = await safeJson(response);
    await this.touchLastCall(accountKey);
    return { data: redactValue(payload) as T, status: response.status };
  }

  private async touchLastCall(accountKey: string): Promise<void> {
    const record = await this.deps.vault.getAccount(accountKey);
    if (!record) return;
    await this.deps.vault.putAccount({ ...record, lastApiCallAt: this.now() }).catch(() => undefined);
  }

  /** Self-imposed budget that keeps DEMO below Roblox's published limits. */
  private async chargeOpenCloud(accountKey: string): Promise<void> {
    const outcome = await this.deps.vault.charge("opencloud", accountKey, this.deps.config.openCloudRatePerMinute);
    if (outcome.allowed) return;
    throw robloxAuthError("rate_limited", `DEMO's Roblox Open Cloud budget is used up (${outcome.limit} per minute per account).`, {
      retryable: true,
      hint: `Roblox publishes 10/minute for \`GET /cloud/v2/users/{id}\` and 20/minute for inventory reads per OAuth authorization. DEMO self-limits to ${outcome.limit}/minute so it never gets the authorization throttled.`,
      data: { retryAfterSeconds: outcome.retryAfterSeconds },
    });
  }

  private async rawGet(url: string, accessToken: string, timeoutMs: number): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw robloxAuthError("network_error", "The request to the Roblox Open Cloud API did not complete.", {
        retryable: true,
        hint: "Roblox may be degraded, or the Worker could not open a socket. Retry shortly.",
        data: { cause: error instanceof Error ? error.name : "FetchFailure" },
        status: 502,
      });
    }
  }

  /**
   * Read `userinfo` with a token the caller already holds. Used once, at the end of
   * the callback, to prove which account the code belongs to; afterwards the token
   * lives only in the vault and callers go through `profile()`.
   */
  async fetchProfileWithToken(accessToken: string): Promise<RobloxUserInfo> {
    return fetchUserInfo(accessToken, this.fetchImpl);
  }

  /** `openid`/`profile` claims for the connected account, refreshed if needed. */
  async profile(accountKey: string): Promise<{ profile: RobloxUserInfo; record: AccountRecord }> {
    const session = await this.authorize(accountKey);
    let userInfo: RobloxUserInfo;
    try {
      userInfo = await fetchUserInfo(session.accessToken, this.fetchImpl);
    } catch (error) {
      const authError = asRobloxAuthError(error);
      if (authError.code === "insufficient_scope" || authError.code === "api_error") {
        throw authError;
      }
      throw authError;
    }
    if (!userInfo.sub) {
      throw robloxAuthError("insufficient_scope", "Roblox returned a userinfo response without a user id.", {
        hint: "The `openid` scope must be granted on the app and ticked in the consent screen.",
        status: 403,
      });
    }
    const record = await this.syncProfile(accountKey, session.record, userInfo);
    return { profile: userInfo, record };
  }

  /** Persist the public claims so status stays useful when a token later expires. */
  private async syncProfile(accountKey: string, fallback: AccountRecord, userInfo: RobloxUserInfo): Promise<AccountRecord> {
    // Always patch the *current* record: an intervening refresh may have rotated
    // the token envelope, and overwriting it would strand the account on a
    // consumed refresh token.
    const record = (await this.deps.vault.getAccount(accountKey)) ?? fallback;
    const next: AccountRecord = {
      ...record,
      userId: userInfo.sub ?? record.userId,
      displayName: userInfo.name ?? record.displayName,
      username: userInfo.preferred_username ?? record.username,
      profileUrl: safeHttpUrl(userInfo.profile) ?? record.profileUrl,
      headshotUrl: safeHttpUrl(userInfo.picture) ?? record.headshotUrl,
      accountCreatedAt: userInfo.created_at ?? record.accountCreatedAt,
    };
    await this.deps.vault.putAccount(next).catch(() => undefined);
    return next;
  }

  async extendedProfile(accountKey: string): Promise<Record<string, unknown>> {
    const session = await this.authorize(accountKey);
    const userId = session.record.userId;
    if (!userId) {
      throw robloxAuthError("insufficient_scope", "No Roblox user id is stored for this account, so the Open Cloud profile cannot be read.", {
        hint: "Enable the openid scope on the Roblox app, then use roblox_account_link_start and the /oauth/roblox/link form to consent again.",
        status: 403,
      });
    }
    const { data } = await this.call<Record<string, unknown>>(accountKey, {
      path: `/users/${userId}`,
      anyOfScopes: ["user.advanced:read", "user.social:read"],
    });
    return data;
  }

  /**
   * Open Cloud inventory items for the connected user only.
   *
   * `user_id` is always the stored `sub`, never a caller argument: an MCP client
   * must not be able to aim the user's token at somebody else's inventory.
   */
  async inventory(accountKey: string, options: { maxPageSize?: number; pageToken?: string; filter?: string } = {}): Promise<Record<string, unknown>> {
    const session = await this.authorize(accountKey);
    const userId = session.record.userId;
    if (!userId) {
      throw robloxAuthError("insufficient_scope", "The connected account has no stored user id, so inventory cannot be resolved.", {
        hint: "Reconnect with the openid scope.",
        status: 403,
      });
    }
    const maxPageSize = Math.min(Math.max(1, Math.trunc(options.maxPageSize ?? 25)), OPEN_CLOUD_LIMITS.maxPageSize);
    const { data } = await this.call<Record<string, unknown>>(accountKey, {
      path: `/users/${userId}/inventory-items`,
      query: { maxPageSize, pageToken: options.pageToken, filter: options.filter },
      requiredScopes: ["user.inventory-item:read"],
    });
    return data;
  }

  /** Avatar thumbnail generation, polling the documented long-running operation. */
  async thumbnail(
    accountKey: string,
    options: { size?: number; format?: "PNG" | "JPEG"; shape?: "ROUND" | "SQUARE"; maxWaitMs?: number } = {},
  ): Promise<{ status: "ready" | "pending"; imageUri: string | null; operationId: string | null; note: string }> {
    const session = await this.authorize(accountKey);
    const userId = session.record.userId;
    if (!userId) {
      throw robloxAuthError("insufficient_scope", "The connected account has no stored user id, so a thumbnail cannot be generated.", { status: 403 });
    }
    const size = [48, 50, 60, 75, 100, 110, 150, 180, 352, 420, 720].includes(Number(options.size)) ? Number(options.size) : 420;
    const started = await this.call<Record<string, any>>(accountKey, {
      path: `/users/${userId}:generateThumbnail`,
      query: { size, format: options.format ?? "PNG", shape: options.shape ?? "ROUND" },
      timeoutMs: 10_000,
    });
    const operation = started.data ?? {};
    const operationId = typeof operation.path === "string" ? operation.path : null;
    if (operation.done === true && typeof operation.response?.imageUri === "string") {
      return { status: "ready", imageUri: operation.response.imageUri, operationId, note: "Generated by the Open Cloud thumbnails operation." };
    }
    if (!operationId) {
      return { status: "pending", imageUri: null, operationId: null, note: "Roblox accepted the request but returned no operation handle." };
    }
    const deadline = this.now() + Math.min(options.maxWaitMs ?? 6_000, 10_000);
    // Roblox returns the operation as `users/{user_id}/operations/{operation_id}`;
    // only that exact shape is polled, so an unexpected value can never turn into a
    // request to a different resource with the user's bearer token.
    const pollMatch = /^users\/(\d+)\/operations\/[A-Za-z0-9_-]{4,120}$/.exec(operationId);
    if (!pollMatch || pollMatch[1] !== userId) {
      return { status: "pending", imageUri: null, operationId, note: "Roblox returned an operation handle DEMO does not recognise, so it was not polled." };
    }
    while (this.now() < deadline) {
      await delay(750);
      const polled = await this.call<Record<string, any>>(accountKey, { path: `/${operationId}`, timeoutMs: 10_000 }).catch(() => null);
      const value = polled?.data ?? {};
      if (value.done === true) {
        const imageUri = typeof value.response?.imageUri === "string" ? value.response.imageUri : null;
        return { status: imageUri ? "ready" : "pending", imageUri, operationId, note: imageUri ? "Thumbnail generated." : "The operation finished without an image URI." };
      }
    }
    return {
      status: "pending",
      imageUri: null,
      operationId,
      note: "Roblox is still generating the thumbnail. Call the tool again for the result.",
    };
  }

  /**
   * Logout: revoke at Roblox when a refresh token exists, then destroy local
   * state. Revocation is best effort by design — a Roblox outage must not leave a
   * user unable to sign out of DEMO.
   */
  async disconnect(accountKey: string, options: { sessionId?: string | null } = {}): Promise<DisconnectResult> {
    const { vault, config, env } = this.deps;
    const record = await vault.getAccount(accountKey);
    const tokens = record ? await vault.openTokens(record.token) : null;
    let revocationAttempted = false;
    let revoked = false;
    if (record && tokens?.refreshToken && config.clientId) {
      const result = await revokeAuthorization({
        config,
        clientSecret: (env.ROBLOX_CLIENT_SECRET ?? "").trim(),
        refreshToken: tokens.refreshToken,
        fetchImpl: this.fetchImpl,
      });
      revocationAttempted = result.attempted;
      revoked = result.revoked;
    }
    await vault.deleteAccount(accountKey);
    if (options.sessionId) await vault.dropSession(options.sessionId);
    safeLog("log", `disconnected:${accountKey}`, { revoked, revocationAttempted }, "roblox");
    return { disconnected: true, revocationAttempted, revoked };
  }
}

function buildOpenCloudUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
  if (!path.startsWith("/") || path.includes("//") || /[:?#]/.test(path)) {
    // Only a path under the pinned base is allowed, so this helper can never be
    // talked into fetching an arbitrary host with the user's bearer token.
    throw robloxAuthError("invalid_input", "An Open Cloud request path must be a plain path under /cloud/v2.");
  }
  const url = new URL(`${ROBLOX_OPEN_CLOUD_BASE}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    // A CDN URL is safe to hand back only without any query: signed URLs carry
    // credentials, and the redaction layer would mangle them into nonsense anyway.
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function parseRetryAfterMs(value: string | null): number {
  if (!value) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(Math.trunc(seconds * 1000), 30_000));
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 30_000));
  return 1_000;
}

async function readOauthErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.clone().json()) as { errors?: Array<{ code?: string; message?: string }>; error?: { code?: string } };
    const code = body?.error?.code ?? body?.errors?.[0]?.code;
    return typeof code === "string" ? code.slice(0, 64) : null;
  } catch {
    return null;
  }
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw robloxAuthError("api_error", "The Roblox Open Cloud response was not JSON.", { status: 502 });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.trunc(ms))));
}

export type { VaultMode };
