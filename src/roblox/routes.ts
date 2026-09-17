/**
 * Browser-facing Roblox OAuth routes, mounted on the Worker before the MCP
 * handler:
 *
 *   GET  /oauth/roblox/start     → mint state + PKCE, redirect to Roblox consent
 *   GET  /oauth/roblox/callback  → validate state, exchange the code, open a session
 *   POST /oauth/roblox/logout    → revoke at Roblox, destroy the local session
 *   GET  /oauth/roblox/status    → safe account status for this browser session
 *
 * Design notes that matter for review:
 *
 *  - Every response is `Cache-Control: no-store` with `Referrer-Policy:
 *    no-referrer`, so a code or state can never leak through a cache or a
 *    `Referer` header.
 *  - The browser never receives a token. The only thing it gets is an opaque
 *    `HttpOnly` session id; the status payload is built field-by-field and has no
 *    token property to leak.
 *  - HTML is only produced by an escape-everything renderer with no scripts and a
 *    `default-src 'none'` CSP, so an OAuth error string cannot become XSS.
 *  - Content negotiation (`Accept`) decides HTML vs JSON, which is what lets the
 *    iPhone flow work from the DEMO page: fetch JSON, render a tappable link.
 */

import { OAUTH_PATHS, resolveRobloxConfig, normalizeAccountKey } from "./config.js";
import { STATE_COOKIE, SESSION_COOKIE, OAUTH_PATH, buildCookie, clearCookie, readCookieValue, sameSiteRequestAllowed } from "./cookies.js";
import { randomOpaqueToken, sha256Hex, createPkcePair } from "./crypto.js";
import { asRobloxAuthError, robloxAuthError, type RobloxAuthError } from "./errors.js";
import { buildAuthorizeUrl, exchangeAuthorizationCode, normalizePrompt, readCallbackParams } from "./oauth.js";
import { AccountVault, createVault, type VaultHandle } from "./store.js";
import { safeLog } from "../core/redact.js";
import type { AccountRecord, RobloxAuthEnv, RobloxOAuthConfig, AccountStatusPayload } from "./types.js";
import { RobloxAccountClient } from "./client.js";

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export interface RobloxRouteDeps {
  /** Injectable for tests. */
  vault?: VaultHandle;
  now?: () => number;
}

export function isRobloxOAuthPath(pathname: string): boolean {
  return pathname === OAUTH_PATHS.start || pathname === OAUTH_PATHS.callback || pathname === OAUTH_PATHS.logout || pathname === OAUTH_PATHS.status;
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
  const config = resolveRobloxConfig(env as RobloxAuthEnv, request.url);
  const vaultHandle = deps.vault ?? (await createVault(env));
  const vault = vaultHandle.vault;
  applyVaultState(config, vaultHandle);
  const client = new RobloxAccountClient({ env: env as RobloxAuthEnv, config, vault });

  // A cross-origin *fetch* against these routes is never legitimate; a top-level
  // navigation returning from roblox.com is (and browsers send no Origin for it).
  if (!oauthOriginAllowed(request)) {
    throw robloxAuthError("origin_mismatch", "Roblox OAuth routes cannot be read from another site.", {
      hint: "Open the flow directly in Safari on this Worker's own URL, or fetch it from the DEMO page.",
      status: 403,
    });
  }

  // Rate limiting first: it must be able to refuse work before any state,
  // browser redirect or Roblox request is produced.
  await guardRate(vault, config, request, path);

  switch (path) {
    case OAUTH_PATHS.start:
      return await startFlow(request, config, vault, url, ctx);
    case OAUTH_PATHS.callback:
      return await completeFlow(request, env, config, vault, client, ctx);
    case OAUTH_PATHS.logout:
      return await logout(request, config, vault, client);
    case OAUTH_PATHS.status:
      return await status(request, config, vault);
    default:
      return new Response("Not Found", { status: 404 });
  }
}

function applyVaultState(config: RobloxOAuthConfig, handle: VaultHandle): void {
  config.storageMode = handle.mode;
  config.encryption = handle.encryption;
  config.encryptionReason = handle.reason;
}

/* ------------------------------------------------------------------ /start */

async function startFlow(request: Request, config: RobloxOAuthConfig, vault: AccountVault, url: URL, ctx: ExecutionContext): Promise<Response> {
  if (!config.enabled) {
    throw robloxAuthError("not_configured", config.disabledReason ?? "Roblox OAuth is not configured on this Worker.", {
      hint: "Add ROBLOX_CLIENT_ID and the ROBLOX_CLIENT_SECRET secret in the Cloudflare dashboard (Workers → your Worker → Settings → Variables and secrets), then open this URL again.",
      status: 503,
    });
  }
  const accountKey = url.searchParams.get("account") ? normalizeAccountKey(url.searchParams.get("account")) : config.accountKey;
  const prompt = normalizePrompt(url.searchParams.get("prompt"));

  const { verifier, challenge } = await createPkcePair();
  // The browser binding: a random value in an HttpOnly cookie, of which only the
  // hash is stored. That is what makes the state non-transferable between browsers.
  const binding = randomOpaqueToken(24);
  const bindingHash = await sha256Hex(binding);

  // The vault returns the state it actually stored, so the value sent to Roblox and
  // the hash kept server-side can never diverge.
  const { state } = await vault.beginAuthorization({
    accountKey,
    redirectUri: config.redirectUri,
    scopes: config.scopes,
    host: new URL(request.url).host,
    codeVerifier: verifier,
    stateTtlSeconds: config.stateTtlSeconds,
    bindingHash,
  });

  const authorizeUrl = buildAuthorizeUrl({ config, state, codeChallenge: challenge, codeChallengeMethod: "S256", prompt });

  // A long-running redirect costs the user their isolate if the Worker is
  // recycled; nothing to await here, so `waitUntil` is only for hygiene.
  ctx.waitUntil(vault.sweep(Date.now(), 100).then(() => undefined).catch(() => undefined));

  const cookie = buildCookie(STATE_COOKIE, binding, { maxAgeSeconds: config.stateTtlSeconds, path: OAUTH_PATH, secure: isSecure(request) });

  if (!wantsHtml(request)) {
    // Used by the DEMO page: render a link the user can tap in Safari. Same
    // payload, no redirect, and the state cookie is still set.
    return secureResponse(
      Response.json(
        {
          ok: true,
          authorizeUrl,
          redirectUri: config.redirectUri,
          requestedScopes: config.scopes,
          accountKey,
          stateExpiresInSeconds: config.stateTtlSeconds,
          nextStep: "Open authorizeUrl in Safari, approve the consent screen, and return here.",
        },
        { status: 200 },
      ),
      [cookie],
    );
  }

  return secureResponse(new Response(null, { status: 302, headers: { location: authorizeUrl } }), [cookie]);
}

/* --------------------------------------------------------------- /callback */

async function completeFlow(
  request: Request,
  env: RobloxAuthEnv,
  config: RobloxOAuthConfig,
  vault: AccountVault,
  client: RobloxAccountClient,
  ctx: ExecutionContext,
): Promise<Response> {
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
        : "If you declined the consent screen, open /oauth/roblox/start again and approve it. A 13+ account is required to authorize third-party apps.",
      data: { oauthError: params.error },
      status: 400,
    });
  }
  if (!params.state) {
    throw robloxAuthError("state_missing", "The callback carried no OAuth state parameter.", {
      hint: "Roblox only echoes back a state value if the flow was started by DEMO. Open /oauth/roblox/start in this same browser tab and complete the consent screen.",
    });
  }
  if (!params.code) {
    throw robloxAuthError("invalid_input", "The callback carried no authorization code.", {
      hint: "Authorization codes are single-use and expire after about one minute. Restart the flow at /oauth/roblox/start and complete it promptly.",
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
        hint: `DEMO allows ${config.stateTtlSeconds}s between /oauth/roblox/start and the callback. Open /oauth/roblox/start again and finish the consent screen.`,
      });
    case "replayed":
      throw robloxAuthError("state_replayed", "This OAuth callback has already been redeemed.", {
        hint: "Reload the DEMO page instead of using the browser Back button, then start a new flow if you need to reconnect.",
      });
    case "binding_mismatch":
      throw robloxAuthError("state_binding_mismatch", "The state on this callback was not issued to this browser.", {
        hint: "Finish the flow in the same tab and browser that opened /oauth/roblox/start. Do not copy the Roblox link to another device.",
      });
    default:
      throw robloxAuthError("state_mismatch", "The state on this callback does not match any pending authorization on this Worker.", {
        hint: "Start the flow at /oauth/roblox/start on this Worker. A state issued by another deployment (or an older isolate) is not redeemable here.",
      });
  }
  if (outcome.status !== "ok") return new Response(null, { status: 500 });
  const pending = outcome.pending;

  // The redeemed record must describe *this* request: a state issued for another
  // host or another configured redirect URI is refused rather than honoured.
  if (pending.host !== new URL(request.url).host) {
    throw robloxAuthError("host_not_allowed", "This authorization was started for a different Worker host.", {
      hint: `Start the flow on ${new URL(request.url).host} so the redirect URI matches the one registered on the Roblox app.`,
    });
  }
  if (pending.redirectUri !== config.redirectUri) {
    throw robloxAuthError("origin_mismatch", "The registered redirect URI changed while this authorization was in flight.", {
      hint: "ROBLOX_REDIRECT_URI (or the Worker host) differs from the value used at /oauth/roblox/start. Reconnect to complete the flow.",
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
  await vault.putAccount(record);

  const { sessionId, record: session } = await vault.createSession(pending.accountKey, config.sessionTtlSeconds);
  ctx.waitUntil(vault.touchSession(sessionId, config.sessionTtlSeconds).then(() => undefined).catch(() => undefined));
  const cookies = [
    buildCookie(SESSION_COOKIE, sessionId, { maxAgeSeconds: config.sessionTtlSeconds, path: OAUTH_PATH, secure: isSecure(request), expiresAt: session.expiresAt }),
    clearCookie(STATE_COOKIE, { path: OAUTH_PATH, secure: isSecure(request) }),
  ];

  const payload = {
    ok: true,
    connected: true,
    accountKey: pending.accountKey,
    userId: record.userId,
    displayName: record.displayName,
    username: record.username,
    grantedScopes: record.scopes,
    requestedScopesNotGranted: missingScopes,
    sessionExpiresAt: new Date(session.expiresAt).toISOString(),
    tokenExpiresAt: new Date(tokens.expiresAt).toISOString(),
    canRefresh: record.hasRefreshToken,
    storage: config.storageMode,
    tokenEncryption: config.encryption,
    message: "Roblox account connected. Tokens stay on the Worker.",
  };
  if (wantsHtml(request)) {
    return secureResponse(
      htmlPage({
        title: "Roblox connected",
        tone: "success",
        lines: [
          `${accountLabel(record)} is connected to DEMO on this browser.`,
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

async function logout(request: Request, config: RobloxOAuthConfig, vault: AccountVault, client: RobloxAccountClient): Promise<Response> {
  if (request.method !== "POST") {
    throw robloxAuthError("invalid_input", "Logout must be a POST.", { hint: "From a browser, POST an empty body to /oauth/roblox/logout." });
  }
  // A state-changing route needs a same-site check, on top of the HttpOnly cookie.
  if (!sameSiteRequestAllowed(request)) {
    throw robloxAuthError("origin_mismatch", "Logout was refused because the request did not come from this site.", {
      hint: "Use the DEMO page or a fetch() from this origin.",
      status: 403,
    });
  }
  const sessionId = readCookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
  const session = sessionId ? await vault.resolveSession(sessionId) : null;
  const accountKey = session?.accountKey ?? config.accountKey;
  const result = await client.disconnect(accountKey, { sessionId: sessionId ?? null });
  const cookies = [clearCookie(SESSION_COOKIE, { path: OAUTH_PATH, secure: isSecure(request) }), clearCookie(STATE_COOKIE, { path: OAUTH_PATH, secure: isSecure(request) })];
  const payload = {
    ok: true,
    disconnected: result.disconnected,
    revocationAttempted: result.revocationAttempted,
    revokedAtRoblox: result.revoked,
    ...(result.revocationAttempted && !result.revoked
      ? { notice: "The session was cleared on DEMO. Roblox could not be reached to revoke the authorization, so it will expire by itself; you can also revoke it from your Roblox app settings." }
      : {}),
  };
  if (wantsHtml(request)) {
    return secureResponse(
      htmlPage({
        title: "Disconnected",
        tone: "info",
        lines: [result.revoked ? "Your Roblox authorization was revoked and the DEMO session was deleted." : "The DEMO session was deleted."],
        actions: [{ label: "Connect again", href: OAUTH_PATHS.start }],
      }),
      cookies,
    );
  }
  return secureResponse(Response.json(payload), cookies);
}

/* ----------------------------------------------------------------- /status */

async function status(request: Request, config: RobloxOAuthConfig, vault: AccountVault): Promise<Response> {
  const sessionId = readCookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
  const session = sessionId ? await vault.resolveSession(sessionId) : null;
  const accountKey = session?.accountKey ?? null;
  // Never fall back to a "default" account here: status must describe *this
  // browser*, otherwise a visitor could read somebody else's connection state.
  const record = accountKey ? await vault.getAccount(accountKey) : null;
  if (sessionId && session && sessionId) {
    await vault.touchSession(sessionId, config.sessionTtlSeconds).catch(() => undefined);
  }
  const payload: AccountStatusPayload = {
    connected: Boolean(record) && !record?.reauthorizationRequired,
    configuration: {
      enabled: config.enabled,
      disabledReason: config.disabledReason,
      clientIdConfigured: Boolean(config.clientId),
      clientSecretConfigured: config.hasClientSecret,
      redirectUri: config.redirectUri,
      requestedScopes: config.scopes,
      storage: config.storageMode,
      tokenEncryption: config.encryption,
      tokenEncryptionReason: config.encryptionReason,
      pkce: "S256",
    },
    endpoints: { start: OAUTH_PATHS.start, callback: OAUTH_PATHS.callback, logout: OAUTH_PATHS.logout },
    security: {
      passwordOrCookieRequested: false,
      tokensExposedToClient: false,
      stateValidation: "single-use, expiring, browser-bound",
      cookieFlags: "HttpOnly; Secure; SameSite=Lax",
    },
  };
  if (record) {
    const tokens = await vault.openTokens(record.token);
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
      sessionExpiresAt: session ? new Date(session.expiresAt).toISOString() : null,
      canRefresh: record.hasRefreshToken,
      reauthorizationRequired: record.reauthorizationRequired,
      reauthorizationReason: record.reauthorizationReason,
    };
    payload.accountKey = record.accountKey;
    payload.tokenExpiresIn = Math.max(0, Math.ceil(((tokens?.expiresAt ?? 0) - Date.now()) / 1000));
  } else {
    payload.message = sessionId
      ? "This browser's session has expired. Start the flow again at /oauth/roblox/start."
      : "No Roblox account is connected to this browser session.";
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

function secureResponse(response: Response, setCookies: string[]): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
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
      actions: [{ label: "Try again", href: OAUTH_PATHS.start }],
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
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(input.title)}</title><style>${PAGE_STYLE}</style></head><body><main class="card"><div class="dot" style="background:${accent}"></div><h1>${escapeHtml(input.title)}</h1>${body}<div class="row">${actions}</div><p class="foot">DEMO keeps every Roblox token on the Worker. Nothing was stored in your browser except an HttpOnly session id.</p></main></body></html>`;
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
