/**
 * DEMO account system tests: password hashing, the account store, the JSON API,
 * session identity, and the OAuth authorize sign-in bridge. No real email is
 * sent — a stub fetch captures the messages Resend would receive.
 */

import { describe, expect, it, vi } from "vitest";
import { checkPasswordPolicy, hashPassword, verifyPassword, passwordNeedsRehash } from "../src/account/passwords.js";
import { InMemoryAccountStore, type AccountUserRecord } from "../src/account/store.js";
import { handleAccountRoute } from "../src/account/routes.js";
import { resolveRequestIdentity, accountSubjectHash } from "../src/auth/request-identity.js";
import { handleMcpOAuthRoute, clearChatGptClientMetadataCacheForTests } from "../src/auth/oauth-routes.js";
import { InMemoryMcpAuthStore } from "../src/auth/oauth-store.js";
import { robloxAccountKeyForSubjectHash } from "../src/auth/tool-auth.js";

const ORIGIN = "https://demo-mcp.test.workers.dev";
const NOW = 1_790_000_000_000;
const CLIENT_ID = "https://chatgpt.com/oauth/client.json";
const REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";
const CLIENT_DOCUMENT = {
  client_id: CLIENT_ID,
  redirect_uris: [REDIRECT_URI],
  response_types: ["code"],
  grant_types: ["authorization_code"],
  token_endpoint_auth_method: "none",
};

interface SentMail {
  to: string;
  subject: string;
  text: string;
}

function harness(options: { now?: number | (() => number) } = {}) {
  const store = new InMemoryAccountStore();
  const mail: SentMail[] = [];
  const env = {
    MCP_PUBLIC_ORIGIN: ORIGIN,
    EMAIL_PROVIDER: "resend",
    EMAIL_FROM: "DEMO <no-reply@demo.test>",
    RESEND_API_KEY: "test-resend-key",
  } as Record<string, unknown>;
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://api.resend.com/emails") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { to: string[]; subject: string; text: string };
      mail.push({ to: body.to?.[0] ?? "", subject: body.subject ?? "", text: body.text ?? "" });
      return Response.json({ id: "mail_1" });
    }
    throw new Error(`unexpected fetch in account test: ${url}`);
  });
  // A function-valued clock lets a test cross a cooldown or a TTL boundary
  // without re-creating the store.
  const deps = {
    store,
    fetch: fetchStub as unknown as typeof fetch,
    now: () => (typeof options.now === "function" ? options.now() : options.now ?? NOW),
  };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  async function call(path: string, init?: RequestInit) {
    const response = await handleAccountRoute(new Request(`${ORIGIN}${path}`, init), env, ctx, deps);
    if (!response) throw new Error(`account route not handled: ${path}`);
    return response;
  }
  async function callJson(path: string, init?: RequestInit) {
    const response = await call(path, init);
    return { response, body: (await response.json()) as Record<string, any> };
  }
  function post(path: string, payload: unknown, headers: HeadersInit = {}) {
    return callJson(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(payload),
    });
  }
  function cookieOf(response: Response): string | null {
    const set = response.headers.getSetCookie().find((value) => value.startsWith("demo_session="));
    return set ? set.split(";", 1)[0]! : null;
  }
  return { store, mail, env, deps, call, callJson, post, cookieOf };
}

const GOOD_PASSWORD = "correct-horse-battery-9";

async function registerUser(h: ReturnType<typeof harness>, email = "user@demo.test", password = GOOD_PASSWORD) {
  const { response, body } = await h.post("/account/register", { email, password });
  return { response, body, cookie: h.cookieOf(response) };
}

describe("account passwords", () => {
  it("enforces policy and hashes/verifies PBKDF2 round-trips", async () => {
    expect(checkPasswordPolicy("short1").ok).toBe(false);
    expect(checkPasswordPolicy("onlylettershere").ok).toBe(false);
    expect(checkPasswordPolicy("1234567890").ok).toBe(false);
    expect(checkPasswordPolicy("password123").ok).toBe(false);
    expect(checkPasswordPolicy(GOOD_PASSWORD).ok).toBe(true);
    const stored = await hashPassword(GOOD_PASSWORD);
    expect(stored.startsWith("pbkdf2$")).toBe(true);
    expect(await verifyPassword(GOOD_PASSWORD, stored)).toBe(true);
    expect(await verifyPassword("wrong-password-1", stored)).toBe(false);
    expect(await verifyPassword(GOOD_PASSWORD, "argon2$bogus")).toBe(false);
    expect(await verifyPassword(GOOD_PASSWORD, "pbkdf2$1$AAAA$bbbb")).toBe(false);
    expect(passwordNeedsRehash(stored)).toBe(false);
    expect(passwordNeedsRehash("pbkdf2$100000$AAAA$bbbb")).toBe(true);
  });
});

describe("account store", () => {
  it("keeps emails unique and supports the session lifecycle", async () => {
    const store = new InMemoryAccountStore();
    const passwordHash = await hashPassword(GOOD_PASSWORD);
    const record: AccountUserRecord = {
      version: 1, id: "usr_testuser1", email: "a@demo.test", emailNormalized: "a@demo.test",
      passwordHash, createdAt: NOW, updatedAt: NOW, verifiedAt: null,
    };
    expect(await store.createUser(record)).toBe("ok");
    expect(await store.createUser({ ...record, id: "usr_testuser2" })).toBe("exists");
    expect((await store.getUserByEmail("a@demo.test"))?.id).toBe("usr_testuser1");
    await store.putSession("aa11aa11aa", { version: 1, userId: record.id, createdAt: NOW, expiresAt: NOW + 60_000, label: "ua" });
    await store.putSession("bb22bb22bb", { version: 1, userId: record.id, createdAt: NOW, expiresAt: NOW + 60_000, label: "ua" });
    expect((await store.listSessions(record.id, NOW)).length).toBe(2);
    expect(await store.getSession("aa11aa11aa", NOW + 61_000)).toBeNull();
    expect(await store.deleteSessionByPrefix(record.id, "bb22bb22")).toBe(true);
    expect((await store.listSessions(record.id, NOW)).length).toBe(0);
    expect(await store.deleteUser(record.id)).toBe(true);
    expect(await store.getUser(record.id)).toBeNull();
  });

  it("consumes verification codes and reset tokens exactly once", async () => {
    const store = new InMemoryAccountStore();
    await store.putVerificationCode("usr_testuser1", { hash: "h", linkHash: "l", expiresAt: NOW + 60_000, attempts: 0, sentAt: NOW });
    expect(await store.consumeVerificationCode("usr_testuser1", "wrong", NOW)).toBe("mismatch");
    expect(await store.consumeVerificationCode("usr_testuser1", "h", NOW + 61_000)).toBe("expired");
    await store.putVerificationCode("usr_testuser1", { hash: "h", linkHash: "l", expiresAt: NOW + 60_000, attempts: 0, sentAt: NOW });
    expect(await store.consumeVerificationCode("usr_testuser1", "h", NOW)).toBe("ok");
    expect(await store.consumeVerificationCode("usr_testuser1", "h", NOW)).toBe("none");
    await store.putResetToken("rt", { userId: "usr_testuser1", expiresAt: NOW + 60_000 });
    expect((await store.consumeResetToken("rt", NOW))?.userId).toBe("usr_testuser1");
    expect(await store.consumeResetToken("rt", NOW)).toBeNull();
  });
});

describe("account API", () => {
  it("registers, signs a session in, and answers the session probe", async () => {
    const h = harness();
    const { response, body, cookie } = await registerUser(h);
    expect(response.status).toBe(201);
    expect(body.account?.email).toBe("user@demo.test");
    expect(cookie).toBeTruthy();
    expect(h.mail.length).toBe(1);
    expect(/^[A-Z2-9]{8}$/.test(h.mail[0]!.text.match(/ {2}([A-Z2-9]{8})/)?.[1] ?? "")).toBe(true);

    const probe = await h.callJson("/account/session", { headers: { Cookie: cookie! } });
    expect(probe.body.signedIn).toBe(true);
    expect(probe.body.account?.emailVerified).toBe(false);
  });

  it("does not leak whether an email is registered and rejects weak input", async () => {
    const h = harness();
    await registerUser(h);
    const dup = await h.post("/account/register", { email: "user@demo.test", password: GOOD_PASSWORD });
    expect(dup.response.status).toBe(200);
    expect(dup.body.registered).toBe(true);
    expect(h.cookieOf(dup.response)).toBeNull();
    const weak = await h.post("/account/register", { email: "b@demo.test", password: "short1" });
    expect(weak.response.status).toBe(400);
    expect(weak.body.error).toBe("weak_password");
    const badEmail = await h.post("/account/register", { email: "not-an-email", password: GOOD_PASSWORD });
    expect(badEmail.response.status).toBe(400);
  });

  it("signs in with correct credentials and refuses wrong ones without enumeration", async () => {
    const h = harness();
    await registerUser(h);
    const wrong = await h.post("/account/login", { email: "user@demo.test", password: "wrong-password-1" });
    expect(wrong.response.status).toBe(401);
    expect(wrong.body.error).toBe("invalid_credentials");
    const missing = await h.post("/account/login", { email: "ghost@demo.test", password: GOOD_PASSWORD });
    expect(missing.response.status).toBe(401);
    expect(missing.body.error).toBe("invalid_credentials");
    const right = await h.post("/account/login", { email: "USER@demo.test", password: GOOD_PASSWORD });
    expect(right.response.status).toBe(200);
    expect(h.cookieOf(right.response)).toBeTruthy();
  });

  it("rate-limits repeated account login attempts", async () => {
    const h = harness();
    await registerUser(h);
    let last = 0;
    for (let i = 0; i < 9; i++) {
      const attempt = await h.post("/account/login", { email: "user@demo.test", password: "wrong-password-1" });
      last = attempt.response.status;
    }
    expect(last).toBe(429);
  });

  it("rejects cross-site mutations", async () => {
    const h = harness();
    const { response } = await h.post(
      "/account/login",
      { email: "user@demo.test", password: GOOD_PASSWORD },
      { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.test" },
    );
    expect(response.status).toBe(403);
  });

  it("verifies email with the code from the captured message", async () => {
    const h = harness();
    const { cookie } = await registerUser(h);
    const code = h.mail[0]!.text.match(/ {2}([A-Z2-9]{8})/)![1]!;
    const wrong = await h.post("/account/verify/confirm", { code: "ZZZZZZZZ" }, { Cookie: cookie! });
    expect(wrong.response.status).toBe(400);
    const right = await h.post("/account/verify/confirm", { code }, { Cookie: cookie! });
    expect(right.response.status).toBe(200);
    expect(right.body.account?.emailVerified).toBe(true);
    const again = await h.post("/account/verify/request", {}, { Cookie: cookie! });
    expect(again.body.alreadyVerified).toBe(true);
  });

  it("resets a password via a single-use token and revokes sessions", async () => {
    const h = harness();
    const { cookie } = await registerUser(h);
    const forgot = await h.post("/account/password/forgot", { email: "user@demo.test" });
    expect(forgot.response.status).toBe(200);
    const mail = h.mail.find((m) => m.subject.includes("Reset"));
    expect(mail).toBeTruthy();
    const token = mail!.text.match(/token=([A-Za-z0-9_-]{32,128})/)![1]!;
    const bad = await h.post("/account/password/reset", { token, password: "short1" });
    expect(bad.response.status).toBe(400);
    const reset = await h.post("/account/password/reset", { token, password: "new-strong-pass-7" });
    expect(reset.response.status).toBe(200);
    const reused = await h.post("/account/password/reset", { token, password: "another-new-pass-9" });
    expect(reused.response.status).toBe(410);
    const oldSession = await h.callJson("/account/session", { headers: { Cookie: cookie! } });
    expect(oldSession.body.signedIn).toBe(false);
    const login = await h.post("/account/login", { email: "user@demo.test", password: "new-strong-pass-7" });
    expect(login.response.status).toBe(200);
  });

  it("changes a password with the current one and revokes other sessions", async () => {
    const h = harness();
    await registerUser(h);
    const second = await h.post("/account/login", { email: "user@demo.test", password: GOOD_PASSWORD });
    const cookie2 = h.cookieOf(second.response)!;
    const changed = await h.post("/account/password/change", { currentPassword: GOOD_PASSWORD, newPassword: "next-strong-pass-4" }, { Cookie: cookie2 });
    expect(changed.response.status).toBe(200);
    expect(changed.body.otherSessionsRevoked).toBeGreaterThanOrEqual(1);
    const old = await h.post("/account/login", { email: "user@demo.test", password: GOOD_PASSWORD });
    expect(old.response.status).toBe(401);
    const wrongCurrent = await h.post("/account/password/change", { currentPassword: GOOD_PASSWORD, newPassword: "anything-strong-1" }, { Cookie: cookie2 });
    expect(wrongCurrent.response.status).toBe(403);
  });

  it("lists and revokes sessions, including revoke-others", async () => {
    const h = harness();
    const first = await registerUser(h);
    const second = await h.post("/account/login", { email: "user@demo.test", password: GOOD_PASSWORD });
    const cookie2 = h.cookieOf(second.response)!;
    const list = await h.callJson("/account/sessions", { headers: { Cookie: cookie2 } });
    expect(list.body.sessions.length).toBe(2);
    const other = list.body.sessions.find((s: any) => !s.current);
    const revoked = await h.post("/account/sessions/revoke", { id: other.id }, { Cookie: cookie2 });
    expect(revoked.response.status).toBe(200);
    const firstProbe = await h.callJson("/account/session", { headers: { Cookie: first.cookie! } });
    expect(firstProbe.body.signedIn).toBe(false);
    const third = await h.post("/account/login", { email: "user@demo.test", password: GOOD_PASSWORD });
    const cookie3 = h.cookieOf(third.response)!;
    const others = await h.post("/account/sessions/revoke-others", {}, { Cookie: cookie3 });
    expect(others.body.revoked).toBe(1);
    const listAgain = await h.callJson("/account/sessions", { headers: { Cookie: cookie3 } });
    expect(listAgain.body.sessions.length).toBe(1);
  });

  it("requires the session for protected account reads", async () => {
    const h = harness();
    const me = await h.callJson("/account/me");
    expect(me.response.status).toBe(401);
    const sessions = await h.callJson("/account/sessions");
    expect(sessions.response.status).toBe(401);
  });

  it("joins Roblox link state into /account/me without exposing tokens", async () => {
    const h = harness();
    const { cookie } = await registerUser(h);
    const subjectHash = await accountSubjectHash("usr_" + "");
    void subjectHash;
    const withRoblox = {
      ...h.deps,
      roblox: async () => ({ available: true, linked: true, username: "BuilderOne", robloxUserId: "12345", connectedAt: new Date(NOW).toISOString() }),
    };
    const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
    const response = await handleAccountRoute(new Request(`${ORIGIN}/account/me`, { headers: { Cookie: cookie! } }), h.env, ctx, withRoblox);
    const body = (await response!.json()) as Record<string, any>;
    expect(body.roblox?.linked).toBe(true);
    expect(JSON.stringify(body)).not.toContain("access_token");
    expect(JSON.stringify(body)).not.toContain("refresh");
  });

  it("deletes the account after password + confirmation, unlinking Roblox", async () => {
    const h = harness();
    const { cookie } = await registerUser(h);
    let disconnectCalls = 0;
    const deps = { ...h.deps, roblox: async () => { disconnectCalls++; return { available: true, linked: false }; } };
    const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
    async function del(payload: unknown) {
      const response = await handleAccountRoute(new Request(`${ORIGIN}/account/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie! },
        body: JSON.stringify(payload),
      }), h.env, ctx, deps);
      return { response: response!, body: (await response!.json()) as Record<string, any> };
    }
    expect((await del({ password: GOOD_PASSWORD, confirmation: "delete" })).response.status).toBe(400);
    expect((await del({ password: "wrong-password-1", confirmation: "DELETE" })).response.status).toBe(403);
    const done = await del({ password: GOOD_PASSWORD, confirmation: "DELETE" });
    expect(done.response.status).toBe(200);
    expect(done.body.deleted).toBe(true);
    expect(disconnectCalls).toBeGreaterThanOrEqual(1);
    const probe = await h.callJson("/account/session", { headers: { Cookie: cookie! } });
    expect(probe.body.signedIn).toBe(false);
    expect(await h.store.getUserByEmail("user@demo.test")).toBeNull();
    // The same email can be re-registered afterwards (tombstoning would trap users).
    const re = await registerUser(h);
    expect(re.response.status).toBe(201);
  });

  it("refuses to run without the account store", async () => {
    const response = await handleAccountRoute(
      new Request(`${ORIGIN}/account/session`),
      { MCP_PUBLIC_ORIGIN: ORIGIN },
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
      { store: undefined },
    );
    expect(response!.status).toBe(503);
  });
});

describe("registration contract (root-cause regression)", () => {
  it("reports authenticated:true only when the account was really created and a session issued", async () => {
    const h = harness();
    const { response, body, cookie } = await registerUser(h);
    expect(response.status).toBe(201);
    // The website gates on this exact field; its absence is what made every
    // successful registration look like a failure.
    expect(body.authenticated).toBe(true);
    expect(body.registered).toBe(true);
    expect(body.account?.email).toBe("user@demo.test");
    expect(body.account?.displayName).toBeNull();
    expect(cookie).toBeTruthy();
    // The cookie that came back must actually identify the new account.
    const probe = await h.callJson("/account/session", { headers: { Cookie: cookie! } });
    expect(probe.body.signedIn).toBe(true);
    expect(probe.body.account?.email).toBe("user@demo.test");
  });

  it("never claims authentication for a duplicate email, and stays enumeration-resistant", async () => {
    const h = harness();
    await registerUser(h);
    const dup = await h.post("/account/register", { email: "USER@demo.test", password: GOOD_PASSWORD });
    expect(dup.response.status).toBe(200);
    expect(dup.body.registered).toBe(true);
    expect(dup.body.authenticated).toBe(false);
    expect(dup.body.account).toBeUndefined();
    expect(h.cookieOf(dup.response)).toBeNull();
    // Same wording as a fresh signup, so the answer leaks nothing.
    expect(String(dup.body.message)).toContain("If this email can be registered");
  });

  it("validates the confirmation field and the display name", async () => {
    const h = harness();
    const mismatch = await h.post("/account/register", {
      email: "c@demo.test", password: GOOD_PASSWORD, passwordConfirm: "something-else-7",
    });
    expect(mismatch.response.status).toBe(400);
    expect(mismatch.body.error).toBe("password_mismatch");

    const badName = await h.post("/account/register", {
      email: "c@demo.test", password: GOOD_PASSWORD, displayName: "no",
    });
    expect(badName.response.status).toBe(400);
    expect(badName.body.error).toBe("invalid_display_name");

    const ok = await h.post("/account/register", {
      email: "c@demo.test", password: GOOD_PASSWORD, passwordConfirm: GOOD_PASSWORD, displayName: "Builder One",
    });
    expect(ok.response.status).toBe(201);
    expect(ok.body.account?.displayName).toBe("Builder One");
  });

  it("detects a duplicate display name while keeping email answers generic", async () => {
    const h = harness();
    await h.post("/account/register", { email: "first@demo.test", password: GOOD_PASSWORD, displayName: "UniqueHandle" });
    const dup = await h.post("/account/register", { email: "second@demo.test", password: GOOD_PASSWORD, displayName: "uniquehandle" });
    expect(dup.response.status).toBe(409);
    expect(dup.body.error).toBe("display_name_taken");
    // A different email with a free handle still works.
    const ok = await h.post("/account/register", { email: "second@demo.test", password: GOOD_PASSWORD, displayName: "AnotherHandle" });
    expect(ok.response.status).toBe(201);
  });

  it("sends both a one-click link and a code, and reports delivery honestly", async () => {
    const h = harness();
    const { body } = await registerUser(h);
    expect(body.verification?.sent).toBe(true);
    expect(body.verification?.linkIncluded).toBe(true);
    expect(body.emailDelivery?.configured).toBe(true);
    const mail = h.mail[0]!;
    expect(mail.text).toMatch(/ {2}[A-Z2-9]{8}/);
    expect(mail.text).toContain(`${ORIGIN}/#/verify?token=`);
  });

  it("says why no email was sent instead of promising one", async () => {
    const h = harness();
    const { response, body } = await h.post("/account/register", { email: "noemail@demo.test", password: GOOD_PASSWORD });
    expect(response.status).toBe(201);
    expect(body.authenticated).toBe(true);
    expect(h.cookieOf(response)).toBeTruthy();
    // Same request shape, with email switched off entirely.
    const bare = harness();
    const env = { MCP_PUBLIC_ORIGIN: ORIGIN } as Record<string, unknown>;
    const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
    const offlineResponse = await handleAccountRoute(
      new Request(`${ORIGIN}/account/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "offline@demo.test", password: GOOD_PASSWORD }),
      }),
      env, ctx, bare.deps,
    );
    const offlineBody = (await offlineResponse!.json()) as Record<string, any>;
    expect(offlineResponse!.status).toBe(201);
    expect(offlineBody.authenticated).toBe(true);
    expect(offlineBody.emailDelivery?.configured).toBe(false);
    expect(offlineBody.verification?.sent).toBe(false);
    expect(String(offlineBody.verification?.reason)).toContain("EMAIL_PROVIDER");
    expect(bare.mail.length).toBe(0);
  });
});

describe("email verification link", () => {
  it("verifies through the emailed link without any session", async () => {
    const h = harness();
    const { cookie } = await registerUser(h);
    const token = h.mail[0]!.text.match(/#\/verify\?token=([A-Za-z0-9_-]{32,128})/)![1]!;
    // No Cookie header at all: the link must work from another device.
    const confirmed = await h.post("/account/verify/confirm", { token });
    expect(confirmed.response.status).toBe(200);
    expect(confirmed.body.verified).toBe(true);
    expect(confirmed.body.viaLink).toBe(true);
    const probe = await h.callJson("/account/session", { headers: { Cookie: cookie! } });
    expect(probe.body.account?.emailVerified).toBe(true);
  });

  it("rejects a reused link, an unknown token, and a superseded one", async () => {
    const h = harness();
    const { cookie } = await registerUser(h);
    const token = h.mail[0]!.text.match(/#\/verify\?token=([A-Za-z0-9_-]{32,128})/)![1]!;
    expect((await h.post("/account/verify/confirm", { token })).response.status).toBe(200);
    const reused = await h.post("/account/verify/confirm", { token });
    expect(reused.response.status).toBe(410);

    const unknown = await h.post("/account/verify/confirm", { token: "a".repeat(43) });
    expect(unknown.response.status).toBe(410);

    // A second registration for a fresh address, then a *new* verification email:
    // the first link must stop working because the newest record replaces it.
    let clock = NOW;
    const second = harness({ now: () => clock });
    const reg = await registerUser(second, "second@demo.test");
    const firstToken = second.mail[0]!.text.match(/#\/verify\?token=([A-Za-z0-9_-]{32,128})/)![1]!;
    clock = NOW + 61_000; // past the 60-second resend cooldown
    const resent = await second.post("/account/verify/request", {}, { Cookie: reg.cookie! });
    expect(resent.response.status).toBe(200);
    const superseded = await second.post("/account/verify/confirm", { token: firstToken });
    expect(superseded.response.status).toBe(410);
    const fresh = second.mail[second.mail.length - 1]!.text.match(/#\/verify\?token=([A-Za-z0-9_-]{32,128})/)![1]!;
    expect((await second.post("/account/verify/confirm", { token: fresh })).response.status).toBe(200);
  });

  it("keeps the code path session-bound and reports the resend cooldown", async () => {
    const h = harness();
    const { cookie } = await registerUser(h);
    // The code path requires a session even when the value is correct.
    const anonymous = await h.post("/account/verify/confirm", { code: h.mail[0]!.text.match(/ {2}([A-Z2-9]{8})/)![1]! });
    expect(anonymous.response.status).toBe(401);
    const tooSoon = await h.post("/account/verify/request", {}, { Cookie: cookie! });
    expect(tooSoon.response.status).toBe(429);
    expect(tooSoon.body.retryAfterSeconds).toBeGreaterThan(0);
    const code = h.mail[0]!.text.match(/ {2}([A-Z2-9]{8})/)![1]!;
    expect((await h.post("/account/verify/confirm", { code }, { Cookie: cookie! })).response.status).toBe(200);
  });
});

describe("profile management", () => {
  it("changes and clears the display name, enforcing uniqueness", async () => {
    const h = harness();
    const { cookie } = await registerUser(h);
    const changed = await h.post("/account/profile", { displayName: "Renamed User" }, { Cookie: cookie! });
    expect(changed.response.status).toBe(200);
    expect(changed.body.account?.displayName).toBe("Renamed User");
    expect((await h.store.getUserByDisplayName("renamed user"))?.email).toBe("user@demo.test");

    const other = await h.post("/account/register", { email: "other@demo.test", password: GOOD_PASSWORD });
    const otherCookie = h.cookieOf(other.response)!;
    const taken = await h.post("/account/profile", { displayName: "RENAMED USER" }, { Cookie: otherCookie });
    expect(taken.response.status).toBe(409);

    const cleared = await h.post("/account/profile", { displayName: "" }, { Cookie: cookie! });
    expect(cleared.response.status).toBe(200);
    expect(cleared.body.account?.displayName).toBeNull();
    expect(await h.store.getUserByDisplayName("renamed user")).toBeNull();
  });

  it("requires a session and rejects an unusable handle", async () => {
    const h = harness();
    const anonymous = await h.post("/account/profile", { displayName: "Whoever" });
    expect(anonymous.response.status).toBe(401);
    const { cookie } = await registerUser(h);
    const bad = await h.post("/account/profile", { displayName: "x" }, { Cookie: cookie! });
    expect(bad.response.status).toBe(400);
  });

  it("lets a removed handle be claimed by another account", async () => {
    const h = harness();
    const first = await h.post("/account/register", { email: "a@demo.test", password: GOOD_PASSWORD, displayName: "Contested" });
    expect(first.response.status).toBe(201);
    const cookieA = h.cookieOf(first.response)!;
    await h.post("/account/delete", { password: GOOD_PASSWORD, confirmation: "DELETE" }, { Cookie: cookieA });
    const second = await h.post("/account/register", { email: "b@demo.test", password: GOOD_PASSWORD, displayName: "Contested" });
    expect(second.response.status).toBe(201);
  });
});

describe("account isolation", () => {
  it("never exposes or mutates another account's sessions", async () => {
    const h = harness();
    const a = await h.post("/account/register", { email: "a@demo.test", password: GOOD_PASSWORD });
    const cookieA = h.cookieOf(a.response)!;
    const b = await h.post("/account/register", { email: "b@demo.test", password: GOOD_PASSWORD });
    const cookieB = h.cookieOf(b.response)!;

    const listA = await h.callJson("/account/sessions", { headers: { Cookie: cookieA } });
    const listB = await h.callJson("/account/sessions", { headers: { Cookie: cookieB } });
    const idsA = (listA.body.sessions ?? []).map((s: { id: string }) => s.id);
    const idsB = (listB.body.sessions ?? []).map((s: { id: string }) => s.id);
    expect(idsA.length).toBeGreaterThan(0);
    expect(idsB.length).toBeGreaterThan(0);
    // B's list is B's own; A's session id must not appear in it.
    expect(idsB.some((id: string) => idsA.includes(id))).toBe(false);

    // B cannot revoke a session id that belongs to A, and A keeps working.
    const stolen = await h.post("/account/sessions/revoke", { id: idsA[0] }, { Cookie: cookieB });
    expect([403, 404]).toContain(stolen.response.status);
    expect((await h.callJson("/account/session", { headers: { Cookie: cookieA } })).body.signedIn).toBe(true);

    // Nor can an anonymous caller reach the session surface at all.
    expect((await h.post("/account/sessions/revoke", { id: idsA[0] })).response.status).toBe(401);
    expect((await h.callJson("/account/sessions")).response.status).toBe(401);

    // B changing the display name never touches A's profile.
    await h.post("/account/profile", { displayName: "Bee" }, { Cookie: cookieB });
    const probeA = await h.callJson("/account/session", { headers: { Cookie: cookieA } });
    expect(probeA.body.account?.displayName).toBeNull();
    expect(probeA.body.account?.email).toBe("a@demo.test");
  });

  it("answers a known and an unknown address identically on forgot", async () => {
    const h = harness();
    await h.post("/account/register", { email: "known@demo.test", password: GOOD_PASSWORD });
    const known = await h.post("/account/password/forgot", { email: "known@demo.test" });
    const unknown = await h.post("/account/password/forgot", { email: "unknown@demo.test" });
    expect(known.response.status).toBe(unknown.response.status);
    expect(known.body.message).toBe(unknown.body.message);
    expect(known.body.error).toBeUndefined();
    expect(unknown.body.error).toBeUndefined();
  });
});

describe("security notifications", () => {
  it("emails a password-change notice on reset and on change", async () => {
    const h = harness();
    const { cookie } = await registerUser(h);
    await h.post("/account/password/forgot", { email: "user@demo.test" });
    const resetMail = h.mail.find((m) => m.subject.includes("Reset"))!;
    const token = resetMail.text.match(/token=([A-Za-z0-9_-]{32,128})/)![1]!;
    await h.post("/account/password/reset", { token, password: "brand-new-pass-3" });
    expect(h.mail.some((m) => m.subject.includes("password was changed"))).toBe(true);

    const login = await h.post("/account/login", { email: "user@demo.test", password: "brand-new-pass-3" });
    const cookie2 = h.cookieOf(login.response)!;
    const before = h.mail.length;
    const changed = await h.post("/account/password/change", {
      currentPassword: "brand-new-pass-3", newPassword: "third-strong-pass-8", newPasswordConfirm: "third-strong-pass-8",
    }, { Cookie: cookie2 });
    expect(changed.response.status).toBe(200);
    // The notice is dispatched through ctx.waitUntil, so let the microtask queue drain.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.mail.length).toBeGreaterThan(before);
    expect(cookie).toBeTruthy();
  });

  it("rejects a mismatched password confirmation on change", async () => {
    const h = harness();
    const { cookie } = await registerUser(h);
    const mismatch = await h.post("/account/password/change", {
      currentPassword: GOOD_PASSWORD, newPassword: "first-choice-pass-1", newPasswordConfirm: "second-choice-2",
    }, { Cookie: cookie! });
    expect(mismatch.response.status).toBe(400);
    expect(mismatch.body.error).toBe("password_mismatch");
  });
});

describe("request identity", () => {
  it("derives a domain-separated principal hash from a DEMO session", async () => {
    const h = harness();
    const { cookie } = await registerUser(h);
    const identity = await resolveRequestIdentity(new Request(`${ORIGIN}/`, { headers: { Cookie: cookie! } }), h.env, { accountStore: h.store });
    expect(identity?.kind).toBe("account");
    expect(identity?.subjectHash).toMatch(/^[a-f0-9]{64}$/);
    const user = await h.store.getUserByEmail("user@demo.test");
    expect(identity?.subjectHash).toBe(await accountSubjectHash(user!.id));
    // No collision possible with a raw-user-id hash or an Access-shaped hash.
    expect(identity?.subjectHash).not.toBe(await accountSubjectHash("usr_other"));
    expect(robloxAccountKeyForSubjectHash(identity!.subjectHash).startsWith("u_")).toBe(true);
    const anonymous = await resolveRequestIdentity(new Request(`${ORIGIN}/`), h.env, { accountStore: h.store });
    expect(anonymous).toBeNull();
  });
});

describe("MCP OAuth authorize sign-in bridge", () => {
  function oauthHarness() {
    const h = harness();
    const mcpStore = new InMemoryMcpAuthStore();
    const env = {
      ...h.env,
      MCP_AUTH: { idFromName: (name: string) => name, get: () => mcpStore },
      DEMO_ACCOUNTS: { idFromName: (name: string) => name, get: () => h.store },
    };
    const oauthFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== CLIENT_ID) throw new Error("unexpected external request");
      return Response.json(CLIENT_DOCUMENT);
    });
    const deps = { store: mcpStore, fetch: oauthFetch as unknown as typeof fetch, now: () => NOW };
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "roblox:read",
      state: "state-123",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      resource: ORIGIN,
    });
    clearChatGptClientMetadataCacheForTests();
    return { h, env, deps, params };
  }

  it("renders a DEMO sign-in page instead of a bare 401 when accounts exist", async () => {
    const { h, env, deps, params } = oauthHarness();
    const response = await handleMcpOAuthRoute(new Request(`${ORIGIN}/oauth/authorize?${params}`, { headers: { Accept: "text/html" } }), env, { ...deps } as never);
    // No account store backed identity: production deps resolve the unified identity, so
    // pass a route deps object WITHOUT the identity seam and with the account store visible via env.
    expect(response).toBeTruthy();
    expect(response!.status).toBe(200);
    expect(response!.headers.get("Content-Type")).toContain("text/html");
    const html = await response!.text();
    expect(html).toContain("Sign in to DEMO");
    expect(html).toContain('name="auth_action"');
    expect(html).toContain('name="email"');
    expect(h).toBeTruthy();
  });

  it("issues a session through the authorize form and redirects back to the consent flow", async () => {
    const { h, env, deps, params } = oauthHarness();
    const { body } = await h.post("/account/register", { email: "oauth@demo.test", password: GOOD_PASSWORD });
    expect(body.registered).toBe(true);
    const form = new URLSearchParams(params);
    form.set("auth_action", "demo_session");
    form.set("email", "oauth@demo.test");
    form.set("password", GOOD_PASSWORD);
    const login = await handleMcpOAuthRoute(new Request(`${ORIGIN}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
      body: form.toString(),
    }), env, deps as never);
    expect(login!.status).toBe(302);
    const sessionCookie = login!.headers.getSetCookie().find((value) => value.startsWith("demo_session="));
    expect(sessionCookie).toBeTruthy();
    expect(sessionCookie).toContain("HttpOnly");
    const location = login!.headers.get("Location")!;
    expect(location.startsWith(`${ORIGIN}/oauth/authorize?`)).toBe(true);
    expect(location).toContain("client_id=");
    // The redirected GET now shows consent, because the session identifies the user.
    const consent = await handleMcpOAuthRoute(new Request(location, { headers: { Accept: "text/html", Cookie: sessionCookie!.split(";", 1)[0]! } }), env, deps as never);
    expect(consent!.status).toBe(200);
    const html = await consent!.text();
    expect(html).toContain("Authorize protected tools?");
  });

  it("re-renders the sign-in page with a generic error on wrong credentials", async () => {
    const { env, deps, params } = oauthHarness();
    const form = new URLSearchParams(params);
    form.set("auth_action", "demo_session");
    form.set("email", "nobody@demo.test");
    form.set("password", "wrong-password-1");
    const response = await handleMcpOAuthRoute(new Request(`${ORIGIN}/oauth/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
      body: form.toString(),
    }), env, deps as never);
    expect(response!.status).toBe(401);
    const html = await response!.text();
    expect(html).toContain("did not match");
    expect(html).not.toContain("no account");
  });
});
