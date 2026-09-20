/**
 * Extensible command router.
 *
 * Commands are a thin layer on top of MCP tools. They coexist with normal tool
 * invocation and are registered through the same MCP server. Each command is
 * a named handler that produces a ToolResult.
 *
 * The router is designed to be extended: add a new file in this directory,
 * export a CommandHandler, and register it in the COMMANDS map below.
 */

import type { ToolResult } from "../mcp/results.js";

/** A command handler receives raw arguments and returns a ToolResult. */
export interface CommandHandler {
  /** The command name without the leading slash. */
  name: string;
  /** Short description for the /mcp command listing. */
  description: string;
  /** Execute the command. */
  execute: (args: string, env: Record<string, unknown>) => Promise<ToolResult>;
}

/** Registry of all available commands. Add new commands here. */
const COMMANDS = new Map<string, CommandHandler>();

export function registerCommand(handler: CommandHandler): void {
  COMMANDS.set(handler.name, handler);
}

export function getCommand(name: string): CommandHandler | undefined {
  return COMMANDS.get(name);
}

export function listCommands(): CommandHandler[] {
  return Array.from(COMMANDS.values());
}

/**
 * Route a command string (e.g. "/mcp" or "/jev analyze this") to the handler.
 * Returns null if the command is unknown.
 */
export function routeCommand(
  input: string,
  env: Record<string, unknown>,
): Promise<ToolResult> | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const parts = trimmed.slice(1).split(/\s+/);
  const name = parts[0]?.toLowerCase();
  if (!name) return null;

  const handler = COMMANDS.get(name);
  if (!handler) {
    return Promise.resolve({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "unknown_command",
            message: `Unknown command: /${name}`,
            hint: `Available commands: ${Array.from(COMMANDS.keys()).map((c) => `/${c}`).join(", ")}`,
          }, null, 2),
        },
      ],
    });
  }

  const args = parts.slice(1).join(" ");
  return handler.execute(args, env);
}
