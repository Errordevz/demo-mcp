/**
 * Deployment configuration synchronization.
 *
 * The Worker reads its runtime policy from `wrangler.jsonc`, and `wrangler deploy`
 * (including the repository's deploy workflow) reads the same file. If a variable is
 * missing, duplicated, renamed or typed differently, local behavior and deployed
 * behavior drift silently — which is exactly the class of bug that makes a review
 * environment differ from production. These tests pin the file against what the code
 * actually consumes, so the drift shows up in `npm test` instead of in production.
 *
 * No Cloudflare credentials are needed here, and none are used: this validates the
 * committed configuration, not the deployed one.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkUrl } from "../src/core/url-guard.js";

const ROOT = path.resolve(__dirname, "..");

/** JSONC → JSON: drop `//` and `/* *​/` comments outside string literals, then parse. */
function stripJsonComments(source: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      out += " ";
      continue;
    }
    out += char;
  }
  return out;
}

async function config(): Promise<Record<string, any>> {
  return JSON.parse(stripJsonComments(await readFile(path.join(ROOT, "wrangler.jsonc"), "utf8"))) as Record<string, any>;
}

/** The browser/video runtime contract a deployment must carry. */
const REQUIRED_VARS: Record<string, string> = {
  BROWSER_KEEPALIVE_MS: "300000",
  BROWSER_PROVIDER: "cloudflare",
  DEMO_PLATFORM_ORIGIN: "https://demo-platform.pages.dev",
  SSRF_DNS_CHECK: "true",
  SSRF_DNS_FAIL_OPEN: "true",
  VIDEO_MAX_DOWNLOAD_MB: "50",
  VIDEO_MAX_DURATION_SECONDS: "600",
  VIDEO_ARTIFACT_TTL_SECONDS: "3600",
  VIDEO_RATE_LIMIT_PER_MINUTE: "12",
  VIDEO_TRANSCRIPTION_MODEL: "@cf/openai/whisper",
  VIDEO_VISION_MODEL: "@cf/llava-hf/llava-1.5-7b-hf",
};

/** Jev decision-engine policy. The credential must never appear here. */
const JEV_VARS: Record<string, string> = {
  TYPESAFE_ENABLED: "true",
  TYPESAFE_MODEL: "jev-latest",
  TYPESAFE_DECISION_TIMEOUT_MS: "2500",
  TYPESAFE_REVIEW_THRESHOLD: "0.5",
  TYPESAFE_ACCEPT_THRESHOLD: "0.7",
};

describe("wrangler.jsonc", () => {
  it("declares every required browser/video variable exactly once, with the documented string value", async () => {
    const source = await readFile(path.join(ROOT, "wrangler.jsonc"), "utf8");
    const data = await config();
    expect(typeof data.vars).toBe("object");

    for (const [name, value] of Object.entries({ ...REQUIRED_VARS, ...JEV_VARS })) {
      const occurrences = [...source.matchAll(new RegExp(`"${name}"\\s*:`, "g"))].length;
      expect(occurrences, `${name} must be declared exactly once`).toBe(1);
      // Strings, not numbers/booleans: the code parses them with its own coercion, and
      // a typed value here would silently differ from what a dashboard-set var looks like.
      expect(data.vars[name], `${name} value`).toBe(value);
    }
  });

  it("keeps every credential out of vars", async () => {
    const data = await config();
    const credentialShaped = Object.keys(data.vars as Record<string, unknown>).filter((name) => /(?:SECRET|API_KEY|TOKEN|PASSWORD|_KEY)$/i.test(name));
    expect(credentialShaped).toEqual([]);
    // …while still documenting them, so a reader cannot conclude they are forgotten.
    const source = await readFile(path.join(ROOT, "wrangler.jsonc"), "utf8");
    for (const name of ["DEMO_API_KEY", "ROBLOX_CLIENT_SECRET", "ROBLOX_TOKEN_KEY", "TYPESAFE_API_KEY"]) {
      expect(source).toContain(name);
    }
    expect(source).not.toMatch(/TYPESAFE_API_KEY"\s*:/);
    expect(source).not.toMatch(/"sk-[A-Za-z0-9_-]{16,}"/);
  });

  it("has no environment sections that could override the shared vars", async () => {
    const data = await config();
    // `wrangler deploy` in .github/workflows/live-deploy.yml runs with no `--env`, and
    // there is no `env.<name>` block here, so the vars above are the production values.
    expect(data.env).toBeUndefined();
    expect(data.name).toBe("demo-mcp");
    expect(data.main).toBe("platform-entry.ts");
  });

  it("binds the Durable Objects and migrations the code expects", async () => {
    const data = await config();
    expect(data.durable_objects.bindings.map((entry: { name: string }) => entry.name).sort()).toEqual(["BROWSER_SESSIONS", "ROBLOX_AUTH"]);
    expect(data.migrations.map((entry: { tag: string }) => entry.tag)).toEqual(["v1", "v2"]);
    expect(data.r2_buckets.map((entry: { binding: string }) => entry.binding)).toContain("SCREENSHOTS");
    expect(data.browser.binding).toBe("BROWSER");
    expect(data.ai.binding).toBe("AI");
  });

  it("only declares variables the code actually reads, and reads the flags it declares", async () => {
    const data = await config();
    const readers = await Promise.all(
      ["index.ts", "platform-entry.ts", "src/session/factory.ts", "src/video/processor.ts", "src/video/capabilities.ts", "src/jev/config.ts", "src/roblox/config.ts"].map((file) =>
        readFile(path.join(ROOT, file), "utf8"),
      ),
    );
    const consumed = readers.join("\n");
    for (const name of Object.keys(data.vars as Record<string, unknown>)) {
      expect(consumed, `${name} is declared but never read`).toContain(name);
    }
    // The two SSRF flags are consumed identically by the browser and the video path.
    expect((consumed.match(/SSRF_DNS_FAIL_OPEN/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(consumed).toMatch(/dnsFailOpen: String\(env\.SSRF_DNS_FAIL_OPEN \?\? "true"\)/);
  });

  it("declares exactly the Jev policy the code reads, and nothing that costs money by default", async () => {
    const data = await config();
    const jev = Object.keys(data.vars as Record<string, unknown>).filter((name) => name.startsWith("TYPESAFE_"));
    expect(jev.sort()).toEqual(Object.keys(JEV_VARS).sort());
    // The engine is on by policy but inert without a secret, so deploying this file
    // cannot start paid calls or break anything.
    expect(data.vars.TYPESAFE_ENABLED).toBe("true");
  });

/**
 * What the requested `SSRF_DNS_FAIL_OPEN=true` actually does, pinned by behavior
 * rather than by a comment. It widens availability when the DNS-over-HTTPS resolver is
 * unreachable; it does not relax any static rule.
 */
describe("SSRF_DNS_FAIL_OPEN semantics", () => {
  const unreachable = { resolve: async () => { throw new Error("resolver unreachable"); } };

  it("allows an unverified hostname with a warning, and denies it when fail-closed", async () => {
    const open = await checkUrl("https://example.test/page", { dns: unreachable, dnsFailOpen: true });
    expect(open.ok).toBe(true);
    if (open.ok) expect(open.warnings).toContain("dns-unverified");

    const closed = await checkUrl("https://example.test/page", { dns: unreachable, dnsFailOpen: false });
    expect(closed.ok).toBe(false);
  });

  it("keeps every static block in force while fail-open is on", async () => {
    for (const target of ["http://127.0.0.1/admin", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://localhost:8787/mcp", "file:///etc/passwd", "http://10.0.0.5/", "http://metadata.google.internal/"]) {
      const verdict = await checkUrl(target, { dns: unreachable, dnsFailOpen: true });
      expect(verdict.ok, target).toBe(false);
    }
  });

  it("still blocks a public name that resolves to a private address", async () => {
    const rebinding = { resolve: async () => ["127.0.0.1"] };
    const verdict = await checkUrl("https://evil.test/x", { dns: rebinding, dnsFailOpen: true });
    expect(verdict.ok).toBe(false);
  });
});
});
