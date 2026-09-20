// Safe deployed/local smoke check. Never sends Authorization or cookies and
// never initiates account linking, token refresh or logout.
import assert from "node:assert/strict";

const origin = new URL(process.argv[2]).origin;
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
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  assert(response.ok, `${method}: HTTP ${response.status}`);
  sessionId = response.headers.get("mcp-session-id") ?? sessionId;
  const text = await response.text();
  if (notification) {
    assert.equal(response.status, 202, "initialized notification accepted");
    console.log(`${method}: HTTP 202 (no Authorization header)`);
    return;
  }
  const payload = text.trim().startsWith("{") ? text : text.split("\n").filter(line => line.startsWith("data:")).at(-1)?.slice(5);
  assert(payload, `${method}: missing JSON-RPC response`);
  const body = JSON.parse(payload);
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, id);
  assert.equal(body.error, undefined, `${method}: JSON-RPC error`);
  assert(body.result, `${method}: missing result`);
  console.log(`${method}: HTTP ${response.status} (no Authorization header)`);
  return body.result;
}

const initialized = await rpc("initialize", {
  protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "demo-no-auth-verification", version: "1.0" },
});
assert.equal(initialized.serverInfo.name, "DEMO");
assert.equal(initialized.protocolVersion, "2025-03-26");
protocolVersion = initialized.protocolVersion;
console.log(`Server: DEMO ${initialized.serverInfo.version}; protocol: ${protocolVersion}`);
await rpc("notifications/initialized", {}, true);
const tools = (await rpc("tools/list")).tools.map(tool => tool.name);
for (const tool of ["demo_ping", "roblox_user", "roblox_account_status", "roblox_account_unlink", "jev_decide"]) assert(tools.includes(tool), `Missing tool: ${tool}`);
const ping = await rpc("tools/call", { name: "demo_ping", arguments: {} });
assert.notEqual(ping.isError, true, "demo_ping returned a tool error");
const status = JSON.parse(ping.content.find(content => content.type === "text").text);
assert.equal(status.ok, true);
assert.equal(status.name, "DEMO");
assert.equal(status.toolCount, tools.length);
console.log(`demo_ping: ok; ${tools.length} tools registered`);
for (const path of ["/health", "/tools", "/oauth/roblox/status"]) {
  const response = await fetch(`${origin}${path}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000), redirect: "error" });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  const body = await response.json();
  if (path === "/health") assert.equal(body.ok, true);
  if (path === "/tools") assert.deepEqual(body.tools.toSorted(), tools.toSorted());
  if (path === "/oauth/roblox/status") assert.equal(typeof body.connected, "boolean");
  console.log(`${path}: HTTP 200`);
}
console.log("PASS: unauthenticated MCP handshake, discovery and demo_ping completed.");
