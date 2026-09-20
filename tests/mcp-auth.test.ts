import { describe, expect, it, vi, afterEach } from "vitest";
import worker, { DEMO_TOOL_NAMES, TOOL_COUNT } from "../index.js";
import platform from "../platform-entry.js";
import { AccountVault } from "../src/roblox/store.js";

const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const ENV = { DEMO_API_KEY: "private-tool-key" };

async function rpc(entry: typeof worker | typeof platform, method: string, params = {}, authorization?: string, env = ENV) {
  const response = await entry.fetch(new Request("https://demo.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(authorization ? { authorization } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }), env as never, CTX);
  const text = await response.text();
  const data = text.startsWith("{") ? text : text.split("\n").filter(line => line.startsWith("data:")).at(-1)?.slice(5);
  return { response, body: data ? JSON.parse(data) : null };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

for (const [name, entry] of [["MCP worker", worker], ["deployed platform entry", platform]] as const) {
  describe(`${name}: public MCP transport`, () => {
    for (const authorization of [undefined, "Bearer wrong-key", "Bearer private-tool-key"]) {
      it(`initializes, discovers all tools and pings with ${authorization ? authorization.includes("wrong") ? "invalid credentials" : "valid credentials" : "no Authorization header"}`, async () => {
        const initialized = await rpc(entry, "initialize", {
          protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "auth-regression", version: "1.0" },
        }, authorization);
        expect(initialized.response.status).toBe(200);
        expect(initialized.body.error).toBeUndefined();
        expect(initialized.body.result.serverInfo.name).toBe("DEMO");
        expect(initialized.body.result.protocolVersion).toBe("2025-03-26");
        const listed = await rpc(entry, "tools/list", {}, authorization);
        expect(listed.response.status).toBe(200);
        expect(listed.body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([...DEMO_TOOL_NAMES].sort());
        const ping = await rpc(entry, "tools/call", { name: "demo_ping", arguments: {} }, authorization);
        expect(ping.response.status).toBe(200);
        expect(ping.body.result.isError).not.toBe(true);
        expect(JSON.parse(ping.body.result.content[0].text)).toMatchObject({ ok: true, name: "DEMO", toolCount: TOOL_COUNT });
      });
    }

    it("also works with no DEMO_API_KEY configured", async () => {
      expect((await rpc(entry, "tools/call", { name: "demo_ping", arguments: {} }, undefined, {} as typeof ENV)).response.status).toBe(200);
    });

    it("keeps linked-account state out of the public capabilities resource", async () => {
      const readAccount = vi.spyOn(AccountVault.prototype, "getAccount").mockResolvedValue(null);
      for (const authorization of [undefined, "Bearer wrong-key"]) {
        const result = await rpc(entry, "resources/read", { uri: "demo://capabilities/roblox" }, authorization);
        expect(result.response.status).toBe(200);
        expect(result.body.result.contents[0].mimeType).toBe("application/json");
        expect(readAccount).not.toHaveBeenCalled();
      }
      const result = await rpc(entry, "resources/read", { uri: "demo://capabilities/roblox" }, "Bearer private-tool-key");
      expect(result.response.status).toBe(200);
      expect(readAccount).toHaveBeenCalledOnce();
    });

    it("retains MCP content negotiation and malformed JSON validation", async () => {
      for (const [headers, body, status] of [
        [{ "content-type": "application/json", accept: "application/json, text/event-stream" }, "{", 400],
        [{ "content-type": "application/json", accept: "text/plain" }, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), 406],
      ] as const) {
        const response = await entry.fetch(new Request("https://demo.test/mcp", { method: "POST", headers, body }), ENV as never, CTX);
        expect(response.status).toBe(status);
      }
    });

    for (const tool of [...DEMO_TOOL_NAMES.filter(name => name.startsWith("roblox_account_")), "jev_decide"]) {
      it(`keeps ${tool} private even when the secret remains configured`, async () => {
        const upstream = vi.fn(() => { throw new Error("Private operation must not reach upstream"); });
        vi.stubGlobal("fetch", upstream);
        for (const authorization of [undefined, "Bearer wrong-key"]) {
          const result = await rpc(entry, "tools/call", { name: tool, arguments: tool === "jev_decide" ? { decision: "tool_route", request: "test" } : {} }, authorization);
          expect(result.response.status).toBe(200);
          expect(result.body.result.isError).toBe(true);
          expect(JSON.parse(result.body.result.content[0].text).error).toBe("unauthorized");
          expect(JSON.stringify(result.body)).not.toContain(ENV.DEMO_API_KEY);
        }
        expect(upstream).not.toHaveBeenCalled();
      });
    }
  });
}

it("retains the platform origin guard and public health route", async () => {
  const denied = await platform.fetch(new Request("https://demo.test/mcp", { headers: { origin: "https://untrusted.test" } }), ENV as never, CTX);
  expect(denied.status).toBe(403);
  expect(await denied.text()).toBe("Forbidden origin");
  const health = await platform.fetch(new Request("https://demo.test/health"), ENV as never, CTX);
  expect(health.status).toBe(200);
  expect(await health.json()).toMatchObject({ ok: true, name: "DEMO", toolCount: TOOL_COUNT });
});
