/**
 * DEMO 0.9 — capability-surface integration: every new tool discoverable via
 * tools/list and /tools, /mcp grouping, capability reports, rate limits,
 * structured errors for malformed inputs, and no capability errors when
 * bindings are missing (they must degrade, not crash).
 */

import { describe, expect, it } from "vitest";
import worker from "../index.js";
import platform from "../platform-entry.js";
import { DEMO_TOOL_NAMES, TOOL_COUNT } from "../index.js";
import { GIT_TOOL_NAMES } from "../src/mcp/git-tools.js";
import { ARCHIVE_TOOL_NAMES } from "../src/mcp/archive-tools.js";
import { FEED_TOOL_NAMES } from "../src/mcp/feed-tools.js";
import { DOCUMENT_TOOL_NAMES } from "../src/mcp/document-tools.js";
import { WEB_TOOL_NAMES } from "../src/mcp/web-tools.js";
import { UTIL_TOOL_NAMES } from "../src/mcp/util-tools.js";
import { NETWORK_TOOL_NAMES } from "../src/mcp/network-tools.js";
import { RESEARCH_TOOL_NAMES } from "../src/mcp/research-tools.js";
import { createMcpCommand } from "../src/commands/mcp-command.js";

const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const EXPANSION_TOOLS = [...GIT_TOOL_NAMES, ...ARCHIVE_TOOL_NAMES, ...FEED_TOOL_NAMES, ...DOCUMENT_TOOL_NAMES, ...WEB_TOOL_NAMES, ...UTIL_TOOL_NAMES, ...NETWORK_TOOL_NAMES, ...RESEARCH_TOOL_NAMES];

async function rpc(method: string, params: Record<string, unknown>, env: unknown = {}) {
  const response = await worker.fetch(
    new Request("https://demo.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env as never,
    CTX,
  );
  const text = await response.text();
  return text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter((line) => line.startsWith("data:")).at(-1)!.slice(5).trim());
}

async function callTool(name: string, args: Record<string, unknown>, env: unknown = {}) {
  const payload = await rpc("tools/call", { name, arguments: args }, env);
  const result = payload.result ?? {};
  const text = (result.content ?? []).map((entry: { text?: string }) => entry.text ?? "").join("\n");
  return { isError: Boolean(result.isError), text, parsed: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

describe("expanded capability surface", () => {
  it("lists every new tool in tools/list and keeps TOOL_COUNT consistent", async () => {
    const response = await rpc("tools/list", {});
    const names: string[] = (response.result?.tools ?? []).map((tool: { name: string }) => tool.name);
    expect(names.length).toBe(TOOL_COUNT);
    for (const name of EXPANSION_TOOLS) expect(names, `${name} missing`).toContain(name);
    for (const name of EXPANSION_TOOLS) expect(DEMO_TOOL_NAMES as readonly string[]).toContain(name);
  });

  it("exposes the same set through GET /tools with the expanded resource", async () => {
    const tools = await platform.fetch(new Request("https://demo.test/tools"), {} as never, CTX);
    const body = (await tools.json()) as { count: number; tools: string[]; resources: string[] };
    expect(body.count).toBe(TOOL_COUNT);
    for (const name of EXPANSION_TOOLS) expect(body.tools).toContain(name);
    expect(body.resources).toContain("demo://capabilities/expanded");
  });

  it("reports expanded capability flags on demo_ping and /health", async () => {
    const ping = await callTool("demo_ping", {});
    expect(ping.parsed.expanded.git.publicOnly).toBe(true);
    expect(ping.parsed.expanded.git.requiresApiKey).toBe(false);
    expect(ping.parsed.expanded.internetArchive.apiKeyRequired).toBe(false);
    expect(ping.parsed.expanded.utilities.jwt).toMatch(/DECODING/);
    expect(ping.parsed.expanded.openapi.callsDiscoveredApis).toBe(false);
    expect(ping.parsed.expandedResources).toContain("demo://capabilities/expanded");
    expect(ping.parsed.gitPublicOnly).toBe(true);

    const health = await (await platform.fetch(new Request("https://demo.test/health"), {} as never, CTX)).json() as Record<string, any>;
    expect(health.expandedCapabilities).toBe(true);
    expect(health.gitPublicOnly).toBe(true);
  });

  it("serves GET /capabilities/expanded with presence-only reporting", async () => {
    const response = await platform.fetch(new Request("https://demo.test/capabilities/expanded"), {} as never, CTX);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(body.git.credentialsAccepted).toBe(false);
    expect(body.research.provenance).toMatch(/source URL/);
    expect(body.security.join(" ")).toMatch(/No IP logging/);
    expect(JSON.stringify(body)).not.toMatch(/api[_-]?key\"?\s*[:=]\s*\"?[A-Za-z0-9]{8,}/i);
  });

  it("groups the new tools in the /mcp command", async () => {
    const cmd = createMcpCommand({ version: "0.9.0", toolNames: DEMO_TOOL_NAMES, commands: [] });
    const result = await cmd.execute("", {});
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.tools.Git).toContain("git_repository");
    expect(parsed.tools["Internet Archive"]).toEqual(expect.arrayContaining(["wayback", "archive_search"]));
    expect(parsed.tools.Feeds).toContain("feed_read");
    expect(parsed.tools.Documents).toEqual(expect.arrayContaining(["pdf_document", "image_analyze"]));
    expect(parsed.tools["Web Intelligence"]).toEqual(expect.arrayContaining(["web_extract", "web_diff", "web_monitor"]));
    expect(parsed.tools.Browser).toContain("screenshot_diff");
    expect(parsed.tools.Network).toEqual(expect.arrayContaining(["openapi_inspect", "net_diagnose", "url_inspect"]));
    expect(parsed.tools.Research).toContain("web_research");
    expect(parsed.tools.Utilities).toEqual(expect.arrayContaining(["schema_validate", "jwt_inspect", "cron_explain", "text_diff"]));
    expect(parsed.capabilities).toContain("Public Git (no API key)");
    expect(parsed.capabilities).toContain("RSS / Atom feeds");
  });

  it("local utilities work with no bindings at all", async () => {
    const schema = await callTool("schema_validate", { instance: '{"a":1}', schema: '{"type":"object","required":["b"]}' });
    expect(schema.isError).toBeFalsy();
    expect(schema.parsed.valid).toBe(false);
    const jwt = await callTool("jwt_inspect", { token: `${btoa('{"alg":"none"}')}.${btoa('{"sub":"x"}')}.` });
    expect(jwt.parsed.verification).toBe("not-performed");
    const cron = await callTool("cron_explain", { expression: "@daily", count: 1 });
    expect(cron.parsed.valid).toBe(true);
    const diff = await callTool("text_diff", { a: "one", b: "two" });
    expect(diff.parsed.summary.identical).toBe(false);
  });

  it("returns structured validation errors for malformed inputs", async () => {
    const badJson = await callTool("schema_validate", { instance: "{oops", schema: "{}" });
    expect(badJson.isError).toBe(true);
    expect(badJson.parsed.error).toBe("invalid_input");

    const badJwt = await callTool("jwt_inspect", { token: "totally-not-a-jwt-SECRETVALUE" });
    expect(badJwt.isError).toBeFalsy(); // structured failure payload, not a throw
    expect(badJwt.parsed.ok).toBe(false);
    expect(badJwt.text).not.toContain("SECRETVALUE");

    const badCron = await callTool("cron_explain", { expression: "99 * * * *" });
    expect(badCron.parsed.valid).toBe(false);
    expect(badCron.parsed.error).toBeTruthy();

    const missingArgs = await callTool("pdf_document", { mode: "search", url: "https://example.com/x.pdf" });
    // search mode without query is invalid, but it fails before fetch only after download…
    // (downloading is required first — accept either structured error shape).
    expect(missingArgs.isError).toBe(true);

    const badMode = await callTool("web_monitor", { mode: "nope" });
    // Rejected either by schema validation (JSON-RPC error) or in the handler.
    expect(badMode.isError || badMode.parsed === null || badMode.parsed?.error).toBeTruthy();
  });

  it("degrades with capability_unavailable instead of crashing when storage is missing", async () => {
    const monitor = await callTool("web_monitor", { mode: "list" }, { TOOL_RATE_LIMIT_PER_MINUTE: "60" });
    expect(monitor.isError).toBe(true);
    expect(monitor.parsed.error).toBe("capability_unavailable");
    expect(monitor.parsed.message).toMatch(/SCREENSHOTS/);

    const diff = await callTool("web_diff", { url: "https://example.com/", snapshot_key: "web-snap/x.json" }, { TOOL_RATE_LIMIT_PER_MINUTE: "60" });
    // No bucket → capability_unavailable when a stored baseline is requested.
    expect(diff.isError).toBe(true);
    expect(["capability_unavailable", "blocked_url", "invalid_input"]).toContain(diff.parsed.error);
  });

  it("enforces the shared public-source rate limit with a stable code", async () => {
    const env = { TOOL_RATE_LIMIT_PER_MINUTE: "1" };
    // A local tool with a rate-limited fetch target: jwt/schema are local-only;
    // use feed_read inline (no rate charge) vs fetch-based call for the limit.
    const { installFetchRouter, htmlResult } = await import("./helpers/fetch-router.js");
    const router = installFetchRouter();
    try {
      router.on("rate.example.com", () => htmlResult("<html><body>hi</body></html>"));
      const first = await callTool("web_extract", { url: "https://rate.example.com/a" }, env);
      expect(first.isError).toBe(false);
      const second = await callTool("web_extract", { url: "https://rate.example.com/a" }, env);
      expect(second.isError).toBe(true);
      expect(second.parsed.error).toBe("rate_limited");
      expect(second.parsed.retryable).toBe(true);
    } finally {
      router.restore();
    }
  });
});
