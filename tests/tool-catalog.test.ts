/**
 * The UI's tool catalog is generated from the real tool registrations; this
 * test pins it so it can never drift from the live MCP surface. If a tool is
 * added/removed/renamed in index.ts or src/mcp/*, regenerate the catalog with
 * `node scripts/generate-tool-catalog.mjs` — this test catches forgetting.
 */
import { describe, expect, it } from "vitest";
import { DEMO_TOOL_NAMES, TOOL_COUNT } from "../index.js";
import { TOOL_CATALOG, TOOL_GROUPS, TOOL_CATALOG_COUNT } from "../src/ui/tool-catalog.js";
import { createMcpCommand } from "../src/commands/mcp-command.js";

describe("generated UI tool catalog", () => {
  it("covers exactly the live DEMO_TOOL_NAMES inventory", () => {
    const catalogNames = [...TOOL_CATALOG.map((t) => t.name)].sort();
    const liveNames = [...DEMO_TOOL_NAMES].sort();
    expect(catalogNames).toEqual(liveNames);
    expect(TOOL_CATALOG_COUNT).toBe(TOOL_COUNT);
    expect(new Set(catalogNames).size, "no duplicate tool entries").toBe(catalogNames.length);
  });

  it("every tool has a title, a known group and an availability mapping", () => {
    const knownAvailability = new Set(["browser", "youtube", "jev", "laya", "transcription", "vision", "frames", "artifacts", "snapshots", "bearer", "always"]);
    for (const tool of TOOL_CATALOG) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(TOOL_GROUPS, `group of ${tool.name}`).toContain(tool.group);
      expect(knownAvailability.has(tool.availability), `availability of ${tool.name}`).toBe(true);
    }
  });

  it("groups mirror the /mcp command grouping of the same names", async () => {
    const command = createMcpCommand({ version: "test", toolNames: DEMO_TOOL_NAMES, commands: [] });
    const result = await command.execute("", {} as never);
    const parsed = JSON.parse(String((result.content[0] as { text?: string }).text ?? "{}")) as { tools?: Record<string, string[]> };
    const commandGroups = Object.keys(parsed.tools ?? {}).sort();
    expect([...TOOL_GROUPS].sort()).toEqual(commandGroups);
    for (const [group, names] of Object.entries(parsed.tools ?? {})) {
      const catalogNames = TOOL_CATALOG.filter((t) => t.group === group).map((t) => t.name).sort();
      expect(catalogNames, `members of group ${group}`).toEqual([...names].sort());
    }
  });

  it("carries no credential-shaped content", () => {
    const dumped = JSON.stringify(TOOL_CATALOG).toLowerCase();
    for (const marker of ["api_key\":", "apikey =\"", "secret\":", "token\":", "bearer "]) {
      expect(dumped, marker).not.toContain(marker);
    }
  });
});
