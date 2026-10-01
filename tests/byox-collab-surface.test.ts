/**
 * The public surface of the two new features, exercised through the real Worker
 * entrypoints (platform dispatcher + MCP transport) rather than module calls:
 * tool registration, the capability reports the UI reads, the honest failure
 * modes when storage or a credential is missing, and the HTTP routes.
 */
import { describe, expect, it } from "vitest";
import platform from "../platform-entry.js";
import worker, { DEMO_TOOL_NAMES, TOOL_COUNT } from "../index.js";
import { BYOX_TOOL_NAMES } from "../src/mcp/byox-tools.js";
import { COLLAB_TOOL_NAMES } from "../src/mcp/collab-tools.js";
import { clearByoxCacheForTests, refreshByoxIndex } from "../src/byox/store.js";

const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

class FakeBucket {
  objects = new Map<string, string>();
  async put(key: string, value: string) {
    this.objects.set(key, value);
  }
  async get(key: string) {
    const text = this.objects.get(key);
    if (text === undefined) return null;
    return {
      text: async () => text,
      json: async () => JSON.parse(text),
      arrayBuffer: async () => new TextEncoder().encode(text).buffer,
      customMetadata: {},
      httpMetadata: {},
    };
  }
  async head(key: string) {
    const text = this.objects.get(key);
    return text === undefined ? null : { size: text.length, customMetadata: {} };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

function readme(): string {
  let body = "# Build your own X\n\n## Tutorials\n";
  for (let c = 0; c < 5; c += 1) {
    body += `\n#### Build your own \`Thing ${c}\`\n\n`;
    for (let t = 0; t < 12; t += 1) body += `* [**Python**: _Write your own ${c}-${t}_](https://example.org/${c}/${t})\n`;
  }
  return body;
}

async function rpc(method: string, params: Record<string, unknown>, env: unknown, headers: Record<string, string> = {}) {
  const response = await worker.fetch(
    new Request("https://demo.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env as never,
    CTX,
  );
  const text = await response.text();
  if (text.trim().startsWith("{")) return JSON.parse(text) as { result?: any; error?: { message: string } };
  const data = text.split("\n").filter((line) => line.startsWith("data:"));
  return JSON.parse(data[data.length - 1]!.slice(5).trim()) as { result?: any; error?: { message: string } };
}

async function callTool(name: string, args: Record<string, unknown>, env: unknown, headers: Record<string, string> = {}) {
  const response = await rpc("tools/call", { name, arguments: args }, env, headers);
  const result = response.result ?? {};
  const text = (result.content ?? []).map((entry: { text?: string }) => entry.text ?? "").join("\n");
  return { isError: Boolean(result.isError), text, parsed: (() => { try { return JSON.parse(text); } catch { return null; } })(), meta: result._meta };
}

describe("BYOX and collaboration tool registration", () => {
  it("adds the fourteen new tools to the live inventory without disturbing existing ones", () => {
    for (const name of [...BYOX_TOOL_NAMES, ...COLLAB_TOOL_NAMES]) expect(DEMO_TOOL_NAMES).toContain(name);
    expect(TOOL_COUNT).toBe(DEMO_TOOL_NAMES.length);
    // The pre-existing tool names were not renamed or duplicated.
    expect(new Set(DEMO_TOOL_NAMES).size).toBe(DEMO_TOOL_NAMES.length);
    for (const legacy of ["browser_inspect", "video_analyze", "jev_decide", "laya_capabilities", "roblox_user", "roblox_game", "git_repository"]) {
      expect(DEMO_TOOL_NAMES).toContain(legacy);
    }
  });

  it("lists them over MCP with the documented titles", async () => {
    const listed = await rpc("tools/list", {}, {});
    const byName = new Map<string, { title?: string; description?: string }>((listed.result?.tools ?? []).map((tool: { name: string }) => [tool.name, tool]));
    expect(byName.get("byox_search")?.title).toContain("Build Your Own X");
    expect(byName.get("collab_patch")?.description).toContain("collab:write");
    expect(byName.get("collab_collaborators")?.description).toContain("limitations");
  });
});

describe("BYOX tools", () => {
  it("reports an honest capability gap instead of inventing an index", async () => {
    const call = await callTool("byox_search", { query: "renderer" }, {});
    expect(call.isError).toBe(true);
    expect(String(call.parsed?.error ?? call.text)).toMatch(/not been indexed|no R2|capability/i);
  });

  it("searches a stored catalog and exposes categories and a reading plan", async () => {
    const bucket = new FakeBucket();
    const env = { SCREENSHOTS: bucket, BYOX_REFRESH_MIN_INTERVAL_SECONDS: "60", SSRF_DNS_CHECK: "false" };
    await refreshByoxIndex(env as never, { force: true, fetchImpl: (async () => new Response(readme(), { headers: { "content-type": "text/plain" } })) as never, guard: async (url: string) => url });
    clearByoxCacheForTests();

    const search = await callTool("byox_search", { query: "write your own", limit: 3 }, env);
    expect(search.isError).toBe(false);
    const hits = search.parsed?.hits ?? search.parsed?.results ?? [];
    expect(hits.length).toBe(3);
    expect(JSON.stringify(hits)).toContain("https://example.org/");

    const categories = await callTool("byox_categories", {}, env);
    expect(categories.isError).toBe(false);
    expect(JSON.stringify(categories.parsed)).toContain("Thing 0");

    const plan = await callTool("byox_learning_plan", { goal: "write my own database", language: "Python" }, env);
    expect(plan.isError).toBe(false);
    expect(JSON.stringify(plan.parsed)).toContain("Python");
  });

  it("refuses byox_refresh_index without the administrator credential and never asks for it in an argument", async () => {
    const call = await callTool("byox_refresh_index", {}, {});
    expect(call.isError).toBe(true);
    const text = String(call.parsed?.error ?? call.text);
    expect(text).toMatch(/administrat|DEMO_API_KEY/);
    // The tool schema must not accept a key argument at all.
    const listed = await rpc("tools/list", {}, {});
    const tool = (listed.result?.tools ?? []).find((entry: { name: string }) => entry.name === "byox_refresh_index") as { inputSchema?: { properties?: Record<string, unknown> } };
    expect(Object.keys(tool?.inputSchema?.properties ?? {})).not.toContain("admin_key");
    expect(Object.keys(tool?.inputSchema?.properties ?? {})).not.toContain("key");
  });
});

describe("collaboration tools", () => {
  it("publishes the capability matrix publicly and keeps workspace reads behind a grant", async () => {
    const publicCall = await callTool("collab_collaborators", {}, {});
    expect(publicCall.isError).toBe(false);
    expect(publicCall.parsed?.collaborators ?? publicCall.parsed?.matrix ?? []).toBeTruthy();
    expect(JSON.stringify(publicCall.parsed)).toContain("executes no code");

    const protectedCall = await callTool("collab_workspace", { action: "list" }, {});
    expect(protectedCall.isError).toBe(true);
    expect(String(protectedCall.meta?.["mcp/www_authenticate"] ?? protectedCall.text)).toMatch(/oauth|collab:write|authoriz/i);
  });

  it("states the missing-storage case honestly when DEMO_ACCOUNTS is unbound", async () => {
    const call = await callTool("collab_collaborators", {}, {});
    expect(call.isError).toBe(false);
    expect(JSON.stringify(call.parsed)).toContain("unavailable");
  });
});

describe("public HTTP surface", () => {
  it("serves the collaboration summary and the catalog routes through the platform dispatcher", async () => {
    const collab = await platform.fetch(new Request("https://demo.test/collab"), {} as never, CTX);
    expect(collab.status).toBe(200);
    const collabBody = (await collab.json()) as { ok: boolean; collaborators: unknown[] };
    expect(collabBody.ok).toBe(true);
    expect(collabBody.collaborators).toHaveLength(3);

    const noIndex = await platform.fetch(new Request("https://demo.test/byox/search?q=x"), {} as never, CTX);
    expect([200, 503]).toContain(noIndex.status);
    const body = (await noIndex.json()) as { ok: boolean; error?: { code: string } };
    if (noIndex.status === 503) expect(body.error?.code).toBe("capability_unavailable");

    const refused = await platform.fetch(new Request("https://demo.test/byox/refresh", { method: "POST" }), {} as never, CTX);
    expect(refused.status).toBe(403);

    const unknown = await platform.fetch(new Request("https://demo.test/byox/nope"), {} as never, CTX);
    expect(unknown.status).toBe(404);
  });

  it("advertises the new capability reports and resources", async () => {
    const stats = await platform.fetch(new Request("https://demo.test/platform/stats"), {} as never, CTX);
    const body = (await stats.json()) as {
      endpoints: Record<string, string>;
      capabilities: { byox: { available: boolean; refreshRequiresAdmin: boolean }; collaboration: { workspaceStorage: boolean; scopes: string[] } };
    };
    expect(body.endpoints.byoxCapabilities).toBe("/capabilities/byox");
    expect(body.endpoints.collabCapabilities).toBe("/capabilities/collab");
    expect(body.capabilities.collaboration.workspaceStorage).toBe(false);
    expect(body.capabilities.collaboration.scopes).toContain("collab:write");
    expect(body.capabilities.byox.available).toBe(true);
    expect(body.capabilities.byox.refreshRequiresAdmin).toBe(true);

    const tools = await platform.fetch(new Request("https://demo.test/tools"), {} as never, CTX);
    const inventory = (await tools.json()) as { count: number; tools: string[]; resources: string[] };
    expect(inventory.count).toBe(TOOL_COUNT);
    expect(inventory.tools).toContain("byox_search");
    expect(inventory.tools).toContain("collab_patch");
    expect(inventory.resources).toContain("demo://capabilities/byox");
    expect(inventory.resources).toContain("demo://capabilities/collab");
  });
});
