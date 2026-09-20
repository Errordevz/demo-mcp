/**
 * /mcp command — Demo's main status/capability command.
 *
 * Shows:
 *  - Status (online / limited / offline)
 *  - Version
 *  - Capabilities (only those that actually exist)
 *  - Tools (all registered MCP tools, grouped logically)
 *  - Commands (available commands)
 *  - Health (real subsystem health)
 *
 * The tool listing is generated dynamically from the actual MCP tool registry,
 * so when a new tool is added, /mcp automatically reflects it.
 */

import type { ToolResult } from "../mcp/results.js";
import type { CommandHandler } from "./router.js";
import { resolveYouTubeConfig } from "../youtube/config.js";
import { resolveJevConfig } from "../jev/config.js";

interface McpCommandDeps {
  version: string;
  toolNames: readonly string[];
  commands: CommandHandler[];
}

/**
 * Determine the overall Demo status based on subsystem health.
 */
function determineStatus(env: Record<string, unknown>): "online" | "limited" | "offline" {
  const jevConfig = resolveJevConfig(env);
  const ytConfig = resolveYouTubeConfig(env);
  const hasBrowser = Boolean(env.BROWSER);
  const hasScreenshots = Boolean(env.SCREENSHOTS);

  // Core requirements: MCP itself always works (it's the endpoint)
  // "online" = all major subsystems are configured
  // "limited" = some subsystems unavailable but core works
  if (hasBrowser && hasScreenshots) return "online";
  if (jevConfig.available || ytConfig.available) return "limited";
  return "limited"; // MCP itself is always at least "limited" online
}

function statusEmoji(status: "online" | "limited" | "offline"): string {
  switch (status) {
    case "online": return "🟢 Online";
    case "limited": return "🟡 Limited";
    case "offline": return "🔴 Offline";
  }
}

/**
 * Group tools logically based on their names.
 */
function groupTools(toolNames: readonly string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {
    Core: [],
    Browser: [],
    Video: [],
    YouTube: [],
    Roblox: [],
    JEV: [],
    Skills: [],
    Utilities: [],
  };

  for (const name of toolNames) {
    if (name === "demo_ping" || name.startsWith("http_") || name.startsWith("json_") || name.startsWith("hash_") || name.startsWith("generate_")) {
      groups.Core.push(name);
    } else if (name.startsWith("browser_")) {
      groups.Browser.push(name);
    } else if (name === "inspect_video" || name.startsWith("video_")) {
      groups.Video.push(name);
    } else if (name.startsWith("youtube_")) {
      groups.YouTube.push(name);
    } else if (name.startsWith("roblox_")) {
      groups.Roblox.push(name);
    } else if (name.startsWith("jev_")) {
      groups.JEV.push(name);
    } else if (name.startsWith("skills_") || name.startsWith("skill_")) {
      groups.Skills.push(name);
    } else {
      groups.Utilities.push(name);
    }
  }

  // Remove empty groups
  for (const key of Object.keys(groups)) {
    if (groups[key].length === 0) delete groups[key];
  }

  return groups;
}

/**
 * Determine health of each subsystem.
 */
function subsystemHealth(env: Record<string, unknown>): Record<string, { status: "online" | "limited" | "offline"; detail: string }> {
  const health: Record<string, { status: "online" | "limited" | "offline"; detail: string }> = {};

  // Cloudflare Worker (always online if we're responding)
  health.Cloudflare = { status: "online", detail: "Worker is responding" };

  // MCP (always available — it's the endpoint)
  health.MCP = { status: "online", detail: "MCP endpoint active" };

  // Browser
  health.Browser = {
    status: env.BROWSER ? "online" : "limited",
    detail: env.BROWSER ? "Cloudflare Browser Rendering available" : "No Browser Rendering binding",
  };

  // Video
  const hasR2 = Boolean(env.SCREENSHOTS || env.VIDEO_ARTIFACTS);
  const hasAi = Boolean(env.AI && typeof (env.AI as { run?: unknown }).run === "function");
  health.Video = {
    status: hasR2 ? "online" : "limited",
    detail: hasR2
      ? `R2 storage available${hasAi ? ", Workers AI configured" : ", no Workers AI"}`
      : "No R2 storage binding",
  };

  // YouTube
  const ytConfig = resolveYouTubeConfig(env);
  health.YouTube = {
    status: ytConfig.available ? "online" : "offline",
    detail: ytConfig.available ? "YouTube Data API configured" : (ytConfig.disabledReason ?? "Not configured"),
  };

  // Roblox
  const robloxClientId = String(env.ROBLOX_CLIENT_ID ?? "").trim();
  const robloxSecret = String(env.ROBLOX_CLIENT_SECRET ?? "").trim();
  health.Roblox = {
    status: robloxClientId && robloxSecret ? "online" : "limited",
    detail: robloxClientId && robloxSecret ? "OAuth 2.0 configured" : "Not fully configured",
  };

  // JEV / TypeSafe
  const jevConfig = resolveJevConfig(env);
  health["JEV / TypeSafe"] = {
    status: jevConfig.available ? "online" : "limited",
    detail: jevConfig.available ? `TypeSafe ${jevConfig.model} configured` : (jevConfig.disabledReason ?? "Not configured"),
  };

  return health;
}

export function createMcpCommand(deps: McpCommandDeps): CommandHandler {
  return {
    name: "mcp",
    description: "Show Demo status, version, capabilities, tools, and commands.",
    execute: async (_args, env) => {
      const status = determineStatus(env);
      const health = subsystemHealth(env);
      const toolGroups = groupTools(deps.toolNames);

      const output: Record<string, unknown> = {
        command: "/mcp",
        name: "DEMO MCP",
        status: statusEmoji(status),
        version: deps.version,
        capabilities: buildCapabilitiesList(env),
        tools: toolGroups,
        tool_count: deps.toolNames.length,
        commands: deps.commands.map((cmd) => ({
          name: `/${cmd.name}`,
          description: cmd.description,
        })),
        health: Object.fromEntries(
          Object.entries(health).map(([name, info]) => [name, `${statusEmoji(info.status)} — ${info.detail}`]),
        ),
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    },
  };
}

function buildCapabilitiesList(env: Record<string, unknown>): string[] {
  const caps: string[] = [];
  if (env.BROWSER) caps.push("Browser", "Screenshots", "Live browser view", "Video inspection", "Frame extraction");
  if (env.SCREENSHOTS || env.VIDEO_ARTIFACTS) caps.push("Video artifacts");
  const hasAi = Boolean(env.AI && typeof (env.AI as { run?: unknown }).run === "function");
  if (hasAi || env.TRANSCRIPTION_ENDPOINT) caps.push("Audio extraction", "Transcription", "Vision");
  if (resolveYouTubeConfig(env).available) caps.push("YouTube");
  const robloxClientId = String(env.ROBLOX_CLIENT_ID ?? "").trim();
  const robloxSecret = String(env.ROBLOX_CLIENT_SECRET ?? "").trim();
  if (robloxClientId && robloxSecret) caps.push("Roblox");
  if (resolveJevConfig(env).available) caps.push("JEV");
  caps.push("HTTP fetching", "JSON utilities", "Hashing", "UUID generation");
  return caps;
}
