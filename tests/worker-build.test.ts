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
      expect(output).toMatch(/env\.AI/);
      expect(output).not.toMatch(/Error:|ERROR:/);
    },
    300_000,
  );

  /**
   * The deployment is R2-free on purpose (DEMO 0.7.1.5): enabling R2 needs a
   * credit card on file, so `wrangler.jsonc` declares no `r2_buckets` binding
   * and the deploy plan must not reference one. A stray binding here is what
   * previously failed `wrangler deploy` with error 10013/10042.
   */
  it(
    "declares no R2 binding, so the deploy works with R2 never enabled",
    async () => {
      const { stdout, stderr } = await build();
      const output = `${stdout}\n${stderr}`;
      expect(output).not.toMatch(/R2 Bucket/);
      expect(output).not.toMatch(/env\.SCREENSHOTS/);
      expect(output).not.toMatch(/env\.VIDEO_ARTIFACTS/);
      expect(output).not.toMatch(/demo-mcp-screenshots/);
      // The rest of the stack is still bound.
      expect(output).toMatch(/env\.BROWSER\b/);
      expect(output).toMatch(/BROWSER_SESSIONS/);
    },
    300_000,
  );
});
