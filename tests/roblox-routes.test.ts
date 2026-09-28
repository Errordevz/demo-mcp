import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryMcpAuthStore } from "../src/auth/oauth-store.js";
import { robloxAccountKeyForSubjectHash } from "../src/auth/tool-auth.js";
import { randomOpaqueToken, sha256Hex, TokenCipher } from "../src/roblox/crypto.js";
import { AccountVault, MemoryKv, type VaultHandle } from "../src/roblox/store.js";
import { handleRobloxOAuthRoute, isRobloxOAuthPath } from "../src/roblox/routes.js";
import type { VerifiedAccessIdentity } from "../src/auth/access-identity.js";

const ORIGIN = "https://demo-mcp.test.workers.dev";
const CTX = { waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined), passThroughOnException: () => undefined } as unknown as ExecutionContext;
const SUBJECT_A = "a".repeat(64);
const SUBJECT_B = "b".repeat(64);
const ACCESS = "AT.access-token-value-abcdefghijklmnop";
const REFRESH = "RT.refresh-token-value-abcdefghijklmnop";
const ID_TOKEN = "ID.id-token-value-abcdefghijklmnop";
const CLIENT_SECRET = "roblox-client-secret-test-value";
const TOKEN_KEY = "high-entropy-roblox-token-key-for-tests";

function identity(subjectHash: string): VerifiedAccessIdentity {
  return { subjectHash, issuer: "https://demo.cloudflareaccess.com" };
}

async function encryptedVault(): Promise<VaultHandle> {
  const cipher = await TokenCipher.fromSecret(TOKEN_KEY);
  if (!cipher) throw new Error("test cipher could not be initialized");
  return {
    vault: new AccountVault(new MemoryKv(), cipher, "durable-object"),
    mode: "durable-object",
    encryption: "aes-gcm-256",
    reason: null,
  };
}

function env(overrides: Record<string, unknown> = {}) {
  return {
    MCP_PUBLIC_ORIGIN: ORIGIN,
    MCP_AUTH_ACCESS_TEAM_DOMAIN: "demo.cloudflareaccess.com",
    MCP_AUTH_ACCESS_AUD: "access-audience-test",
    ROBLOX_CLIENT_ID: "roblox-client-id-test",
    ROBLOX_CLIENT_SECRET: CLIENT_SECRET,
    ROBLOX_TOKEN_KEY: TOKEN_KEY,
    ROBLOX_OAUTH_SCOPES: "openid profile",
    ...overrides,
  } as Record<string, any>;
}

function deps(vault: VaultHandle, store: InMemoryMcpAuthStore, subjectHash: string | null = SUBJECT_A) {
  return {
    vault,
    mcpAuthStore: store,
    identity: async () => subjectHash ? identity(subjectHash) : null,
  };
}

async function createLinkCode(store: InMemoryMcpAuthStore, subjectHash = SUBJECT_A): Promise<string> {
  const code = randomOpaqueToken(32);
  const inserted = await store.putRobloxLinkCode(await sha256Hex(code), {
    version: 1,
    principalHash: subjectHash,
    expiresAt: Date.now() + 5 * 60_000,
  });
  if (!inserted) throw new Error("link code collision in test");
  return code;
}

async function submitLinkCode(vault: VaultHandle, store: InMemoryMcpAuthStore, code: string, subjectHash: string | null = SUBJECT_A) {
  const response = await handleRobloxOAuthRoute(new Request(`${ORIGIN}/oauth/roblox/start`, {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ link_code: code }).toString(),
  }), env(), CTX, deps(vault, store, subjectHash));
  if (!response) throw new Error("Roblox route not handled");
  return response;
}

function stubRoblox() {
  const calls: Array<{ url: string; method: string; body: Record<string, string> | null; authorization: string | null }> = [];
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null;
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    calls.push({ url: url.href, method: String(init?.method ?? "GET"), body, authorization: headers.get("authorization") });
    if (url.pathname === "/oauth/v1/token" && body?.grant_type === "authorization_code") {
      return Response.json({ access_token: ACCESS, refresh_token: REFRESH, id_token: ID_TOKEN, token_type: "Bearer", expires_in: 900, scope: "openid profile" });
    }
    if (url.pathname === "/oauth/v1/userinfo") {
      return Response.json({ sub: "1516563360", name: "Example User", preferred_username: "exampleuser", profile: "https://www.roblox.com/users/1516563360/profile" });
    }
    if (url.pathname === "/oauth/v1/token/revoke") return new Response(null, { status: 200 });
    throw new Error(`unexpected Roblox test fetch: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchStub);
  return { calls, fetchStub };
}

async function finishRobloxCallback(vault: VaultHandle, authorizeResponse: Response): Promise<Response> {
  const authorize = new URL(authorizeResponse.headers.get("Location")!);
  const state = authorize.searchParams.get("state")!;
  const cookie = authorizeResponse.headers.getSetCookie().find((value) => value.startsWith("roblox_oauth_state="))?.split(";", 1)[0];
  if (!cookie) throw new Error("state binding cookie missing");
  const callback = await handleRobloxOAuthRoute(new Request(`${ORIGIN}/oauth/roblox/callback?code=single-use-roblox-auth-code-1234567890&state=${encodeURIComponent(state)}`, {
    headers: { Accept: "text/html", Cookie: cookie },
  }), env(), CTX, { vault });
  if (!callback) throw new Error("Roblox callback not handled");
  return callback;
}

describe("identity-bound Roblox OAuth routes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("exposes a safe link-code form only to a verified Access identity", async () => {
    const vault = await encryptedVault();
    const store = new InMemoryMcpAuthStore();
    const anonymous = await handleRobloxOAuthRoute(new Request(`${ORIGIN}/oauth/roblox/link`, { headers: { Accept: "application/json" } }), env(), CTX, deps(vault, store, null));
    expect(anonymous?.status).toBe(401);
    expect(await anonymous?.json()).toMatchObject({ error: "unauthenticated" });

    const response = await handleRobloxOAuthRoute(new Request(`${ORIGIN}/oauth/roblox/link`, { headers: { Accept: "text/html" } }), env(), CTX, deps(vault, store));
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-security-policy")).toContain("form-action 'self'");
    const html = await response!.text();
    expect(html).toContain("One-time link code");
    expect(html).toContain("same DEMO identity");
    expect(html).not.toMatch(/<script|type="password"|roblox[_-]?session/i);
  });

  it("consumes a hashed one-time code, binds state to the Access subject, and encrypts the PKCE verifier", async () => {
    const vault = await encryptedVault();
    const store = new InMemoryMcpAuthStore();
    const code = await createLinkCode(store);
    const storedLinkCodes = (store as unknown as { linkCodes: Map<string, unknown> }).linkCodes;
    expect([...storedLinkCodes.keys()]).toEqual([await sha256Hex(code)]);
    expect(JSON.stringify([...storedLinkCodes.keys()])).not.toContain(code);
    const response = await submitLinkCode(vault, store, code);
    expect(response.status).toBe(302);
    const authorize = new URL(response.headers.get("Location")!);
    expect(authorize.origin + authorize.pathname).toBe("https://apis.roblox.com/oauth/v1/authorize");
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("prompt")).toBe("consent");
    expect(authorize.searchParams.has("client_secret")).toBe(false);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");

    const state = authorize.searchParams.get("state")!;
    const stateHash = await sha256Hex(state);
    // AccountVault intentionally keeps its persistence adapter private; inspect its safe snapshot instead.
    const snapshot = (vault.vault as unknown as { kv: MemoryKv }).kv.snapshot();
    const pending = snapshot[AccountVault.pendingKey(stateHash)] as Record<string, unknown>;
    expect(pending).toMatchObject({ accountKey: robloxAccountKeyForSubjectHash(SUBJECT_A), principalHash: SUBJECT_A, codeVerifier: null });
    expect(pending.codeVerifierSealed).toEqual(expect.any(String));
    expect(JSON.stringify(snapshot)).not.toContain(code);
    expect(JSON.stringify(snapshot)).not.toContain(authorize.searchParams.get("code_challenge"));
    expect(JSON.stringify(snapshot)).not.toContain(state);
    expect((store as unknown as { linkCodes: Map<string, unknown> }).linkCodes.has(code)).toBe(false);
    expect((store as unknown as { linkCodes: Map<string, unknown> }).linkCodes.has(await sha256Hex(code))).toBe(false); // consumed atomically
    expect(JSON.stringify([...((store as unknown as { linkCodes: Map<string, unknown> }).linkCodes.keys())])).not.toContain(code);

    const cookies = response.headers.getSetCookie();
    const stateCookie = cookies.find((value) => value.startsWith("roblox_oauth_state="))!;
    expect(stateCookie).toContain("HttpOnly");
    expect(stateCookie).toContain("Secure");
    expect(stateCookie).toContain("SameSite=Lax");
    expect(stateCookie).toContain("Max-Age=600");
    expect(response.headers.get("Location")).not.toContain(CLIENT_SECRET);
  });

  it("rejects a link code submitted by a different verified Access identity", async () => {
    const vault = await encryptedVault();
    const store = new InMemoryMcpAuthStore();
    const code = await createLinkCode(store, SUBJECT_A);
    const response = await submitLinkCode(vault, store, code, SUBJECT_B);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "unauthenticated" });
    expect(response.headers.get("location")).toBeNull();
  });

  it("rejects cross-site, malformed, expired, and replayed link codes", async () => {
    const vault = await encryptedVault();
    const store = new InMemoryMcpAuthStore();
    const code = await createLinkCode(store);
    const crossSite = await handleRobloxOAuthRoute(new Request(`${ORIGIN}/oauth/roblox/start`, {
      method: "POST",
      headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site", "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ link_code: code }).toString(),
    }), env(), CTX, deps(vault, store));
    expect(crossSite?.status).toBe(403);
    expect(await crossSite?.json()).toMatchObject({ error: "origin_mismatch" });

    const malformed = await handleRobloxOAuthRoute(new Request(`${ORIGIN}/oauth/roblox/start`, {
      method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: "link_code=short",
    }), env(), CTX, deps(vault, store));
    expect(malformed?.status).toBe(400);
    expect(await malformed?.json()).toMatchObject({ error: "invalid_input" });

    const good = await submitLinkCode(vault, store, code);
    expect(good.status).toBe(302);
    const replay = await submitLinkCode(vault, store, code);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: "unauthenticated" });
  });

  it("completes Roblox consent without a persistent browser session or token leakage", async () => {
    const { calls } = stubRoblox();
    const vault = await encryptedVault();
    const store = new InMemoryMcpAuthStore();
    const code = await createLinkCode(store);
    const start = await submitLinkCode(vault, store, code);
    const callback = await finishRobloxCallback(vault, start);
    expect(callback.status).toBe(200);
    const html = await callback.text();
    expect(html).toContain("Roblox connected");
    expect(html).toContain("@exampleuser");
    expect(html).not.toContain(ACCESS);
    expect(html).not.toContain(REFRESH);
    expect(html).not.toContain(ID_TOKEN);
    expect(html).not.toContain(CLIENT_SECRET);
    expect(callback.headers.get("cache-control")).toBe("no-store");
    expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
    const cookies = callback.headers.getSetCookie();
    expect(cookies.some((value) => value.startsWith("roblox_session=") && !value.includes("Max-Age=0"))).toBe(false);
    expect(calls.some((call) => call.url.includes("/oauth/v1/token") && call.body?.grant_type === "authorization_code")).toBe(true);
    expect(calls.find((call) => call.url.includes("/oauth/v1/userinfo"))?.authorization).toBe(`Bearer ${ACCESS}`);

    const accountKey = robloxAccountKeyForSubjectHash(SUBJECT_A);
    const account = await vault.vault.getAccount(accountKey);
    expect(account).toMatchObject({ principalHash: SUBJECT_A, accountKey, userId: "1516563360", username: "exampleuser" });
    const serialized = JSON.stringify((vault.vault as unknown as { kv: MemoryKv }).kv.snapshot());
    for (const secret of [ACCESS, REFRESH, ID_TOKEN, CLIENT_SECRET]) expect(serialized).not.toContain(secret);
    expect(serialized).toContain(account!.token!.sealed);
    expect(serialized).not.toContain(`"roblox_session"`);

    const statusA = await handleRobloxOAuthRoute(new Request(`${ORIGIN}/oauth/roblox/status`, { headers: { Accept: "application/json" } }), env(), CTX, deps(vault, store, SUBJECT_A));
    expect(statusA?.status).toBe(200);
    const statusPayload = await statusA!.json();
    expect(statusPayload).toMatchObject({ connected: true, account: { userId: "1516563360", username: "exampleuser" }, security: { tokensExposedToClient: false } });
    expect(JSON.stringify(statusPayload)).not.toMatch(/access_token|refresh_token|id_token|ROBLOX_TOKEN_KEY|roblox_session/i);
    const statusB = await handleRobloxOAuthRoute(new Request(`${ORIGIN}/oauth/roblox/status?account=${accountKey}`, { headers: { Accept: "application/json" } }), env(), CTX, deps(vault, store, SUBJECT_B));
    expect(await statusB?.json()).toMatchObject({ connected: false, message: expect.stringMatching(/No Roblox account is linked/) });
  });

  it("keeps a linked grant isolated during status, unlink, and disconnect", async () => {
    const { calls } = stubRoblox();
    const vault = await encryptedVault();
    const store = new InMemoryMcpAuthStore();
    const start = await submitLinkCode(vault, store, await createLinkCode(store));
    expect((await finishRobloxCallback(vault, start)).status).toBe(200);

    const crossSiteDisconnect = await handleRobloxOAuthRoute(new Request(`${ORIGIN}/oauth/roblox/logout`, {
      method: "POST", headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site", Accept: "application/json" },
    }), env(), CTX, deps(vault, store, SUBJECT_A));
    expect(crossSiteDisconnect?.status).toBe(403);

    const otherUserDisconnect = await handleRobloxOAuthRoute(new Request(`${ORIGIN}/oauth/roblox/logout`, {
      method: "POST", headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", Accept: "application/json" },
    }), env(), CTX, deps(vault, store, SUBJECT_B));
    expect(otherUserDisconnect?.status).toBe(200);
    expect(await otherUserDisconnect?.json()).toMatchObject({ disconnected: false, revocationAttempted: false });
    expect(calls.some((call) => call.url.includes("/token/revoke"))).toBe(false);

    const ownerDisconnect = await handleRobloxOAuthRoute(new Request(`${ORIGIN}/oauth/roblox/logout`, {
      method: "POST", headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", Accept: "application/json" },
    }), env(), CTX, deps(vault, store, SUBJECT_A));
    expect(ownerDisconnect?.status).toBe(200);
    expect(await ownerDisconnect?.json()).toMatchObject({ disconnected: true, revocationAttempted: true, revokedAtRoblox: true });
    expect(calls.some((call) => call.url.includes("/oauth/v1/token/revoke") && call.body?.token === REFRESH)).toBe(true);
    expect(await vault.vault.getAccount(robloxAccountKeyForSubjectHash(SUBJECT_A))).toBeNull();
    const ownerStatus = await handleRobloxOAuthRoute(new Request(`${ORIGIN}/oauth/roblox/status`, { headers: { Accept: "application/json" } }), env(), CTX, deps(vault, store, SUBJECT_A));
    expect(await ownerStatus?.json()).toMatchObject({ connected: false });
  });

  it("claims only the intended paths and fails closed without encrypted Durable Object storage", async () => {
    expect(isRobloxOAuthPath("/oauth/roblox/link")).toBe(true);
    expect(isRobloxOAuthPath("/oauth/roblox/start")).toBe(true);
    expect(isRobloxOAuthPath("/oauth/roblox/callback")).toBe(true);
    expect(isRobloxOAuthPath("/mcp")).toBe(false);
    const memory: VaultHandle = { vault: new AccountVault(new MemoryKv(), null, "memory"), mode: "memory", encryption: "none", reason: "test" };
    const response = await handleRobloxOAuthRoute(new Request(`${ORIGIN}/oauth/roblox/link`, { headers: { Accept: "application/json" } }), env(), CTX, deps(memory, new InMemoryMcpAuthStore()));
    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ error: "storage_unavailable" });
  });
});
