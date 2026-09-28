/**
 * DEMO account JSON API, mounted at /account/*.
 *
 * Registration, login/logout, email verification (code *and* one-click link),
 * password reset/change, profile, session management and account deletion. All
 * responses are JSON with `Cache-Control: no-store`; the only credential a
 * browser ever holds is the HttpOnly `demo_session` cookie (an opaque id — the
 * store keeps only its hash).
 *
 * Response contract (the client relies on these exact fields):
 *   POST /account/register       → 201 { ok, registered, authenticated, account, verification }
 *                                → 200 { ok, registered, authenticated: false } (duplicate email, generic)
 *   POST /account/login          → 200 { ok, authenticated, account }
 *   GET  /account/session        → 200 { ok, signedIn, accountsAvailable, account?, session? }
 *   POST /account/verify/request → 200 { ok, alreadyVerified, verification }
 *   POST /account/verify/confirm → 200 { ok, verified, account? }  (code needs a session; link token does not)
 *   POST /account/password/forgot→ 200 (uniform, enumeration-resistant)
 *   POST /account/password/reset → 200 { ok, reset, sessionsRevoked }
 *   POST /account/password/change→ 200 { ok, changed, otherSessionsRevoked }
 *   POST /account/profile        → 200 { ok, account }
 *   GET  /account/sessions       → 200 { ok, sessions[] }
 *   POST /account/sessions/revoke, /account/sessions/revoke-others
 *   POST /account/delete         → 200 { ok, deleted }
 *
 * Enumeration discipline: register, login and forgot-password answers never
 * reveal whether an email address is registered. A *display name* is a public
 * handle, so "that handle is taken" is reported precisely — the alternative
 * would be an unusable signup form, and a visible handle is public by design.
 *
 * Rate limits apply per account email and per client IP hash; the raw IP is
 * never stored.
 */

import { sameSiteRequestAllowed } from "../roblox/cookies.js";
import { sha256Hex, randomOpaqueToken } from "../roblox/crypto.js";
import {
  resolveAccountConfig,
  sendAccountEmail,
  verificationEmail,
  resetEmail,
  passwordChangedEmail,
  accountDeletedEmail,
  type AccountConfigEnv,
} from "./config.js";
import { checkPasswordPolicy, hashPassword, verifyPassword, passwordNeedsRehash } from "./passwords.js";
import {
  resolveAccountStore,
  normalizeDisplayName,
  type AccountStoreApi,
  type AccountUserRecord,
} from "./store.js";
import { ACCOUNT_SESSION_COOKIE, accountSubjectHash, readSessionCookie } from "../auth/request-identity.js";
import { robloxAccountKeyForSubjectHash } from "../auth/tool-auth.js";

const MAX_BODY_BYTES = 8 * 1024;
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,249}\.[^\s@]{2,}$/;
const VERIFICATION_CODE_PATTERN = /^[A-Z2-9]{8}$/;
const VERIFICATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export interface AccountRouteDeps {
  store?: AccountStoreApi;
  fetch?: typeof fetch;
  now?: () => number;
  /** Test seam for Roblox summary/disconnect; production resolves the real vault. */
  roblox?: (userSubjectHash: string) => Promise<RobloxSummary>;
}

interface RobloxSummary {
  available: boolean;
  linked: boolean;
  username?: string | null;
  robloxUserId?: string | null;
  connectedAt?: string | null;
}

type ResolvedConfig = ReturnType<typeof resolveAccountConfig>;

export function isAccountPath(pathname: string): boolean {
  return pathname === "/account" || pathname.startsWith("/account/");
}

export async function handleAccountRoute(
  request: Request,
  env: AccountConfigEnv,
  ctx: ExecutionContext,
  deps: AccountRouteDeps = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (!isAccountPath(path)) return null;
  const now = deps.now?.() ?? Date.now();
  const config = resolveAccountConfig(env);
  const store = deps.store ?? resolveAccountStore(env);
  if (!store) {
    return json(503, { ok: false, error: "accounts_unavailable", message: "The account system is not configured on this deployment (DEMO_ACCOUNTS binding missing)." });
  }
  try {
    return await route(request, env, ctx, config, store, deps, path, now);
  } catch {
    return json(500, { ok: false, error: "internal_error", message: "The account request could not be completed. Try again." });
  }
}

async function route(
  request: Request,
  env: AccountConfigEnv,
  ctx: ExecutionContext,
  config: ResolvedConfig,
  store: AccountStoreApi,
  deps: AccountRouteDeps,
  path: string,
  now: number,
): Promise<Response> {
  switch (path) {
    case "/account/session": {
      if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
      const session = await currentSession(request, store, now);
      const base = {
        ok: true,
        accountsAvailable: true,
        emailDelivery: emailDeliveryStatus(config),
        verificationRequired: config.requireVerifiedForLinking,
      };
      if (!session) return json(200, { ...base, signedIn: false });
      return json(200, {
        ...base,
        signedIn: true,
        account: publicAccount(session.user),
        session: { expiresAt: new Date(session.record.expiresAt).toISOString() },
      });
    }
    case "/account/register":
      return requirePost(request, () => register(request, env, config, store, deps, now));
    case "/account/login":
      return requirePost(request, () => login(request, config, store, deps, now));
    case "/account/logout":
      return requirePost(request, async () => {
        const session = await currentSession(request, store, now);
        if (session) await store.deleteSession(session.tokenHash);
        return json(200, { ok: true, signedIn: false }, [clearSessionCookie(request)]);
      });
    case "/account/me": {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const session = await requireSession(request, store, now);
      if ("response" in session) return session.response;
      const roblox = await robloxSummaryFor(env, deps, session.user);
      return json(200, { ok: true, account: publicAccount(session.user), roblox });
    }
    case "/account/profile":
      return requirePost(request, () => updateProfile(request, store, now));
    case "/account/verify/request":
      return requirePost(request, () => verifyRequest(request, env, config, store, deps, now));
    case "/account/verify/confirm":
      return requirePost(request, () => verifyConfirm(request, env, config, store, now));
    case "/account/password/forgot":
      return requirePost(request, () => forgot(request, env, config, store, deps, now));
    case "/account/password/reset":
      return requirePost(request, () => reset(request, env, config, store, deps, now));
    case "/account/password/change":
      return requirePost(request, () => changePassword(request, env, config, store, deps, ctx, now));
    case "/account/sessions": {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const session = await requireSession(request, store, now);
      if ("response" in session) return session.response;
      const sessions = await store.listSessions(session.user.id, now);
      const currentId = session.tokenHash.slice(0, 8);
      return json(200, { ok: true, sessions: sessions.map((s) => ({ ...s, current: s.id === currentId })) });
    }
    case "/account/sessions/revoke":
      return requirePost(request, async () => {
        const session = await requireSession(request, store, now);
        if ("response" in session) return session.response;
        const body = await readJson(request);
        if (!body) return badBody();
        const id = String(body.id ?? "");
        if (!/^[a-f0-9]{8}$/.test(id)) return json(400, { ok: false, error: "invalid_input", message: "Unknown session id." });
        const sessions = await store.listSessions(session.user.id, now);
        const target = sessions.find((s) => s.id === id);
        if (!target) return json(404, { ok: false, error: "not_found", message: "That session no longer exists." });
        if (id === session.tokenHash.slice(0, 8)) {
          await store.deleteSession(session.tokenHash);
          return json(200, { ok: true, revoked: true, self: true }, [clearSessionCookie(request)]);
        }
        await store.deleteSessionByPrefix(session.user.id, id);
        return json(200, { ok: true, revoked: true, self: false });
      });
    case "/account/sessions/revoke-others":
      return requirePost(request, async () => {
        const session = await requireSession(request, store, now);
        if ("response" in session) return session.response;
        const revoked = await store.deleteOtherSessions(session.user.id, session.tokenHash);
        return json(200, { ok: true, revoked });
      });
    case "/account/delete":
      return requirePost(request, () => deleteAccount(request, env, config, store, deps, ctx, now));
    default:
      return json(404, { ok: false, error: "not_found", message: "Unknown account route." });
  }
}

/* ---------------------------------------------------------------- register */

async function register(
  request: Request,
  env: AccountConfigEnv,
  config: ResolvedConfig,
  store: AccountStoreApi,
  deps: AccountRouteDeps,
  now: number,
): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badBody();
  const email = normalizeEmail(body.email);
  if (!email) return json(400, { ok: false, error: "invalid_email", message: "Enter a valid email address." });
  const password = typeof body.password === "string" ? body.password : "";
  const policy = checkPasswordPolicy(password);
  if (!policy.ok) return json(400, { ok: false, error: "weak_password", message: policy.reason ?? "Choose a stronger password." });
  // Confirmation is validated when supplied; the API stays usable without it for
  // non-browser clients, and the browser form always sends it.
  if (body.passwordConfirm !== undefined) {
    if (typeof body.passwordConfirm !== "string" || body.passwordConfirm !== password) {
      return json(400, { ok: false, error: "password_mismatch", message: "The two passwords did not match." });
    }
  }
  const rawDisplayName = body.displayName ?? body.username;
  const displayName = rawDisplayName === undefined || rawDisplayName === null || rawDisplayName === "" ? null : normalizeDisplayName(rawDisplayName);
  if (rawDisplayName !== undefined && rawDisplayName !== null && rawDisplayName !== "" && !displayName) {
    return json(400, {
      ok: false,
      error: "invalid_display_name",
      message: "Display names are 3–32 characters and may use letters, numbers, spaces, and . _ -",
    });
  }

  const ipLimit = await store.charge("register-ip", await clientScopeHash(request), config.rateLimitPerMinute, 3_600_000, now);
  if (!ipLimit.allowed) return rateLimited(ipLimit.retryAfterSeconds, "Too many accounts created from this network. Try again later.");
  const acctLimit = await store.charge("register-acct", (await sha256Hex(email.normalized)).slice(0, 32), 6, 3_600_000, now);
  if (!acctLimit.allowed) return rateLimited(acctLimit.retryAfterSeconds, "Too many registration attempts for this email. Try again later.");

  // A public handle is answerable precisely (see the file header); the email is not.
  if (displayName) {
    const existingHandle = await store.getUserByDisplayName(displayName.normalized);
    if (existingHandle) {
      return json(409, { ok: false, error: "display_name_taken", message: `The display name "${displayName.display}" is already in use. Try another.` });
    }
  }

  const record: AccountUserRecord = {
    version: 1,
    id: `usr_${randomOpaqueToken(18)}`,
    email: email.display,
    emailNormalized: email.normalized,
    displayName: displayName?.display ?? null,
    passwordHash: await hashPassword(password),
    createdAt: now,
    updatedAt: now,
    verifiedAt: null,
  };
  const created = await store.createUser(record);
  if (created !== "ok") {
    // Either the email or the handle was claimed between the checks above and
    // this write. Re-check to answer precisely without ever confirming the email.
    if (displayName && await store.getUserByDisplayName(displayName.normalized)) {
      return json(409, { ok: false, error: "display_name_taken", message: `The display name "${displayName.display}" is already in use. Try another.` });
    }
    // Generic success: a duplicate email must be indistinguishable from a new one.
    return json(200, {
      ok: true,
      registered: true,
      authenticated: false,
      emailDelivery: emailDeliveryStatus(config),
      message: "If this email can be registered, your account is ready — sign in to continue.",
    });
  }

  const sessionCookie = await createSession(request, config, store, record, now);
  const verification = await issueVerification(request, env, config, store, deps, record, now);
  return json(201, {
    ok: true,
    registered: true,
    authenticated: true,
    emailDelivery: emailDeliveryStatus(config),
    account: publicAccount(record),
    verification,
  }, [sessionCookie]);
}

/* ------------------------------------------------------------------- login */

async function login(
  request: Request,
  config: ResolvedConfig,
  store: AccountStoreApi,
  deps: AccountRouteDeps,
  now: number,
): Promise<Response> {
  void deps;
  const body = await readJson(request);
  if (!body) return badBody();
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) return invalidCredentials();

  const emailHash = (await sha256Hex(email.normalized)).slice(0, 32);
  const acctLimit = await store.charge("login-acct", emailHash, 8, 300_000, now);
  if (!acctLimit.allowed) return rateLimited(acctLimit.retryAfterSeconds, "Too many sign-in attempts for this account. Try again later.");
  const ipLimit = await store.charge("login-ip", await clientScopeHash(request), config.rateLimitPerMinute * 2, 60_000, now);
  if (!ipLimit.allowed) return rateLimited(ipLimit.retryAfterSeconds, "Too many sign-in attempts from this network. Try again later.");

  let user = await store.getUserByEmail(email.normalized);
  const valid = user ? await verifyPassword(password, user.passwordHash) : false;
  if (!user || !valid) {
    // Run an equal-cost hash so a missing account does not answer measurably faster.
    if (!user) await verifyPassword(password, await hashPassword(randomOpaqueToken(8)));
    return invalidCredentials();
  }
  if (passwordNeedsRehash(user.passwordHash)) {
    const rehash = await hashPassword(password);
    await store.updateUser(user.id, { passwordHash: rehash, updatedAt: now });
    user = { ...user, passwordHash: rehash };
  }
  // A fresh opaque token on every sign-in: no session can be fixated or replayed.
  const sessionCookie = await createSession(request, config, store, user, now);
  return json(200, {
    ok: true,
    authenticated: true,
    account: publicAccount(user),
    emailDelivery: emailDeliveryStatus(config),
    // Unverified accounts are usable; account-only features report why they are locked.
    verificationRequired: config.requireVerifiedForLinking && !user.verifiedAt,
  }, [sessionCookie]);
}

function invalidCredentials(): Response {
  return json(401, { ok: false, error: "invalid_credentials", message: "That email and password combination did not match a DEMO account." });
}

/* -------------------------------------------------- verification + recovery */

interface VerificationPayload {
  sent: boolean;
  reason: string | null;
  expiresInSeconds: number;
  retryAfterSeconds: number;
  linkIncluded: boolean;
}

/**
 * Mint a fresh verification code *and* a one-click link token, store only their
 * hashes, and hand the message to the configured provider. The returned payload
 * states truthfully whether the provider accepted the message.
 */
async function issueVerification(
  request: Request,
  env: AccountConfigEnv,
  config: ResolvedConfig,
  store: AccountStoreApi,
  deps: AccountRouteDeps,
  user: AccountUserRecord,
  now: number,
): Promise<VerificationPayload> {
  void request;
  const code = verificationCode();
  const linkToken = randomOpaqueToken(32);
  await store.putVerificationCode(user.id, {
    hash: await sha256Hex(code),
    linkHash: await sha256Hex(linkToken),
    expiresAt: now + config.verificationCodeTtlSeconds * 1000,
    attempts: 0,
    sentAt: now,
  });
  const link = config.publicOrigin ? `${config.publicOrigin}/#/verify?token=${encodeURIComponent(linkToken)}` : null;
  const message = verificationEmail(code, link, Math.round(config.verificationCodeTtlSeconds / 60));
  const delivery = await sendAccountEmail(env, { to: user.email, ...message }, { fetch: deps.fetch });
  return {
    sent: delivery.sent,
    reason: delivery.reason,
    expiresInSeconds: config.verificationCodeTtlSeconds,
    retryAfterSeconds: 60,
    linkIncluded: Boolean(link),
  };
}

async function verifyRequest(
  request: Request,
  env: AccountConfigEnv,
  config: ResolvedConfig,
  store: AccountStoreApi,
  deps: AccountRouteDeps,
  now: number,
): Promise<Response> {
  const session = await requireSession(request, store, now);
  if ("response" in session) return session.response;
  if (session.user.verifiedAt) return json(200, { ok: true, alreadyVerified: true, verification: null });
  const existing = await store.getVerificationState(session.user.id);
  if (existing && now - existing.sentAt < 60_000) {
    const retryAfterSeconds = Math.ceil((60_000 - (now - existing.sentAt)) / 1000);
    return json(429, {
      ok: false,
      error: "rate_limited",
      message: `A code was just sent. You can request another in ${retryAfterSeconds}s.`,
      retryAfterSeconds,
    });
  }
  const verification = await issueVerification(request, env, config, store, deps, session.user, now);
  return json(200, { ok: true, alreadyVerified: false, verification });
}

async function verifyConfirm(
  request: Request,
  env: AccountConfigEnv,
  config: ResolvedConfig,
  store: AccountStoreApi,
  now: number,
): Promise<Response> {
  void env;
  const body = await readJson(request);
  if (!body) return badBody();
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";

  // One-click link: the emailed token proves mailbox control, so it needs no
  // session and works from a different browser or device.
  if (token) {
    if (!VERIFICATION_TOKEN_PATTERN.test(token)) {
      return json(400, { ok: false, error: "invalid_token", message: "This verification link is not valid. Request a new one." });
    }
    const tokenHash = await sha256Hex(token);
    const limit = await store.charge("verify-token", tokenHash.slice(0, 16), 10, 300_000, now);
    if (!limit.allowed) return rateLimited(limit.retryAfterSeconds, "Too many attempts. Request a fresh verification email.");
    const outcome = await store.consumeVerificationToken(tokenHash, now);
    if (outcome === "expired") {
      return json(410, { ok: false, error: "token_expired", message: "This verification link expired. Sign in and request a new email." });
    }
    if (outcome === "none") {
      return json(410, { ok: false, error: "invalid_token", message: "This verification link was already used or replaced. Request a new one." });
    }
    const user = await store.getUser(outcome.userId);
    if (!user) return json(410, { ok: false, error: "invalid_token", message: "This verification link is no longer valid. Request a new one." });
    if (!user.verifiedAt) await store.updateUser(user.id, { verifiedAt: now, updatedAt: now });
    return json(200, { ok: true, verified: true, viaLink: true, account: publicAccount({ ...user, verifiedAt: user.verifiedAt ?? now }) });
  }

  // Code path: the caller must already be signed in, so a code cannot be used to
  // probe accounts from an anonymous session.
  const session = await requireSession(request, store, now);
  if ("response" in session) return session.response;
  if (session.user.verifiedAt) return json(200, { ok: true, alreadyVerified: true, account: publicAccount(session.user) });
  if (!code) return json(400, { ok: false, error: "invalid_input", message: "Send the verification code or the link token." });
  if (!VERIFICATION_CODE_PATTERN.test(code)) return json(400, { ok: false, error: "invalid_code", message: "Enter the 8-character code from the email." });

  const ipLimit = await store.charge("verify-ip", await clientScopeHash(request), config.rateLimitPerMinute, 60_000, now);
  if (!ipLimit.allowed) return rateLimited(ipLimit.retryAfterSeconds, "Too many verification attempts from this network. Try again later.");

  const outcome = await store.consumeVerificationCode(session.user.id, await sha256Hex(code), now);
  switch (outcome) {
    case "ok": {
      await store.updateUser(session.user.id, { verifiedAt: now, updatedAt: now });
      return json(200, { ok: true, verified: true, account: publicAccount({ ...session.user, verifiedAt: now }) });
    }
    case "expired":
      return json(410, { ok: false, error: "code_expired", message: "That code expired. Request a fresh one." });
    case "too_many_attempts":
      return json(429, { ok: false, error: "too_many_attempts", message: "Too many wrong guesses — the code was invalidated. Request a fresh one." });
    case "mismatch":
      return json(400, { ok: false, error: "invalid_code", message: "That code did not match. Check the email and try again." });
    default:
      return json(400, { ok: false, error: "no_code", message: "No verification code is pending. Request one first." });
  }
}

async function forgot(
  request: Request,
  env: AccountConfigEnv,
  config: ResolvedConfig,
  store: AccountStoreApi,
  deps: AccountRouteDeps,
  now: number,
): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badBody();
  const email = normalizeEmail(body.email);
  if (!email) {
    return json(200, { ok: true, emailDelivery: emailDeliveryStatus(config), message: "If a DEMO account exists for that email, a reset link is on its way." });
  }
  const acctLimit = await store.charge("forgot-acct", (await sha256Hex(email.normalized)).slice(0, 32), 5, 300_000, now);
  if (!acctLimit.allowed) return rateLimited(acctLimit.retryAfterSeconds, "Too many reset requests for this account. Try again later.");
  const ipLimit = await store.charge("forgot-ip", await clientScopeHash(request), config.rateLimitPerMinute, 60_000, now);
  if (!ipLimit.allowed) return rateLimited(ipLimit.retryAfterSeconds, "Too many reset requests from this network. Try again later.");

  const user = await store.getUserByEmail(email.normalized);
  if (user) {
    const token = randomOpaqueToken(32);
    await store.putResetToken(await sha256Hex(token), { userId: user.id, expiresAt: now + config.resetTokenTtlSeconds * 1000 });
    const message = resetEmail(config.publicOrigin, token, Math.round(config.resetTokenTtlSeconds / 60));
    await sendAccountEmail(env, { to: user.email, ...message }, { fetch: deps.fetch });
  }
  // Identical answer whether or not the account exists — enumeration-resistant.
  return json(200, {
    ok: true,
    emailDelivery: emailDeliveryStatus(config),
    message: "If a DEMO account exists for that email, a reset link is on its way.",
  });
}

async function reset(
  request: Request,
  env: AccountConfigEnv,
  config: ResolvedConfig,
  store: AccountStoreApi,
  deps: AccountRouteDeps,
  now: number,
): Promise<Response> {
  const body = await readJson(request);
  if (!body) return badBody();
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!VERIFICATION_TOKEN_PATTERN.test(token)) {
    return json(400, { ok: false, error: "invalid_token", message: "This reset link is invalid or was already used. Request a new one." });
  }
  const policy = checkPasswordPolicy(password);
  if (!policy.ok) return json(400, { ok: false, error: "weak_password", message: policy.reason ?? "Choose a stronger password." });
  if (body.passwordConfirm !== undefined) {
    if (typeof body.passwordConfirm !== "string" || body.passwordConfirm !== password) {
      return json(400, { ok: false, error: "password_mismatch", message: "The two passwords did not match." });
    }
  }

  const tokenHash = await sha256Hex(token);
  const limit = await store.charge("reset", tokenHash.slice(0, 16), 10, 300_000, now);
  if (!limit.allowed) return rateLimited(limit.retryAfterSeconds, "Too many reset attempts. Request a fresh link.");

  // Single use: consumed before the password is written, so a replay after a
  // crash cannot reuse it, and an invalid token cannot be brute-forced cheaply.
  const record = await store.consumeResetToken(tokenHash, now);
  if (!record) {
    return json(410, { ok: false, error: "invalid_token", message: "This reset link expired or was already used. Request a new one." });
  }
  const user = await store.getUser(record.userId);
  if (!user) return json(410, { ok: false, error: "invalid_token", message: "This reset link is no longer valid. Request a new one." });
  await store.updateUser(user.id, { passwordHash: await hashPassword(password), updatedAt: now });
  // A password reset invalidates every existing session — including the
  // attacker's, if the mailbox was the thing that leaked.
  const revoked = await store.deleteUserSessions(user.id);
  await sendAccountEmail(env, { to: user.email, ...passwordChangedEmail(config.publicOrigin, now) }, { fetch: deps.fetch });
  return json(200, {
    ok: true,
    reset: true,
    sessionsRevoked: revoked,
    emailVerified: Boolean(user.verifiedAt),
    message: "Password updated. Every session was signed out — sign in with the new password.",
  });
}

async function changePassword(
  request: Request,
  env: AccountConfigEnv,
  config: ResolvedConfig,
  store: AccountStoreApi,
  deps: AccountRouteDeps,
  ctx: ExecutionContext,
  now: number,
): Promise<Response> {
  const session = await requireSession(request, store, now);
  if ("response" in session) return session.response;
  const body = await readJson(request);
  if (!body) return badBody();
  const current = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const next = typeof body.newPassword === "string" ? body.newPassword : "";
  if (!(await verifyPassword(current, session.user.passwordHash))) {
    return json(403, { ok: false, error: "invalid_credentials", message: "The current password did not match." });
  }
  const policy = checkPasswordPolicy(next);
  if (!policy.ok) return json(400, { ok: false, error: "weak_password", message: policy.reason ?? "Choose a stronger password." });
  if (body.newPasswordConfirm !== undefined) {
    if (typeof body.newPasswordConfirm !== "string" || body.newPasswordConfirm !== next) {
      return json(400, { ok: false, error: "password_mismatch", message: "The two passwords did not match." });
    }
  }
  await store.updateUser(session.user.id, { passwordHash: await hashPassword(next), updatedAt: now });
  const revoked = await store.deleteOtherSessions(session.user.id, session.tokenHash);
  // A security notice is a notification, not part of the operation: it must not
  // delay the response, and a delivery failure must not fail the change.
  ctx.waitUntil(sendAccountEmail(env, { to: session.user.email, ...passwordChangedEmail(config.publicOrigin, now) }, { fetch: deps.fetch }).then(() => undefined));
  return json(200, { ok: true, changed: true, otherSessionsRevoked: revoked });
}

/* --------------------------------------------------------------- profile */

async function updateProfile(
  request: Request,
  store: AccountStoreApi,
  now: number,
): Promise<Response> {
  const session = await requireSession(request, store, now);
  if ("response" in session) return session.response;
  const body = await readJson(request);
  if (!body) return badBody();
  if (!("displayName" in body) && !("username" in body)) {
    return json(400, { ok: false, error: "invalid_input", message: "Send a displayName to change (an empty value clears it)." });
  }
  const rawValue = "displayName" in body ? body.displayName : body.username;
  const clearing = rawValue === null || rawValue === "" || rawValue === undefined;
  const next = clearing ? null : normalizeDisplayName(rawValue);
  if (!clearing && !next) {
    return json(400, {
      ok: false,
      error: "invalid_display_name",
      message: "Display names are 3–32 characters and may use letters, numbers, spaces, and . _ -",
    });
  }
  const outcome = await store.setDisplayName(session.user.id, next?.display ?? null, next?.normalized ?? null);
  if (outcome === "taken") {
    return json(409, { ok: false, error: "display_name_taken", message: `The display name "${next!.display}" is already in use. Try another.` });
  }
  if (outcome !== "ok") {
    return json(404, { ok: false, error: "not_found", message: "That account no longer exists." });
  }
  return json(200, { ok: true, account: publicAccount({ ...session.user, displayName: next?.display ?? null }) });
}

/* ------------------------------------------------------------------ delete */

async function deleteAccount(
  request: Request,
  env: AccountConfigEnv,
  _config: ResolvedConfig,
  store: AccountStoreApi,
  deps: AccountRouteDeps,
  ctx: ExecutionContext,
  now: number,
): Promise<Response> {
  const session = await requireSession(request, store, now);
  if ("response" in session) return session.response;
  const body = await readJson(request);
  if (!body) return badBody();
  const password = typeof body.password === "string" ? body.password : "";
  const confirmation = typeof body.confirmation === "string" ? body.confirmation : "";
  if (confirmation !== "DELETE") {
    return json(400, { ok: false, error: "confirmation_required", message: "Type DELETE to confirm account deletion." });
  }
  if (!(await verifyPassword(password, session.user.passwordHash))) {
    return json(403, { ok: false, error: "invalid_credentials", message: "The password did not match — the account was not deleted." });
  }
  // Unlink Roblox first (best effort: revoke the grant, delete the encrypted record).
  await robloxDisconnectFor(env, deps, session.user);
  const email = session.user.email;
  await store.deleteUser(session.user.id);
  // Sent after the delete succeeds, so it can never outlive a failed deletion.
  ctx.waitUntil(sendAccountEmail(env, { to: email, ...accountDeletedEmail(now) }, { fetch: deps.fetch }).then(() => undefined));
  return json(200, {
    ok: true,
    deleted: true,
    message: "Your DEMO account, sessions and linked Roblox grant were deleted. Any DEMO authorization granted to an MCP client expires within its normal short lifetime.",
  }, [clearSessionCookie(request)]);
}

/* ------------------------------------------------------------ roblox bridge */

async function robloxSummaryFor(env: AccountConfigEnv, deps: AccountRouteDeps, user: AccountUserRecord): Promise<RobloxSummary> {
  const subjectHash = await accountSubjectHash(user.id);
  if (deps.roblox) return deps.roblox(subjectHash);
  try {
    const { createVault } = await import("../roblox/store.js");
    const vault = (await createVault(env as Record<string, unknown>)).vault;
    const record = await vault.getAccount(robloxAccountKeyForSubjectHash(subjectHash));
    if (!record || record.principalHash !== subjectHash) return { available: true, linked: false };
    return {
      available: true,
      linked: true,
      username: record.username,
      robloxUserId: record.userId,
      connectedAt: new Date(record.connectedAt).toISOString(),
    };
  } catch {
    return { available: false, linked: false };
  }
}

async function robloxDisconnectFor(env: AccountConfigEnv, deps: AccountRouteDeps, user: AccountUserRecord): Promise<void> {
  const subjectHash = await accountSubjectHash(user.id);
  try {
    if (deps.roblox) {
      await deps.roblox(subjectHash);
    }
    const { createVault } = await import("../roblox/store.js");
    const { RobloxAccountClient } = await import("../roblox/client.js");
    const { resolveRobloxConfig } = await import("../roblox/config.js");
    const config = resolveRobloxConfig(env as never, "https://localhost/");
    const vault = (await createVault(env as Record<string, unknown>)).vault;
    const client = new RobloxAccountClient({ env: env as never, config, vault });
    const accountKey = robloxAccountKeyForSubjectHash(subjectHash);
    const candidate = await vault.getAccount(accountKey);
    if (candidate?.principalHash === subjectHash) await client.disconnect(accountKey);
  } catch {
    // Best effort: account deletion proceeds even when the vault is unreachable.
  }
}

/* ----------------------------------------------------------------- sessions */

interface LiveSession {
  user: AccountUserRecord;
  record: { createdAt: number; expiresAt: number; label: string };
  tokenHash: string;
}

async function currentSession(request: Request, store: AccountStoreApi, now: number): Promise<LiveSession | null> {
  const token = readSessionCookie(request.headers.get("Cookie"));
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const record = await store.getSession(tokenHash, now);
  if (!record) return null;
  const user = await store.getUser(record.userId);
  if (!user) return null;
  return { user, record, tokenHash };
}

async function requireSession(
  request: Request,
  store: AccountStoreApi,
  now: number,
): Promise<LiveSession | { response: Response }> {
  const session = await currentSession(request, store, now);
  if (!session) {
    return { response: json(401, { ok: false, error: "unauthenticated", message: "Sign in to your DEMO account to continue." }) };
  }
  return session;
}

async function createSession(
  request: Request,
  config: ResolvedConfig,
  store: AccountStoreApi,
  user: AccountUserRecord,
  now: number,
): Promise<string> {
  const token = randomOpaqueToken(32);
  const expiresAt = now + config.sessionTtlSeconds * 1000;
  await store.putSession(await sha256Hex(token), {
    version: 1,
    userId: user.id,
    createdAt: now,
    expiresAt,
    label: sessionLabel(request),
  });
  return buildSessionCookie(request, token, config.sessionTtlSeconds);
}

/* ----------------------------------------------------------------- helpers */

function publicAccount(user: AccountUserRecord) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName ?? null,
    emailVerified: Boolean(user.verifiedAt),
    createdAt: new Date(user.createdAt).toISOString(),
  };
}

/** Non-secret email state for the client: names and booleans only. */
function emailDeliveryStatus(config: ResolvedConfig): Record<string, unknown> {
  const address = config.email.from;
  return {
    configured: config.email.configured,
    provider: config.email.provider,
    from: config.email.configured ? address : null,
    reason: config.email.reason,
  };
}

function normalizeEmail(value: unknown): { display: string; normalized: string } | null {
  if (typeof value !== "string") return null;
  const display = value.trim();
  const normalized = display.toLowerCase();
  if (display.length > 254 || !EMAIL_PATTERN.test(normalized)) return null;
  return { display, normalized };
}

/** 8-char code over an unambiguous alphabet (no I, O, 0, 1). */
function verificationCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let code = "";
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return code;
}

async function clientScopeHash(request: Request): Promise<string> {
  const cf = (request as unknown as { cf?: { clientIp?: string } }).cf;
  const forwarded = (request.headers.get("X-Forwarded-For") ?? "").split(",")[0]?.trim();
  const ip = cf?.clientIp || forwarded || "unknown";
  return (await sha256Hex(ip)).slice(0, 24);
}

function sessionLabel(request: Request): string {
  return (request.headers.get("User-Agent") ?? "Unknown device").slice(0, 100);
}

function secureRequest(request: Request): boolean {
  const url = new URL(request.url);
  return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

function buildSessionCookie(request: Request, token: string, maxAgeSeconds: number): string {
  const segments = [
    `${ACCOUNT_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.trunc(maxAgeSeconds))}`,
    "HttpOnly",
  ];
  if (secureRequest(request)) segments.push("Secure");
  segments.push("SameSite=Lax");
  return segments.join("; ");
}

function clearSessionCookie(request: Request): string {
  const segments = [`${ACCOUNT_SESSION_COOKIE}=`, "Path=/", "Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT", "HttpOnly"];
  if (secureRequest(request)) segments.push("Secure");
  segments.push("SameSite=Lax");
  return segments.join("; ");
}

async function requirePost(request: Request, handler: () => Promise<Response>): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  // JSON API called from the same-origin UI; a cross-site POST is rejected.
  if (!sameSiteRequestAllowed(request)) {
    return json(403, { ok: false, error: "origin_mismatch", message: "Account changes must be submitted from this site." });
  }
  return handler();
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const type = (request.headers.get("Content-Type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") return null;
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_BODY_BYTES) return null;
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) return null;
    const value = JSON.parse(body);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function badBody(): Response {
  return json(400, { ok: false, error: "invalid_input", message: "Send a JSON object with the documented fields." });
}

function baseHeaders(): Headers {
  const headers = new Headers();
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return headers;
}

export function json(status: number, payload: unknown, setCookies: string[] = []): Response {
  const headers = baseHeaders();
  headers.set("Content-Type", "application/json; charset=UTF-8");
  for (const cookie of setCookies) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(payload), { status, headers });
}

function methodNotAllowed(allow: string): Response {
  const headers = baseHeaders();
  headers.set("Allow", allow);
  return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), { status: 405, headers });
}

function rateLimited(retryAfterSeconds: number, message: string): Response {
  const headers = baseHeaders();
  headers.set("Content-Type", "application/json; charset=UTF-8");
  headers.set("Retry-After", String(retryAfterSeconds));
  return new Response(JSON.stringify({ ok: false, error: "rate_limited", message, retryAfterSeconds }), { status: 429, headers });
}
