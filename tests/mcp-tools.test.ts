import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import worker, { DEMO_TOOL_NAMES, TOOL_COUNT } from "../index.js";
import platform from "../platform-entry.js";
import { BROWSER_TOOL_NAMES } from "../src/mcp/browser-tools.js";

const ENV = {} as never;
const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

interface RpcResponse {
  jsonrpc: string;
  id?: number | string;
  result?: any;
  error?: { code: number; message: string };
}

async function rpc(method: string, params: Record<string, unknown>, env: unknown = ENV, headers: Record<string, string> = {}): Promise<RpcResponse> {
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
  if (text.trim().startsWith("{")) return JSON.parse(text) as RpcResponse;
  const dataLines = text.split("\n").filter((line) => line.startsWith("data:"));
  return JSON.parse(dataLines[dataLines.length - 1].slice(5).trim()) as RpcResponse;
}

async function callTool(name: string, args: Record<string, unknown>, env: unknown = ENV) {
  const response = await rpc("tools/call", { name, arguments: args }, env);
  expect(response.error).toBeUndefined();
  const result = response.result ?? {};
  const text = (result.content ?? []).map((entry: { text?: string }) => entry.text ?? "").join("\n");
  return { isError: Boolean(result.isError), text, parsed: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

describe("MCP surface", () => {
  it("exposes every documented tool, including the original DEMO tools", async () => {
    const response = await rpc("tools/list", {});
    const names: string[] = (response.result?.tools ?? []).map((tool: { name: string }) => tool.name).sort();
    expect(names.length).toBe(TOOL_COUNT);
    for (const name of DEMO_TOOL_NAMES) expect(names, `${name} missing`).toContain(name);
    for (const name of BROWSER_TOOL_NAMES) expect(names, `${name} missing`).toContain(name);
    // Original DEMO utilities and legacy browser tools must survive the overhaul.
    for (const legacy of ["demo_ping", "json_format", "hash_text", "generate_uuid", "http_fetch", "roblox_user", "roblox_game"]) {
      expect(names).toContain(legacy);
    }
    for (const legacy of ["browser_inspect", "browser_fill", "browser_press", "browser_evaluate", "browser_console", "browser_run", "browser_watch", "browser_task"]) {
      expect(names).toContain(legacy);
    }
    for (const video of ["video_inspect_url", "video_download_public", "video_extract_frames", "video_extract_audio", "video_transcribe", "video_analyze", "video_get_frame"]) {
      expect(names).toContain(video);
    }
    for (const skill of ["skills_search", "skills_browse", "skills_get", "skills_use", "skills_audit", "skills_curated", "skill_install_info", "skill_builtin_caveman"]) {
      expect(names).toContain(skill);
    }
  });

  it("answers demo_ping with version and capability flags", async () => {
    const { parsed, isError } = await callTool("demo_ping", {});
    expect(isError).toBeFalsy();
    expect(parsed?.name).toBe("DEMO");
    expect(parsed?.version).toMatch(/^\d+\.\d+\.\d+(\s+\w+)?$/);
    expect(parsed?.toolCount).toBe(TOOL_COUNT);
    expect(parsed).toHaveProperty("browser");
    expect(parsed).toHaveProperty("browserSessions");
    expect(parsed).toHaveProperty("liveView");
    expect(parsed).toHaveProperty("videoFrames");
    expect(parsed.publicVideo).toBe(true);
  });

  it("keeps the original utility tools working", async () => {
    const uuid = await callTool("generate_uuid", {});
    expect(uuid.text).toMatch(/^[0-9a-f-]{36}$/);
    const hash = await callTool("hash_text", { text: "abc" });
    expect(hash.text).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const formatted = await callTool("json_format", { json: '{"a":1}' });
    expect(formatted.parsed).toEqual({ a: 1 });
    const invalid = await callTool("json_format", { json: "{oops" });
    expect(invalid.isError).toBe(true);
  });

  it("reports browser capabilities instead of crashing when bindings are missing", async () => {
    const { parsed, isError } = await callTool("browser_capabilities", {});
    expect(isError).toBeFalsy();
    expect(parsed.browserAvailable).toBe(false);
    expect(String(parsed.reason)).toMatch(/Browser Run/);
    expect(parsed.screenshots).toBe(false);
    expect(String(parsed.screenshotReason)).toMatch(/R2/);
    expect(parsed.sessionStorage).toBe("memory");
  });

  it("returns a structured capability error for browser tools without a binding", async () => {
    const result = await callTool("browser_open", { url: "https://example.com/" });
    expect(result.isError).toBe(true);
    expect(result.parsed?.error).toBe("capability_unavailable");
    expect(String(result.parsed?.hint ?? result.parsed?.message)).toMatch(/Browser Run|binding/i);
  });

  it("validates URLs before any navigation happens", async () => {
    for (const url of ["http://localhost:8080/admin", "file:///etc/passwd", "https://169.254.169.254/latest/meta-data/", "not a url"]) {
      const result = await callTool("browser_open", { url });
      expect(result.isError, url).toBe(true);
      expect(["blocked_url", "invalid_input", "capability_unavailable"]).toContain(result.parsed?.error);
    }
  });

  it("validates session and page identifiers", async () => {
    const badSession = await callTool("browser_tabs", { session_id: "bad id with spaces", action: "list" });
    expect(badSession.isError).toBe(true);
    expect(badSession.parsed?.error).toBe("invalid_input");
    const badPage = await callTool("browser_read", { session_id: "s1", page_id: "nope" });
    expect(badPage.isError).toBe(true);
    expect(badPage.parsed?.error).toBe("invalid_input");
  });

  it("never echoes typed secrets back", async () => {
    const result = await callTool("browser_type", { session_id: "s1", target: "#password", text: "hunter2-supersecret", secret: true });
    expect(result.text).not.toContain("hunter2-supersecret");
  });
});

describe("worker routes", () => {
  it("serves health, root and tool listings", async () => {
    const health = await platform.fetch(new Request("https://demo.test/health"), ENV as never, CTX);
    expect(health.status).toBe(200);
    const body = (await health.json()) as Record<string, unknown>;
    expect(body.name).toBe("DEMO");
    expect(body.toolCount).toBe(TOOL_COUNT);

    const root = await platform.fetch(new Request("https://demo.test/"), ENV as never, CTX);
    expect(root.status).toBe(200);

    const tools = await platform.fetch(new Request("https://demo.test/tools"), ENV as never, CTX);
    const listing = (await tools.json()) as { count: number; tools: string[] };
    expect(listing.count).toBe(TOOL_COUNT);
    expect(listing.tools).toContain("browser_pause_for_human");
  });

  it("reports one version everywhere, matching package.json", async () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "../package.json"), "utf8")) as { version: string };
    const health = (await (await platform.fetch(new Request("https://demo.test/health"), ENV as never, CTX)).json()) as Record<string, any>;
    const stats = (await (await platform.fetch(new Request("https://demo.test/platform/stats"), ENV as never, CTX)).json()) as Record<string, any>;
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "1" } });
    const ping = await callTool("demo_ping", {});
    expect(health.version, "GET /health (index.ts)").toBe(pkg.version);
    expect(stats.version, "GET /platform/stats (platform-entry.ts)").toBe(pkg.version);
    expect(init.result?.serverInfo?.version, "MCP initialize").toBe(pkg.version);
    expect(ping.parsed?.version, "demo_ping").toBe(pkg.version);
    // The two Workers each keep their own constant; pin both to the package so a release
    // cannot ship one surface on a stale version.
    for (const file of ["index.ts", "platform-entry.ts"]) {
      const source = readFileSync(path.resolve(__dirname, "..", file), "utf8");
      const declared = [...source.matchAll(/const VERSION = "([^"]+)"/g)].map((match) => match[1]);
      expect(declared, `${file} declares exactly one version`).toEqual([pkg.version]);
    }
    // The outbound User-Agent is a version string too; a stale one is a silent lie to
    // whoever is being called. The User-Agent uses a URL-safe form (hyphen instead of space).
    const oauth = readFileSync(path.resolve(__dirname, "../src/roblox/oauth.ts"), "utf8");
    const agents = [...oauth.matchAll(/DEMO-MCP\/([^\s(]+)/g)].map((match) => match[1]);
    expect(agents.length, "the User-Agent must carry a version").toBeGreaterThan(0);
    // Normalize: "0.8.4-beta" in User-Agent matches "0.8.4 beta" in package.json
    for (const declared of agents) expect(declared.replace(/-/g, " ")).toBe(pkg.version);
  });

  it("serves telemetry without secrets", async () => {
    const sentinels = ["typesafe-secret-sentinel", "laya-secret-sentinel", "roblox-secret-sentinel"];
    const telemetryEnv = {
      TYPESAFE_API_KEY: sentinels[0],
      LAYA_API_KEY: sentinels[1],
      ROBLOX_CLIENT_SECRET: sentinels[2],
    };
    const response = await platform.fetch(new Request("https://demo.test/platform/stats"), telemetryEnv as never, CTX);
    const body = (await response.json()) as Record<string, any>;
    const serialized = JSON.stringify(body);
    expect(body.telemetry.containsSecrets).toBe(false);
    expect(body.capabilities).toHaveProperty("browserSessions");
    expect(body.endpoints.mcp).toBe("/mcp");
    for (const sentinel of sentinels) expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toMatch(/\"(?:authorization|access_token|refresh_token|client_secret|api_key)\"\s*:/i);
  });

  it("offers an obvious Connect Roblox entry point in the UI and the server instructions", async () => {
    const root = await platform.fetch(new Request("https://demo.test/"), ENV as never, CTX);
    expect(root.status).toBe(200);
    const html = await root.text();
    // The affordance a human looks for, wired to the real route.
    expect(html).toContain("Connect Roblox account");
    expect(html).toContain("/oauth/roblox/link");
    expect(html).toContain("/oauth/roblox/status");
    expect(html).toContain("/oauth/roblox/logout"); // disconnect/revoke is reachable too
    expect(html).toContain("Disconnect");
    // The dashboard only carries credentials in the dedicated DEMO-account
    // forms (all server-side /account/*); password autofill is hardened and no
    // OAuth token material is ever rendered.
    expect(html).not.toMatch(/autocomplete=["']?password/i);
    expect(html).not.toMatch(/(access|refresh)[_-]?token\s*[:=]/i);

    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "1" } });
    const instructions = String(init.result?.instructions ?? "");
    expect(instructions).toMatch(/ROBLOX ACCOUNT/i);
    expect(instructions).toMatch(/roblox_account_link_start/);
    expect(instructions).toMatch(/linkCode/);
    expect(instructions).toMatch(/same Cloudflare Access identity/i);
    expect(instructions).toMatch(/official consent page/i);
    expect(instructions).toMatch(/never build or link a Roblox login form/i);
    expect(instructions).toMatch(/not_supported/i);
  });

  it("returns 404 for unknown routes", async () => {
    const response = await platform.fetch(new Request("https://demo.test/nope"), ENV as never, CTX);
    expect(response.status).toBe(404);
  });

  it("keeps screenshot ids unguessable", async () => {
    const short = await platform.fetch(new Request("https://demo.test/screenshots/abc"), { SCREENSHOTS: {} } as never, CTX);
    expect(short.status).toBe(400);
  });
});
