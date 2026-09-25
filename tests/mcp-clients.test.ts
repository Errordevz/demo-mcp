/**
 * Locks DEMO's client handoff to formats copied from official docs.
 * A new query parameter or scheme should fail here until the citation is updated.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MCP_ENDPOINT } from "../src/ui/content.js";
import { demoUiHtml } from "../ui.js";
import {
  CONNECT_PICKER,
  CONNECT_RESEARCHED_ON,
  MCP_CLIENTS,
  MCP_SERVER_NAME,
  MCP_SERVER_URL,
  claudeCodeAddCommand,
  claudeConnectorInstallUrl,
  connectClientPayload,
  cursorInstallUrl,
  mcpClientById,
  vscodeInstallUrl,
} from "../src/ui/mcp-clients.js";

const CHATGPT_PLUGINS = "https://chatgpt.com/plugins";
const CLAUDE_PERSONAL = "https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=DEMO&connectorUrl=https%3A%2F%2Fdemo-mcp.amidevz.workers.dev%2Fmcp";
const CLAUDE_ADMIN = "https://claude.ai/admin-settings/connectors?modal=add-custom-connector&connectorName=DEMO&connectorUrl=https%3A%2F%2Fdemo-mcp.amidevz.workers.dev%2Fmcp";

function bootFromHtml(html: string): { serverUrl: string; connect: { title: string; subtitle: string }; clients: Array<Record<string, unknown>> } {
  const marker = "window.__DEMO_BOOT__=";
  const start = html.indexOf(marker);
  const end = html.indexOf(";</script>", start);
  return JSON.parse(html.slice(start + marker.length, end));
}

describe("official MCP client integrations", () => {
  it("uses the public no-login endpoint and nothing else", () => {
    expect(MCP_ENDPOINT).toBe("demo-mcp.amidevz.workers.dev/mcp");
    expect(MCP_SERVER_URL).toBe("https://demo-mcp.amidevz.workers.dev/mcp");
    expect(MCP_SERVER_NAME).toBe("demo");
    expect(CONNECT_RESEARCHED_ON).toBe("2026-09-25");
    expect(CONNECT_PICKER).toEqual({
      title: "Connect DEMO",
      subtitle: "Choose where you want to connect DEMO.",
    });
    for (const client of MCP_CLIENTS) {
      expect(client.transport).toBe("streamable-http");
      expect(client.authentication).toBe("none");
      expect(client.documentationUrl.startsWith("https://")).toBe(true);
      expect(client.sources.length).toBeGreaterThan(0);
      expect(client.sources.every((source) => source.startsWith("https://"))).toBe(true);
    }
  });

  it("builds the documented Claude install link and does not grant permission", () => {
    expect(claudeConnectorInstallUrl("personal")).toBe(CLAUDE_PERSONAL);
    expect(claudeConnectorInstallUrl("organization")).toBe(CLAUDE_ADMIN);
    const claude = mcpClientById("claude");
    expect(claude?.connectionUrl).toBe(CLAUDE_PERSONAL);
    expect(claude?.method).toBe("direct-prefill");
    expect(claude?.prefillsEndpoint).toBe(true);
    expect(claude?.destinationPromptsUser).toBe(true);
    expect(claude?.verification).toBe("verified");
    expect(claude?.alternates[0]?.url).toBe(CLAUDE_ADMIN);
    expect(claude?.confirmTitle).toBe("Connect DEMO to Claude?");
    expect(claude?.confirmBody).toBe("You're about to connect DEMO as a remote MCP server in Claude.");
  });

  it("builds the documented Cursor deeplink from the remote mcp.json shape", () => {
    const link = cursorInstallUrl();
    expect(link.startsWith("cursor://anysphere.cursor-deeplink/mcp/install?name=demo&config=")).toBe(true);
    expect(link).not.toContain("cursor.com/link");
    const config = JSON.parse(Buffer.from(decodeURIComponent(link.split("config=")[1] ?? ""), "base64").toString("utf8"));
    expect(config).toEqual({ url: MCP_SERVER_URL });
    expect(config).not.toHaveProperty("command");
    const cursor = mcpClientById("cursor");
    expect(cursor?.connectionUrl).toBe(link);
    expect(cursor?.method).toBe("direct-install");
    expect(cursor?.prefillsEndpoint).toBe(true);
    expect(cursor?.destinationPromptsUser).toBe(true);
    expect(cursor?.manualConfig).toContain(MCP_SERVER_URL);
    expect(cursor?.manualConfig).not.toContain("\"command\"");
  });

  it("builds the documented VS Code install URL, not the unofficial name/config form", () => {
    const link = vscodeInstallUrl(false);
    expect(link.startsWith("vscode:mcp/install?")).toBe(true);
    expect(link.startsWith("vscode://")).toBe(false);
    expect(link).not.toContain("name=");
    expect(link).not.toContain("config=");
    expect(link).not.toContain("vscode.dev/redirect");
    expect(JSON.parse(decodeURIComponent(link.slice("vscode:mcp/install?".length)))).toEqual({
      name: "demo",
      type: "http",
      url: MCP_SERVER_URL,
    });
    const insiders = vscodeInstallUrl(true);
    expect(insiders.startsWith("vscode-insiders:mcp/install?")).toBe(true);
    const vscode = mcpClientById("vscode");
    expect(vscode?.connectionUrl).toBe(link);
    expect(vscode?.alternates[0]?.url).toBe(insiders);
    expect(vscode?.alternates[0]?.kind).toBe("app");
    expect(vscode?.manualConfig).toContain("\"type\": \"http\"");
    expect(vscode?.destinationPromptsUser).toBe(true);
  });

  it("keeps ChatGPT on the documented Plugins page with no invented prefill", () => {
    const chatgpt = mcpClientById("chatgpt");
    expect(chatgpt?.connectionUrl).toBe(CHATGPT_PLUGINS);
    expect(new URL(chatgpt?.connectionUrl ?? "").search).toBe("");
    expect(chatgpt?.method).toBe("official-screen");
    expect(chatgpt?.prefillsEndpoint).toBe(false);
    expect(chatgpt?.destinationPromptsUser).toBe(false);
    expect(chatgpt?.verification).toBe("verified");
    expect(chatgpt?.confirmTitle).toBe("Connect DEMO to ChatGPT?");
    expect(chatgpt?.confirmBody).toBe("You're about to connect DEMO as a remote MCP server in ChatGPT.");
    expect(chatgpt?.steps.join(" ")).toMatch(/does not document a link/i);
  });

  it("gives Claude Code the documented command and no install deeplink", () => {
    expect(claudeCodeAddCommand("user")).toBe(
      "claude mcp add --transport http demo --scope user https://demo-mcp.amidevz.workers.dev/mcp",
    );
    expect(claudeCodeAddCommand("local")).toBe(
      "claude mcp add --transport http demo https://demo-mcp.amidevz.workers.dev/mcp",
    );
    const code = mcpClientById("claude-code");
    expect(code?.connectionUrl).toBeNull();
    expect(code?.method).toBe("manual");
    expect(code?.verification).toBe("manual");
    expect(code?.destinationPromptsUser).toBe(false);
    expect(code?.manualCommand).toBe(claudeCodeAddCommand("user"));
    expect(code?.manualConfig).toContain("\"type\": \"http\"");
    expect(code?.limitations.join(" ")).toMatch(/claude-cli:\/\//);
    expect(JSON.stringify(code)).not.toContain("claude-cli://open");
  });

  it("keeps generic clients on a copyable endpoint", () => {
    const other = mcpClientById("other");
    expect(other?.confirmTitle).toBe("Connect DEMO to your MCP-compatible client.");
    expect(other?.connectionUrl).toBeNull();
    expect(other?.actionLabel).toBe("Copy endpoint");
    expect(other?.method).toBe("manual");
    expect(other?.destinationPromptsUser).toBe(false);
  });

  it("does not mark a direct handoff as prompting the user unless the docs say so", () => {
    expect(mcpClientById("chatgpt")?.destinationPromptsUser).toBe(false);
    expect(mcpClientById("claude")?.destinationPromptsUser).toBe(true);
    expect(mcpClientById("cursor")?.destinationPromptsUser).toBe(true);
    expect(mcpClientById("vscode")?.destinationPromptsUser).toBe(true);
    expect(mcpClientById("claude-code")?.destinationPromptsUser).toBe(false);
    expect(mcpClientById("other")?.destinationPromptsUser).toBe(false);
  });

  it("ships the same registry in the inspector, with no secrets and no invented schemes", () => {
    const html = demoUiHtml();
    const boot = bootFromHtml(html);
    expect(boot.serverUrl).toBe(MCP_SERVER_URL);
    expect(boot.connect).toEqual(CONNECT_PICKER);
    expect(boot.clients).toEqual(connectClientPayload());
    expect(html).not.toMatch(/(ROBLOX_CLIENT_SECRET|DEMO_API_KEY|LAYA_API_KEY)\s*[:=]\s*["'][^"']{8,}/);
    expect(html).not.toContain('href="chatgpt://');
    expect(html).not.toContain('href="claude://');
    expect(html).not.toContain('href="claude-cli://');
    expect(html).not.toContain("vscode.dev/redirect/mcp");
    const source = readFileSync(new URL("../src/ui/mcp-clients.ts", import.meta.url), "utf8");
    expect(source).not.toContain("chatgpt://");
    expect(source).not.toContain("vscode.dev/redirect");
    expect(source).not.toContain("cursor.com/link");
  });
});
