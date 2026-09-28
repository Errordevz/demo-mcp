import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccessJwksCacheForTests, verifyCloudflareAccessIdentity } from "../src/auth/access-identity.js";

const DOMAIN = "demo.cloudflareaccess.com";
const ISSUER = `https://${DOMAIN}`;
const AUDIENCE = "access-application-audience";
const NOW = 1_790_000_000_000;
const KID = "test-rsa-key-1";

function encodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function encodeJson(value: unknown): string {
  return encodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

let privateKey: CryptoKey;
let publicJwk: JsonWebKey & { kid: string; alg: string; use: string };

beforeEach(async () => {
  clearAccessJwksCacheForTests();
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }, true, ["sign", "verify"]);
  privateKey = pair.privateKey;
  publicJwk = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: KID, alg: "RS256", use: "sig" };
});

afterEach(() => {
  clearAccessJwksCacheForTests();
  vi.unstubAllGlobals();
});

async function jwt(claimOverrides: Record<string, unknown> = {}, headerOverrides: Record<string, unknown> = {}): Promise<string> {
  const nowSeconds = Math.floor(NOW / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: KID, ...headerOverrides };
  const claims = {
    iss: ISSUER,
    aud: ["another-audience", AUDIENCE],
    sub: "access-subject-user-1",
    type: "app",
    iat: nowSeconds - 5,
    nbf: nowSeconds - 5,
    exp: nowSeconds + 600,
    email: "alice@example.test",
    ...claimOverrides,
  };
  const unsigned = `${encodeJson(header)}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${encodeBytes(new Uint8Array(signature))}`;
}

function jwksFetch() {
  return vi.fn(async (_input: RequestInfo | URL) => Response.json({ keys: [publicJwk] }));
}

function request(assertion?: string): Request {
  return new Request("https://demo.test/oauth/authorize", {
    headers: assertion ? { "CF-Access-Jwt-Assertion": assertion } : {},
  });
}

describe("Cloudflare Access human identity verification", () => {
  it("validates the RS256 signature, issuer, audience, time claims, and app token type", async () => {
    const assertion = await jwt();
    const fetch = jwksFetch();
    const identity = await verifyCloudflareAccessIdentity(request(assertion), {
      MCP_AUTH_ACCESS_TEAM_DOMAIN: DOMAIN,
      MCP_AUTH_ACCESS_AUD: AUDIENCE,
    }, { fetch: fetch as unknown as typeof globalThis.fetch, now: NOW });
    expect(identity).toMatchObject({ issuer: ISSUER, subjectHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(identity?.subjectHash).not.toContain("access-subject-user-1");
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(`${ISSUER}/cdn-cgi/access/certs`);
  });

  it("rejects unsigned, altered, expired, future, wrong-audience, wrong-issuer and service tokens", async () => {
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ["expired", { exp: Math.floor(NOW / 1000) - 1 }, {}],
      ["not-yet-valid", { nbf: Math.floor(NOW / 1000) + 61 }, {}],
      ["future-issued", { iat: Math.floor(NOW / 1000) + 61 }, {}],
      ["wrong-issuer", { iss: "https://attacker.cloudflareaccess.com" }, {}],
      ["wrong-audience", { aud: "some-other-app" }, {}],
      ["service-token", { type: "app-token" }, {}],
      ["empty-subject", { sub: "   " }, {}],
      ["wrong-algorithm", {}, { alg: "HS256" }],
      ["unsupported-critical-header", {}, { crit: ["b64"] }],
    ];
    for (const [label, claims, headers] of cases) {
      const fetch = jwksFetch();
      const result = await verifyCloudflareAccessIdentity(request(await jwt(claims, headers)), {
        MCP_AUTH_ACCESS_TEAM_DOMAIN: DOMAIN,
        MCP_AUTH_ACCESS_AUD: AUDIENCE,
      }, { fetch: fetch as unknown as typeof globalThis.fetch, now: NOW });
      expect(result, label).toBeNull();
    }

    const original = await jwt();
    const tampered = `${original.slice(0, original.lastIndexOf(".") + 1)}${encodeBytes(new Uint8Array(256).fill(1))}`;
    expect(await verifyCloudflareAccessIdentity(request(tampered), {
      MCP_AUTH_ACCESS_TEAM_DOMAIN: DOMAIN,
      MCP_AUTH_ACCESS_AUD: AUDIENCE,
    }, { fetch: jwksFetch() as unknown as typeof globalThis.fetch, now: NOW })).toBeNull();
  });

  it("fails closed without a valid configured tenant, audience, assertion, or signing key", async () => {
    const fetch = jwksFetch();
    const valid = await jwt();
    expect(await verifyCloudflareAccessIdentity(request(valid), { MCP_AUTH_ACCESS_TEAM_DOMAIN: "https://demo.cloudflareaccess.com", MCP_AUTH_ACCESS_AUD: AUDIENCE }, { fetch: fetch as unknown as typeof globalThis.fetch, now: NOW })).toBeNull();
    expect(await verifyCloudflareAccessIdentity(request(valid), { MCP_AUTH_ACCESS_TEAM_DOMAIN: DOMAIN }, { fetch: fetch as unknown as typeof globalThis.fetch, now: NOW })).toBeNull();
    expect(await verifyCloudflareAccessIdentity(request(), { MCP_AUTH_ACCESS_TEAM_DOMAIN: DOMAIN, MCP_AUTH_ACCESS_AUD: AUDIENCE }, { fetch: fetch as unknown as typeof globalThis.fetch, now: NOW })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    const noKeys = vi.fn(async () => Response.json({ keys: [] }));
    expect(await verifyCloudflareAccessIdentity(request(valid), { MCP_AUTH_ACCESS_TEAM_DOMAIN: DOMAIN, MCP_AUTH_ACCESS_AUD: AUDIENCE }, { fetch: noKeys as unknown as typeof globalThis.fetch, now: NOW })).toBeNull();
  });

  it("caches JWKS but derives a stable, privacy-preserving identity from sub rather than email", async () => {
    const fetch = jwksFetch();
    const firstJwt = await jwt({ sub: "stable-user-id", email: "first@example.test" });
    const secondJwt = await jwt({ sub: "stable-user-id", email: "renamed@example.test" });
    const first = await verifyCloudflareAccessIdentity(request(firstJwt), { MCP_AUTH_ACCESS_TEAM_DOMAIN: DOMAIN, MCP_AUTH_ACCESS_AUD: AUDIENCE }, { fetch: fetch as unknown as typeof globalThis.fetch, now: NOW });
    const second = await verifyCloudflareAccessIdentity(request(secondJwt), { MCP_AUTH_ACCESS_TEAM_DOMAIN: DOMAIN, MCP_AUTH_ACCESS_AUD: AUDIENCE }, { fetch: fetch as unknown as typeof globalThis.fetch, now: NOW + 1_000 });
    expect(first?.subjectHash).toBe(second?.subjectHash);
    expect(fetch).toHaveBeenCalledOnce();
    expect(first?.subjectHash).not.toContain("example.test");
  });
});
