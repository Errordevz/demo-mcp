/**
 * Roblox OAuth protocol tests.
 *
 * Everything here runs against a stubbed `fetch`, so no Roblox traffic (and no
 * real credentials) is involved: the assertions are about *our* behaviour —
 * PKCE, state-vault semantics, config validation, token exchange, userinfo, and
 * secret handling. Identity-bound browser routes and per-user isolation are tested
 * in tests/roblox-routes.test.ts; no live Roblox credentials are used here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPkcePair, sha256Hex, verifyPkcePair } from "../src/roblox/crypto.js";
import { buildAuthorizeUrl, normalizePrompt, readCallbackParams } from "../src/roblox/oauth.js";
import { normalizeScopes, resolveRobloxConfig } from "../src/roblox/config.js";
import { AccountVault, MemoryKv } from "../src/roblox/store.js";
import { TokenCipher, randomOpaqueToken } from "../src/roblox/crypto.js";
import { exchangeAuthorizationCode, fetchUserInfo, revokeAuthorization, sanitizeProviderError } from "../src/roblox/oauth.js";

const WORKER_ORIGIN = "https://demo-mcp.test.workers.dev";

function baseEnv(overrides: Record<string, unknown> = {}) {
  return {
    ROBLOX_CLIENT_ID: "840974200211308101",
    ROBLOX_CLIENT_SECRET: "RBX-CR9-secret-value",
    ROBLOX_OAUTH_SCOPES: "openid profile",
    ...overrides,
  } as Record<string, any>;
}

/** JSON response helper for the stub. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface StubOptions {
  tokenResponse?: unknown;
  tokenStatus?: number;
  userinfo?: unknown;
  userinfoStatus?: number;
  revokeStatus?: number;
}

/** Fake Roblox OAuth server. Records every request it receives. */
function stubRoblox(options: StubOptions = {}) {
  const calls: Array<{ url: string; method: string; body: Record<string, string> | null; authorization: string | null }> = [];
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : null;
    calls.push({ url: url.href, method: String(init?.method ?? "GET"), body, authorization: new Headers(init?.headers as HeadersInit | undefined).get("authorization") });
    if (url.pathname === "/oauth/v1/token") {
      if (options.tokenStatus) return jsonResponse(options.tokenResponse ?? { error: "invalid_grant" }, options.tokenStatus);
      return jsonResponse(
        options.tokenResponse ?? {
          access_token: "AT.access-token-value",
          refresh_token: "RT.refresh-token-value",
          id_token: "ID.id-token-value",
          token_type: "Bearer",
          expires_in: 900,
          scope: "openid profile",
        },
      );
    }
    if (url.pathname === "/oauth/v1/userinfo") {
      if (options.userinfoStatus) return jsonResponse({ errors: [{ code: "Unauthorized" }] }, options.userinfoStatus);
      return jsonResponse(
        options.userinfo ?? {
          sub: "1516563360",
          name: "exampleuser",
          nickname: "exampleuser",
          preferred_username: "exampleuser",
          created_at: 1584682495,
          profile: "https://www.roblox.com/users/1516563360/profile",
          picture: "https://tr.rbxcdn.com/abc/150/150/AvatarHeadshot/Png",
        },
      );
    }
    if (url.pathname === "/oauth/v1/token/revoke") {
      return new Response(null, { status: options.revokeStatus ?? 200 });
    }
    throw new Error(`unexpected fetch in roblox-oauth test: ${url.href}`);
  });
  vi.stubGlobal("fetch", handler);
  return { calls, handler };
}

describe("PKCE and authorization URL", () => {
  it("produces an RFC 7636 verifier and an S256 challenge", async () => {
    const { verifier, challenge, method } = await createPkcePair();
    expect(method).toBe("S256");
    expect(verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await verifyPkcePair(verifier, challenge)).toBe(true);
  });

  it("agrees with an independent SHA-256/base64url implementation", async () => {
    // Cross-checked against Node's own crypto (an unrelated implementation of the
    // same RFC 7636 construction), which is what Roblox will recompute server-side.
    const { createHash } = await import("node:crypto");
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXK";
    const expected = createHash("sha256").update(verifier).digest("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    expect(await verifyPkcePair(verifier, expected)).toBe(true);
    // A verifier that is not the one hashed must never validate.

    expect(await verifyPkcePair("another-verifier-that-is-at-least-43-characters-long!!", expected)).toBe(false);
  });

  it("builds a consent URL with the minimum scopes, state and PKCE - and no secret", () => {
    const config = resolveRobloxConfig(baseEnv(), `${WORKER_ORIGIN}/oauth/roblox/start`);
    const url = buildAuthorizeUrl({ config, state: "state-value-abcdef-0123456789", codeChallenge: "challenge-value", codeChallengeMethod: "S256", prompt: null });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://apis.roblox.com/oauth/v1/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("840974200211308101");
    expect(parsed.searchParams.get("redirect_uri")).toBe(`${WORKER_ORIGIN}/oauth/roblox/callback`);
    expect(parsed.searchParams.get("scope")).toBe("openid profile");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBe("state-value-abcdef-0123456789");
    expect(parsed.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{16,256}$/);
    // The whole point of PKCE for a confidential client: the secret never enters a URL.
    expect(url).not.toContain("RBX-CR9-secret-value");
    expect(parsed.searchParams.has("client_secret")).toBe(false);
    // No nonce: identity is proven with /userinfo, not by trusting an ID token.
    expect(parsed.searchParams.has("nonce")).toBe(false);
  });

  it("accepts only documented prompt values", () => {
    expect(normalizePrompt("consent")).toBe("consent");
    expect(normalizePrompt("select_account")).toBe("select_account");
    expect(normalizePrompt("consent+login")).toBe("consent login");
    expect(() => normalizePrompt("skip_captcha")).toThrow(/Unsupported prompt/);
    expect(normalizePrompt(null)).toBeNull();
  });

  it("rejects a callback payload that is not shaped like Roblox's", () => {
    const parsed = readCallbackParams(`${WORKER_ORIGIN}/oauth/roblox/callback?code=ok&state=<script>alert(1)</script>`);
    expect(parsed.code).toBeNull();
    expect(parsed.state).toBeNull();
    const denial = readCallbackParams(`${WORKER_ORIGIN}/oauth/roblox/callback?error=access_denied&error_description=User+declined`);
    expect(denial.error).toBe("access_denied");
    expect(denial.errorDescription).toBe("User declined");
  });
});

describe("scope policy", () => {
  it("defaults to the minimum identity scopes", () => {
    expect(normalizeScopes(undefined).scopes).toEqual(["openid", "profile"]);
  });

  it("adds openid when a caller asks for profile alone", () => {
    expect(normalizeScopes("profile").scopes).toEqual(["openid", "profile"]);
  });

  it("refuses to run without openid, and flags undocumented scopes", () => {
    expect(() => normalizeScopes("user.inventory-item:read profile")).not.toThrow();
    expect(() => normalizeScopes("asset:read")).toThrow(/must include openid/);
    const result = normalizeScopes("openid profile user.inventory-item:read made-up:scope");
    expect(result.scopes).toContain("user.inventory-item:read");
    expect(result.unrecognized).toEqual(["made-up:scope"]);
  });

  it("rejects a syntactically invalid scope list", () => {
    expect(() => normalizeScopes("openid; DROP TABLE")).toThrow(/invalid scope name/);
  });
});

describe("state vault: expiry, replay, binding", () => {
  let kv: MemoryKv;
  let vault: AccountVault;

  beforeEach(() => {
    kv = new MemoryKv();
    vault = new AccountVault(kv, null, "memory");
  });

  async function begin(ttlSeconds = 600) {
    const bindingHash = await sha256Hex("browser-binding");
    const result = await vault.beginAuthorization({
      accountKey: "default",
      redirectUri: `${WORKER_ORIGIN}/oauth/roblox/callback`,
      scopes: ["openid", "profile"],
      host: new URL(WORKER_ORIGIN).host,
      codeVerifier: "verifier-value-that-is-long-enough-for-pkce-43",
      stateTtlSeconds: ttlSeconds,
      bindingHash,
    });
    return result;
  }

  it("never stores the raw state value, only its hash", async () => {
    const { state, stateHash } = await begin();
    const snapshot = JSON.stringify(kv.snapshot());
    expect(snapshot).not.toContain(state);
    expect(snapshot).toContain(stateHash);
  });

  it("redeems a state exactly once and reports a replay", async () => {
    const { state } = await begin();
    const first = await vault.consumeAuthorization(state, await sha256Hex("browser-binding"));
    expect(first.status).toBe("ok");
    const second = await vault.consumeAuthorization(state, await sha256Hex("browser-binding"));
    expect(second.status).toBe("replayed");
  });

  it("refuses an unknown state", async () => {
    const outcome = await vault.consumeAuthorization(randomOpaqueToken(32), await sha256Hex("browser-binding"));
    expect(outcome.status).toBe("unknown");
  });

  it("refuses an expired state", async () => {
    const { state, stateHash } = await begin();
    const key = AccountVault.pendingKey(stateHash);
    const record = (await kv.get<any>(key))!;
    await kv.put(key, { ...record, expiresAt: Date.now() - 1_000 });
    const outcome = await vault.consumeAuthorization(state, await sha256Hex("browser-binding"));
    expect(outcome.status).toBe("expired");
  });

  it("refuses a state redeemed by a different browser", async () => {
    const { state } = await begin();
    const outcome = await vault.consumeAuthorization(state, await sha256Hex("some-other-browser"));
    expect(outcome.status).toBe("binding_mismatch");
    // The record is burned even when the binding is wrong, so a probe cannot
    // leave a live state behind for a later guess.
    expect((await vault.consumeAuthorization(state, await sha256Hex("browser-binding"))).status).toBe("replayed");
  });

  it("refuses a state redeemed without a binding at all", async () => {
    const { state } = await begin();
    expect((await vault.consumeAuthorization(state, "")).status).toBe("binding_mismatch");
  });

  it("encrypts token material and never writes it in the clear", async () => {
    const cipher = await TokenCipher.fromSecret("c2VjcmV0LWtleS1zZWNyZXQta2V5LXNlY3JldC1r");
    const encrypted = new AccountVault(new MemoryKv(), cipher, "durable-object");
    const sealed = await encrypted.sealTokens({
      accessToken: "AT.super-secret-access-token",
      refreshToken: "RT.super-secret-refresh-token",
      idToken: null,
      scopes: ["openid"],
      expiresAt: Date.now() + 900_000,
    });
    expect(sealed.sealed).toBeTruthy();
    expect(sealed.sealed).not.toContain("super-secret");
    const opened = await encrypted.openTokens(sealed);
    expect(opened?.accessToken).toBe("AT.super-secret-access-token");
    expect(opened?.refreshToken).toBe("RT.super-secret-refresh-token");
  });

  it("refuses to persist plaintext tokens in durable storage", async () => {
    const noCipher = new AccountVault(new MemoryKv(), null, "durable-object");
    await expect(noCipher.sealTokens({ accessToken: "x", refreshToken: null, idToken: null, scopes: [], expiresAt: 0 })).rejects.toThrow(/without encryption/);
    await expect(noCipher.beginAuthorization({
      accountKey: "default",
      redirectUri: "https://x.test/cb",
      scopes: ["openid"],
      host: "x.test",
      codeVerifier: "v",
      stateTtlSeconds: 600,
      bindingHash: "h",
    })).rejects.toThrow(/ROBLOX_TOKEN_KEY/);
  });

  it("treats a rotated encryption key as signed out rather than failing oddly", async () => {
    const first = await TokenCipher.fromSecret("key-one-key-one-key-one-key-one-11");
    const second = await TokenCipher.fromSecret("key-two-key-two-key-two-key-two-22");
    const sealed = await new AccountVault(new MemoryKv(), first, "durable-object").sealTokens({
      accessToken: "AT.value",
      refreshToken: "RT.value",
      idToken: null,
      scopes: [],
      expiresAt: 1,
    });
    const opened = await new AccountVault(new MemoryKv(), second, "durable-object").openTokens(sealed);
    expect(opened).toBeNull();
    expect(sealed.kid).not.toBe(second!.keyId);
  });
});

describe("configuration and host validation", () => {
  it("requires HTTPS for the redirect URI", () => {
    expect(() => resolveRobloxConfig(baseEnv({ ROBLOX_REDIRECT_URI: "http://example.com/oauth/roblox/callback" }), `${WORKER_ORIGIN}/oauth/roblox/start`)).toThrow(/must be HTTPS/);
  });

  it("allows plain http only on localhost, for local development", () => {
    const config = resolveRobloxConfig(baseEnv(), "http://localhost:8787/oauth/roblox/start");
    expect(config.redirectUri).toBe("http://localhost:8787/oauth/roblox/callback");
    expect(() => resolveRobloxConfig(baseEnv({ ROBLOX_REDIRECT_URI: "http://evil.test/cb" }), "http://localhost:8787/oauth/roblox/start")).toThrow(/HTTPS/);
  });

  it("refuses a host outside ROBLOX_ALLOWED_HOSTS on either side", () => {
    const env = baseEnv({ ROBLOX_ALLOWED_HOSTS: "demo-mcp.test.workers.dev" });
    expect(() => resolveRobloxConfig(env, "https://attacker.example/oauth/roblox/start")).toThrow(/not listed in ROBLOX_ALLOWED_HOSTS/);
    const ok = resolveRobloxConfig(env, `${WORKER_ORIGIN}/oauth/roblox/start`);
    expect(ok.redirectUri).toBe(`${WORKER_ORIGIN}/oauth/roblox/callback`);
  });

  it("reports the missing pieces instead of half-working", () => {
    const missingId = resolveRobloxConfig({ ROBLOX_CLIENT_SECRET: "s" } as never, `${WORKER_ORIGIN}/oauth/roblox/start`);
    expect(missingId.enabled).toBe(false);
    expect(missingId.disabledReason).toMatch(/ROBLOX_CLIENT_ID/);
    const missingSecret = resolveRobloxConfig({ ROBLOX_CLIENT_ID: "c" } as never, `${WORKER_ORIGIN}/oauth/roblox/start`);
    expect(missingSecret.disabledReason).toMatch(/ROBLOX_CLIENT_SECRET/);
    expect(missingSecret.hasClientSecret).toBe(false);
  });

  it("clamps policy knobs into safe ranges", () => {
    const config = resolveRobloxConfig(
      baseEnv({ OAUTH_STATE_TTL_SECONDS: "99999", ROBLOX_RATE_LIMIT_PER_MINUTE: "-5", ROBLOX_OPEN_CLOUD_RATE_PER_MINUTE: "5000" }),
      `${WORKER_ORIGIN}/oauth/roblox/start`,
    );
    expect(config.stateTtlSeconds).toBe(900);
    expect(config.rateLimitPerMinute).toBe(1);
    expect(config.openCloudRatePerMinute).toBe(20);
    expect(config).not.toHaveProperty("sessionTtlSeconds");
    expect(config).not.toHaveProperty("accountKey");
  });

  it("does not expose a configurable account slot; user identity selects Roblox storage", () => {
    const config = resolveRobloxConfig(baseEnv({ ROBLOX_ACCOUNT_KEY: "caller-selected-slot" }), `${WORKER_ORIGIN}/oauth/roblox/start`);
    expect(config).not.toHaveProperty("accountKey");
  });
});

describe("token exchange", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the code, verifier and secret to Roblox's token endpoint as a form body", async () => {
    const config = resolveRobloxConfig(baseEnv(), `${WORKER_ORIGIN}/oauth/roblox/start`);
    const { calls } = stubRoblox();
    const tokens = await exchangeAuthorizationCode({ config, clientSecret: "RBX-CR9-secret-value", code: "authcode1234567890", codeVerifier: "verifier-value" });
    expect(tokens.accessToken).toBe("AT.access-token-value");
    expect(tokens.expiresIn).toBe(900);
    expect(tokens.scopes).toEqual(["openid", "profile"]);
    expect(tokens.scopesSource).toBe("granted");
    const call = calls[0];
    expect(call.url).toBe("https://apis.roblox.com/oauth/v1/token");
    expect(call.method).toBe("POST");
    expect(call.body).toMatchObject({ grant_type: "authorization_code", code: "authcode1234567890", code_verifier: "verifier-value", client_id: "840974200211308101" });
    expect(call.url).not.toContain("secret");
  });

  it("maps an invalid or already-used code to an actionable error", async () => {
    const config = resolveRobloxConfig(baseEnv(), `${WORKER_ORIGIN}/oauth/roblox/start`);
    stubRoblox({ tokenStatus: 400, tokenResponse: { error: "invalid_grant" } });
    await expect(exchangeAuthorizationCode({ config, clientSecret: "s", code: "c", codeVerifier: "v" })).rejects.toMatchObject({
      code: "token_exchange_failed",
      hint: expect.stringMatching(/single-use and expire after about one minute/),
    });
  });

  it("maps Roblox 5xx to a retryable failure and a rate limit to 429", async () => {
    const config = resolveRobloxConfig(baseEnv(), `${WORKER_ORIGIN}/oauth/roblox/start`);
    stubRoblox({ tokenStatus: 503 });
    await expect(exchangeAuthorizationCode({ config, clientSecret: "s", code: "c", codeVerifier: "v" })).rejects.toMatchObject({ code: "network_error", retryable: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 429, headers: { "retry-after": "12" } })));
    await expect(exchangeAuthorizationCode({ config, clientSecret: "s", code: "c", codeVerifier: "v" })).rejects.toMatchObject({ code: "rate_limited", retryable: true });
  });

  it("survives a total network failure without pretending the code is reusable", async () => {
    const config = resolveRobloxConfig(baseEnv(), `${WORKER_ORIGIN}/oauth/roblox/start`);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("socket hang up"); }));
    await expect(exchangeAuthorizationCode({ config, clientSecret: "s", code: "c", codeVerifier: "v" })).rejects.toMatchObject({
      code: "network_error",
      hint: expect.stringMatching(/single-use/),
    });
  });

  it("requires credentials rather than calling Roblox anonymously", async () => {
    const config = resolveRobloxConfig({ ROBLOX_OAUTH_SCOPES: "openid" } as never, `${WORKER_ORIGIN}/oauth/roblox/start`);
    expect(config.enabled).toBe(false);
    await expect(exchangeAuthorizationCode({ config, clientSecret: "", code: "c", codeVerifier: "v" })).rejects.toMatchObject({ code: "not_configured" });
  });

  it("understands Roblox's standard { errors: [...] } envelope, not just OAuth-style errors", async () => {
    // This is the shape apis.roblox.com returns for requests that never reach an OAuth
    // handler, so a misconfiguration would otherwise surface as a bare HTTP 400.
    const config = resolveRobloxConfig(baseEnv(), `${WORKER_ORIGIN}/oauth/roblox/start`);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ errors: [{ code: 814, message: "Code exchange failed" }] }, 400)));
    await expect(exchangeAuthorizationCode({ config, clientSecret: "s", code: "c", codeVerifier: "v" })).rejects.toMatchObject({
      code: "token_exchange_failed",
      data: { httpStatus: 400, oauthError: "Code exchange failed" },
      hint: expect.stringContaining("Roblox said: Code exchange failed"),
    });

    // A code with no message is still reported as itself rather than "unknown".
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ errors: [{ code: 0, message: "" }] }, 400)));
    await expect(exchangeAuthorizationCode({ config, clientSecret: "s", code: "c", codeVerifier: "v" })).rejects.toMatchObject({
      data: { oauthError: "roblox_error_0" },
    });
  });

  it("never repeats a provider message that could carry a credential back to the user", () => {
    expect(sanitizeProviderError("invalid_grant")).toBe("invalid_grant");
    expect(sanitizeProviderError("bad code 9f2b7c1d8e4a5566f0ab34cd78ef0123abcd")).toBe("bad code [redacted]");
    expect(sanitizeProviderError("a".repeat(400)).length).toBeLessThanOrEqual(80);
  });

  it("revokes best-effort and reports honestly when Roblox cannot be reached", async () => {
    const config = resolveRobloxConfig(baseEnv(), `${WORKER_ORIGIN}/oauth/roblox/start`);
    const { calls } = stubRoblox();
    const ok = await revokeAuthorization({ config, clientSecret: "s", refreshToken: "RT.value" });
    expect(ok).toMatchObject({ attempted: true, revoked: true });
    expect(calls[0].url).toBe("https://apis.roblox.com/oauth/v1/token/revoke");
    expect(calls[0].body).toMatchObject({ token: "RT.value" });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(revokeAuthorization({ config, clientSecret: "s", refreshToken: "RT.value" })).resolves.toMatchObject({ attempted: true, revoked: false });
  });

  it("reads userinfo with a bearer header and surfaces only public claims", async () => {
    const { calls } = stubRoblox();
    const info = await fetchUserInfo("AT.access-token-value");
    expect(info.sub).toBe("1516563360");
    expect(info.profile).toContain("/users/1516563360/profile");
    const userinfoCall = calls.find((call) => call.url.includes("/oauth/v1/userinfo"));
    expect(userinfoCall?.authorization).toBe("Bearer AT.access-token-value");
    await expect(fetchUserInfo("")).rejects.toMatchObject({ code: "unauthenticated" });
  });
});
