/**
 * Tests for the command system: router, /mcp command, /jev command.
 */

import { describe, expect, it } from "vitest";
import { registerCommand, routeCommand, listCommands, getCommand } from "../src/commands/router.js";
import { createMcpCommand } from "../src/commands/mcp-command.js";
import { createJevCommand } from "../src/commands/jev-command.js";

describe("command router", () => {
  it("registers and retrieves commands", () => {
    registerCommand({
      name: "test_cmd",
      description: "Test command",
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
    const cmd = getCommand("test_cmd");
    expect(cmd).toBeDefined();
    expect(cmd?.name).toBe("test_cmd");
    expect(cmd?.description).toBe("Test command");
  });

  it("lists all registered commands", () => {
    const commands = listCommands();
    expect(commands.length).toBeGreaterThan(0);
  });

  it("returns null for non-command input", () => {
    expect(routeCommand("hello", {})).toBeNull();
    expect(routeCommand("", {})).toBeNull();
  });

  it("returns error for unknown commands", async () => {
    const result = await routeCommand("/unknown_command", {});
    expect(result).not.toBeNull();
    expect(result?.isError).toBe(true);
    const text = (result?.content[0] as { text: string }).text;
    expect(text).toContain("unknown_command");
  });

  it("routes /mcp to the mcp command", async () => {
    // Register the real mcp command
    registerCommand(createMcpCommand({
      version: "0.8.4 beta",
      toolNames: ["demo_ping", "browser_open", "inspect_video", "youtube_search"],
      commands: [],
    }));
    const result = await routeCommand("/mcp", { BROWSER: true, SCREENSHOTS: {} });
    expect(result).not.toBeNull();
    const text = (result?.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.version).toBe("0.8.4 beta");
    expect(parsed.name).toBe("DEMO MCP");
    expect(parsed.status).toContain("Online");
    expect(parsed.tool_count).toBe(4);
  });
});

describe("/mcp command", () => {
  it("reports version from deps", async () => {
    const cmd = createMcpCommand({
      version: "0.8.4 beta",
      toolNames: ["demo_ping", "json_format", "hash_text"],
      commands: [],
    });
    const result = await cmd.execute("", {});
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.version).toBe("0.8.4 beta");
  });

  it("groups tools logically", async () => {
    const cmd = createMcpCommand({
      version: "0.8.4 beta",
      toolNames: [
        "demo_ping", "json_format", "hash_text", "generate_uuid", "http_fetch",
        "browser_open", "browser_screenshot",
        "inspect_video", "video_resolve",
        "youtube_search", "youtube_video",
        "roblox_account_status",
        "jev_decide", "jev_capabilities",
        "skills_search", "skill_builtin_typesafe",
      ],
      commands: [],
    });
    const result = await cmd.execute("", {});
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.tools).toHaveProperty("Core");
    expect(parsed.tools).toHaveProperty("Browser");
    expect(parsed.tools).toHaveProperty("Video");
    expect(parsed.tools).toHaveProperty("YouTube");
    expect(parsed.tools).toHaveProperty("Roblox");
    expect(parsed.tools).toHaveProperty("JEV");
    expect(parsed.tools).toHaveProperty("Skills");
    expect(parsed.tools.Core).toContain("demo_ping");
    expect(parsed.tools.Browser).toContain("browser_open");
    expect(parsed.tools.Video).toContain("inspect_video");
    expect(parsed.tools.YouTube).toContain("youtube_search");
  });

  it("shows capabilities only for configured subsystems", async () => {
    const cmd = createMcpCommand({
      version: "0.8.4 beta",
      toolNames: [],
      commands: [],
    });
    // Without any bindings
    const result = await cmd.execute("", {});
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    // Should include always-present capabilities
    expect(parsed.capabilities).toContain("HTTP fetching");
    expect(parsed.capabilities).toContain("JSON utilities");
    expect(parsed.capabilities).toContain("Hashing");
    expect(parsed.capabilities).toContain("UUID generation");
    // Should NOT include YouTube since no key
    expect(parsed.capabilities).not.toContain("YouTube");
  });

  it("shows YouTube capability when key is configured", async () => {
    const cmd = createMcpCommand({
      version: "0.8.4 beta",
      toolNames: [],
      commands: [],
    });
    const result = await cmd.execute("", { YOUTUBE_API_KEY: "test-key" });
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.capabilities).toContain("YouTube");
  });

  it("includes subsystem health information", async () => {
    const cmd = createMcpCommand({
      version: "0.8.4 beta",
      toolNames: [],
      commands: [],
    });
    const result = await cmd.execute("", {});
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.health).toHaveProperty("Cloudflare");
    expect(parsed.health).toHaveProperty("MCP");
    expect(parsed.health).toHaveProperty("Browser");
    expect(parsed.health).toHaveProperty("Video");
    expect(parsed.health).toHaveProperty("YouTube");
    expect(parsed.health).toHaveProperty("Roblox");
    expect(parsed.health).toHaveProperty("JEV / TypeSafe");
  });
});

describe("/jev command", () => {
  it("reports unavailable when TYPESAFE_API_KEY is not set", async () => {
    const cmd = createJevCommand();
    const result = await cmd.execute("", {});
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toBe("jev_unavailable");
  });

  it("shows usage info when called without arguments", async () => {
    const cmd = createJevCommand();
    const result = await cmd.execute("", { TYPESAFE_API_KEY: "test-key", TYPESAFE_ENABLED: "true" });
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.command).toBe("/jev");
    expect(parsed.usage).toBeDefined();
    expect(parsed.available_templates).toBeDefined();
  });

  it("collaborates with JEV when called with a task", async () => {
    const cmd = createJevCommand();
    const result = await cmd.execute("analyze this decision", {
      TYPESAFE_API_KEY: "test-key",
      TYPESAFE_ENABLED: "true",
    });
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.command).toBe("/jev");
    expect(parsed.source).toBe("jev");
    // Should not expose the API key
    expect(text).not.toContain("test-key");
  });

  it("never exposes secrets in the output", async () => {
    const cmd = createJevCommand();
    const result = await cmd.execute("test", {
      TYPESAFE_API_KEY: "super-secret-typesafe-key-12345",
      TYPESAFE_ENABLED: "true",
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain("super-secret-typesafe-key-12345");
  });
});
