// Regression tests for the post-deploy smoke check (`scripts/verify-mcp.mjs`)
// and its bounded/redacted diagnostics (`scripts/safe-diagnostics.mjs`).
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import platform from "../platform-entry.js";
import {
  MAX_DIAGNOSTIC_BYTES,
  MAX_DIAGNOSTIC_CHARS,
  formatResponseSummary,
  readBoundedBody,
  redactSecrets,
  safeRedirectTarget,
} from "../scripts/safe-diagnostics.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "verify-mcp.mjs");
const workflowPath = path.join(repoRoot, ".github", "workflows", "live-deploy.yml");
const CTX = { waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined), passThroughOnException: () => undefined } as unknown as ExecutionContext;

const TOOL_NAMES = ["demo_ping", "roblox_user", "roblox_game", "jev_decide", "json_format", "hash_text"];

/** Obviously fake credentials — never a real value, per docs/TESTING.md. */
const FAKE = {
  bearer: "fake-bearer-value-0123456789abcdef",
  jwt: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJmYWtlLXN1YmplY3QifQ.fake-signature-0123456789",
  cookie: "fake-cookie-value-0123456789abcdef",
  clientSecret: "fake-client-secret-0123456789abcdef",
  awsKey: "AKIAFAKEFAKEFAKE1234",
  email: "smoke-test@example.com",
};

/** A hostile error body: what a broken deploy or an intercepting proxy might say. */
const HOSTILE_BODY = [
  "<!doctype html><html><body>upstream failure",
  `authorization: Bearer ${FAKE.bearer}`,
  `cf-access-jwt-assertion: ${FAKE.jwt}`,
  `set-cookie: _cf_access_session=${FAKE.cookie}; HttpOnly; Secure`,
  `TYPESAFE_API_KEY=${FAKE.clientSecret}`,
  `LAYA_API_KEY=${FAKE.awsKey}`,
  `operator: ${FAKE.email}`,
  "</body></html>",
].join("\n");

interface MockOptions {
  /** `"hostile"` makes /health fail with a body full of fake secrets. */
  health?: "ok" | "hostile" | "huge";
  /** Answer `/mcp` with HTTP 200 and an empty body, like a broken proxy. */
  mcpEmpty?: boolean;
}

interface RecordedRequest {
  method: string;
  pathname: string;
  /** Names only — the mock never records a credential value. */
  forbiddenHeaderNames: string[];
}

const FORBIDDEN_REQUEST_HEADERS = ["authorization", "cf-access-jwt-assertion", "cf-access-client-id", "cf-access-client-secret", "cookie"];

function startMockWorker(options: MockOptions = {}) {
  const requests: RecordedRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.on("error", () => undefined);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({
      method: req.method ?? "GET",
      pathname: url.pathname,
      forbiddenHeaderNames: FORBIDDEN_REQUEST_HEADERS.filter((name) => req.headers[name] !== undefined),
    });
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      try {
        res.writeHead(status, { "content-type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json", ...headers });
        res.end(text);
      } catch {
        // Socket already gone; nothing useful to report.
      }
    };

    if (url.pathname === "/mcp") {
      if (options.mcpEmpty) return send(200, "", { "content-type": "text/plain" });
      let raw = "";
      req.on("data", (chunk) => { raw += String(chunk); });
      req.on("end", () => {
        let message: { id?: number; method?: string };
        try {
          message = JSON.parse(raw) as { id?: number; method?: string };
        } catch {
          send(400, { error: "bad json" });
          return;
        }
        if (message.method === "initialize") {
          send(200, {
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "DEMO", version: "1.1.0" } },
          }, { "mcp-session-id": "fake-session-id" });
          return;
        }
        if (message.method === "notifications/initialized") {
          try { res.writeHead(202); res.end(); } catch { /* closed */ }
          return;
        }
        if (message.method === "tools/list") {
          send(200, { jsonrpc: "2.0", id: message.id, result: { tools: TOOL_NAMES.map((name) => ({ name })) } });
          return;
        }
        if (message.method === "tools/call") {
          send(200, {
            jsonrpc: "2.0",
            id: message.id,
            result: { content: [{ type: "text", text: JSON.stringify({ ok: true, name: "DEMO", toolCount: TOOL_NAMES.length }) }] },
          });
          return;
        }
        send(200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
      });
      return;
    }

    if (url.pathname === "/health") {
      if (options.health === "hostile") return send(500, HOSTILE_BODY);
      if (options.health === "huge") {
        const filler = "x".repeat(4 * 1024 * 1024);
        return send(503, `${filler}${FAKE.clientSecret}`);
      }
      return send(200, { ok: true, name: "DEMO", version: "1.1.0" });
    }
    if (url.pathname === "/tools") return send(200, { count: TOOL_NAMES.length, tools: TOOL_NAMES });

    send(404, { error: "not_found" });
  });

  return new Promise<{ origin: string; requests: RecordedRequest[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("mock worker did not report a port");
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done()))),
      });
    });
  });
}

async function runScript(origin: string, env: Record<string, string> = {}) {
  const childEnv: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  for (const [key, value] of Object.entries(env)) childEnv[key] = value;
  const child = spawn(process.execPath, [scriptPath, origin], { env: childEnv, cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk as Buffer));
  child.stderr.on("data", (chunk) => stderr.push(chunk as Buffer));
  const [code] = (await once(child, "close", { signal: AbortSignal.timeout(60_000) })) as [number | null];
  return { status: code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

describe("the real Worker public routes", () => {
  it("answers the public no-login routes with 200", async () => {
    const health = await platform.fetch(new Request("https://demo-mcp.test.workers.dev/health", { headers: { Accept: "application/json" } }), {} as never, CTX);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { ok?: boolean }).ok).toBe(true);

    const tools = await platform.fetch(new Request("https://demo-mcp.test.workers.dev/tools", { headers: { Accept: "application/json" } }), {} as never, CTX);
    expect(tools.status).toBe(200);
    expect(Array.isArray(((await tools.json()) as { tools?: unknown }).tools)).toBe(true);
  });
});

describe("scripts/verify-mcp.mjs against the real Worker over HTTP", () => {
  function startRealWorkerBridge() {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      res.on("error", () => undefined);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const init: RequestInit = { method: req.method, headers: req.headers as Record<string, string> };
      if (chunks.length) init.body = Buffer.concat(chunks);
      let response: Response;
      try {
        response = await platform.fetch(new Request(`http://127.0.0.1${req.url ?? "/"}`, init), {} as never, CTX);
      } catch (error) {
        try { res.writeHead(500); res.end(String(error)); } catch { /* closed */ }
        return;
      }
      const body = Buffer.from(await response.arrayBuffer());
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => { headers[key] = value; });
      try { res.writeHead(response.status, headers); res.end(body); } catch { /* closed */ }
    });
    return new Promise<{ origin: string; close: () => Promise<void> }>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("worker bridge did not report a port");
        resolve({
          origin: `http://127.0.0.1:${address.port}`,
          close: () => new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done()))),
        });
      });
    });
  }

  it("passes end to end against the no-login surface", async () => {
    const bridge = await startRealWorkerBridge();
    try {
      const result = await runScript(bridge.origin);
      expect(result.status, `real-Worker smoke check failed: ${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("PASS:");
      expect(result.stdout).toContain("initialize: HTTP 200 (no Authorization header)");
      expect(result.stdout).toContain("notifications/initialized: HTTP 202 (no Authorization header)");
      expect(result.stdout).toContain("tools/list: HTTP 200 (no Authorization header)");
      expect(result.stdout).toContain("demo_ping: ok");
      expect(result.stdout).toContain("/health: HTTP 200");
      expect(result.stdout).toContain("/tools: HTTP 200");
      expect(result.stderr).toBe("");
    } finally {
      await bridge.close();
    }
  }, 60_000);
});

describe("scripts/verify-mcp.mjs (run for real against a production-shaped mock)", () => {
  it("passes and sends no credentials at all", async () => {
    const mock = await startMockWorker();
    try {
      const result = await runScript(mock.origin);
      expect(result.stderr, `smoke check failed: ${result.stderr}`).toBe("");
      expect(result.status, `smoke check exited nonzero: ${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("PASS:");
      expect(result.stdout).toContain("initialize: HTTP 200 (no Authorization header)");
      expect(result.stdout).toContain("tools/list: HTTP 200 (no Authorization header)");
      expect(result.stdout).toContain("demo_ping: ok");
      expect(result.stdout).toContain("/health: HTTP 200");
      expect(result.stdout).toContain("/tools: HTTP 200");
      expect(mock.requests.length).toBeGreaterThan(0);
      expect(mock.requests.flatMap((request) => request.forbiddenHeaderNames)).toEqual([]);
    } finally {
      await mock.close();
    }
  });

  it("reports a bounded, redacted body when an unexpected response breaks the check", async () => {
    const mock = await startMockWorker({ health: "hostile" });
    try {
      const result = await runScript(mock.origin);
      expect(result.status).not.toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("FAIL:");
      expect(output).toContain("/health");
      expect(output).toContain("HTTP 500");
      for (const secret of [FAKE.bearer, FAKE.jwt, FAKE.cookie, FAKE.clientSecret, FAKE.awsKey, FAKE.email]) {
        expect(output, `diagnostics leaked ${secret.slice(0, 12)}…`).not.toContain(secret);
      }
      expect(output).not.toContain("eyJhbGciOiJSUzI1NiJ9");
      expect(output).toContain("[redacted]");
    } finally {
      await mock.close();
    }
  });

  it("never buffers or prints a huge failure body past the byte cap", async () => {
    const mock = await startMockWorker({ health: "huge" });
    try {
      const result = await runScript(mock.origin);
      expect(result.status).not.toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("HTTP 503");
      expect(output).toContain("truncated at cap");
      expect(output).not.toContain(FAKE.clientSecret);
      const failureLine = output.split("\n").find((line) => line.includes("FAIL:")) ?? "";
      expect(failureLine.length).toBeLessThan(MAX_DIAGNOSTIC_CHARS + 1200);
    } finally {
      await mock.close();
    }
  });

  it("reports a missing JSON-RPC payload without trying to read the body twice", async () => {
    const mock = await startMockWorker({ mcpEmpty: true });
    try {
      const result = await runScript(mock.origin);
      expect(result.status).not.toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("initialize: missing JSON-RPC response");
      expect(output).toContain("HTTP 200");
      expect(output).toContain("<empty>");
      expect(output).not.toContain("unusable");
      expect(output).not.toContain("TypeError");
    } finally {
      await mock.close();
    }
  });

  it("exits with a usage error when no worker URL is given", async () => {
    const child = spawn(process.execPath, [scriptPath], { env: { PATH: process.env.PATH ?? "" }, cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk as Buffer));
    child.stderr.on("data", (chunk) => stderr.push(chunk as Buffer));
    const [code] = (await once(child, "close", { signal: AbortSignal.timeout(30_000) })) as [number | null];
    expect(code).toBe(2);
    expect(Buffer.concat(stderr).toString("utf8")).toContain("usage: node scripts/verify-mcp.mjs <worker-url>");
    expect(Buffer.concat(stdout).toString("utf8")).toBe("");
  });
});

describe("smoke-check source contract", () => {
  const source = readFileSync(scriptPath, "utf8");

  it("expects HTTP 200 only from the public no-login routes", () => {
    const literal = /const PUBLIC_200_PATHS = \[([^\]]*)\]/.exec(source);
    expect(literal, "PUBLIC_200_PATHS must stay a plain array literal so this guard can read it").not.toBeNull();
    const paths = (literal![1] ?? "")
      .split(",")
      .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    expect(paths).toEqual(["/health", "/tools"]);
  });

  it("reads no secrets from the environment", () => {
    const envReads = [...source.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
    expect(envReads).toEqual([]);
  });

  it("keeps the public CI step credential-free", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const index = workflow.indexOf("scripts/verify-mcp.mjs");
    expect(index, "the deploy workflow must still run the smoke check").toBeGreaterThan(-1);
    const step = workflow.slice(Math.max(0, index - 600), index + 400);
    expect(step).not.toMatch(/CF_ACCESS|CF-Access/);
    expect(step).not.toMatch(/secrets\.[A-Z_]*(ROBLOX|ACCESS|TOKEN_KEY|JWT)/);
  });
});

describe("scripts/safe-diagnostics.mjs redaction and bounding", () => {
  it("redacts every credential shape a failure body could carry", () => {
    const redacted = redactSecrets(HOSTILE_BODY);
    for (const secret of [FAKE.bearer, FAKE.jwt, FAKE.cookie, FAKE.clientSecret, FAKE.awsKey, FAKE.email]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain("[jwt-redacted]");
    expect(redacted).toContain("[redacted]");
    expect(redacted).toContain("[email-redacted]");
  });

  it("redacts key/value secrets by name, including the Access assertion headers", () => {
    const cases: Array<[string, string]> = [
      [`{"authorization":"Bearer ${FAKE.bearer}"}`, FAKE.bearer],
      [`{"CF-Access-Jwt-Assertion":"${FAKE.jwt}"}`, FAKE.jwt],
      [`cf-access-jwt-assertion=${FAKE.jwt}`, FAKE.jwt],
      [`{"cf_access_client_secret":"${FAKE.clientSecret}"}`, FAKE.clientSecret],
      [`{"cf_access_client_id":"${FAKE.clientSecret}"}`, FAKE.clientSecret],
      [`{"refresh_token":"${FAKE.cookie}"}`, FAKE.cookie],
      [`{"ROBLOSECURITY":"${FAKE.cookie}"}`, FAKE.cookie],
      [`.ROBLOSECURITY=${FAKE.cookie}`, FAKE.cookie],
      [`Cookie: _cf_access_session=${FAKE.cookie}`, FAKE.cookie],
      [`{"password":"${FAKE.bearer}"}`, FAKE.bearer],
      [`{"link_code":"${FAKE.clientSecret}"}`, FAKE.clientSecret],
      [`{"set-cookie":"${FAKE.cookie}"}`, FAKE.cookie],
    ];
    for (const [input, secret] of cases) {
      const out = redactSecrets(input);
      expect(out, `${input.slice(0, 30)}… leaked`).not.toContain(secret);
      expect(out, `${input.slice(0, 30)}… produced no redaction marker`).toMatch(/\[[a-z-]*redacted\]/);
    }
  });

  it("redacts Worker-style SCREAMING_SNAKE secret assignments and provider keys", () => {
    const cases: Array<[string, string]> = [
      [`ROBLOX_TOKEN_KEY=${FAKE.clientSecret}`, FAKE.clientSecret],
      [`{"ROBLOX_TOKEN_KEY":"${FAKE.clientSecret}"}`, FAKE.clientSecret],
      [`ROBLOX_CLIENT_SECRET: ${FAKE.clientSecret}`, FAKE.clientSecret],
      [`CLOUDFLARE_API_TOKEN=${FAKE.bearer}`, FAKE.bearer],
      ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
      [`sk_live_${FAKE.clientSecret}`, `sk_live_${FAKE.clientSecret}`],
      ["AKIAFAKEFAKEFAKE1234", "AKIAFAKEFAKEFAKE1234"],
    ];
    for (const [input, secret] of cases) {
      const out = redactSecrets(input);
      expect(out, `${input.slice(0, 34)}… leaked`).not.toContain(secret);
      expect(out).toMatch(/\[[a-z-]*redacted\]/);
    }
  });

  it("leaves ordinary non-secret diagnostics readable", () => {
    for (const text of [
      "BROWSER_PROVIDER=cloudflare",
      "MCP_PUBLIC_ORIGIN=https://demo-mcp.amidevz.workers.dev",
      '{"error":"unauthenticated","message":"A verified human Cloudflare Access identity is required.","retryable":false}',
    ]) {
      expect(redactSecrets(text), `${text.slice(0, 40)}… was mangled`).toBe(text);
    }
  });

  it("bounds the printed preview and marks truncation", () => {
    const bounded = redactSecrets("z".repeat(MAX_DIAGNOSTIC_CHARS * 4));
    expect(bounded.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CHARS + 64);
    expect(bounded).toContain("truncated");
  });

  it("withholds the preview entirely if a credential shape survives redaction", () => {
    const awkward = "assertion fragment: eyJhbGciOiJSUzI1NiJ9 (header only)";
    const out = redactSecrets(awkward);
    expect(out).toBe("[withheld: credential-shaped content survived redaction]");
    expect(out).not.toContain("eyJhbGciOiJSUzI1NiJ9");
  });

  it("bounds a body read to the byte cap without buffering the rest", async () => {
    const huge = "y".repeat(MAX_DIAGNOSTIC_BYTES * 8) + FAKE.clientSecret;
    const response = new Response(huge, { status: 503, headers: { "content-type": "text/plain" } });
    const read = await readBoundedBody(response, MAX_DIAGNOSTIC_BYTES);
    expect(read.truncated).toBe(true);
    expect(read.text.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_BYTES);
    expect(read.text).not.toContain(FAKE.clientSecret);
    const summary = formatResponseSummary(response, read, { label: "GET /health" });
    expect(summary).toContain("HTTP 503");
    expect(summary).toContain("truncated at cap");
    expect(summary.length).toBeLessThan(MAX_DIAGNOSTIC_CHARS + 600);
  });

  it("reports only allowlisted headers and never a cookie value", async () => {
    const response = new Response("nope", {
      status: 401,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "set-cookie": `_cf_access_session=${FAKE.cookie}`,
        "www-authenticate": `Bearer realm="${FAKE.bearer}"`,
      },
    });
    const read = await readBoundedBody(response, 1024);
    const summary = formatResponseSummary(response, read);
    expect(summary).toContain("content-type=application/json");
    expect(summary).toContain("cache-control=no-store");
    expect(summary).toContain("set-cookie=[present, value withheld]");
    expect(summary).not.toContain(FAKE.cookie);
    expect(summary).not.toContain(FAKE.bearer);
    expect(summary).not.toContain("www-authenticate");
  });

  it("strips the query from a redirect target, where OAuth state lives", () => {
    const response = new Response(null, {
      status: 302,
      headers: { location: `https://fake-team.cloudflareaccess.com/login?state=${FAKE.cookie}&code_challenge=fake-challenge-0123456789` },
    });
    const target = safeRedirectTarget(response);
    expect(target).toBe("https://fake-team.cloudflareaccess.com/login?[query withheld]");
    expect(target).not.toContain(FAKE.cookie);
  });
});
