#!/usr/bin/env node
/**
 * Safe deployed/local smoke check. Never sends Authorization or cookies and
 * never initiates account linking, token refresh or logout.
 *
 * What the unauthenticated run proves (this is the post-deploy CI step):
 *
 *   - MCP `initialize` / `notifications/initialized` / `tools/list` / `demo_ping`
 *     work with no Authorization header and no session cookie;
 *   - `GET /health` and `GET /tools` answer HTTP 200 with the expected public
 *     payload;
 *   - `GET /oauth/roblox/status` REFUSES an anonymous caller.
 *
 * `/oauth/roblox/status` is a private route. It answers only for a verified
 * human Cloudflare Access identity (`CF-Access-Jwt-Assertion`, RS256, `type:
 * "app"` — service tokens are rejected by design) and only when encrypted
 * Roblox storage is configured, so an anonymous request must yield HTTP 401
 * (or an Access login redirect / a 503 when storage is not configured).
 * Expecting HTTP 200 there made the post-deploy smoke check fail against a
 * correctly secured Worker; this script now asserts the refusal instead, and
 * fails loudly if the route ever answers an anonymous caller with 2xx. That
 * contract is pinned by `tests/verify-mcp.test.ts`.
 *
 * Optional protected probe — OFF by default and never used by the public CI
 * step. To exercise the authenticated 200 path, an operator can supply a real,
 * unexpired *human* Cloudflare Access assertion for the configured team:
 *
 *   SMOKE_CF_ACCESS_JWT='<assertion>' node scripts/verify-mcp.mjs <worker-url>
 *
 * The value is only ever sent as the `CF-Access-Jwt-Assertion` header to the
 * private route, is never printed (it is reported as a length + SHA-256
 * fingerprint) and never committed. This does not weaken the endpoint: the
 * Worker still verifies the signature, issuer, audience, expiry and `type`
 * claim itself. A service token cannot be used — the Worker rejects it.
 *
 * Failure diagnostics are byte-bounded and redacted by
 * `scripts/safe-diagnostics.mjs`: no Authorization value, Access assertion,
 * cookie, token or secret is ever printed, and a redirect target is reported
 * without its query string (OAuth `state`/`code_challenge` live there).
 *
 * Usage: node scripts/verify-mcp.mjs <worker-url>
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  MAX_PAYLOAD_BYTES,
  describeResponse,
  fingerprintSecret,
  formatResponseSummary,
  readBoundedBody,
  redactSecrets,
  safeRedirectTarget,
} from "./safe-diagnostics.mjs";

/** Public JSON routes that must answer an anonymous caller with HTTP 200. */
const PUBLIC_200_PATHS = ["/health", "/tools"];
/**
 * Private route: must NOT answer an anonymous caller with 2xx. Keep it out of
 * `PUBLIC_200_PATHS` — see `tests/verify-mcp.test.ts`.
 */
const PRIVATE_ROBLOX_STATUS_PATH = "/oauth/roblox/status";
/** Statuses that all mean "refused, and therefore still private". */
const PRIVATE_REFUSAL_STATUSES = new Set([400, 401, 403, 405, 429, 503]);
/** Tools that must be discoverable without login. */
const REQUIRED_TOOLS = ["demo_ping", "roblox_user", "roblox_account_status", "roblox_account_unlink", "jev_decide"];
const REQUEST_TIMEOUT_MS = 30_000;

const urlArgument = process.argv[2];
if (!urlArgument) {
  console.error("usage: node scripts/verify-mcp.mjs <worker-url>");
  process.exit(2);
}
let origin;
try {
  origin = new URL(urlArgument).origin;
} catch (error) {
  console.error(`invalid worker URL: ${redactSecrets(error instanceof Error ? error.message : String(error), 200)}`);
  process.exit(2);
}

const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");
let id = 0;
let protocolVersion;
let sessionId;

async function rpc(method, params = {}, notification = false) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(protocolVersion ? { "MCP-Protocol-Version": protocolVersion } : {}),
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: ++id }), method, params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`${method}: unexpected response — ${await describeResponse(response, { label: "POST /mcp" })}`);
  }
  sessionId = response.headers.get("mcp-session-id") ?? sessionId;
  if (notification) {
    assert.equal(response.status, 202, "initialized notification accepted");
    console.log(`${method}: HTTP 202 (no Authorization header)`);
    return;
  }
  const text = await response.text();
  const payload = text.trim().startsWith("{") ? text : text.split("\n").filter(line => line.startsWith("data:")).at(-1)?.slice(5);
  if (!payload) {
    // The body was already consumed by `response.text()`, so summarise from
    // what is in hand rather than trying to read the stream a second time.
    const read = { text, bytesRead: Buffer.byteLength(text), truncated: false };
    throw new Error(`${method}: missing JSON-RPC response — ${formatResponseSummary(response, read, { label: "POST /mcp" })}`);
  }
  let body;
  try {
    body = JSON.parse(payload);
  } catch (error) {
    throw new Error(`${method}: unparseable JSON-RPC response (${redactSecrets(error instanceof Error ? error.message : String(error), 160)}) — body: ${redactSecrets(payload)}`);
  }
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, id);
  if (body.error !== undefined) throw new Error(`${method}: JSON-RPC error — ${redactSecrets(JSON.stringify(body.error))}`);
  assert(body.result, `${method}: missing result`);
  console.log(`${method}: HTTP ${response.status} (no Authorization header)`);
  return body.result;
}

async function readJsonRoute(path) {
  const response = await fetch(`${origin}${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "error",
  });
  const read = await readBoundedBody(response, MAX_PAYLOAD_BYTES);
  if (response.status !== 200) {
    throw new Error(`${path}: expected HTTP 200 — ${formatResponseSummary(response, read, { label: `GET ${path}` })}`);
  }
  let body;
  try {
    body = JSON.parse(read.text);
  } catch (error) {
    throw new Error(`${path}: HTTP 200 but the body is not JSON (${redactSecrets(error instanceof Error ? error.message : String(error), 160)}) — ${formatResponseSummary(response, read, { label: `GET ${path}` })}`);
  }
  return { response, body };
}

/**
 * The private Roblox status route, called anonymously on purpose.
 *
 * No Authorization header, no cookie, no Access assertion. `redirect: "manual"`
 * so an Access login redirect is observed and reported but never followed
 * (following it would start an interactive login and could carry credentials).
 */
async function checkPrivateRobloxStatusRefusesAnonymous() {
  const path = PRIVATE_ROBLOX_STATUS_PATH;
  const response = await fetch(`${origin}${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "manual",
  });
  const read = await readBoundedBody(response);
  const summary = formatResponseSummary(response, read, { label: `GET ${path} (anonymous)` });

  if (response.status >= 200 && response.status < 300) {
    throw new Error(
      `${path}: SECURITY REGRESSION — the private Roblox status route answered an anonymous smoke check with HTTP ${response.status}. ` +
      `It must require a verified human Cloudflare Access identity and encrypted Roblox storage, so an anonymous caller must be refused (HTTP 401). ` +
      `Do not fix this by expecting 200 here and do not weaken the identity check in src/roblox/routes.ts or src/auth/access-identity.ts. ` +
      `Details: ${summary}`,
    );
  }

  if (response.status >= 300 && response.status < 400) {
    const target = safeRedirectTarget(response);
    console.log(`${path}: HTTP ${response.status} (redirected to ${target ?? "a withheld target"} — anonymous access refused; redirect not followed)`);
    return { refused: true, status: response.status };
  }

  if (!PRIVATE_REFUSAL_STATUSES.has(response.status)) {
    throw new Error(
      `${path}: expected an authentication refusal (401 from the Worker, 403, or 503 when Roblox storage is unconfigured) but got HTTP ${response.status}. ` +
      `The route must stay present and private. Details: ${summary}`,
    );
  }

  // When the Worker itself refused, its documented error code should be there.
  // An Access-edge refusal or an HTML body is equally acceptable, so this is a
  // note rather than an assertion.
  let note = "";
  try {
    const body = JSON.parse(read.text);
    if (body && typeof body.error === "string") note = ` (error code: ${redactSecrets(body.error, 64)})`;
  } catch {
    note = " (non-JSON refusal body)";
  }
  console.log(`${path}: HTTP ${response.status}${note} — private route refused the anonymous check; no Authorization, cookie or Access assertion was sent`);
  return { refused: true, status: response.status };
}

/**
 * Decode an Access assertion's claims WITHOUT verifying or printing them, so an
 * operator who supplies an unusable token gets a precise reason. Only booleans
 * and the `type` enum are ever reported — never `sub`, `email` or `iss`.
 */
function inspectAssertion(assertion) {
  const parts = assertion.split(".");
  if (parts.length !== 3) return { usable: false, reason: "not a three-part JWT" };
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { usable: false, reason: "claims segment is not decodable JSON" };
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) return { usable: false, reason: "expired — mint a fresh assertion" };
  if (typeof claims.iat === "number" && claims.iat > nowSeconds + 60) return { usable: false, reason: "issued in the future — check the clock" };
  if (claims.type !== "app") return { usable: false, reason: `type claim is ${redactSecrets(JSON.stringify(claims.type ?? null), 64)}, but the Worker only accepts human "app" assertions (service tokens are rejected by design)` };
  if (typeof claims.sub !== "string" || !claims.sub.trim()) return { usable: false, reason: "no subject claim" };
  return { usable: true, reason: null };
}

/**
 * Opt-in: prove the authenticated 200 path with an operator-supplied, real
 * Access assertion. Skipped (loudly, never silently) when none is provided.
 */
async function checkProtectedRobloxStatusIfConfigured() {
  const path = PRIVATE_ROBLOX_STATUS_PATH;
  const assertion = (process.env.SMOKE_CF_ACCESS_JWT ?? "").trim();
  if (!assertion) {
    console.log(
      `SKIP: protected ${path} probe — SMOKE_CF_ACCESS_JWT is not set. The anonymous refusal above is the deploy gate; ` +
      `the authenticated 200 path is covered offline by tests/roblox-routes.test.ts and tests/access-identity.test.ts. ` +
      `Supply a real, unexpired human Access assertion to run this probe; never a service token and never a committed secret.`,
    );
    return { skipped: true };
  }

  const fingerprint = fingerprintSecret(assertion, sha256Hex);
  const inspection = inspectAssertion(assertion);
  if (!inspection.usable) {
    throw new Error(`protected ${path}: SMOKE_CF_ACCESS_JWT cannot work — ${inspection.reason} (assertion ${fingerprint}; value not printed)`);
  }

  const response = await fetch(`${origin}${path}`, {
    headers: { Accept: "application/json", "CF-Access-Jwt-Assertion": assertion },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "error",
  });
  const read = await readBoundedBody(response, MAX_PAYLOAD_BYTES);
  if (response.status !== 200) {
    throw new Error(
      `protected ${path}: expected HTTP 200 for a verified Access identity but got ${formatResponseSummary(response, read, { label: `GET ${path} (protected probe)` })} ` +
      `(assertion ${fingerprint}; the Worker verifies signature, issuer, audience, expiry and type itself)`,
    );
  }
  let body;
  try {
    body = JSON.parse(read.text);
  } catch (error) {
    throw new Error(`protected ${path}: HTTP 200 but the body is not JSON (${redactSecrets(error instanceof Error ? error.message : String(error), 160)}) — ${formatResponseSummary(response, read, { label: `GET ${path} (protected probe)` })}`);
  }
  assert.equal(typeof body.connected, "boolean", `protected ${path}: connected must be a boolean`);
  // Non-secret configuration facts only: no account name, no token expiry, no
  // redirect URI, and never the assertion.
  const configuration = body.configuration ?? {};
  console.log(
    `protected ${path}: HTTP 200 (connected=${body.connected}, enabled=${configuration.enabled}, storage=${configuration.storage}, ` +
    `tokenEncryption=${configuration.tokenEncryption}) — assertion ${fingerprint}`,
  );
  return { skipped: false, connected: body.connected };
}

async function main() {
  console.log(`Smoke-checking ${origin} with no credentials.`);

  const initialized = await rpc("initialize", {
    protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "demo-no-auth-verification", version: "1.0" },
  });
  assert.equal(initialized.serverInfo.name, "DEMO");
  assert.equal(initialized.protocolVersion, "2025-03-26");
  protocolVersion = initialized.protocolVersion;
  console.log(`Server: DEMO ${initialized.serverInfo.version}; protocol: ${protocolVersion}`);
  await rpc("notifications/initialized", {}, true);
  const tools = (await rpc("tools/list")).tools.map(tool => tool.name);
  for (const tool of REQUIRED_TOOLS) assert(tools.includes(tool), `Missing tool: ${tool}`);
  const ping = await rpc("tools/call", { name: "demo_ping", arguments: {} });
  assert.notEqual(ping.isError, true, "demo_ping returned a tool error");
  const status = JSON.parse(ping.content.find(content => content.type === "text").text);
  assert.equal(status.ok, true);
  assert.equal(status.name, "DEMO");
  assert.equal(status.toolCount, tools.length);
  console.log(`demo_ping: ok; ${tools.length} tools registered`);

  // Public no-login HTTP routes. /oauth/roblox/status is deliberately absent:
  // it is private and is checked for refusal below.
  for (const path of PUBLIC_200_PATHS) {
    const { body } = await readJsonRoute(path);
    if (path === "/health") assert.equal(body.ok, true, "/health: ok must be true");
    if (path === "/tools") assert.deepEqual(body.tools.toSorted(), tools.toSorted(), "/tools: tool list must match MCP tools/list");
    console.log(`${path}: HTTP 200`);
  }

  const refusal = await checkPrivateRobloxStatusRefusesAnonymous();
  const protectedProbe = await checkProtectedRobloxStatusIfConfigured();

  console.log(
    `PASS: unauthenticated MCP handshake, discovery and demo_ping completed; ` +
    `/health and /tools returned 200; ${PRIVATE_ROBLOX_STATUS_PATH} stayed private (HTTP ${refusal.status} anonymously` +
    `${protectedProbe.skipped ? "; protected probe skipped" : `; protected probe verified HTTP 200`}).`,
  );
}

try {
  await main();
} catch (error) {
  // Redaction is applied again here as a last line of defence: an unexpected
  // error object must not become the thing that leaks a credential.
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause ? ` (cause: ${error.cause instanceof Error ? error.cause.message : String(error.cause)})` : "";
  console.error(`FAIL: ${redactSecrets(`${message}${cause}`, 2000)}`);
  process.exit(1);
}
