import { describe, expect, it, vi, afterEach } from "vitest";
import worker, { DEMO_TOOL_NAMES, TOOL_COUNT } from "../index.js";
import platform from "../platform-entry.js";
import { InMemoryMcpAuthStore } from "../src/auth/oauth-store.js";

const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

function testEnv() {
  const store = new InMemoryMcpAuthStore();
  return {
    MCP_PUBLIC_ORIGIN: "https://demo.test",
    MCP_AUTH_ACCESS_TEAM_DOMAIN: "demo.cloudflareaccess.com",
    MCP_AUTH_ACCESS_AUD: "test-access-audience",
    MCP_AUTH: {
      idFromName: (name: string) => name,
      get: () => store,
    },
  };
}

async function rpc(entry: typeof worker | typeof platform, method: string, params = {}, authorization?: string, env = testEnv()) {
  const response = await entry.fetch(new Request("https://demo.test/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }), env as never, CTX);
  const text = await response.text();
  const data = text.startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).at(-1)?.slice(5);
  return { response, body: data ? JSON.parse(data) : null };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

for (const [name, entry] of [["MCP worker", worker], ["deployed platform entry", platform]] as const) {
  describe(`${name}: public transport and per-tool OAuth`, () => {
    for (const authorization of [undefined, "Bearer malformed-token-with-enough-length-1234567890"]) {
      it(`keeps public discovery and demo_ping available with ${authorization ? "an invalid token" : "no token"}`, async () => {
        const initialized = await rpc(entry, "initialize", {
          protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "oauth-regression", version: "1.0" },
        }, authorization);
        expect(initialized.response.status).toBe(200);
        expect(initialized.body.error).toBeUndefined();
        expect(initialized.body.result.serverInfo.name).toBe("DEMO");
        expect(initialized.body.result.protocolVersion).toBe("2025-03-26");

        const listed = await rpc(entry, "tools/list", {}, authorization);
        expect(listed.response.status).toBe(200);
        const tools = listed.body.result.tools;
        expect(tools.map((tool: { name: string }) => tool.name).sort()).toEqual([...DEMO_TOOL_NAMES].sort());
        expect(tools.find((tool: { name: string }) => tool.name === "demo_ping").securitySchemes).toEqual([{ type: "noauth" }]);
        expect(tools.find((tool: { name: string }) => tool.name === "jev_capabilities").securitySchemes).toEqual([{ type: "noauth" }]);
        expect(tools.find((tool: { name: string }) => tool.name === "roblox_account_profile").securitySchemes).toEqual([{ type: "oauth2", scopes: ["roblox:read"] }]);
        expect(tools.find((tool: { name: string }) => tool.name === "roblox_account_link_start").securitySchemes).toEqual([{ type: "oauth2", scopes: ["roblox:link"] }]);
        expect(tools.find((tool: { name: string }) => tool.name === "roblox_account_unlink").securitySchemes).toEqual([{ type: "oauth2", scopes: ["roblox:disconnect"] }]);
        expect(tools.find((tool: { name: string }) => tool.name === "jev_decide").securitySchemes).toEqual([{ type: "oauth2", scopes: ["decision:use"] }]);

        const ping = await rpc(entry, "tools/call", { name: "demo_ping", arguments: {} }, authorization);
        expect(ping.response.status).toBe(200);
        expect(ping.body.result.isError).not.toBe(true);
        expect(JSON.parse(ping.body.result.content[0].text)).toMatchObject({ ok: true, name: "DEMO", toolCount: TOOL_COUNT });
        const capabilities = await rpc(entry, "tools/call", { name: "jev_capabilities", arguments: {} }, authorization);
        expect(capabilities.body.result.isError).not.toBe(true);
      });
    }

    it("does not inspect any user's account from the public Roblox capabilities resource", async () => {
      const { AccountVault } = await import("../src/roblox/store.js");
      const readAccount = vi.spyOn(AccountVault.prototype, "getAccount");
      const result = await rpc(entry, "resources/read", { uri: "demo://capabilities/roblox" });
      expect(result.response.status).toBe(200);
      expect(result.body.result.contents[0].mimeType).toBe("application/json");
      const report = JSON.parse(result.body.result.contents[0].text);
      expect(report.separation.accountTools.authenticated).toBe(true);
      expect(report.separation.accountTools.note).toMatch(/user-bound DEMO OAuth/i);
      expect(readAccount).not.toHaveBeenCalled();
    });

    for (const tool of [...DEMO_TOOL_NAMES.filter((toolName) => toolName.startsWith("roblox_account_")), "jev_decide"]) {
      it(`returns a scoped OAuth challenge for ${tool} without contacting an upstream`, async () => {
        const upstream = vi.fn(() => { throw new Error("Protected operation must not reach upstream"); });
        vi.stubGlobal("fetch", upstream);
        const args = tool === "jev_decide" ? { decision: "tool_route", request: "test" } : {};
        const result = await rpc(entry, "tools/call", { name: tool, arguments: args });
        expect(result.response.status).toBe(200);
        expect(result.body.result.isError).toBe(true);
        expect(JSON.parse(result.body.result.content[0].text).error).toBe("invalid_token");
        const challenges = result.body.result._meta?.["mcp/www_authenticate"];
        expect(challenges).toHaveLength(1);
        expect(challenges[0]).toContain('resource_metadata="https://demo.test/.well-known/oauth-protected-resource"');
        expect(challenges[0]).toContain('error="invalid_token"');
        expect(upstream).not.toHaveBeenCalled();
      });
    }

    it("retains MCP content negotiation and malformed JSON validation", async () => {
      for (const [headers, body, status] of [
        [{ "content-type": "application/json", accept: "application/json, text/event-stream" }, "{", 400],
        [{ "content-type": "application/json", accept: "text/plain" }, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), 406],
      ] as const) {
        const response = await entry.fetch(new Request("https://demo.test/mcp", { method: "POST", headers, body }), testEnv() as never, CTX);
        expect(response.status).toBe(status);
      }
    });
  });
}

it("publishes RFC 9728 and authorization-server metadata while leaving token exchange public", async () => {
  const env = testEnv();
  for (const [path, expected] of [
    ["/.well-known/oauth-protected-resource", { resource: "https://demo.test", authorization_servers: ["https://demo.test"] }],
    ["/.well-known/oauth-authorization-server", { issuer: "https://demo.test", code_challenge_methods_supported: ["S256"], grant_types_supported: ["authorization_code"] }],
  ] as const) {
    const response = await platform.fetch(new Request(`https://demo.test${path}`), env as never, CTX);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject(expected);
  }
  const missingAuthConfig = await platform.fetch(new Request("https://demo.test/oauth/token", { method: "POST" }), {} as never, CTX);
  expect(missingAuthConfig.status).toBe(503);
});

it("retains the platform origin guard and public health route", async () => {
  const env = testEnv();
  const denied = await platform.fetch(new Request("https://demo.test/mcp", { headers: { origin: "https://untrusted.test" } }), env as never, CTX);
  expect(denied.status).toBe(403);
  expect(await denied.text()).toBe("Forbidden origin");
  const health = await platform.fetch(new Request("https://demo.test/health"), env as never, CTX);
  expect(health.status).toBe(200);
  expect(await health.json()).toMatchObject({ ok: true, name: "DEMO", toolCount: TOOL_COUNT });
});
