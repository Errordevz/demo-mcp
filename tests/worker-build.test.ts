import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const ROOT = path.resolve(__dirname, "..");

/**
 * Builds the Worker exactly as `wrangler deploy` would so the bundle is proven
 * to be Cloudflare compatible: no Node-only imports may reach the Worker graph.
 */
async function build(): Promise<{ stdout: string; stderr: string }> {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const { stdout, stderr } = await run(npx, ["wrangler", "deploy", "--dry-run", "--outdir", "dist-test"], {
    cwd: ROOT,
    env: { ...process.env, CI: "1", NODE_ENV: "production" },
    maxBuffer: 32 * 1024 * 1024,
  });
  return { stdout, stderr };
}

describe("Cloudflare Worker build", () => {
  it(
    "compiles the worker bundle for the Cloudflare runtime",
    async () => {
      const { stdout, stderr } = await build();
      const output = `${stdout}\n${stderr}`;
      expect(output).toMatch(/Total Upload/);
      // Every declared binding must be present in the deploy plan.
      expect(output).toMatch(/BROWSER_SESSIONS/);
      expect(output).toMatch(/SCREENSHOTS/);
      expect(output).toMatch(/env\.AI/);
      expect(output).not.toMatch(/Error:|ERROR:/);
    },
    300_000,
  );
});
