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

function harness(options: { now?: number } = {}) {
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
  const deps = { store, fetch: fetchStub as unknown as typeof fetch, now: () => options.now ?? NOW };
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
    await store.putVerificationCode("usr_testuser1", { hash: "h", expiresAt: NOW + 60_000, attempts: 0, sentAt: NOW });
    expect(await store.consumeVerificationCode("usr_testuser1", "wrong", NOW)).toBe("mismatch");
    expect(await store.consumeVerificationCode("usr_testuser1", "h", NOW + 61_000)).toBe("expired");
    await store.putVerificationCode("usr_testuser1", { hash: "h", expiresAt: NOW + 60_000, attempts: 0, sentAt: NOW });
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
