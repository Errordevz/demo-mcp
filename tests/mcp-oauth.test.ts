import { afterEach, describe, expect, it, vi } from "vitest";
import { clearChatGptClientMetadataCacheForTests, handleMcpOAuthRoute, isChatGptClientId } from "../src/auth/oauth-routes.js";
import { resolveMcpOAuthConfig } from "../src/auth/oauth-config.js";
import { InMemoryMcpAuthStore } from "../src/auth/oauth-store.js";
import { requireMcpScope, robloxAccountKeyForSubjectHash } from "../src/auth/tool-auth.js";
import type { VerifiedAccessIdentity } from "../src/auth/access-identity.js";
import { createPkcePair, randomOpaqueToken, sha256Hex } from "../src/roblox/crypto.js";

const ORIGIN = "https://demo.test";
const CLIENT_ID = "https://chatgpt.com/oauth/client.json";
const REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";
const SUBJECT_A = "a".repeat(64);
const SUBJECT_B = "b".repeat(64);
const ISSUER = "https://demo.cloudflareaccess.com";
const NOW = 1_790_000_000_000;

const CLIENT_DOCUMENT = {
  client_id: CLIENT_ID,
  client_name: "ChatGPT",
  redirect_uris: [REDIRECT_URI],
  response_types: ["code"],
  grant_types: ["authorization_code"],
  token_endpoint_auth_methods_supported: ["private_key_jwt", "none"],
  token_endpoint_auth_method: "private_key_jwt",
};

function identity(subjectHash = SUBJECT_A): VerifiedAccessIdentity {
  return { subjectHash, issuer: ISSUER };
}

function env(store = new InMemoryMcpAuthStore()) {
  return {
    MCP_PUBLIC_ORIGIN: ORIGIN,
    MCP_AUTH_ACCESS_TEAM_DOMAIN: "demo.cloudflareaccess.com",
    MCP_AUTH_ACCESS_AUD: "test-access-audience",
    MCP_AUTH: { idFromName: (name: string) => name, get: () => store },
    store,
  };
}

function deps(options: { store?: InMemoryMcpAuthStore; subjectHash?: string | null; now?: number } = {}) {
  const store = options.store ?? new InMemoryMcpAuthStore();
  return {
    store,
    identity: async () => options.subjectHash === null ? null : identity(options.subjectHash ?? SUBJECT_A),
    fetch: vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== CLIENT_ID) throw new Error("unexpected external request");
      return Response.json(CLIENT_DOCUMENT, { headers: { "content-type": "application/json" } });
    }),
    now: () => options.now ?? NOW,
  };
}

async function route(url: string, init: RequestInit | undefined, envValue: ReturnType<typeof env>, routeDeps: ReturnType<typeof deps>) {
  const response = await handleMcpOAuthRoute(new Request(url, init), envValue, routeDeps);
  if (!response) throw new Error(`OAuth route not handled: ${url}`);
  return response;
}

function hidden(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]+)"`).exec(html);
  if (!match?.[1]) throw new Error(`missing hidden ${name}`);
  return match[1];
}

async function beginConsent(store = new InMemoryMcpAuthStore(), principal = SUBJECT_A) {
  const envValue = env(store);
  const routeDeps = deps({ store, subjectHash: principal });
  const pkce = await createPkcePair();
  const state = randomOpaqueToken(24);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    response_mode: "query",
    scope: "roblox:read roblox:link",
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    resource: ORIGIN,
  });
  const authorize = await route(`${ORIGIN}/oauth/authorize?${params}`, { method: "GET", headers: { Accept: "text/html" } }, envValue, routeDeps);
  return { env: envValue, deps: routeDeps, store, pkce, state, authorize };
}

async function approveConsent(flow: Awaited<ReturnType<typeof beginConsent>>, subjectHash = SUBJECT_A) {
  const html = await flow.authorize.text();
  const cookie = flow.authorize.headers.getSetCookie().find((value) => value.startsWith("demo_mcp_oauth_flow="))?.split(";", 1)[0];
  if (!cookie) throw new Error("DEMO OAuth flow cookie missing");
  const form = new URLSearchParams({
    request_id: hidden(html, "request_id"),
    csrf_token: hidden(html, "csrf_token"),
    decision: "authorize",
  });
  return route(`${ORIGIN}/oauth/authorize`, {
    method: "POST",
    headers: { Origin: ORIGIN, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  }, flow.env, { ...flow.deps, identity: async () => identity(subjectHash) });
}

async function exchangeCode(flow: Awaited<ReturnType<typeof beginConsent>>, code: string, verifier = flow.pkce.verifier, redirectUri = REDIRECT_URI) {
  return route(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { Origin: "https://chatgpt.com", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: ORIGIN,
    }).toString(),
  }, flow.env, flow.deps);
}

afterEach(() => {
  clearChatGptClientMetadataCacheForTests();
  vi.restoreAllMocks();
});

describe("DEMO OAuth 2.1 authorization code + PKCE", () => {
  it("accepts only the official ChatGPT CIMD URL shapes, without method-selection query strings", () => {
    expect(isChatGptClientId(CLIENT_ID)).toBe(true);
    expect(isChatGptClientId("https://chatgpt.com/oauth/callback_123/client.json")).toBe(true);
    expect(isChatGptClientId("https://chatgpt.com/oauth/client.json?token_endpoint_auth_method=none")).toBe(false);
    expect(isChatGptClientId("https://chatgpt.example.com/oauth/client.json")).toBe(false);
    expect(isChatGptClientId("https://chatgpt.com.evil.test/oauth/client.json")).toBe(false);
  });

  it("publishes pinned metadata with S256, short grants, CIMD, and only public-client authentication", async () => {
    const store = new InMemoryMcpAuthStore();
    const envValue = env(store);
    const routeDeps = deps({ store });
    const resource = await route(`${ORIGIN}/.well-known/oauth-protected-resource`, { method: "GET" }, envValue, routeDeps);
    expect(resource.status).toBe(200);
    expect(await resource.json()).toMatchObject({
      resource: ORIGIN,
      authorization_servers: [ORIGIN],
      bearer_methods_supported: ["header"],
      scopes_supported: ["roblox:read", "roblox:link", "roblox:disconnect", "decision:use"],
    });
    const server = await route(`${ORIGIN}/.well-known/oauth-authorization-server`, { method: "GET" }, envValue, routeDeps);
    expect(await server.json()).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      revocation_endpoint: `${ORIGIN}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  it("requires verified Access identity and renders explicit separate-scope consent", async () => {
    const store = new InMemoryMcpAuthStore();
    const envValue = env(store);
    const missingIdentityDeps = { ...deps({ store, subjectHash: null }) };
    const pkce = await createPkcePair();
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: "roblox:read roblox:link",
      state: randomOpaqueToken(24),
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      resource: ORIGIN,
    });
    const denied = await route(`${ORIGIN}/oauth/authorize?${params}`, { method: "GET" }, envValue, missingIdentityDeps);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: "login_required" });

    const flow = await beginConsent(store);
    expect(flow.authorize.status).toBe(200);
    expect(flow.authorize.headers.get("cache-control")).toBe("no-store");
    expect(flow.authorize.headers.get("content-security-policy")).toContain("script-src 'none'");
    const html = await flow.authorize.text();
    expect(html).toContain("Authorize protected tools?");
    expect(html).toContain("roblox:read");
    expect(html).toContain("roblox:link");
    expect(html).toContain("Public tools stay public");
    expect(html).toContain("does not connect a Roblox account");
    const cookie = flow.authorize.headers.getSetCookie().find((value) => value.startsWith("demo_mcp_oauth_flow="));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain(flow.state);
  });

  it("validates ChatGPT's CIMD, exact registered redirect, response type, scope, resource, and S256", async () => {
    const store = new InMemoryMcpAuthStore();
    const envValue = env(store);
    const routeDeps = deps({ store });
    for (const [field, value, error] of [
      ["client_id", "https://evil.example/oauth/client.json", "invalid_client"],
      ["redirect_uri", "https://evil.example/callback", "invalid_request"],
      ["response_type", "token", "unsupported_response_type"],
      ["scope", "roblox:read admin", "invalid_scope"],
      ["resource", "https://other.test", "invalid_target"],
      ["code_challenge_method", "plain", "invalid_request"],
    ] as const) {
      const pkce = await createPkcePair();
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: "roblox:read",
        state: randomOpaqueToken(24),
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        resource: ORIGIN,
      });
      params.set(field, value);
      const response = await route(`${ORIGIN}/oauth/authorize?${params}`, { method: "GET" }, envValue, routeDeps);
      if (error === "invalid_client" || error === "invalid_request" && field === "redirect_uri") {
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error });
      } else {
        expect(response.status).toBe(302);
        expect(new URL(response.headers.get("Location")!).searchParams.get("error")).toBe(error);
      }
    }
  });

  it("issues a short-lived opaque token only after one-time consent and a correct PKCE verifier", async () => {
    const flow = await beginConsent();
    const callback = await approveConsent(flow);
    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe(flow.state);
    expect(location.searchParams.get("iss")).toBe(ORIGIN);
    const code = location.searchParams.get("code")!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    expect(JSON.stringify((flow.store as unknown as { codes: Map<string, unknown> }).codes)).not.toContain(code);

    const wrongVerifier = await exchangeCode(flow, code, `${flow.pkce.verifier}wrong`);
    expect(wrongVerifier.status).toBe(400);
    expect(await wrongVerifier.json()).toMatchObject({ error: "invalid_grant" });

    const second = await exchangeCode(flow, code);
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("exchanges exactly once, stores only a token hash, and issues no refresh token", async () => {
    const flow = await beginConsent();
    const callback = await approveConsent(flow);
    const code = new URL(callback.headers.get("Location")!).searchParams.get("code")!;
    const response = await exchangeCode(flow, code);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://chatgpt.com");
    const payload = await response.json() as Record<string, any>;
    expect(payload).toMatchObject({ token_type: "Bearer", expires_in: 900, scope: "roblox:read roblox:link", resource: ORIGIN });
    expect(payload.access_token).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    expect(payload).not.toHaveProperty("refresh_token");
    const rawToken = payload.access_token as string;
    const hashed = await sha256Hex(rawToken);
    expect(await flow.store.getAccessToken(hashed, NOW)).toMatchObject({ principalHash: SUBJECT_A, scopes: ["roblox:read", "roblox:link"], audience: ORIGIN });
    expect(await flow.store.getAccessToken(rawToken, NOW)).toBeNull();
    const tokenKeys = [...(flow.store as unknown as { tokens: Map<string, unknown> }).tokens.keys()];
    expect(tokenKeys).toEqual([hashed]);
    expect(JSON.stringify(tokenKeys)).not.toContain(rawToken);
    const replay = await exchangeCode(flow, code);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("consumes consent only once and refuses a different Access identity or cross-site POST", async () => {
    const mismatch = await beginConsent();
    const html = await mismatch.authorize.text();
    const cookie = mismatch.authorize.headers.getSetCookie().find((value) => value.startsWith("demo_mcp_oauth_flow="))?.split(";", 1)[0]!;
    const badIdentity = await route(`${ORIGIN}/oauth/authorize`, {
      method: "POST",
      headers: { Origin: ORIGIN, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: hidden(html, "request_id"), csrf_token: hidden(html, "csrf_token"), decision: "authorize" }).toString(),
    }, mismatch.env, { ...mismatch.deps, identity: async () => identity(SUBJECT_B) });
    expect(badIdentity.status).toBe(400);
    expect(await badIdentity.json()).toMatchObject({ error: "invalid_request" });

    const crossSite = await beginConsent();
    const crossHtml = await crossSite.authorize.text();
    const crossCookie = crossSite.authorize.headers.getSetCookie().find((value) => value.startsWith("demo_mcp_oauth_flow="))?.split(";", 1)[0]!;
    const blocked = await route(`${ORIGIN}/oauth/authorize`, {
      method: "POST",
      headers: { Origin: "https://attacker.example", Cookie: crossCookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: hidden(crossHtml, "request_id"), csrf_token: hidden(crossHtml, "csrf_token"), decision: "authorize" }).toString(),
    }, crossSite.env, crossSite.deps);
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ error: "invalid_request" });
  });

  it("rejects unsupported client authentication and non-ChatGPT CORS origins", async () => {
    const clientAssertion = await route(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        client_assertion: "signed-client-assertion",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      }).toString(),
    }, env(), deps());
    expect(clientAssertion.status).toBe(401);
    expect(await clientAssertion.json()).toMatchObject({ error: "invalid_client" });

    const wrongOrigin = await route(`${ORIGIN}/oauth/token`, {
      method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code",
    }, env(), deps());
    expect(wrongOrigin.status).toBe(403);

    const flow = await beginConsent();
    const callback = await approveConsent(flow);
    const code = new URL(callback.headers.get("Location")!).searchParams.get("code")!;
    const tokenResponse = await exchangeCode(flow, code);
    const token = (await tokenResponse.json() as { access_token: string }).access_token;
    const revoke = await route(`${ORIGIN}/oauth/revoke`, {
      method: "POST",
      headers: { Origin: "https://chatgpt.com", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT_ID, token, resource: ORIGIN }).toString(),
    }, flow.env, flow.deps);
    expect(revoke.status).toBe(200);
    expect(await flow.store.getAccessToken(await sha256Hex(token), NOW)).toBeNull();
    const duplicate = await route(`${ORIGIN}/oauth/revoke`, {
      method: "POST", headers: { Origin: "https://chatgpt.com", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLIENT_ID, token, resource: ORIGIN }).toString(),
    }, flow.env, flow.deps);
    expect(duplicate.status).toBe(200);
  });
});

describe("user-bound protected tool authorization", () => {
  it("derives separate Roblox keys from opaque user principals, never request arguments", async () => {
    const store = new InMemoryMcpAuthStore();
    const configured = env(store);
    const config = resolveMcpOAuthConfig(configured)!;
    const tokenA = randomOpaqueToken(32);
    const tokenB = randomOpaqueToken(32);
    const clientIdHash = await sha256Hex(CLIENT_ID);
    for (const [token, subjectHash] of [[tokenA, SUBJECT_A], [tokenB, SUBJECT_B]] as const) {
      await store.putAccessToken(await sha256Hex(token), {
        version: 1,
        clientIdHash,
        principalHash: subjectHash,
        scopes: ["roblox:read"],
        audience: ORIGIN,
        issuedAt: NOW,
        expiresAt: NOW + 900_000,
      });
    }
    const authA = await requireMcpScope({ env: configured, authorization: `Bearer ${tokenA}` }, "roblox_account_profile", "roblox:read", NOW);
    const authB = await requireMcpScope({ env: configured, authorization: `Bearer ${tokenB}` }, "roblox_account_profile", "roblox:read", NOW);
    expect(authA.ok).toBe(true);
    expect(authB.ok).toBe(true);
    if (!authA.ok || !authB.ok) return;
    expect(authA.principal.subjectHash).toBe(SUBJECT_A);
    expect(authB.principal.subjectHash).toBe(SUBJECT_B);
    expect(authA.principal.robloxAccountKey).toBe(robloxAccountKeyForSubjectHash(SUBJECT_A));
    expect(authB.principal.robloxAccountKey).toBe(robloxAccountKeyForSubjectHash(SUBJECT_B));
    expect(authA.principal.robloxAccountKey).not.toBe(authB.principal.robloxAccountKey);
  });

  it("rejects missing, expired, wrong-audience, revoked, and under-scoped tokens with OAuth challenges", async () => {
    const store = new InMemoryMcpAuthStore();
    const configured = env(store);
    const clientIdHash = await sha256Hex(CLIENT_ID);
    const tokens = {
      expired: randomOpaqueToken(32),
      audience: randomOpaqueToken(32),
      scope: randomOpaqueToken(32),
      revoked: randomOpaqueToken(32),
    };
    for (const [kind, token] of Object.entries(tokens)) {
      await store.putAccessToken(await sha256Hex(token), {
        version: 1,
        clientIdHash,
        principalHash: SUBJECT_A,
        scopes: kind === "scope" ? ["roblox:read"] : ["roblox:disconnect"],
        audience: kind === "audience" ? "https://other.test" : ORIGIN,
        issuedAt: NOW - 10_000,
        expiresAt: kind === "expired" ? NOW - 1 : NOW + 60_000,
      });
    }
    await store.revokeAccessToken(await sha256Hex(tokens.revoked), clientIdHash);
    for (const token of [undefined, "Bearer malformed"] as const) {
      const result = await requireMcpScope({ env: configured, authorization: token }, "roblox_account_profile", "roblox:read", NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) expect((result.result._meta?.["mcp/www_authenticate"] as string[] | undefined)?.[0]).toContain('error="invalid_token"');
    }
    for (const token of [tokens.expired, tokens.audience, tokens.revoked]) {
      const result = await requireMcpScope({ env: configured, authorization: `Bearer ${token}` }, "roblox_account_profile", "roblox:read", NOW);
      expect(result.ok).toBe(false);
      if (!result.ok) expect((result.result._meta?.["mcp/www_authenticate"] as string[] | undefined)?.[0]).toContain('error="invalid_token"');
    }
    const underScoped = await requireMcpScope({ env: configured, authorization: `Bearer ${tokens.scope}` }, "roblox_account_unlink", "roblox:disconnect", NOW);
    expect(underScoped.ok).toBe(false);
    if (!underScoped.ok) expect((underScoped.result._meta?.["mcp/www_authenticate"] as string[] | undefined)?.[0]).toContain('error="insufficient_scope"');
  });
});
