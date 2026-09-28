/**
 * Validate a human Cloudflare Access assertion before using it as the upstream
 * identity for OAuth authorization or the Roblox browser controls.
 *
 * Only the signed `sub` claim is used as an identity. Email and all other PII
 * are intentionally ignored, and the value returned to callers is a domain-
 * separated SHA-256 hash rather than the raw subject or JWT.
 */

export interface AccessIdentityEnv {
  MCP_AUTH_ACCESS_TEAM_DOMAIN?: string;
  MCP_AUTH_ACCESS_AUD?: string;
}

export interface VerifiedAccessIdentity {
  subjectHash: string;
  issuer: string;
}

interface AccessJwtHeader {
  alg?: unknown;
  kid?: unknown;
  typ?: unknown;
  crit?: unknown;
}
interface AccessJwtClaims {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  exp?: unknown;
  iat?: unknown;
  nbf?: unknown;
  type?: unknown;
}
interface AccessJwkSet {
  keys?: JsonWebKey[];
}
interface CachedKeys {
  expiresAt: number;
  keys: Map<string, CryptoKey>;
  refresh?: Promise<Map<string, CryptoKey>>;
}

const JWKS_CACHE_MS = 5 * 60 * 1000;
const MAX_JWKS_BYTES = 64 * 1024;
const keyCache = new Map<string, CachedKeys>();

function teamIssuer(raw: string | undefined): string | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value || value.includes("/") || value.includes(":") || value.includes("@")) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(value)) return null;
  return `https://${value}`;
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const decoded = atob(base64);
    return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeJsonPart<T>(segment: string): T | null {
  const bytes = decodeBase64Url(segment);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  } catch {
    return null;
  }
}

function audienceContains(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  return Array.isArray(value) && value.some((entry) => typeof entry === "string" && entry === expected);
}

async function importJwks(issuer: string, fetcher: typeof fetch): Promise<Map<string, CryptoKey>> {
  const url = `${issuer}/cdn-cgi/access/certs`;
  const response = await fetcher(url, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) throw new Error("Access JWKS unavailable");
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_JWKS_BYTES) throw new Error("Access JWKS too large");
  const text = await response.text();
  if (text.length > MAX_JWKS_BYTES) throw new Error("Access JWKS too large");
  const payload = JSON.parse(text) as AccessJwkSet;
  if (!Array.isArray(payload.keys) || payload.keys.length > 32) throw new Error("Invalid Access JWKS");

  const result = new Map<string, CryptoKey>();
  for (const jwk of payload.keys) {
    const kid = (jwk as JsonWebKey & { kid?: string }).kid;
    const alg = (jwk as JsonWebKey & { alg?: string }).alg;
    const use = (jwk as JsonWebKey & { use?: string }).use;
    if (!kid || kid.length > 256 || alg !== "RS256" || (use && use !== "sig") || jwk.kty !== "RSA") continue;
    try {
      result.set(kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
    } catch {
      // Ignore malformed keys; the signed assertion still has to match one valid key.
    }
  }
  if (result.size === 0) throw new Error("No supported Access signing keys");
  return result;
}

async function getKeys(issuer: string, fetcher: typeof fetch, now: number, forceRefresh = false): Promise<Map<string, CryptoKey>> {
  let cached = keyCache.get(issuer);
  if (!forceRefresh && cached && cached.expiresAt > now && cached.keys.size) return cached.keys;
  if (cached?.refresh) return cached.refresh;

  const entry: CachedKeys = cached ?? { expiresAt: 0, keys: new Map() };
  entry.refresh = importJwks(issuer, fetcher).then((keys) => {
    entry.keys = keys;
    entry.expiresAt = now + JWKS_CACHE_MS;
    entry.refresh = undefined;
    keyCache.set(issuer, entry);
    return keys;
  }).catch((error) => {
    entry.refresh = undefined;
    if (!entry.keys.size) keyCache.delete(issuer);
    throw error;
  });
  keyCache.set(issuer, entry);
  return entry.refresh;
}

/**
 * Verify `CF-Access-Jwt-Assertion` against the configured Access team's JWKS.
 * Service tokens are rejected (`sub` must be non-empty and `type` must be app),
 * so one shared machine credential can never become a human user identity.
 */
export async function verifyCloudflareAccessIdentity(
  request: Request,
  env: AccessIdentityEnv,
  options: { fetch?: typeof fetch; now?: number } = {},
): Promise<VerifiedAccessIdentity | null> {
  const issuer = teamIssuer(env.MCP_AUTH_ACCESS_TEAM_DOMAIN);
  const audience = (env.MCP_AUTH_ACCESS_AUD ?? "").trim();
  const assertion = request.headers.get("CF-Access-Jwt-Assertion") ?? request.headers.get("cf-access-jwt-assertion");
  if (!issuer || !audience || audience.length > 512 || !assertion || assertion.length > 8_192 || /\s|,/.test(assertion)) return null;

  const parts = assertion.split(".");
  if (parts.length !== 3) return null;
  const header = decodeJsonPart<AccessJwtHeader>(parts[0]!);
  const claims = decodeJsonPart<AccessJwtClaims>(parts[1]!);
  const signature = decodeBase64Url(parts[2]!);
  if (!header || !claims || !signature || header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length > 256) return null;
  if (header.typ !== undefined && (typeof header.typ !== "string" || header.typ.toUpperCase() !== "JWT")) return null;
  if (header.crit !== undefined) return null;
  if (claims.iss !== issuer || !audienceContains(claims.aud, audience) || claims.type !== "app") return null;
  if (typeof claims.sub !== "string" || !claims.sub.trim() || claims.sub.length > 512) return null;

  const now = options.now ?? Date.now();
  const nowSeconds = Math.floor(now / 1000);
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= nowSeconds) return null;
  if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat) || claims.iat > nowSeconds + 60 || claims.iat >= claims.exp) return null;
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > nowSeconds + 60)) return null;

  const fetcher = options.fetch ?? fetch;
  try {
    let keys = await getKeys(issuer, fetcher, now);
    let key = keys.get(header.kid);
    if (!key) {
      keys = await getKeys(issuer, fetcher, now, true);
      key = keys.get(header.kid);
    }
    if (!key) return null;
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signatureBytes = new Uint8Array(signature.byteLength);
    signatureBytes.set(signature);
    const signedBytes = new Uint8Array(signed.byteLength);
    signedBytes.set(signed);
    const verified = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      key,
      signatureBytes.buffer as ArrayBuffer,
      signedBytes.buffer as ArrayBuffer,
    );
    if (!verified) return null;
    const subjectHash = await sha256Hex(`${issuer}\u0000${audience}\u0000${claims.sub}`);
    return { subjectHash, issuer };
  } catch {
    return null;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Test helper for isolating JWKS rotation/cache behavior. */
export function clearAccessJwksCacheForTests(): void {
  keyCache.clear();
}
