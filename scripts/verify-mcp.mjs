#!/usr/bin/env node
/**
 * Safe deployed/local smoke check. Never sends Authorization or cookies.
 *
 * What the unauthenticated run proves (this is the post-deploy CI step):
 *
 *   - MCP `initialize` / `notifications/initialized` / `tools/list` / `demo_ping`
 *     work with no Authorization header and no session cookie;
 *   - `GET /health` and `GET /tools` answer HTTP 200 with the expected public
 *     payload.
 *
 * Failure diagnostics are byte-bounded and redacted by
 * `scripts/safe-diagnostics.mjs`: no Authorization value, Access assertion,
 * cookie, token or secret is ever printed, and a redirect target is reported
 * without its query string.
 *
 * Usage: node scripts/verify-mcp.mjs <worker-url>
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  MAX_PAYLOAD_BYTES,
  describeResponse,
  formatResponseSummary,
  readBoundedBody,
  redactSecrets,
} from "./safe-diagnostics.mjs";

/** Public JSON routes that must answer an anonymous caller with HTTP 200. */
const PUBLIC_200_PATHS = ["/health", "/tools"];
/** Tools that must be discoverable without login. */
const REQUIRED_TOOLS = ["demo_ping", "roblox_user", "roblox_game", "jev_decide"];
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

  for (const path of PUBLIC_200_PATHS) {
    const { body } = await readJsonRoute(path);
    if (path === "/health") assert.equal(body.ok, true, "/health: ok must be true");
    if (path === "/tools") assert.deepEqual(body.tools.toSorted(), tools.toSorted(), "/tools: tool list must match MCP tools/list");
    console.log(`${path}: HTTP 200`);
  }

  console.log(
    `PASS: unauthenticated MCP handshake, discovery and demo_ping completed; ` +
    `/health and /tools returned 200.`,
  );
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause ? ` (cause: ${error.cause instanceof Error ? error.cause.message : String(error.cause)})` : "";
  console.error(`FAIL: ${redactSecrets(`${message}${cause}`, 2000)}`);
  process.exit(1);
}
