/**
 * OAuth 2.1 authorization-code + PKCE endpoints for ChatGPT -> DEMO.
 */

import { randomOpaqueToken, sha256Hex, verifyPkcePair } from "./crypto.js";
import type { VerifiedAccessIdentity } from "./access-identity.js";
import { resolveRequestIdentity, validRequestIdentity, type RequestIdentity } from "./request-identity.js";
import {
  authorizationServerMetadata,
  MCP_OAUTH_SCOPES,
  MCP_OAUTH_SCOPE_DESCRIPTIONS,
  mcpOAuthReady,
  resolveMcpOAuthConfig,
  resourceMetadata,
  type McpOAuthConfig,
} from "./oauth-config.js";
import {
  resolveMcpAuthStore,
  type AuthorizationCodeRecord,
  type ConsentRequestRecord,
  type McpAuthStoreApi,
} from "./oauth-store.js";

const FLOW_COOKIE = "demo_mcp_oauth_flow";
const MAX_FORM_BYTES = 12 * 1024;
const MAX_CLIENT_METADATA_BYTES = 16 * 1024;
const CLIENT_METADATA_CACHE_MS = 5 * 60 * 1000;
const CHATGPT_ORIGINS = new Set(["https://chatgpt.com"]);
const PROTECTED_RESOURCE_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
]);
const AUTHORIZATION_SERVER_PATHS = new Set([
  "/.well-known/oauth-authorization-server",
]);

export interface McpOAuthRouteEnv extends Record<string, unknown> {
  MCP_PUBLIC_ORIGIN?: string;
  MCP_AUTH_ACCESS_TEAM_DOMAIN?: string;
  MCP_AUTH_ACCESS_AUD?: string;
  MCP_AUTH?: unknown;
}

export interface McpOAuthRouteDeps {
  store?: McpAuthStoreApi;
  /**
   * Test seam: a custom identity provider. Production resolves the unified
   * request identity (DEMO account session first, then Cloudflare Access).
   */
  identity?: (request: Request, env: McpOAuthRouteEnv) => Promise<VerifiedAccessIdentity | null>;
  fetch?: typeof fetch;
  now?: () => number;
}

type Principal = { subjectHash: string };

/** Adapt the legacy Access-only dep shape to the unified principal, or resolve the real identity. */
async function currentIdentity(request: Request, env: McpOAuthRouteEnv, deps: McpOAuthRouteDeps): Promise<Principal | null> {
  if (deps.identity) {
    const legacy = await deps.identity(request, env);
    return legacy && /^[a-f0-9]{64}$/.test(legacy.subjectHash) ? { subjectHash: legacy.subjectHash } : null;
  }
  const identity: RequestIdentity | null = await resolveRequestIdentity(request, env);
  return validRequestIdentity(identity) ? { subjectHash: identity.subjectHash } : null;
}

interface ChatGptClientMetadata {
  clientId: string;
  redirectUris: string[];
  name: "ChatGPT";
}

interface ClientMetadataCacheEntry {
  expiresAt: number;
  value: ChatGptClientMetadata;
}
const clientMetadataCache = new Map<string, ClientMetadataCacheEntry>();

export function isMcpOAuthPath(pathname: string): boolean {
  return PROTECTED_RESOURCE_PATHS.has(pathname) || AUTHORIZATION_SERVER_PATHS.has(pathname) ||
    pathname === "/oauth/authorize" || pathname === "/oauth/token" || pathname === "/oauth/revoke";
}

/** Return null when this module does not own the request path. */
export async function handleMcpOAuthRoute(
  request: Request,
  env: McpOAuthRouteEnv,
  deps: McpOAuthRouteDeps = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isMcpOAuthPath(url.pathname)) return null;
  const now = deps.now?.() ?? Date.now();
  const config = resolveMcpOAuthConfig(env);
  const store = deps.store ?? resolveMcpAuthStore(env);
  if (!config || !store || (!deps.store && !mcpOAuthReady(env))) {
    return oauthJsonError(503, "temporarily_unavailable", "DEMO OAuth is not configured on this Worker.");
  }

  if (PROTECTED_RESOURCE_PATHS.has(url.pathname)) {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
    return publicMetadataResponse(resourceMetadata(config), request.method === "HEAD");
  }
  if (AUTHORIZATION_SERVER_PATHS.has(url.pathname)) {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
    return publicMetadataResponse(authorizationServerMetadata(config), request.method === "HEAD");
  }

  if (url.pathname === "/oauth/authorize") {
    if (request.method === "GET") return authorizationGet(request, env, config, store, deps, now);
    if (request.method === "POST") return authorizationPost(request, env, config, store, deps, now);
    return methodNotAllowed("GET, POST");
  }
  if (url.pathname === "/oauth/token") {
    if (request.method === "OPTIONS") return tokenCorsPreflight(request);
    if (request.method !== "POST") return tokenCors(methodNotAllowed("POST"), request);
    return tokenCors(await tokenPost(request, config, store, deps, now), request);
  }
  if (url.pathname === "/oauth/revoke") {
    if (request.method === "OPTIONS") return tokenCorsPreflight(request);
    if (request.method !== "POST") return tokenCors(methodNotAllowed("POST"), request);
    return tokenCors(await revokePost(request, config, store, deps, now), request);
  }
  return null;
}

/* ---------------------------------------------------------------- discovery */

function publicMetadataResponse(value: unknown, head: boolean): Response {
  const headers = authHeaders();
  headers.set("Content-Type", "application/json; charset=UTF-8");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Accept, Content-Type");
  headers.set("Cache-Control", "public, max-age=300, must-revalidate");
  headers.set("Vary", "Origin");
  return new Response(head ? null : JSON.stringify(value), { status: 200, headers });
}

/* ------------------------------------------------------------ authorization */

async function authorizationGet(
  request: Request,
  env: McpOAuthRouteEnv,
  config: McpOAuthConfig,
  store: McpAuthStoreApi,
  deps: McpOAuthRouteDeps,
  now: number,
): Promise<Response> {
  if (new URL(request.url).search.length > 8_192) return oauthJsonError(400, "invalid_request", "Authorization request is too large.");
  const params = new URL(request.url).searchParams;
  const clientIdValue = singleParam(params, "client_id");
  if (!clientIdValue.ok || !clientIdValue.value || !isChatGptClientId(clientIdValue.value)) {
    return oauthJsonError(400, "invalid_client", "Only the official ChatGPT OAuth client is supported.");
  }
  const clientId = clientIdValue.value;
  const clientIdHash = await sha256Hex(clientId);
  const limit = await store.charge("authorize", clientIdHash.slice(0, 32), config.rateLimitPerMinute, 60_000, now);
  if (!limit.allowed) return rateLimited(limit.retryAfterSeconds);

  const metadata = await fetchChatGptClient(clientId, deps.fetch ?? fetch, now);
  if (!metadata) return oauthJsonError(400, "invalid_client", "The ChatGPT client metadata could not be validated.");
  const redirectValue = singleParam(params, "redirect_uri");
  if (!redirectValue.ok || !redirectValue.value || !metadata.redirectUris.includes(redirectValue.value)) {
    return oauthJsonError(400, "invalid_request", "redirect_uri must exactly match a registered ChatGPT redirect URI.");
  }
  const redirectUri = redirectValue.value;
  const stateValue = singleParam(params, "state");
  const state = stateValue.ok ? stateValue.value : null;
  const responseType = singleParam(params, "response_type");
  if (!responseType.ok || responseType.value !== "code") return authorizationErrorRedirect(config, redirectUri, state, "unsupported_response_type", "Only the authorization-code response type is supported.");
  if (!state || state.length > 512 || /[\u0000-\u001f\u007f]/.test(state)) {
    return authorizationErrorRedirect(config, redirectUri, null, "invalid_request", "A valid state parameter is required.");
  }

  const challenge = singleParam(params, "code_challenge");
  const challengeMethod = singleParam(params, "code_challenge_method");
  if (!challenge.ok || !challenge.value || !/^[A-Za-z0-9_-]{43}$/.test(challenge.value) || !challengeMethod.ok || challengeMethod.value !== "S256") {
    return authorizationErrorRedirect(config, redirectUri, state, "invalid_request", "A valid PKCE S256 code challenge is required.");
  }
  const resource = singleParam(params, "resource");
  if (!resource.ok || resource.value !== config.resource) {
    return authorizationErrorRedirect(config, redirectUri, state, "invalid_target", "The requested resource must exactly match this DEMO server.");
  }
  const scopeValue = singleParam(params, "scope");
  if (!scopeValue.ok) return authorizationErrorRedirect(config, redirectUri, state, "invalid_scope", "The requested scopes are invalid.");
  const scopeParse = parseScopes(scopeValue.value || "decision:use");
  if (!scopeParse) return authorizationErrorRedirect(config, redirectUri, state, "invalid_scope", "One or more requested scopes are not supported.");

  const identity = await currentIdentity(request, env, deps);
  if (!validIdentity(identity)) {
    return oauthJsonError(401, "login_required", "Sign in to the configured Cloudflare Access application to authorize DEMO.");
  }

  const requestId = randomOpaqueToken(32);
  const flowToken = randomOpaqueToken(32);
  const csrfToken = randomOpaqueToken(32);
  const record: ConsentRequestRecord = {
    version: 1,
    expiresAt: now + config.consentTtlSeconds * 1000,
    flowTokenHash: await sha256Hex(flowToken),
    csrfTokenHash: await sha256Hex(csrfToken),
    principalHash: identity.subjectHash,
    clientId,
    clientIdHash,
    redirectUri,
    state,
    codeChallenge: challenge.value,
    scopes: scopeParse,
    audience: config.resource,
  };
  if (!await store.putConsent(await sha256Hex(requestId), record)) {
    return oauthJsonError(503, "temporarily_unavailable", "DEMO could not create a consent request.");
  }

  const response = new Response(consentHtml(requestId, csrfToken, scopeParse, config.consentTtlSeconds), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=UTF-8", "Content-Security-Policy": consentCsp() },
  });
  const cookie = `${FLOW_COOKIE}=${encodeURIComponent(flowToken)}; Path=/; Max-Age=${config.consentTtlSeconds}; HttpOnly; Secure; SameSite=Lax`;
  const headers = authHeaders(response.headers);
  headers.append("Set-Cookie", cookie);
  return new Response(response.body, { status: response.status, headers });
}

async function authorizationPost(
  request: Request,
  env: McpOAuthRouteEnv,
  config: McpOAuthConfig,
  store: McpAuthStoreApi,
  deps: McpOAuthRouteDeps,
  now: number,
): Promise<Response> {
  if (!sameOriginFormAllowed(request, config.origin)) return oauthJsonError(403, "invalid_request", "The consent form must be submitted from DEMO.");
  const form = await readForm(request);
  if (!form) return oauthJsonError(400, "invalid_request", "The consent form is malformed.");
  const requestId = singleParam(form, "request_id");
  const csrf = singleParam(form, "csrf_token");
  const decision = singleParam(form, "decision");
  const flowToken = readFlowCookie(request.headers.get("Cookie"));
  if (!requestId.ok || !requestId.value || !csrf.ok || !csrf.value || !decision.ok || !["authorize", "deny"].includes(decision.value ?? "") || !flowToken) {
    return oauthJsonError(400, "invalid_request", "The consent request is missing required state.");
  }

  const identity = await currentIdentity(request, env, deps);
  if (!validIdentity(identity)) return oauthJsonError(401, "login_required", "Sign in to Cloudflare Access before submitting consent.");

  const record = await store.consumeConsent(
    await sha256Hex(requestId.value),
    await sha256Hex(flowToken),
    await sha256Hex(csrf.value),
    identity.subjectHash,
    now,
  );
  if (!record) return oauthJsonError(400, "invalid_request", "This consent request expired or does not belong to this browser and signed-in identity. Restart the connection in ChatGPT.");

  if (decision.value === "deny") {
    return authorizationErrorRedirect(config, record.redirectUri, record.state, "access_denied", "The user denied the request.", true);
  }

  const code = randomOpaqueToken(32);
  const codeHash = await sha256Hex(code);
  const codeRecord: AuthorizationCodeRecord = {
    version: 1,
    expiresAt: now + config.codeTtlSeconds * 1000,
    clientIdHash: record.clientIdHash,
    redirectUri: record.redirectUri,
    codeChallenge: record.codeChallenge,
    scopes: record.scopes,
    principalHash: record.principalHash,
    audience: record.audience,
  };
  if (!await store.putAuthorizationCode(codeHash, codeRecord)) {
    return oauthJsonError(503, "temporarily_unavailable", "DEMO could not create an authorization code.");
  }
  const callback = new URL(record.redirectUri);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", record.state);
  callback.searchParams.set("iss", config.issuer);
  return redirectResponse(callback.toString(), true);
}

function consentHtml(requestId: string, csrfToken: string, scopes: string[], expiresInSeconds: number): string {
  const list = scopes.map((scope) => `<li><code>${escapeHtml(scope)}</code><span>${escapeHtml(MCP_OAUTH_SCOPE_DESCRIPTIONS[scope as keyof typeof MCP_OAUTH_SCOPE_DESCRIPTIONS])}</span></li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Authorize DEMO</title><style>${CONSENT_STYLE}</style></head><body><main><div class="mark">D</div><p class="eyebrow">DEMO · ChatGPT connection</p><h1>Authorize protected tools?</h1><p class="lead">You are signed in with your Cloudflare Access identity. DEMO uses that verified identity to keep your protected data separate from other users.</p><section><h2>ChatGPT is requesting</h2><ul>${list}</ul></section><p class="note"><strong>Public tools stay public.</strong> Only the requested protected scopes above are granted for this short-lived session.</p><form method="post" action="/oauth/authorize"><input type="hidden" name="request_id" value="${escapeHtml(requestId)}"><input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}"><div class="actions"><button class="deny" type="submit" name="decision" value="deny">Cancel</button><button class="allow" type="submit" name="decision" value="authorize">Authorize ChatGPT</button></div></form><p class="foot">Authorization request expires in ${expiresInSeconds} seconds. DEMO tokens last up to 15 minutes; no refresh token is issued.</p></main></body></html>`;
}

const CONSENT_STYLE = `:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080a0e;color:#f4f6fa;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}main{width:min(100%,560px);padding:30px;border:1px solid #252c37;border-radius:22px;background:#11151c;box-shadow:0 28px 80px #0008}.mark{width:34px;height:34px;display:grid;place-items:center;border-radius:11px;background:#f0f3f7;color:#111;font-weight:900}.eyebrow{margin:16px 0 6px;color:#98a4b5;font-size:12px;text-transform:uppercase;letter-spacing:.1em}h1{font-size:25px;line-height:1.2;letter-spacing:-.03em;margin:0 0 12px}.lead,.note,.foot{color:#aab4c3;line-height:1.55;font-size:14px}section{margin:22px 0;padding:18px;border:1px solid #2a3340;border-radius:15px;background:#0b0e13}h2{font-size:14px;margin:0 0 12px}ul{list-style:none;margin:0;padding:0;display:grid;gap:12px}li{display:grid;gap:4px}code{font:600 12px ui-monospace,monospace;color:#c3d5ff}li span{font-size:13px;color:#9ca7b7;line-height:1.45}.note{padding:13px 14px;border-left:2px solid #8798b2;background:#171c24;border-radius:0 10px 10px 0}.actions{display:flex;gap:10px;justify-content:flex-end;margin-top:22px}button{min-height:44px;padding:10px 16px;border:1px solid #3a4350;border-radius:12px;background:#1a202a;color:#f4f6fa;font:650 14px inherit;cursor:pointer}.allow{background:#f0f3f7;color:#101216;border-color:#f0f3f7}.foot{font-size:12px;margin:20px 0 0;color:#737f90}@media(max-width:480px){main{padding:22px}.actions{flex-direction:column-reverse}button{width:100%}}`;

/* ------------------------------------------------------------------ token */

async function tokenPost(
  request: Request,
  config: McpOAuthConfig,
  store: McpAuthStoreApi,
  deps: McpOAuthRouteDeps,
  now: number,
): Promise<Response> {
  const form = await readForm(request);
  if (!form) return oauthJsonError(400, "invalid_request", "The token request must use application/x-www-form-urlencoded.");
  const grantType = singleParam(form, "grant_type");
  const clientIdParam = singleParam(form, "client_id");
  if (!grantType.ok || grantType.value !== "authorization_code" || !clientIdParam.ok || !clientIdParam.value || !isChatGptClientId(clientIdParam.value)) {
    return oauthJsonError(400, "invalid_request", "grant_type=authorization_code and a supported client_id are required.");
  }
  if (form.has("client_secret") || form.has("client_assertion") || form.has("client_assertion_type") || request.headers.has("Authorization")) {
    return oauthJsonError(401, "invalid_client", "DEMO accepts public PKCE clients using the none token-endpoint authentication method.");
  }
  const metadata = await fetchChatGptClient(clientIdParam.value, deps.fetch ?? fetch, now);
  if (!metadata) return oauthJsonError(400, "invalid_client", "The ChatGPT client metadata could not be validated.");

  const codeParam = singleParam(form, "code");
  const redirectParam = singleParam(form, "redirect_uri");
  const verifierParam = singleParam(form, "code_verifier");
  const resourceParam = singleParam(form, "resource");
  if (!codeParam.ok || !codeParam.value || !/^[A-Za-z0-9_-]{32,128}$/.test(codeParam.value) ||
      !redirectParam.ok || !redirectParam.value || !metadata.redirectUris.includes(redirectParam.value) ||
      !verifierParam.ok || !verifierParam.value || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifierParam.value) ||
      !resourceParam.ok || resourceParam.value !== config.resource) {
    return oauthJsonError(400, "invalid_grant", "The authorization code, redirect URI, PKCE verifier, or resource is invalid.");
  }

  const clientIdHash = await sha256Hex(clientIdParam.value);
  const clientScope = clientIdHash.slice(0, 32);
  const limit = await store.charge("token", clientScope, config.rateLimitPerMinute * 2, 60_000, now);
  if (!limit.allowed) return rateLimited(limit.retryAfterSeconds);

  const record = await store.consumeAuthorizationCode(await sha256Hex(codeParam.value), now);
  if (!record || record.clientIdHash !== clientIdHash || record.redirectUri !== redirectParam.value || record.audience !== config.resource) {
    return oauthJsonError(400, "invalid_grant", "The authorization code is invalid, expired, or already used.");
  }
  if (!await verifyPkcePair(verifierParam.value, record.codeChallenge)) {
    return oauthJsonError(400, "invalid_grant", "The PKCE verifier does not match the authorization request.");
  }

  const accessToken = randomOpaqueToken(48);
  const expiresAt = now + config.accessTokenTtlSeconds * 1000;
  await store.putAccessToken(await sha256Hex(accessToken), {
    version: 1,
    clientIdHash,
    principalHash: record.principalHash,
    scopes: [...record.scopes],
    audience: record.audience,
    issuedAt: now,
    expiresAt,
  });
  const seconds = Math.max(0, Math.floor((expiresAt - now) / 1000));
  return jsonResponse({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: seconds,
    scope: record.scopes.join(" "),
    resource: record.audience,
  });
}

/* ---------------------------------------------------------------- revoke */

async function revokePost(
  request: Request,
  config: McpOAuthConfig,
  store: McpAuthStoreApi,
  deps: McpOAuthRouteDeps,
  now: number,
): Promise<Response> {
  const form = await readForm(request);
  if (!form) return oauthJsonError(400, "invalid_request", "The revocation request must use application/x-www-form-urlencoded.");
  const clientIdParam = singleParam(form, "client_id");
  const tokenParam = singleParam(form, "token");
  if (!clientIdParam.ok || !clientIdParam.value || !isChatGptClientId(clientIdParam.value)) return oauthJsonError(400, "invalid_client", "A supported ChatGPT client_id is required.");
  if (form.has("client_secret") || form.has("client_assertion") || form.has("client_assertion_type") || request.headers.has("Authorization")) {
    return oauthJsonError(401, "invalid_client", "DEMO accepts public clients using the none token-endpoint authentication method.");
  }
  const metadata = await fetchChatGptClient(clientIdParam.value, deps.fetch ?? fetch, now);
  if (!metadata) return oauthJsonError(400, "invalid_client", "The ChatGPT client metadata could not be validated.");
  const clientIdHash = await sha256Hex(clientIdParam.value);
  const limit = await store.charge("revoke", clientIdHash.slice(0, 32), config.rateLimitPerMinute * 2, 60_000, now);
  if (!limit.allowed) return rateLimited(limit.retryAfterSeconds);
  if (tokenParam.ok && tokenParam.value && /^[A-Za-z0-9_-]{32,128}$/.test(tokenParam.value)) {
    const resource = singleParam(form, "resource");
    if (resource.ok && (!resource.value || resource.value === config.resource)) {
      await store.revokeAccessToken(await sha256Hex(tokenParam.value), clientIdHash);
    }
  }
  // RFC 7009 deliberately makes revocation idempotent and does not confirm whether a token existed.
  return new Response(null, { status: 200, headers: authHeaders() });
}

/* -------------------------------------------------------------- client CIMD */

export function isChatGptClientId(value: string): boolean {
  if (value.length > 1_024) return false;
  try {
    const url = new URL(value);
    if (url.href !== value || url.origin !== "https://chatgpt.com" || url.username || url.password || url.search || url.hash) return false;
    // OpenAI's documented CIMD ids are the stable URL or a callback-specific
    // path. The URL itself is the client identity; method-selection query
    // parameters are not part of the current registration contract.
    return url.pathname === "/oauth/client.json" || /^\/oauth\/[A-Za-z0-9_-]{6,128}\/client\.json$/.test(url.pathname);
  } catch {
    return false;
  }
}

function supportedRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    if (url.href !== value || url.origin !== "https://chatgpt.com" || url.username || url.password || url.search || url.hash) return false;
    return url.pathname === "/connector_platform_oauth_redirect" || /^\/connector\/oauth\/[A-Za-z0-9_-]{6,128}$/.test(url.pathname);
  } catch {
    return false;
  }
}

async function fetchChatGptClient(clientId: string, fetcher: typeof fetch, now: number): Promise<ChatGptClientMetadata | null> {
  if (!isChatGptClientId(clientId)) return null;
  const cached = clientMetadataCache.get(clientId);
  if (cached && cached.expiresAt > now) return cached.value;
  try {
    const response = await fetcher(clientId, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return null;
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_CLIENT_METADATA_BYTES) return null;
    const text = await response.text();
    if (text.length > MAX_CLIENT_METADATA_BYTES) return null;
    const document = JSON.parse(text) as Record<string, unknown>;
    if (document.client_id !== clientId) return null;
    const redirects = document.redirect_uris;
    if (!Array.isArray(redirects) || redirects.length < 1 || redirects.length > 8 || !redirects.every(supportedRedirectUri)) return null;
    const responseTypes = document.response_types;
    const grantTypes = document.grant_types;
    if (!Array.isArray(responseTypes) || !responseTypes.includes("code") || !Array.isArray(grantTypes) || !grantTypes.includes("authorization_code")) return null;
    const methods = document.token_endpoint_auth_methods_supported;
    const supportsNone = (Array.isArray(methods) && methods.includes("none")) || document.token_endpoint_auth_method === "none";
    if (!supportsNone) return null;
    const value: ChatGptClientMetadata = { clientId, redirectUris: [...new Set(redirects)], name: "ChatGPT" };
    clientMetadataCache.set(clientId, { expiresAt: now + CLIENT_METADATA_CACHE_MS, value });
    return value;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- utilities */

function validIdentity(identity: Principal | null): identity is Principal {
  return Boolean(identity && /^[a-f0-9]{64}$/.test(identity.subjectHash));
}

function parseScopes(raw: string): string[] | null {
  const scopes = raw.split(/\s+/).filter(Boolean);
  if (!scopes.length || scopes.length > MCP_OAUTH_SCOPES.length) return null;
  const unique = [...new Set(scopes)];
  if (unique.length !== scopes.length || unique.some((scope) => !MCP_OAUTH_SCOPES.includes(scope as (typeof MCP_OAUTH_SCOPES)[number]))) return null;
  return unique;
}

function singleParam(params: URLSearchParams, key: string): { ok: boolean; value: string | null } {
  const values = params.getAll(key);
  if (values.length > 1) return { ok: false, value: null };
  return { ok: true, value: values[0] ?? null };
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  const contentType = (request.headers.get("Content-Type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") return null;
  const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
  if (declaredLength > MAX_FORM_BYTES) return null;
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > MAX_FORM_BYTES) return null;
    return new URLSearchParams(body);
  } catch {
    return null;
  }
}

function readFlowCookie(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0 || part.slice(0, index).trim() !== FLOW_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    try {
      const decoded = decodeURIComponent(value);
      return /^[A-Za-z0-9_-]{32,128}$/.test(decoded) ? decoded : null;
    } catch {
      return null;
    }
  }
  return null;
}

function sameOriginFormAllowed(request: Request, origin: string): boolean {
  const source = request.headers.get("Origin");
  if (source && source !== origin) return false;
  const fetchSite = (request.headers.get("Sec-Fetch-Site") ?? "").toLowerCase();
  return fetchSite !== "cross-site";
}

function authorizationErrorRedirect(
  config: McpOAuthConfig,
  redirectUri: string,
  state: string | null,
  error: string,
  description: string,
  clearCookie = false,
): Response {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  target.searchParams.set("error_description", description);
  if (state) target.searchParams.set("state", state);
  target.searchParams.set("iss", config.issuer);
  return redirectResponse(target.toString(), clearCookie);
}

function redirectResponse(location: string, clearCookie: boolean): Response {
  const headers = authHeaders();
  headers.set("Location", location);
  if (clearCookie) headers.append("Set-Cookie", `${FLOW_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  return new Response(null, { status: 302, headers });
}

function consentCsp(): string {
  return "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; img-src 'none'; script-src 'none'";
}

function escapeHtml(value: string): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function authHeaders(existing?: HeadersInit): Headers {
  const headers = new Headers(existing);
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return headers;
}

function jsonResponse(value: unknown): Response {
  const headers = authHeaders();
  headers.set("Content-Type", "application/json; charset=UTF-8");
  return new Response(JSON.stringify(value), { status: 200, headers });
}

function oauthJsonError(status: number, error: string, description: string): Response {
  const headers = authHeaders();
  headers.set("Content-Type", "application/json; charset=UTF-8");
  return new Response(JSON.stringify({ error, error_description: description }), { status, headers });
}

function methodNotAllowed(allow: string): Response {
  const headers = authHeaders();
  headers.set("Allow", allow);
  return new Response("Method not allowed", { status: 405, headers });
}

function rateLimited(retryAfterSeconds: number): Response {
  const response = oauthJsonError(429, "temporarily_unavailable", "Too many OAuth requests. Retry after the indicated delay.");
  const headers = new Headers(response.headers);
  headers.set("Retry-After", String(retryAfterSeconds));
  return new Response(response.body, { status: response.status, headers });
}

function tokenCorsPreflight(request: Request): Response {
  const origin = request.headers.get("Origin");
  if (!origin || !CHATGPT_ORIGINS.has(origin)) return new Response(null, { status: 403, headers: authHeaders() });
  const headers = authHeaders();
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Accept");
  headers.set("Access-Control-Max-Age", "600");
  headers.set("Vary", "Origin");
  return new Response(null, { status: 204, headers });
}

function tokenCors(response: Response, request: Request): Response {
  const origin = request.headers.get("Origin");
  if (!origin) return response;
  if (!CHATGPT_ORIGINS.has(origin)) return new Response("Forbidden origin", { status: 403, headers: authHeaders() });
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Accept");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Stable helper used by tool-level challenges and protected-resource metadata. */
export function mcpOAuthChallenge(config: McpOAuthConfig, error: "invalid_token" | "insufficient_scope", description: string): string {
  const escaped = description.replaceAll("\\", "\\\\").replaceAll('"', "\\\"").replace(/[\r\n]/g, " ");
  return `Bearer resource_metadata="${config.resourceMetadataUrl}", error="${error}", error_description="${escaped}"`;
}

/** Test-only cache reset, useful for proving fresh CIMD metadata validation. */
export function clearChatGptClientMetadataCacheForTests(): void {
  clientMetadataCache.clear();
}
