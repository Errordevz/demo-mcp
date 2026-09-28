/**
 * Roblox account-layer tests: token lifecycle (refresh, rotation, revocation,
 * 401/403/429/5xx), the Durable Object's atomic primitives, the MCP account
 * tools, and the invariant that no token or secret ever leaves the Worker — in a
 * response, a tool result, an HTML page or a log line.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountVault, MemoryKv, createVault, type VaultHandle } from "../src/roblox/store.js";
import { TokenCipher, sha256Hex } from "../src/roblox/crypto.js";
import { RobloxAccountClient } from "../src/roblox/client.js";
import { resolveRobloxConfig } from "../src/roblox/config.js";
import { handleRobloxOAuthRoute } from "../src/roblox/routes.js";
import { RobloxAuth } from "../src/roblox/do.js";
import { InMemoryMcpAuthStore } from "../src/auth/oauth-store.js";
import { robloxAccountKeyForSubjectHash } from "../src/auth/tool-auth.js";
import { describeRobloxCapabilities } from "../src/roblox/capabilities.js";
import worker, { DEMO_TOOL_NAMES, TOOL_COUNT } from "../index.js";
import platform from "../platform-entry.js";

const CTX = { waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined), passThroughOnException: () => undefined } as unknown as ExecutionContext;
const WORKER_ORIGIN = "https://demo.test";
const MCP_SUBJECT_A = "a".repeat(64);
const MCP_SUBJECT_B = "b".repeat(64);
const DEMO_TOKEN_FOR = (subjectHash: string) => `mcp-roblox-${subjectHash.slice(0, 48)}-test-token`;
const ACCESS = "AT.access-token-value-abcdefghijklmnop";
const REFRESH = "RT.refresh-token-value-abcdefghijklmnop";
const IDTOKEN = "ID.id-token-value-abcdefghijklmnopqrst";
const SECRET = "RBX-CR9-client-secret-value";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

interface RobloxStub {
  calls: Array<{ url: string; method: string; body: Record<string, string> | null; authorization: string | null }>;
  /** Scripted responses per pathname; each entry is shifted as it is consumed. */
  script(pathname: string, responses: Array<() => Response>): void;
}

function stubRoblox(initial: Record<string, Array<() => Response>> = {}): RobloxStub {
  const calls: RobloxStub["calls"] = [];
  const script: Record<string, Array<() => Response>> = {
    "/oauth/v1/token": [() => jsonResponse({ access_token: ACCESS, refresh_token: REFRESH, id_token: IDTOKEN, token_type: "Bearer", expires_in: 900, scope: "openid profile" })],
    "/oauth/v1/userinfo": [
      () =>
        jsonResponse({
          sub: "1516563360",
          name: "exampleuser",
          nickname: "exampleuser",
          preferred_username: "exampleuser",
          created_at: 1584682495,
          profile: "https://www.roblox.com/users/1516563360/profile",
          picture: "https://tr.rbxcdn.com/abc/150/150/AvatarHeadshot/Png",
        }),
    ],
    ...initial,
  };
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    calls.push({
      url: url.href,
      method: String(init?.method ?? "GET"),
      body: init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null,
      authorization: headers.get("authorization"),
    });
    const queue = script[url.pathname];
    if (!queue || queue.length === 0) {
      // Repeat the last scripted response, so a retry path is exercised too.
      if (url.pathname.startsWith("/cloud/v2/")) return jsonResponse({ data: [] });
      throw new Error(`unexpected fetch in roblox-account test: ${url.pathname}`);
    }
    return (queue.length > 1 ? queue.shift() : queue[0])!();
  });
  vi.stubGlobal("fetch", handler);
  return {
    calls,
    script(pathname, responses) {
      script[pathname] = responses;
    },
  };
}

async function makeVault(accountKey = "acct", cipher?: TokenCipher | null) {
  const kv = new MemoryKv();
  const resolved = cipher === undefined ? await TokenCipher.fromSecret("unit-test-token-key-value-123456") : cipher;
  return { kv, vault: new AccountVault(kv, resolved, "memory") };
}

async function seedAccount(vault: AccountVault, overrides: Record<string, unknown> = {}, tokens?: { accessToken: string; refreshToken: string | null; expiresAt: number; scopes: string[] }) {
  const sealed = await vault.sealTokens({
    accessToken: tokens?.accessToken ?? ACCESS,
    refreshToken: tokens?.refreshToken === undefined ? REFRESH : tokens.refreshToken,
    idToken: null,
    scopes: tokens?.scopes ?? ["openid", "profile"],
    expiresAt: tokens?.expiresAt ?? Date.now() + 900_000,
  });
  const record = {
    version: 1 as const,
    principalHash: "a".repeat(64),
    accountKey: "default",
    connectedAt: Date.now() - 60_000,
    updatedAt: Date.now() - 60_000,
    userId: "1516563360",
    displayName: "exampleuser",
    username: "exampleuser",
    profileUrl: "https://www.roblox.com/users/1516563360/profile",
    headshotUrl: null,
    accountCreatedAt: 1584682495,
    scopes: tokens?.scopes ?? ["openid", "profile"],
    scopesSource: "granted" as const,
    expiresAt: tokens?.expiresAt ?? Date.now() + 900_000,
    hasRefreshToken: (tokens?.refreshToken === undefined ? REFRESH : tokens.refreshToken) !== null,
    reauthorizationRequired: false,
    reauthorizationReason: null,
    lastRefreshAt: null,
    lastApiCallAt: null,
    clientIdHash: await sha256Hex("cid"),
    token: sealed,
    ...overrides,
  };
  await vault.putAccount(record);
  return record;
}

function clientFor(vault: AccountVault, env: Record<string, any>, overrides: Record<string, unknown> = {}, now?: () => number) {
  const config = resolveRobloxConfig({ ROBLOX_CLIENT_ID: "cid", ROBLOX_CLIENT_SECRET: SECRET, ...env } as never, `${WORKER_ORIGIN}/oauth/roblox/start`);
  for (const [key, value] of Object.entries(overrides)) (config as unknown as Record<string, unknown>)[key] = value;
  return new RobloxAccountClient({ env: { ROBLOX_CLIENT_ID: "cid", ROBLOX_CLIENT_SECRET: SECRET, ...env } as never, config, vault, now });
}

/* ---------------------------------------------------------------- token life */

describe("token lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refreshes an expired access token and persists the rotated refresh token", async () => {
    const stub = stubRoblox();
    const { vault } = await makeVault();
    const record = await seedAccount(vault, {}, { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: Date.now() - 1_000, scopes: ["openid", "profile"] });
    expect(record.expiresAt).toBeLessThan(Date.now());
    const NEW_REFRESH = "RT.rotated-refresh-token-000000000000";
    stub.script("/oauth/v1/token", [() => jsonResponse({ access_token: "AT.rotated", refresh_token: NEW_REFRESH, expires_in: 900, scope: "openid profile" })]);

    const client = clientFor(vault, {});
    const session = await client.authorize("default");
    expect(session.accessToken).toBe("AT.rotated");
    expect(session.refreshed).toBe(true);
    expect(stub.calls[0].body).toMatchObject({ grant_type: "refresh_token", client_id: "cid" });
    expect(stub.calls[0].url).toBe("https://apis.roblox.com/oauth/v1/token");

    const stored = await vault.getAccount("default");
    expect(stored?.expiresAt).toBeGreaterThan(Date.now());
    expect(stored?.lastRefreshAt).toBeTypeOf("number");
    expect(stored?.reauthorizationRequired).toBe(false);
    // Rotation must be persisted: the old single-use refresh token is gone.
    const opened = await vault.openTokens(stored?.token);
    expect(opened?.refreshToken).toBe(NEW_REFRESH);
    expect(JSON.stringify(await (vault as any).kv.snapshot())).not.toContain(REFRESH);
  });

  it("keeps a valid token and does not refresh early", async () => {
    const stub = stubRoblox();
    const { vault } = await makeVault();
    await seedAccount(vault);
    const client = clientFor(vault, {}, { tokenSkewSeconds: 60 });
    const session = await client.authorize("default");
    expect(session.accessToken).toBe(ACCESS);
    expect(stub.calls.length).toBe(0);
  });

  it("treats a refused refresh as reauthorization required and drops the credentials", async () => {
    const stub = stubRoblox({ "/oauth/v1/token": [() => jsonResponse({ error: "invalid_grant" }, 400)] });
    const { vault } = await makeVault();
    await seedAccount(vault, {}, { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: Date.now() - 1, scopes: ["openid", "profile"] });
    const client = clientFor(vault, {});
    await expect(client.authorize("default")).rejects.toMatchObject({ code: "reauthorization_required", status: 401 });
    const stored = await vault.getAccount("default");
    expect(stored?.reauthorizationRequired).toBe(true);
    expect(stored?.token).toBeNull();
    expect(stored?.userId).toBe("1516563360"); // profile metadata survives, credentials do not
    await expect(client.authorize("default")).rejects.toMatchObject({ code: "reauthorization_required" });
    expect(stub.calls.length).toBe(1);
  });

  it("does not silently degrade when no refresh token exists", async () => {
    const { vault } = await makeVault();
    await seedAccount(vault, { hasRefreshToken: false }, { accessToken: ACCESS, refreshToken: null, expiresAt: Date.now() - 1, scopes: ["openid"] });
    const client = clientFor(vault, {});
    await expect(client.authorize("default")).rejects.toMatchObject({
      code: "reauthorization_required",
      hint: expect.stringMatching(/\/oauth\/roblox\/link/),
    });
  });

  it("retries a 401 once after forcing a refresh", async () => {
    let tokenCalls = 0;
    const stub = stubRoblox({
      "/cloud/v2/users/1516563360": [() => jsonResponse({ errors: [{ code: "Unauthorized" }] }, 401), () => jsonResponse({ id: "1516563360", name: "@exampleuser", displayName: "exampleuser", about: "hi" })],
      "/oauth/v1/token": [
        () => {
          tokenCalls++;
          return jsonResponse({ access_token: `AT.rotated${tokenCalls}`, refresh_token: REFRESH, expires_in: 900, scope: "openid profile user.advanced:read" });
        },
      ],
    });
    const { vault } = await makeVault();
    await seedAccount(vault, { scopes: ["openid", "profile", "user.advanced:read"] });
    const client = clientFor(vault, {});
    const result = await client.extendedProfile("default");
    expect(result).toMatchObject({ displayName: "exampleuser" });
    expect(tokenCalls).toBe(1);
    expect(stub.calls.filter((call) => call.url.includes("/cloud/v2/users/"))).toHaveLength(2);
  });

  it("honours a short Retry-After once, then reports the limit", async () => {
    const { vault } = await makeVault();
    await seedAccount(vault, { scopes: ["openid", "profile", "user.inventory-item:read"] });
    const stub = stubRoblox({
      "/cloud/v2/users/1516563360/inventory-items": [
        () => jsonResponse({ errors: [{ code: "RateLimited" }] }, 429, { "retry-after": "1" }),
        () => jsonResponse({ errors: [{ code: "RateLimited" }] }, 429, { "retry-after": "1" }),
      ],
    });
    const client = clientFor(vault, {});
    await expect(client.inventory("default")).rejects.toMatchObject({ code: "rate_limited", retryable: true });
    expect(stub.calls.filter((call) => call.url.includes("inventory-items"))).toHaveLength(2);
  });

  it("retries a 5xx once for an idempotent read", async () => {
    const { vault } = await makeVault();
    await seedAccount(vault);
    const stub = stubRoblox({
      "/cloud/v2/users/1516563360/inventory-items": [
        () => jsonResponse({ errors: [{ code: "Internal" }] }, 503),
        () => jsonResponse({ inventoryItems: [{ path: "users/1/inventory-items/x", assetDetails: { assetId: "1028595", inventoryItemAssetType: "CLASSIC_TSHIRT" } }], nextPageToken: "" }),
      ],
    });
    const client = clientFor(vault, {}, { openCloudRatePerMinute: 10 }, undefined);
    // Grant the inventory scope on the stored record so the call is allowed.
    const stored = await vault.getAccount("default");
    await vault.putAccount({ ...stored!, scopes: ["openid", "profile", "user.inventory-item:read"] });
    const result = await client.inventory("default");
    expect((result as any).inventoryItems).toHaveLength(1);
    expect(stub.calls.filter((call) => call.url.includes("inventory-items"))).toHaveLength(2);
  });

  it("refuses an action whose scope was never granted, without calling Roblox", async () => {
    const stub = stubRoblox();
    const { vault } = await makeVault();
    await seedAccount(vault, { scopes: ["openid", "profile"] });
    const client = clientFor(vault, {});
    await expect(client.inventory("default")).rejects.toMatchObject({
      code: "insufficient_scope",
      hint: expect.stringMatching(/Add the scope to the Roblox app/),
    });
    expect(stub.calls.filter((call) => call.url.includes("/cloud/v2/"))).toHaveLength(0);
  });

  it("never aims a stored token at another user's inventory", async () => {
    const { vault } = await makeVault();
    await seedAccount(vault, { scopes: ["openid", "profile", "user.inventory-item:read"] });
    const stub = stubRoblox({ "/cloud/v2/users/1516563360/inventory-items": [() => jsonResponse({ inventoryItems: [], nextPageToken: "" })] });
    const client = clientFor(vault, {});
    await client.inventory("default", { maxPageSize: 10 });
    expect(stub.calls[0].url).toContain("/cloud/v2/users/1516563360/inventory-items");
    expect(stub.calls[0].url).not.toContain("9999999");
    // The client has no API that accepts a caller-supplied user id at all.
    expect(Object.getOwnPropertyNames(RobloxAccountClient.prototype)).not.toContain("inventoryForUser");
  });

  it("self-limits Open Cloud calls below Roblox's published rate", async () => {
    const { vault } = await makeVault();
    await seedAccount(vault, { scopes: ["openid", "profile", "user.inventory-item:read"] });
    stubRoblox({ "/cloud/v2/users/1516563360/inventory-items": [() => jsonResponse({ inventoryItems: [], nextPageToken: "" })] });
    const client = clientFor(vault, {}, { openCloudRatePerMinute: 2 });
    await client.inventory("default");
    await client.inventory("default");
    await expect(client.inventory("default")).rejects.toMatchObject({
      code: "rate_limited",
      hint: expect.stringMatching(/20\/minute for inventory reads/),
    });
  });

  it("keeps ciphertext at rest even when the client is the reader", async () => {
    const { kv, vault } = await makeVault();
    await seedAccount(vault);
    const client = clientFor(vault, {});
    const snapshot = JSON.stringify(kv.snapshot());
    expect(snapshot).not.toContain(ACCESS);
    expect(snapshot).not.toContain(REFRESH);
    expect(snapshot).toContain('"algorithm":"AES-GCM"');
    const session = await client.authorize("default");
    expect(session.accessToken).toBe(ACCESS);
  });

  it("disconnects, revoking at Roblox and clearing state", async () => {
    const stub = stubRoblox({ "/oauth/v1/token/revoke": [() => new Response(null, { status: 200 })] });
    const { vault } = await makeVault();
    const { sessionId } = await vault.createSession("default", 600);
    await seedAccount(vault);
    const client = clientFor(vault, {});
    const result = await client.disconnect("default", { sessionId });
    expect(result).toMatchObject({ disconnected: true, revocationAttempted: true, revoked: true });
    expect(stub.calls[0].url).toBe("https://apis.roblox.com/oauth/v1/token/revoke");
    expect(stub.calls[0].body?.token).toBe(REFRESH);
    expect(await vault.getAccount("default")).toBeNull();
    expect(await vault.resolveSession(sessionId)).toBeNull();
    void IDTOKEN;
  });

  it("still logs the user out when Roblox cannot be reached", async () => {
    const { vault } = await makeVault();
    await seedAccount(vault);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ETIMEDOUT");
      }),
    );
    const client = clientFor(vault, {});
    const result = await client.disconnect("default");
    expect(result).toMatchObject({ disconnected: true, revocationAttempted: true, revoked: false });
    expect(await vault.getAccount("default")).toBeNull();
  });
});

/* --------------------------------------------------- Durable Object storage */

function fakeDoContext() {
  const store = new Map<string, unknown>();
  let alarms = 0;
  // Mirror the Durable Object guarantee: while one handler runs inside
  // blockConcurrencyWhile, others wait instead of interleaving at await points.
  let lock: Promise<unknown> = Promise.resolve();
  const ctx = {
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>): Promise<T> => {
      const run = lock.then(fn);
      lock = run.catch(() => undefined);
      return await run;
    },
    storage: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: unknown) => void store.set(key, structuredClone(value)),
      delete: async (key: string) => store.delete(key),
      list: async (options: { prefix?: string; limit?: number } = {}) => {
        const out = new Map<string, unknown>();
        for (const [key, value] of store) {
          if (options.prefix && !key.startsWith(options.prefix)) continue;
          out.set(key, structuredClone(value));
          if (options.limit && out.size >= options.limit) break;
        }
        return out;
      },
      setAlarm: async () => void alarms++,
      getAlarm: async () => null,
    },
  };
  return { ctx: ctx as never, store, get alarms() { return alarms; } };
}

describe("RobloxAuth Durable Object", () => {
  it("redeems a pending state once even under a race", async () => {
    const { ctx, store } = fakeDoContext();
    const doInstance = new RobloxAuth(ctx, {} as never);
    await doInstance.write("pending:hash1", { version: 1, expiresAt: Date.now() + 60_000 });
    const [first, second] = await Promise.all([doInstance.takePending("hash1"), doInstance.takePending("hash1")]);
    expect(first.pending).not.toBeNull();
    expect(second.pending).toBeNull();
    // The loser gets no state (so nothing can be redeemed twice) and an honest
    // "already used" tombstone instead of a vague "unknown".
    expect(second.tombstone).toMatchObject({ usedAt: expect.any(Number) });
    expect([...store.keys()]).toContain("used:hash1");
  });

  it("serializes the rate limit counter", async () => {
    const { ctx } = fakeDoContext();
    const doInstance = new RobloxAuth(ctx, {} as never);
    const results = await Promise.all(Array.from({ length: 8 }, () => doInstance.charge("limit:oauth:start:ip", 5, 60_000)));
    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results.find((result) => !result.allowed)?.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("grants a refresh lease to exactly one caller", async () => {
    const { ctx } = fakeDoContext();
    const doInstance = new RobloxAuth(ctx, {} as never);
    expect(await doInstance.acquireRefreshLease("default", "owner-a")).toMatchObject({ acquired: true });
    expect(await doInstance.acquireRefreshLease("default", "owner-b")).toMatchObject({ acquired: false });
    await doInstance.releaseRefreshLease("default", "owner-a");
    expect(await doInstance.acquireRefreshLease("default", "owner-b")).toMatchObject({ acquired: true });
  });

  it("forgets an account and its lease", async () => {
    const { ctx, store } = fakeDoContext();
    const doInstance = new RobloxAuth(ctx, {} as never);
    await doInstance.write("account:default", { version: 1 });
    await doInstance.acquireRefreshLease("default", "owner");
    const result = await doInstance.forgetAccount("default");
    expect(result.removed).toBe(1);
    expect([...store.keys()].filter((key) => key.startsWith("account:"))).toHaveLength(0);
  });

  it("schedules and runs an expiry sweep from its alarm", async () => {
    const { ctx, store } = fakeDoContext();
    const doInstance = new RobloxAuth(ctx, {} as never);
    await doInstance.write("pending:old", { version: 1, expiresAt: Date.now() - 1 });
    await doInstance.write("session:old", { version: 1, expiresAt: Date.now() - 1 });
    expect(store.size).toBe(2);
    await doInstance.alarm();
    expect(store.size).toBe(0);
    expect(doInstance.alarm).toBeTypeOf("function");
  });
});

/* ------------------------------------------------------------- vault factory */

describe("storage selection", () => {
  it("uses the Durable Object only when encryption is available", async () => {
    const withDo = { ROBLOX_TOKEN_KEY: "key-for-unit-tests-1234567890", ROBLOX_AUTH: { idFromName: (name: string) => name, get: (id: string) => ({ id }) } };
    const handle: VaultHandle = await createVault(withDo as never);
    expect(handle.mode).toBe("durable-object");
    expect(handle.encryption).toBe("aes-gcm-256");

    const noKey = await createVault({ ROBLOX_AUTH: withDo.ROBLOX_AUTH } as never);
    expect(noKey.mode).toBe("memory");
    expect(noKey.encryption).toBe("none");
    expect(noKey.reason).toMatch(/ROBLOX_TOKEN_KEY is not configured/);

    const noDo = await createVault({ ROBLOX_TOKEN_KEY: "key-for-unit-tests-1234567890" } as never);
    expect(noDo.mode).toBe("memory");
    expect(noDo.reason).toMatch(/ROBLOX_AUTH/);
  });
});

/* ------------------------------------------------------------------ routing */

describe("Worker routing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("fails closed on private Roblox status without Access while preserving public MCP routes", async () => {
    const env = { DEMO_PLATFORM_ORIGIN: "https://demo-platform.pages.dev" } as never;
    const status = await platform.fetch(new Request(`${WORKER_ORIGIN}/oauth/roblox/status`, { headers: { Accept: "application/json" } }), env, CTX);
    expect(status.status).toBe(401);
    expect(await status.json()).toMatchObject({ error: "unauthenticated" });

    const health = await platform.fetch(new Request(`${WORKER_ORIGIN}/health`), env, CTX);
    expect(health.status).toBe(200);
    const body = (await health.json()) as Record<string, any>;
    expect(body.robloxOAuthConfigured).toBe(false);
    expect(body.toolCount).toBe(TOOL_COUNT);

    // OAuth stays separate; ordinary MCP requests need no bearer.
    const mcp = await platform.fetch(new Request(`${WORKER_ORIGIN}/mcp`, {
      method: "POST",
      headers: { Host: new URL(WORKER_ORIGIN).host, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }), env, CTX);
    expect(mcp.status).toBe(200);
  });

  it("gives the inspector UI a Connect control for the identity-bound Roblox link form", async () => {
    const env = { DEMO_PLATFORM_ORIGIN: "https://demo-platform.pages.dev" } as never;
    const response = await platform.fetch(new Request(`${WORKER_ORIGIN}/`), env, CTX);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
    const html = await response.text();
    // The no-login dashboard opens the protected form; the user brings only the
    // short-lived code returned by roblox_account_link_start, never Roblox credentials.
    expect(html).toContain("Roblox account");
    expect(html).toContain('location.href=\'/oauth/roblox/link\'');
    expect(html).toContain("/oauth/roblox/status");
    expect(html).toContain("/oauth/roblox/logout");
    expect(html).toContain("redirectUri"); // the page shows the URL to register at Roblox
    // The page is static, so nothing can be rendered into it but the *names* of
    // variables to configure; no credential value may ever be assigned here.
    expect(html).not.toMatch(/(access_token|refresh_token|code_verifier|client_secret|state)\s*[:=]\s*["'`][^"'`]{6,}/i);
    expect(html).not.toMatch(/Set-Cookie/i);
  });

  it("refuses a cross-site fetch of an OAuth route but allows the navigation back from Roblox", async () => {
    const env = { ROBLOX_CLIENT_ID: "cid", ROBLOX_CLIENT_SECRET: SECRET } as never;
    const handle = async (): Promise<VaultHandle> => {
      const kv = new MemoryKv();
      const cipher = await TokenCipher.fromSecret("routing-test-key-1234567890abcdef");
      return { vault: new AccountVault(kv, cipher, "durable-object"), mode: "durable-object", encryption: "aes-gcm-256", reason: null };
    };
    const crossSite = await handleRobloxOAuthRoute(
      new Request(`${WORKER_ORIGIN}/oauth/roblox/status`, { headers: { Origin: "https://evil.test", "Sec-Fetch-Mode": "cors", Accept: "application/json" } }),
      env,
      CTX,
      { vault: await handle() },
    );
    expect(crossSite!.status).toBe(403);
    expect(await crossSite!.json()).toMatchObject({ error: "origin_mismatch" });

    const navigation = await handleRobloxOAuthRoute(new Request(`${WORKER_ORIGIN}/oauth/roblox/status`, { headers: { Origin: "https://www.roblox.com", "Sec-Fetch-Mode": "navigate", Accept: "text/html" } }), env, CTX, {
      vault: await handle(),
      identity: async () => ({ subjectHash: MCP_SUBJECT_A, issuer: "https://demo.cloudflareaccess.com" }),
    });
    expect(navigation!.status).toBe(200);
  });
});

/* --------------------------------------------------------------- MCP tools */

async function rpc(method: string, params: Record<string, unknown>, env: unknown, headers: Record<string, string> = {}) {
  const response = await worker.fetch(
    new Request("https://demo.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env as never,
    CTX,
  );
  const text = await response.text();
  if (text.trim().startsWith("{")) return JSON.parse(text);
  const dataLines = text.split("\n").filter((line) => line.startsWith("data:"));
  return JSON.parse(dataLines[dataLines.length - 1].slice(5).trim());
}

async function callTool(name: string, args: Record<string, unknown>, env: unknown, subjectHash = MCP_SUBJECT_A) {
  const token = DEMO_TOKEN_FOR(subjectHash);
  const response = await rpc("tools/call", { name, arguments: args }, env, { authorization: `Bearer ${token}` });
  expect(response.error).toBeUndefined();
  const text = (response.result?.content ?? []).map((entry: { text?: string }) => entry.text ?? "").join("\n");
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { isError: Boolean(response.result?.isError), text, parsed };
}

interface RobloxMcpHarness {
  env: Record<string, any>;
  mcpStore: InMemoryMcpAuthStore;
  robloxDo: RobloxAuth;
  robloxState: ReturnType<typeof fakeDoContext>;
}

async function addMcpPrincipal(harness: RobloxMcpHarness, subjectHash: string, scopes = ["roblox:read", "roblox:link", "roblox:disconnect"]): Promise<void> {
  const token = DEMO_TOKEN_FOR(subjectHash);
  const now = Date.now();
  await harness.mcpStore.putAccessToken(await sha256Hex(token), {
    version: 1,
    clientIdHash: await sha256Hex("https://chatgpt.com/oauth/client.json"),
    principalHash: subjectHash,
    scopes,
    audience: WORKER_ORIGIN,
    issuedAt: now,
    expiresAt: now + 15 * 60_000,
  });
}

async function makeRobloxMcpHarness(): Promise<RobloxMcpHarness> {
  const mcpStore = new InMemoryMcpAuthStore();
  const robloxState = fakeDoContext();
  const robloxDo = new RobloxAuth(robloxState.ctx, {} as never);
  const env: Record<string, any> = {
    MCP_PUBLIC_ORIGIN: WORKER_ORIGIN,
    MCP_AUTH_ACCESS_TEAM_DOMAIN: "demo.cloudflareaccess.com",
    MCP_AUTH_ACCESS_AUD: "test-access-audience",
    MCP_AUTH: { idFromName: (name: string) => name, get: () => mcpStore },
    ROBLOX_AUTH: { idFromName: (name: string) => name, get: () => robloxDo },
    ROBLOX_CLIENT_ID: "cid",
    ROBLOX_CLIENT_SECRET: SECRET,
    ROBLOX_TOKEN_KEY: "key-for-roblox-mcp-tests-0123456789abcdef",
    ROBLOX_OAUTH_SCOPES: "openid profile",
  };
  const harness = { env, mcpStore, robloxDo, robloxState };
  await addMcpPrincipal(harness, MCP_SUBJECT_A);
  return harness;
}

/** Complete both DEMO's user-bound link-code handoff and Roblox's official PKCE flow. */
async function connectAccount(scopes: string, subjectHash = MCP_SUBJECT_A, providedHarness?: RobloxMcpHarness) {
  const harness = providedHarness ?? await makeRobloxMcpHarness();
  await addMcpPrincipal(harness, subjectHash);
  harness.env.ROBLOX_OAUTH_SCOPES = scopes;

  const started = await callTool("roblox_account_link_start", {}, harness.env, subjectHash);
  expect(started.isError).toBe(false);
  const linkCode = started.parsed.linkCode as string;
  expect(linkCode).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
  const vault = await createVault(harness.env);
  const routeDeps = {
    vault,
    mcpAuthStore: harness.mcpStore,
    identity: async () => ({ subjectHash, issuer: "https://demo.cloudflareaccess.com" }),
  };
  const start = (await handleRobloxOAuthRoute(new Request(`${WORKER_ORIGIN}/oauth/roblox/start`, {
    method: "POST",
    headers: {
      Origin: WORKER_ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ link_code: linkCode }).toString(),
  }), harness.env, CTX, routeDeps))!;
  expect(start.status).toBe(302);
  const authorizeUrl = new URL(start.headers.get("Location")!);
  const state = authorizeUrl.searchParams.get("state")!;
  const stateCookie = start.headers.getSetCookie().find((cookie) => cookie.startsWith("roblox_oauth_state="))!.split(";")[0];
  const callback = (await handleRobloxOAuthRoute(new Request(`${WORKER_ORIGIN}/oauth/roblox/callback?code=authcode1234567890&state=${encodeURIComponent(state)}`, {
    headers: { Accept: "application/json", Cookie: stateCookie },
  }), harness.env, CTX, routeDeps))!;
  expect(callback.status).toBe(200);
  return { env: harness.env, harness, accountKey: robloxAccountKeyForSubjectHash(subjectHash), subjectHash };
}

describe("Roblox MCP account tools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("registers protected account tools beside public no-login Roblox lookups", async () => {
    for (const name of ["roblox_account_status", "roblox_account_link_start", "roblox_account_profile", "roblox_account_inventory", "roblox_account_avatar_thumbnail", "roblox_account_capabilities", "roblox_account_unlink"]) {
      expect(DEMO_TOOL_NAMES).toContain(name);
    }
    const harness = await makeRobloxMcpHarness();
    const response = await rpc("tools/list", {}, harness.env);
    const tools: Array<{ name: string; securitySchemes?: unknown }> = response.result?.tools ?? [];
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(tools).toHaveLength(TOOL_COUNT);
    expect(byName.get("roblox_user")?.securitySchemes).toEqual([{ type: "noauth" }]);
    expect(byName.get("roblox_game")?.securitySchemes).toEqual([{ type: "noauth" }]);
    expect(byName.get("roblox_account_status")?.securitySchemes).toEqual([{ type: "oauth2", scopes: ["roblox:read"] }]);
    expect(byName.get("roblox_account_link_start")?.securitySchemes).toEqual([{ type: "oauth2", scopes: ["roblox:link"] }]);
    expect(byName.get("roblox_account_unlink")?.securitySchemes).toEqual([{ type: "oauth2", scopes: ["roblox:disconnect"] }]);

    const ping = await rpc("tools/call", { name: "demo_ping", arguments: {} }, harness.env);
    expect(ping.result.isError).not.toBe(true);
    expect(JSON.parse(ping.result.content[0].text)).toMatchObject({ ok: true, name: "DEMO" });
  });

  it("returns a scoped OAuth challenge for account data without a DEMO bearer", async () => {
    const harness = await makeRobloxMcpHarness();
    const response = await rpc("tools/call", { name: "roblox_account_status", arguments: {} }, harness.env);
    const text = response.result.content.map((entry: { text: string }) => entry.text).join("");
    expect(text).toMatch(/invalid_token/);
    expect(response.result._meta["mcp/www_authenticate"][0]).toContain('resource_metadata="https://demo.test/.well-known/oauth-protected-resource"');
    expect(text).not.toMatch(/userId|1516563360/);
  });

  it("reports the authenticated user's linked account without any Roblox token material", async () => {
    stubRoblox();
    const { env } = await connectAccount("openid profile");
    const result = await callTool("roblox_account_status", {}, env);
    expect(result.isError).toBe(false);
    expect(result.parsed).toMatchObject({ connected: true, userId: "1516563360", displayName: "exampleuser", username: "exampleuser", canRefresh: true, credentialsReturnedToClient: false });
    expect(result.parsed.grantedScopes).toEqual(["openid", "profile"]);
    expect(result.parsed.storage).toMatchObject({ mode: "durable-object", encryption: "aes-gcm-256" });
    for (const secret of [ACCESS, REFRESH, IDTOKEN, SECRET]) expect(result.text).not.toContain(secret);
    expect(result.text).not.toMatch(/access_token|refresh_token|id_token/i);
  });

  it("does not accept tool-supplied account ids or selectors", async () => {
    stubRoblox();
    const { env } = await makeRobloxMcpHarness();
    const result = await callTool("roblox_account_status", { account: "../../other-user", userId: "1516563360" }, env);
    expect(result.isError).toBe(false);
    expect(result.parsed.connected).toBe(false);
    expect(result.parsed.userId).toBeUndefined();
  });

  it("reads the authenticated user's live profile with the server-side Roblox token", async () => {
    const stub = stubRoblox();
    const { env } = await connectAccount("openid profile");
    const result = await callTool("roblox_account_profile", {}, env);
    expect(result.parsed.profile).toMatchObject({ userId: "1516563360", displayName: "exampleuser", username: "exampleuser" });
    expect(result.parsed.identityNote).toMatch(/stable account id/);
    const userinfo = stub.calls.filter((call) => call.url.includes("/oauth/v1/userinfo"));
    expect(userinfo.at(-1)?.authorization).toBe(`Bearer ${ACCESS}`);
    expect(result.text).not.toContain(ACCESS);
  });

  it("marks a Roblox API scope as insufficient rather than trying a workaround", async () => {
    stubRoblox();
    const { env } = await connectAccount("openid profile");
    const result = await callTool("roblox_account_inventory", {}, env);
    expect(result.isError).toBe(true);
    expect(result.parsed.error).toBe("insufficient_scope");
    expect(result.parsed.message).toMatch(/user\.inventory-item:read/);
    expect(result.parsed.hint).toMatch(/reconnect/i);
  });

  it("reads inventory only after that Roblox scope was separately granted", async () => {
    const stub = stubRoblox({
      "/oauth/v1/token": [() => jsonResponse({ access_token: ACCESS, refresh_token: REFRESH, token_type: "Bearer", expires_in: 900, scope: "openid profile user.inventory-item:read" })],
      "/cloud/v2/users/1516563360/inventory-items": [
        () => jsonResponse({
          inventoryItems: [{ path: "users/1516563360/inventory-items/x", assetDetails: { assetId: "1028595", inventoryItemAssetType: "CLASSIC_TSHIRT", instanceId: "200105119388" } }],
          nextPageToken: "",
        }),
      ],
    });
    const { env } = await connectAccount("openid profile user.inventory-item:read");
    const result = await callTool("roblox_account_inventory", { assertAssetIds: [1028595, 9999999] }, env);
    expect(result.isError).toBe(false);
    expect(result.parsed.itemCount).toBe(1);
    expect(result.parsed.ownership).toEqual([
      { assetId: 1028595, owned: true },
      { assetId: 9999999, owned: false },
    ]);
    expect(stub.calls.some((call) => decodeURIComponent(call.url).includes("assetIds=1028595,9999999"))).toBe(true);
  });

  it("reports unsupported actions and confirms encrypted Durable Object storage", async () => {
    stubRoblox();
    const { env } = await connectAccount("openid profile");
    const result = await callTool("roblox_account_capabilities", {}, env);
    const entries: Array<{ action: string; status: string; note: string }> = result.parsed.support;
    const notSupported = entries.filter((entry) => entry.status === "not_supported");
    expect(notSupported.length).toBeGreaterThanOrEqual(5);
    expect(notSupported.some((entry) => /experiences/.test(entry.action))).toBe(true);
    expect(notSupported.some((entry) => /Robux balance/.test(entry.action))).toBe(true);
    expect(notSupported.some((entry) => /friends/.test(entry.action))).toBe(true);
    expect(JSON.stringify(result.parsed.refusals)).toMatch(/\.ROBLOSECURITY/);
    expect(result.parsed.storage.encryption).toBe("aes-gcm-256");
    expect(result.parsed.storage.mode).toBe("durable-object");
  });

  it("describes capabilities honestly when nothing is configured", () => {
    const report = describeRobloxCapabilities({
      config: {
        enabled: false,
        disabledReason: "ROBLOX_CLIENT_SECRET is not configured on this Worker (it must be a secret, not a plain variable).",
        scopes: ["openid", "profile"],
        unrecognizedScopes: [],
        redirectUri: `${WORKER_ORIGIN}/oauth/roblox/callback`,
        stateTtlSeconds: 600,
        rateLimitPerMinute: 20,
        openCloudRatePerMinute: 10,
        storageMode: "durable-object",
        encryption: "aes-gcm-256",
        encryptionReason: null,
      },
      account: null,
    });
    expect(report.configured).toBe(false);
    expect(report.flow.secretsInUrls).toBe(false);
    expect(report.flow.passwordOrCookieFlow).toBe(false);
    expect(report.separation.publicTools.authenticated).toBe(false);
    expect(report.separation.accountTools.authenticated).toBe(true);
    expect(report.refusals.join(" ")).toMatch(/CAPTCHA/);
  });

  it("isolates status and disconnect per verified DEMO subject", async () => {
    stubRoblox({ "/oauth/v1/token/revoke": [() => new Response(null, { status: 200 })] });
    const harness = await makeRobloxMcpHarness();
    const { env } = await connectAccount("openid profile", MCP_SUBJECT_A, harness);
    await addMcpPrincipal(harness, MCP_SUBJECT_B);

    const otherStatus = await callTool("roblox_account_status", {}, env, MCP_SUBJECT_B);
    expect(otherStatus.parsed.connected).toBe(false);
    expect(otherStatus.parsed.userId).toBeUndefined();
    const otherDisconnect = await callTool("roblox_account_unlink", {}, env, MCP_SUBJECT_B);
    expect(otherDisconnect.parsed).toMatchObject({ disconnected: false, revocationAttempted: false });
    expect(harness.robloxState.store.has(`account:${robloxAccountKeyForSubjectHash(MCP_SUBJECT_A)}`)).toBe(true);

    const ownerStatus = await callTool("roblox_account_status", {}, env, MCP_SUBJECT_A);
    expect(ownerStatus.parsed.connected).toBe(true);
    const ownerDisconnect = await callTool("roblox_account_unlink", {}, env, MCP_SUBJECT_A);
    expect(ownerDisconnect.parsed).toMatchObject({ disconnected: true, revokedAtRoblox: true, revocationAttempted: true });
    expect(harness.robloxState.store.has(`account:${robloxAccountKeyForSubjectHash(MCP_SUBJECT_A)}`)).toBe(false);
    const after = await callTool("roblox_account_status", {}, env, MCP_SUBJECT_A);
    expect(after.parsed.connected).toBe(false);
  });

  it("refreshes an expired token during the owner's tool call and atomically rotates it", async () => {
    const stub = stubRoblox({
      "/oauth/v1/token": [() => jsonResponse({ access_token: "AT.second", refresh_token: "RT.second", token_type: "Bearer", expires_in: 900, scope: "openid profile" })],
    });
    const { env, accountKey } = await connectAccount("openid profile");
    const handle = await createVault(env);
    const record = (await handle.vault.getAccount(accountKey))!;
    const sealed = await handle.vault.sealTokens({ accessToken: ACCESS, refreshToken: REFRESH, idToken: null, scopes: ["openid", "profile"], expiresAt: Date.now() - 5_000 });
    await handle.vault.putAccount({ ...record, token: sealed, expiresAt: Date.now() - 5_000 });

    const result = await callTool("roblox_account_profile", {}, env);
    expect(result.isError).toBe(false);
    expect(stub.calls.some((call) => call.body?.grant_type === "refresh_token")).toBe(true);
    const refreshed = (await handle.vault.getAccount(accountKey))!;
    expect(await handle.vault.openTokens(refreshed.token)).toMatchObject({ refreshToken: "RT.second", accessToken: "AT.second" });
    expect(await handle.vault.openTokens(refreshed.token)).not.toMatchObject({ accessToken: ACCESS });
    expect(result.text).not.toContain("AT.second");
  });

  it("never writes Roblox tokens to the console during the full dual-OAuth flow", async () => {
    stubRoblox();
    const lines: string[] = [];
    const capture = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    try {
      const { env } = await connectAccount("openid profile");
      await callTool("roblox_account_profile", {}, env);
      await callTool("roblox_account_unlink", {}, env);
    } finally {
      vi.restoreAllMocks();
    }
    const dump = lines.join("\n");
    for (const secret of [ACCESS, REFRESH, IDTOKEN, SECRET]) expect(dump).not.toContain(secret);
    expect(dump).not.toMatch(/Bearer /);
    expect(dump).not.toMatch(/roblox_session=/);
  });
});
