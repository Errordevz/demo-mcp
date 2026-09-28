/**
 * Browser-facing Roblox OAuth routes, mounted before the MCP handler:
 *
 *   GET  /oauth/roblox/link      → Access-authenticated one-time-code form
 *   POST /oauth/roblox/start     → consume the code, bind state + PKCE to its verified user, redirect to Roblox
 *   GET  /oauth/roblox/callback  → validate the browser-bound state, exchange the code, save an encrypted per-user grant
 *   GET  /oauth/roblox/status    → safe status for the verified Access identity
 *   POST /oauth/roblox/logout    → best-effort revoke and delete only that identity's grant
 *
 * Design notes that matter for review:
 *
 *  - Sensitive responses are `Cache-Control: no-store` with `Referrer-Policy:
 *    no-referrer`; Roblox access, refresh and ID tokens never leave the Worker.
 *  - The browser gets only a short-lived, HttpOnly state-binding cookie for the
 *    Roblox callback. Status and disconnect revalidate Cloudflare Access identity;
 *    no persistent Roblox browser session or login cookie is issued.
 *  - HTML is produced by an escaping renderer with scripts disabled by CSP, so
 *    OAuth errors and profile text cannot become executable markup.
 *  - Content negotiation (`Accept`) chooses an HTML handoff page or a safe JSON
 *    status response. The one-time code is entered only on DEMO's same-site form.
 */

import { OAUTH_PATHS, resolveRobloxConfig } from "./config.js";
import { STATE_COOKIE, SESSION_COOKIE, OAUTH_PATH, buildCookie, clearCookie, readCookieValue, sameSiteRequestAllowed } from "./cookies.js";
import { randomOpaqueToken, sha256Hex, createPkcePair } from "./crypto.js";
import { asRobloxAuthError, robloxAuthError, type RobloxAuthError } from "./errors.js";
import { buildAuthorizeUrl, exchangeAuthorizationCode, normalizePrompt, readCallbackParams } from "./oauth.js";
import { AccountVault, createVault, type VaultHandle } from "./store.js";
import { safeLog } from "../core/redact.js";
import type { AccountRecord, RobloxAuthEnv, RobloxOAuthConfig, AccountStatusPayload } from "./types.js";
import { RobloxAccountClient } from "./client.js";
import { verifyCloudflareAccessIdentity, type VerifiedAccessIdentity } from "../auth/access-identity.js";
import { resolveMcpAuthStore, type McpAuthStoreApi } from "../auth/oauth-store.js";
import { robloxAccountKeyForSubjectHash } from "../auth/tool-auth.js";

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const FORM_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export interface RobloxRouteDeps {
  /** Injectable adapters for tests; production always uses the configured Durable Objects. */
  vault?: VaultHandle;
  mcpAuthStore?: McpAuthStoreApi;
  identity?: (request: Request, env: RobloxAuthEnv) => Promise<VerifiedAccessIdentity | null>;
  now?: () => number;
}

export function isRobloxOAuthPath(pathname: string): boolean {
  return pathname === OAUTH_PATHS.link || pathname === OAUTH_PATHS.start || pathname === OAUTH_PATHS.callback || pathname === OAUTH_PATHS.logout || pathname === OAUTH_PATHS.status;
}

/**
 * Entry point from the Worker. Returns `null` for any path this module does not
 * own, so the existing DEMO routing is untouched.
 */
export async function handleRobloxOAuthRoute(request: Request, env: Record<string, any>, ctx: ExecutionContext, deps: RobloxRouteDeps = {}): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (!isRobloxOAuthPath(path)) return null;
  try {
    return await route(request, env, ctx, url, path, deps);
  } catch (error) {
    const authError = asRobloxAuthError(error);
    safeLog("warn", `route-error:${path.split("/").pop()}`, { code: authError.code, message: authError.message }, "roblox");
    return await respond(request, authError.toResponse(), wantsHtml(request));
  }
}

async function route(request: Request, env: Record<string, any>, ctx: ExecutionContext, url: URL, path: string, deps: RobloxRouteDeps): Promise<Response> {
  const typedEnv = env as RobloxAuthEnv;
  const config = resolveRobloxConfig(typedEnv, request.url);
  const vaultHandle = deps.vault ?? (await createVault(env));
  const vault = vaultHandle.vault;
  applyVaultState(config, vaultHandle);
  const client = new RobloxAccountClient({ env: typedEnv, config, vault });
  const authStore = deps.mcpAuthStore ?? resolveMcpAuthStore(env);

  // Top-level return navigation from Roblox is permitted; script-initiated
  // cross-origin fetches and cross-site state changes are not.
  if (!oauthOriginAllowed(request)) {
    throw robloxAuthError("origin_mismatch", "Roblox OAuth routes cannot be read from another site.", {
      hint: "Use the DEMO link page in the same browser; cross-origin scripts cannot inspect this route.",
      status: 403,
    });
  }
  await guardRate(vault, config, request, path);

  switch (path) {
    case OAUTH_PATHS.link: {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
      const identity = await currentIdentity(request, typedEnv, deps);
      requireIdentity(identity);
      if (!config.enabled) throw robloxAuthError("not_configured", config.disabledReason ?? "Roblox OAuth is not configured.", { status: 503 });
      requireRobloxStorage(vaultHandle);
      return secureResponse(linkFormPage(), [], FORM_CSP);
    }
    case OAUTH_PATHS.start:
      if (request.method === "GET") return secureResponse(new Response(null, { status: 303, headers: { Location: OAUTH_PATHS.link } }), []);
      return await startFlow(request, typedEnv, config, vaultHandle, vault, authStore, deps, ctx);
    case OAUTH_PATHS.callback:
      return await completeFlow(request, typedEnv, config, vaultHandle, vault, client, ctx, deps);
    case OAUTH_PATHS.logout: {
      const identity = await currentIdentity(request, typedEnv, deps);
      requireIdentity(identity);
      return await logout(request, config, vaultHandle, vault, client, identity);
    }
    case OAUTH_PATHS.status: {
      const identity = await currentIdentity(request, typedEnv, deps);
      requireIdentity(identity);
      return await status(request, config, vaultHandle, vault, identity);
    }
    default:
      return new Response("Not Found", { status: 404 });
  }
}

function applyVaultState(config: RobloxOAuthConfig, handle: VaultHandle): void {
  config.storageMode = handle.mode;
  config.encryption = handle.encryption;
  config.encryptionReason = handle.reason;
}

function requireRobloxStorage(handle: VaultHandle): void {
  if (handle.mode !== "durable-object" || handle.encryption !== "aes-gcm-256" || !handle.vault.encryptsAtRest) {
    throw robloxAuthError("storage_unavailable", "Roblox linking requires the ROBLOX_AUTH Durable Object and ROBLOX_TOKEN_KEY encryption secret.", {
      hint: "Configure both in Cloudflare, then reconnect. DEMO refuses to store Roblox tokens in memory or in plaintext.",
      status: 503,
    });
  }
}

async function currentIdentity(request: Request, env: RobloxAuthEnv, deps: RobloxRouteDeps): Promise<VerifiedAccessIdentity | null> {
  return deps.identity ? deps.identity(request, env) : verifyCloudflareAccessIdentity(request, env);
}

function requireIdentity(identity: VerifiedAccessIdentity | null): asserts identity is VerifiedAccessIdentity {
  if (!identity || !/^[a-f0-9]{64}$/.test(identity.subjectHash)) {
    throw robloxAuthError("unauthenticated", "A verified human Cloudflare Access identity is required for this Roblox route.", {
      hint: "Sign in to the configured Cloudflare Access application using the same identity used by ChatGPT.",
      status: 401,
    });
  }
}

function linkFormPage(): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Link Roblox to DEMO</title><style>${PAGE_STYLE}.field{display:grid;gap:8px;margin:20px 0}.field label{font-size:13px;color:#aab2c0}.field input{width:100%;min-height:48px;padding:12px;border:1px solid #343d4a;border-radius:11px;background:#090c11;color:#f4f6fa;font:600 16px ui-monospace,monospace;letter-spacing:.04em}.button{border:0;cursor:pointer}</style></head><body><main class="card"><div class="dot" style="background:#9bd0ff"></div><h1>Link Roblox to DEMO</h1><p>Paste the short-lived code returned by <code>roblox_account_link_start</code> in ChatGPT. It is single-use and expires in five minutes.</p><p>This browser must be signed in to the <strong>same Cloudflare Access identity</strong> used for ChatGPT. You will then continue to Roblox’s official sign-in and consent page. DEMO never asks for your Roblox password or cookie.</p><form method="post" action="${OAUTH_PATHS.start}"><div class="field"><label for="link_code">One-time link code</label><input id="link_code" name="link_code" type="text" inputmode="text" autocomplete="one-time-code" autocapitalize="none" spellcheck="false" minlength="32" maxlength="128" pattern="[A-Za-z0-9_-]{32,128}" required></div><button class="button" type="submit">Continue to Roblox consent</button></form><p class="foot">ChatGPT → DEMO OAuth and DEMO → Roblox OAuth are separate approvals. Roblox tokens stay encrypted on the Worker.</p></main></body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=UTF-8", "Content-Security-Policy": FORM_CSP } });
}

/* ------------------------------------------------------------------ /link */

async function startFlow(
  request: Request,
  env: RobloxAuthEnv,
  config: RobloxOAuthConfig,
  handle: VaultHandle,
  vault: AccountVault,
  authStore: McpAuthStoreApi | null,
  deps: RobloxRouteDeps,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  if (!sameSiteRequestAllowed(request)) {
    throw robloxAuthError("origin_mismatch", "The Roblox link code must be submitted from DEMO's same-site link page.", { status: 403 });
  }
  if (!config.enabled) {
    throw robloxAuthError("not_configured", config.disabledReason ?? "Roblox OAuth is not configured on this Worker.", {
      hint: "Configure the Roblox OAuth client id and secret on the Worker.",
      status: 503,
    });
  }
  requireRobloxStorage(handle);
  if (!authStore) throw robloxAuthError("storage_unavailable", "The MCP_AUTH Durable Object is not configured.", { status: 503 });

  const identity = await currentIdentity(request, env, deps);
  requireIdentity(identity);
  const rawLinkCode = await readSubmittedLinkCode(request);
  const linkCode = await authStore.consumeRobloxLinkCode(await sha256Hex(rawLinkCode), deps.now?.() ?? Date.now());
  if (!linkCode || linkCode.principalHash !== identity.subjectHash) {
    throw robloxAuthError("unauthenticated", "This Roblox link code is invalid, expired, already used, or belongs to a different signed-in identity.", {
      hint: "Generate a fresh code in ChatGPT and use the same Cloudflare Access identity in this browser.",
      status: 401,
    });
  }

  // The account key is derived only from the verified upstream subject; no query,
  // form field or MCP tool argument can select another user's Roblox record.
  const accountKey = robloxAccountKeyForSubjectHash(identity.subjectHash);
  const prompt = normalizePrompt("consent");
  const { verifier, challenge } = await createPkcePair();
  const binding = randomOpaqueToken(24);
  const bindingHash = await sha256Hex(binding);
  const { state } = await vault.beginAuthorization({
    accountKey,
    principalHash: identity.subjectHash,
    redirectUri: config.redirectUri,
    scopes: config.scopes,
    host: new URL(request.url).host,
    codeVerifier: verifier,
    stateTtlSeconds: config.stateTtlSeconds,
    bindingHash,
  });

  const authorizeUrl = buildAuthorizeUrl({ config, state, codeChallenge: challenge, codeChallengeMethod: "S256", prompt });
  ctx.waitUntil(vault.sweep(Date.now(), 100).then(() => undefined).catch(() => undefined));
  const cookie = buildCookie(STATE_COOKIE, binding, { maxAgeSeconds: config.stateTtlSeconds, path: OAUTH_PATH, secure: isSecure(request) });
  return secureResponse(new Response(null, { status: 302, headers: { Location: authorizeUrl } }), [cookie]);
}

async function readSubmittedLinkCode(request: Request): Promise<string> {
  const type = (request.headers.get("Content-Type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (type !== "application/x-www-form-urlencoded" || declared > 4_096) {
    throw robloxAuthError("invalid_input", "Submit the one-time code using DEMO's link form.");
  }
  let body: string;
  try { body = await request.text(); } catch { throw robloxAuthError("invalid_input", "The link code form could not be read."); }
  if (new TextEncoder().encode(body).byteLength > 4_096) throw robloxAuthError("invalid_input", "The link code form is too large.");
  const form = new URLSearchParams(body);
  const values = form.getAll("link_code");
  const value = values.length === 1 ? values[0]?.trim() ?? "" : "";
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(value)) throw robloxAuthError("invalid_input", "Enter the valid one-time code from roblox_account_link_start.");
  return value;
}

/* --------------------------------------------------------------- /callback */

async function completeFlow(
  request: Request,
  env: RobloxAuthEnv,
  config: RobloxOAuthConfig,
  handle: VaultHandle,
  vault: AccountVault,
  client: RobloxAccountClient,
  ctx: ExecutionContext,
  _deps: RobloxRouteDeps,
): Promise<Response> {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
  requireRobloxStorage(handle);
  if (!config.enabled) {
    throw robloxAuthError("not_configured", config.disabledReason ?? "Roblox OAuth is not configured on this Worker.", { status: 503 });
  }
  const params = readCallbackParams(request.url);

  if (params.error) {
    // Roblox sends `error`/`error_description` on denial. They are echoed back to
    // the *same* browser only, escaped, and never contain credentials.
    throw robloxAuthError("provider_denied", `Roblox reported: ${params.error}.`, {
      hint: params.errorDescription
        ? `Roblox said: ${params.errorDescription}`
        : "If you declined the consent screen, generate a fresh code with roblox_account_link_start, submit it on /oauth/roblox/link, and approve the new request. A 13+ account is required to authorize third-party apps.",
      data: { oauthError: params.error },
      status: 400,
    });
  }
  if (!params.state) {
    throw robloxAuthError("state_missing", "The callback carried no OAuth state parameter.", {
      hint: "Roblox only echoes back a state value if the flow was started by DEMO. Generate a fresh code with roblox_account_link_start and submit it on /oauth/roblox/link in this same browser.",
    });
  }
  if (!params.code) {
    throw robloxAuthError("invalid_input", "The callback carried no authorization code.", {
      hint: "Roblox authorization codes are single-use and expire after about one minute. Generate a fresh DEMO link code, submit it at /oauth/roblox/link, and complete consent promptly.",
    });
  }

  const bindingCookie = readCookieValue(request.headers.get("Cookie"), STATE_COOKIE);
  if (!bindingCookie) {
    throw robloxAuthError("state_missing", "This browser has no OAuth state cookie to match the callback against.", {
      hint: "The flow must be started and finished in the same browser. On iOS Safari, Private Browsing blocks the state cookie — use a normal tab.",
    });
  }
  const bindingHash = await sha256Hex(bindingCookie);
  const outcome = await vault.consumeAuthorization(params.state, bindingHash);
  switch (outcome.status) {
    case "ok":
      break;
    case "expired":
      throw robloxAuthError("state_expired", "The authorization request expired before the callback arrived.", {
        hint: `DEMO allows ${config.stateTtlSeconds}s between submitting a link code and the Roblox callback. Generate a fresh roblox_account_link_start code, submit it at /oauth/roblox/link, and finish consent.`,
      });
    case "replayed":
      throw robloxAuthError("state_replayed", "This OAuth callback has already been redeemed.", {
        hint: "Reload the DEMO page instead of using the browser Back button, then start a new flow if you need to reconnect.",
      });
    case "binding_mismatch":
      throw robloxAuthError("state_binding_mismatch", "The state on this callback was not issued to this browser.", {
        hint: "Submit the code and finish consent in the same browser that opened /oauth/roblox/link. Do not copy the Roblox link to another device.",
      });
    default:
      throw robloxAuthError("state_mismatch", "The state on this callback does not match any pending authorization on this Worker.", {
        hint: "Generate a fresh one-time link code in ChatGPT and submit it on /oauth/roblox/link for this Worker. State from another deployment or a previous flow cannot be redeemed.",
      });
  }
  if (outcome.status !== "ok") return new Response(null, { status: 500 });
  const pending = outcome.pending;
  if (!pending.principalHash || !/^[a-f0-9]{64}$/.test(pending.principalHash) || pending.accountKey !== robloxAccountKeyForSubjectHash(pending.principalHash)) {
    throw robloxAuthError("state_mismatch", "The Roblox link state is not bound to a verified DEMO identity.", { status: 400 });
  }

  // The redeemed record must describe *this* request: a state issued for another
  // host or another configured redirect URI is refused rather than honoured.
  if (pending.host !== new URL(request.url).host) {
    throw robloxAuthError("host_not_allowed", "This authorization was started for a different Worker host.", {
      hint: `Start the flow on ${new URL(request.url).host} so the redirect URI matches the one registered on the Roblox app.`,
    });
  }
  if (pending.redirectUri !== config.redirectUri) {
    throw robloxAuthError("origin_mismatch", "The registered redirect URI changed while this authorization was in flight.", {
      hint: "ROBLOX_REDIRECT_URI (or the Worker host) differs from the value used when the one-time code was submitted. Reconnect to complete the flow.",
    });
  }

  const codeVerifier = await vault.recoverCodeVerifier(pending);
  const tokens = await exchangeAuthorizationCode({
    config,
    clientSecret: (env.ROBLOX_CLIENT_SECRET ?? "").trim(),
    code: params.code,
    codeVerifier,
  });

  const userInfo = await client.fetchProfileWithToken(tokens.accessToken);
  if (!userInfo.sub) {
    throw robloxAuthError("insufficient_scope", "Roblox did not return a user id for this authorization.", {
      hint: "The app must request the `openid` scope and the user must approve it. Check the scope list on the Roblox app, then reconnect.",
      status: 403,
    });
  }
  const missingScopes = config.scopes.filter((scope) => !tokens.scopes.includes(scope));
  if (missingScopes.length > 0) {
    // Not fatal: an app can be approved for fewer scopes than requested. Record it
    // so tools report the gap instead of failing with a mystery 403 later.
    safeLog("warn", "roblox:scopes-missing", { missing: missingScopes }, "roblox");
  }

  const record: AccountRecord = {
    version: 1,
    principalHash: pending.principalHash,
    accountKey: pending.accountKey,
    connectedAt: Date.now(),
    updatedAt: Date.now(),
    userId: userInfo.sub,
    displayName: userInfo.name ?? null,
    username: userInfo.preferred_username ?? null,
    profileUrl: null,
    headshotUrl: null,
    accountCreatedAt: userInfo.created_at ?? null,
    scopes: tokens.scopes,
    scopesSource: tokens.scopesSource,
    expiresAt: tokens.expiresAt,
    hasRefreshToken: Boolean(tokens.refreshToken),
    reauthorizationRequired: false,
    reauthorizationReason: null,
    lastRefreshAt: null,
    lastApiCallAt: null,
    clientIdHash: await sha256Hex(config.clientId ?? ""),
    token: await vault.sealTokens({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      scopes: tokens.scopes,
      expiresAt: tokens.expiresAt,
    }),
  };
  // Headshot/profile URLs are public and useful, but only after the same-host check:
  // keep whatever the userinfo endpoint returned rather than trusting anything else.
  record.profileUrl = profileUrlFor(userInfo.sub, userInfo.profile);
  record.headshotUrl = null;
  const previous = await vault.getAccount(pending.accountKey);
  if (previous) {
    if (previous.principalHash !== pending.principalHash || previous.accountKey !== pending.accountKey) {
      throw robloxAuthError("storage_unavailable", "The stored Roblox grant does not match the verified DEMO identity; refusing to overwrite it.", { status: 503 });
    }
    // Re-linking replaces the same user's grant only after best-effort Roblox
    // revocation of the old refresh token; no grant is silently orphaned.
    await client.disconnect(pending.accountKey);
  }
  await vault.putAccount(record);

  // The state cookie is short-lived and browser-bound; no persistent session is
  // issued. Status and disconnect resolve Access identity again. Clear any legacy
  // session cookie during migration without using it for authorization.
  const cookies = [
    clearCookie(SESSION_COOKIE, { path: OAUTH_PATH, secure: isSecure(request) }),
    clearCookie(STATE_COOKIE, { path: OAUTH_PATH, secure: isSecure(request) }),
  ];

  const payload = {
    ok: true,
    connected: true,
    userId: record.userId,
    displayName: record.displayName,
    username: record.username,
    grantedScopes: record.scopes,
    requestedScopesNotGranted: missingScopes,
    tokenExpiresAt: new Date(tokens.expiresAt).toISOString(),
    canRefresh: record.hasRefreshToken,
    storage: config.storageMode,
    tokenEncryption: config.encryption,
    message: "Roblox is linked to this verified DEMO identity. Roblox tokens remain encrypted on the Worker.",
  };
  if (wantsHtml(request)) {
    return secureResponse(
      htmlPage({
        title: "Roblox connected",
        tone: "success",
        lines: [
          `${accountLabel(record)} is linked to this DEMO identity.`,
          `Roblox user id \`${record.userId}\` (the OIDC \`sub\` claim) — this is what DEMO keys the connection on, so a rename never strands the link.`,
          `Granted scopes: ${record.scopes.join(", ") || "openid"}.`,
          record.hasRefreshToken ? "DEMO will refresh this authorization silently for up to 90 days." : "This authorization has no refresh token, so it expires after about 15 minutes.",
        ],
        actions: [
          { label: "Account status", href: OAUTH_PATHS.status },
          { label: "Back to DEMO", href: "/" },
        ],
      }),
      cookies,
    );
  }
  return secureResponse(Response.json(payload), cookies);
}

/* ---------------------------------------------------------------- /logout */

async function logout(
  request: Request,
  config: RobloxOAuthConfig,
  handle: VaultHandle,
  vault: AccountVault,
  client: RobloxAccountClient,
  identity: VerifiedAccessIdentity,
): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  if (!sameSiteRequestAllowed(request)) {
    throw robloxAuthError("origin_mismatch", "Disconnect was refused because the request did not come from this site.", { status: 403 });
  }
  requireRobloxStorage(handle);
  const accountKey = robloxAccountKeyForSubjectHash(identity.subjectHash);
  const candidate = await vault.getAccount(accountKey);
  const owns = candidate?.accountKey === accountKey && candidate.principalHash === identity.subjectHash;
  const result = owns ? await client.disconnect(accountKey) : { disconnected: false, revocationAttempted: false, revoked: false };
  const cookies = [clearCookie(SESSION_COOKIE, { path: OAUTH_PATH, secure: isSecure(request) }), clearCookie(STATE_COOKIE, { path: OAUTH_PATH, secure: isSecure(request) })];
  const payload = {
    ok: true,
    disconnected: result.disconnected,
    revocationAttempted: result.revocationAttempted,
    revokedAtRoblox: result.revoked,
    ...(result.revocationAttempted && !result.revoked
      ? { notice: "The encrypted DEMO grant was deleted. Roblox could not be reached to revoke it, so it may remain valid until expiry; revoke this app in Roblox account settings." }
      : {}),
  };
  if (wantsHtml(request)) {
    return secureResponse(htmlPage({
      title: "Roblox disconnected",
      tone: "info",
      lines: [result.revoked ? "The Roblox grant was revoked and the encrypted DEMO record was deleted." : owns ? "The encrypted DEMO record was deleted. Roblox revocation may be unavailable; use Roblox account settings if needed." : "No Roblox grant was linked to this DEMO identity."],
      actions: [{ label: "Enter a new link code", href: OAUTH_PATHS.link }],
    }), cookies);
  }
  return secureResponse(Response.json(payload), cookies);
}

/* ----------------------------------------------------------------- /status */

async function status(
  request: Request,
  config: RobloxOAuthConfig,
  handle: VaultHandle,
  vault: AccountVault,
  identity: VerifiedAccessIdentity,
): Promise<Response> {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
  requireRobloxStorage(handle);
  const accountKey = robloxAccountKeyForSubjectHash(identity.subjectHash);
  const candidate = await vault.getAccount(accountKey);
  const record = candidate?.accountKey === accountKey && candidate.principalHash === identity.subjectHash ? candidate : null;
  const tokens = record ? await vault.openTokens(record.token) : null;
  const tokenUsable = Boolean(tokens?.accessToken);
  const reauthorizationRequired = Boolean(record && (record.reauthorizationRequired || !tokenUsable));
  const payload: AccountStatusPayload = {
    connected: Boolean(record && tokenUsable && !record.reauthorizationRequired),
    configuration: {
      enabled: config.enabled && handle.mode === "durable-object" && handle.encryption === "aes-gcm-256",
      disabledReason: config.enabled ? handle.reason : config.disabledReason,
      clientIdConfigured: Boolean(config.clientId),
      clientSecretConfigured: config.hasClientSecret,
      redirectUri: config.redirectUri,
      requestedScopes: config.scopes,
      storage: config.storageMode,
      tokenEncryption: config.encryption,
      tokenEncryptionReason: config.encryptionReason,
      pkce: "S256",
    },
    endpoints: { start: OAUTH_PATHS.link, callback: OAUTH_PATHS.callback, logout: OAUTH_PATHS.logout },
    security: {
      passwordOrCookieRequested: false,
      tokensExposedToClient: false,
      stateValidation: "single-use, expiring, browser-bound; link code bound to verified Access subject",
      cookieFlags: "state cookie only: HttpOnly; Secure; SameSite=Lax",
    },
  };
  if (record) {
    payload.account = {
      userId: record.userId,
      displayName: record.displayName,
      username: record.username,
      profileUrl: record.profileUrl,
      headshotUrl: record.headshotUrl,
      grantedScopes: record.scopes,
      connectedAt: new Date(record.connectedAt).toISOString(),
      updatedAt: new Date(record.updatedAt).toISOString(),
      accessTokenExpiresAt: new Date(tokens?.expiresAt ?? record.expiresAt).toISOString(),
      canRefresh: record.hasRefreshToken,
      reauthorizationRequired,
      reauthorizationReason: record.reauthorizationReason ?? (!tokenUsable ? "Stored token cannot be decrypted; reconnect and approve again." : null),
    };
    payload.tokenExpiresIn = Math.max(0, Math.ceil(((tokens?.expiresAt ?? 0) - Date.now()) / 1000));
  } else {
    payload.message = "No Roblox account is linked to this verified DEMO identity. Start roblox_account_link_start in ChatGPT, then enter its one-time code here.";
  }
  return secureResponse(Response.json(payload, { status: 200 }), []);
}

/* ----------------------------------------------------------------- helpers */

/**
 * Same-origin rule for the OAuth surface.
 *
 * `Sec-Fetch-Mode: navigate` is allowed with a foreign `Origin` because that is
 * exactly what a browser returns after consent; `cors`/`no-cors` from another host
 * is not, which is what stops a foreign page from reading a status response or
 * forging a state-carrying request from within a script.
 */
export function oauthOriginAllowed(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  const mode = (request.headers.get("Sec-Fetch-Mode") ?? "").toLowerCase();
  if (mode === "navigate") return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function isSecure(request: Request): boolean {
  const url = new URL(request.url);
  return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

/** HTML when the caller is a browser navigating; JSON for fetch()/API clients. */
function wantsHtml(request: Request): boolean {
  const accept = (request.headers.get("Accept") ?? "").toLowerCase();
  const forced = new URL(request.url).searchParams.get("format");
  if (forced === "json") return false;
  if (forced === "html") return true;
  if (!accept) return true;
  const html = accept.indexOf("text/html");
  const json = accept.indexOf("application/json");
  if (html >= 0 && (json < 0 || html <= json)) return true;
  return false;
}

/**
 * Rate limit for one OAuth route, keyed by a one-way hash of the client address.
 * The raw IP is never stored — `limit:` records hold only the hash, and the
 * window is 60 seconds.
 */
async function guardRate(vault: AccountVault, config: RobloxOAuthConfig, request: Request, path: string): Promise<void> {
  const bucket = path.split("/").pop() ?? "oauth";
  const scope = await clientScope(request);
  const multiplier = bucket === "status" ? 5 : 1;
  const outcome = await vault.charge(`oauth:${bucket}`, scope, config.rateLimitPerMinute * multiplier);
  if (outcome.allowed) return;
  throw robloxAuthError("rate_limited", `Too many Roblox OAuth attempts from this client (${outcome.limit} per minute).`, {
    retryable: true,
    hint: `Wait ${outcome.retryAfterSeconds}s. This limit exists so the Worker cannot be used to hammer Roblox's authorization server.`,
    data: { retryAfterSeconds: outcome.retryAfterSeconds },
  });
}

async function clientScope(request: Request): Promise<string> {
  const cf = (request as unknown as { cf?: { clientIp?: string } }).cf;
  const forwarded = (request.headers.get("X-Forwarded-For") ?? "").split(",")[0]?.trim();
  const ip = cf?.clientIp || forwarded || "unknown";
  return (await sha256Hex(ip)).slice(0, 24);
}

function profileUrlFor(userId: string, returned: string | null): string | null {
  // Prefer Roblox's own value, but only for this user; otherwise derive it.
  if (returned) {
    try {
      const parsed = new URL(returned);
      if (parsed.hostname === "www.roblox.com" && parsed.pathname.includes(`/users/${userId}/`)) return parsed.origin + parsed.pathname;
    } catch {
      /* fall through to the derived URL */
    }
  }
  return `https://www.roblox.com/users/${userId}/profile`;
}

function secureResponse(response: Response, setCookies: string[], csp?: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  if (csp) headers.set("Content-Security-Policy", csp);
  for (const cookie of setCookies) headers.append("Set-Cookie", cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

interface PageInput {
  title: string;
  tone: "success" | "info" | "error";
  lines: string[];
  actions?: Array<{ label: string; href: string }>;
  status?: number;
}

/**
 * A JSON error becomes a readable page when the caller is a browser. The status
 * code is preserved so `curl`/tests can still assert on it, and only the safe
 * `message`/`hint` fields are carried over — never the raw upstream body.
 */
async function respond(request: Request, response: Response, html: boolean): Promise<Response> {
  if (!html || response.status < 400) return response;
  let body: { message?: string; hint?: string } = {};
  try {
    body = (await response.clone().json()) as { message?: string; hint?: string };
  } catch {
    body = {};
  }
  return secureResponse(
    htmlPage({
      title: "Roblox sign-in did not complete",
      tone: "error",
      status: response.status,
      lines: [body.message ?? "The Roblox authorization could not be completed.", ...(body.hint ? [body.hint] : [])],
      actions: [{ label: "Try again", href: OAUTH_PATHS.link }],
    }),
    [],
  );
}

function escapeHtml(value: string): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** No scripts, escaped interpolation, CSP `default-src 'none'`: an OAuth error string cannot execute. */
/**
 * How a connected account is named to a human: `@username` first, because that is
 * what a Roblox user recognises, with the display name in parentheses when it
 * differs. Nothing here is used as an identity key — the record is keyed on `sub`.
 */
export function accountLabel(record: Pick<AccountRecord, "username" | "displayName" | "userId">): string {
  const display = record.displayName?.trim() || null;
  if (record.username) {
    return display && display !== record.username ? `@${record.username} (${display})` : `@${record.username}`;
  }
  return display ?? `Roblox user ${record.userId ?? "unknown"}`;
}

function htmlPage(input: PageInput): Response {
  const accent = input.tone === "error" ? "#ff8f8f" : input.tone === "success" ? "#7df2b3" : "#aeb7c6";
  const body = input.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
  const actions = (input.actions ?? [])
    .map((action) => `<a class="button" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`)
    .join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(input.title)}</title><style>${PAGE_STYLE}</style></head><body><main class="card"><div class="dot" style="background:${accent}"></div><h1>${escapeHtml(input.title)}</h1>${body}<div class="row">${actions}</div><p class="foot">DEMO keeps Roblox tokens encrypted on the Worker. The browser receives only a short-lived HttpOnly state cookie during the official Roblox redirect.</p></main></body></html>`;
  return new Response(html, {
    status: input.status ?? (input.tone === "error" ? 400 : 200),
    headers: { "content-type": "text/html; charset=UTF-8", "Content-Security-Policy": CSP },
  });
}

const PAGE_STYLE = `:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07080b;color:#f5f7fa;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:22px}.card{max-width:520px;width:100%;background:#101319;border:1px solid #252b36;border-radius:20px;padding:26px}h1{font-size:22px;margin:12px 0 6px;letter-spacing:-.02em}p{margin:8px 0;color:#aab2c0;line-height:1.55;font-size:15px}.dot{width:10px;height:10px;border-radius:50%}.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}.button{display:inline-block;padding:11px 15px;border-radius:13px;background:#f3f5f7;color:#08090c;text-decoration:none;font-weight:650;font-size:14px}.foot{font-size:12px;color:#697384;margin-top:18px}`;

export function renderAuthErrorPage(error: RobloxAuthError, retryHref: string | null): Response {
  return htmlPage({
    title: "Roblox sign-in did not complete",
    tone: "error",
    status: error.status,
    lines: [error.message, ...(error.hint ? [error.hint] : [])],
    actions: retryHref ? [{ label: "Try again", href: retryHref }] : [],
  });
}
