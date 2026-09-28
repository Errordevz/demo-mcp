// Regression tests for the post-deploy smoke check (`scripts/verify-mcp.mjs`)
// and its bounded/redacted diagnostics (`scripts/safe-diagnostics.mjs`).
//
// Why this file exists: the unauthenticated deploy check used to expect
// HTTP 200 from `GET /oauth/roblox/status`. That route is private — it answers
// only for a verified human Cloudflare Access identity (`CF-Access-Jwt-Assertion`,
// RS256, `type: "app"`; service tokens are rejected) and only with encrypted
// Roblox storage — so a correctly secured Worker answers an anonymous caller
// with HTTP 401 and the smoke check failed against a *healthy* deploy.
//
// These tests pin the corrected contract in both directions:
//
//   1. the real Worker refuses an anonymous `/oauth/roblox/status` (401), which
//      is why no unauthenticated check may expect 200 there;
//   2. the real script, run against a production-shaped mock, passes with the
//      private route answering 401 — and sends no Authorization header, no
//      cookie and no Access assertion;
//   3. the script FAILS loudly if the private route ever answers an anonymous
//      caller with 2xx (so nobody "fixes" a future failure by making the
//      endpoint public or by weakening the identity check);
//   4. failure diagnostics are byte-bounded and redacted: no Authorization
//      value, Access assertion, cookie, token, key or e-mail address is ever
//      printed, and a huge body is never buffered or echoed in full;
//   5. the optional protected probe stays opt-in, needs a real human assertion
//      (a service token is refused up front) and never prints the credential.
//
// All fixtures use obviously fake secrets.
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

const TOOL_NAMES = ["demo_ping", "roblox_user", "roblox_account_status", "roblox_account_unlink", "jev_decide", "json_format", "hash_text"];
const PRIVATE_PATH = "/oauth/roblox/status";

/** Obviously fake credentials — never a real value, per docs/TESTING.md. */
const FAKE = {
  bearer: "fake-bearer-value-0123456789abcdef",
  jwt: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJmYWtlLXN1YmplY3QifQ.fake-signature-0123456789",
  cookie: "fake-cookie-value-0123456789abcdef",
  clientSecret: "fake-client-secret-0123456789abcdef",
  awsKey: "AKIAFAKEFAKEFAKE1234",
  email: "smoke-test@example.com",
  robloxUser: "fake-roblox-username",
};

/** A hostile error body: what a broken deploy or an intercepting proxy might say. */
const HOSTILE_BODY = [
  "<!doctype html><html><body>upstream failure",
  `authorization: Bearer ${FAKE.bearer}`,
  `cf-access-jwt-assertion: ${FAKE.jwt}`,
  `set-cookie: _cf_access_session=${FAKE.cookie}; HttpOnly; Secure`,
  `ROBLOX_CLIENT_SECRET=${FAKE.clientSecret}`,
  `ROBLOX_TOKEN_KEY=${FAKE.awsKey}`,
  `operator: ${FAKE.email}`,
  "</body></html>",
].join("\n");

interface MockOptions {
  /** `"private"` answers 401 like production; `"public"` is the regression case. */
  robloxStatus?: "private" | "public" | "redirect";
  /** `"hostile"` makes /health fail with a body full of fake secrets. */
  health?: "ok" | "hostile" | "huge";
  /** Whether an authenticated request to the private route gets a 200. */
  protectedStatus?: boolean;
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
    // The script may stop reading a huge body early; a write to a closed
    // socket must not crash the test process.
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
            result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "DEMO", version: "0.9.0" } },
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
        // 4 MiB of noise with the fake secret buried far past the diagnostic
        // byte cap: it must never be read, buffered or printed.
        const filler = "x".repeat(4 * 1024 * 1024);
        return send(503, `${filler}${FAKE.clientSecret}`);
      }
      return send(200, { ok: true, name: "DEMO", version: "0.9.0" });
    }
    if (url.pathname === "/tools") return send(200, { count: TOOL_NAMES.length, tools: TOOL_NAMES });

    if (url.pathname === PRIVATE_PATH) {
      const authenticated = req.headers["cf-access-jwt-assertion"] !== undefined;
      if (options.robloxStatus === "public") {
        // The regression this suite guards against: the private route answering
        // an anonymous caller.
        return send(200, { connected: false, configuration: { enabled: true, storage: "durable-object", tokenEncryption: "aes-gcm-256" } });
      }
      if (options.robloxStatus === "redirect" && !authenticated) {
        return send(302, "", { location: "https://fake-team.cloudflareaccess.com/cdn-cgi/access/login/demo?redirect_url=%2Foauth%2Froblox%2Fstatus&state=fake-state-value-0123456789" });
      }
      if (authenticated && options.protectedStatus) {
        return send(200, {
          connected: true,
          configuration: { enabled: true, storage: "durable-object", tokenEncryption: "aes-gcm-256" },
          // Private account detail the script must not echo.
          account: { username: FAKE.robloxUser, displayName: "Fake User", accessToken: FAKE.bearer },
        });
      }
      return send(401, {
        error: "unauthenticated",
        message: "A verified human Cloudflare Access identity is required for this Roblox route.",
        hint: "Sign in to the configured Cloudflare Access application using the same identity used by ChatGPT.",
        retryable: false,
      });
    }
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

function base64Url(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** A well-formed but unsigned Access assertion. The mock does not verify it. */
function fakeAssertion(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: "fake-kid" };
  const claims = {
    iss: "https://fake-team.cloudflareaccess.com",
    aud: "fake-audience-tag",
    sub: "fake-subject-never-a-real-identity",
    type: "app",
    iat: now - 10,
    exp: now + 600,
    ...overrides,
  };
  return `${base64Url(header)}.${base64Url(claims)}.fake-signature-0123456789`;
}

describe("the real Worker keeps /oauth/roblox/status private", () => {
  it("refuses an anonymous status request with 401, which is why no unauthenticated check may expect 200", async () => {
    const response = await platform.fetch(
      new Request(`https://demo-mcp.test.workers.dev${PRIVATE_PATH}`, { headers: { Accept: "application/json" } }),
      {} as never,
      CTX,
    );
    expect(response.status, "an anonymous caller must never get a 200 from the private Roblox status route").toBe(401);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("unauthenticated");
    expect(response.headers.get("set-cookie"), "a refusal must not start a browser session").toBeNull();
  });

  it("still answers the public no-login routes with 200", async () => {
    const health = await platform.fetch(new Request("https://demo-mcp.test.workers.dev/health", { headers: { Accept: "application/json" } }), {} as never, CTX);
    expect(health.status).toBe(200);
    expect(((await health.json()) as { ok?: boolean }).ok).toBe(true);

    const tools = await platform.fetch(new Request("https://demo-mcp.test.workers.dev/tools", { headers: { Accept: "application/json" } }), {} as never, CTX);
    expect(tools.status).toBe(200);
    expect(Array.isArray(((await tools.json()) as { tools?: unknown }).tools)).toBe(true);
  });
});

describe("scripts/verify-mcp.mjs against the real Worker over HTTP", () => {
  /**
   * Bridge the real `platform-entry.ts` fetch handler onto a local HTTP server
   * so the *actual* deployed routing, MCP transport and Roblox identity check
   * are exercised by the *actual* smoke script — no mock in between. `env` is
   * empty, exactly like an unconfigured deployment: no Access team domain, no
   * Durable Objects, no secrets, so nothing here can reach the network.
   */
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

  it("passes end to end: the no-login surface works and the private Roblox route refuses", async () => {
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
      // The whole point of the fix: refused, not 200.
      expect(result.stdout).toMatch(/\/oauth\/roblox\/status: HTTP 401 \(error code: unauthenticated\)/);
      expect(result.stdout).not.toMatch(/\/oauth\/roblox\/status: HTTP 200/);
      expect(result.stderr).toBe("");
    } finally {
      await bridge.close();
    }
  }, 60_000);
});

describe("scripts/verify-mcp.mjs (run for real against a production-shaped mock)", () => {
  it("passes when the private route answers 401, and sends no credentials at all", async () => {
    const mock = await startMockWorker({ robloxStatus: "private" });
    try {
      const result = await runScript(mock.origin);
      expect(result.stderr, `smoke check failed: ${result.stderr}`).toBe("");
      expect(result.status, `smoke check exited nonzero: ${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("PASS:");
      // The no-login checks that must survive.
      expect(result.stdout).toContain("initialize: HTTP 200 (no Authorization header)");
      expect(result.stdout).toContain("tools/list: HTTP 200 (no Authorization header)");
      expect(result.stdout).toContain("demo_ping: ok");
      expect(result.stdout).toContain("/health: HTTP 200");
      expect(result.stdout).toContain("/tools: HTTP 200");
      // The private route is asserted as refused, not as 200.
      expect(result.stdout).toMatch(/\/oauth\/roblox\/status: HTTP 401/);
      expect(result.stdout).not.toMatch(/\/oauth\/roblox\/status: HTTP 200/);
      // No credential of any kind reached the Worker.
      expect(mock.requests.length).toBeGreaterThan(0);
      expect(mock.requests.flatMap((request) => request.forbiddenHeaderNames)).toEqual([]);
      // The opt-in protected probe is skipped loudly, never silently.
      expect(result.stdout).toContain("SKIP: protected /oauth/roblox/status probe");
    } finally {
      await mock.close();
    }
  });

  it("passes when Cloudflare Access answers the anonymous check with a login redirect, without following it", async () => {
    const mock = await startMockWorker({ robloxStatus: "redirect" });
    try {
      const result = await runScript(mock.origin);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("HTTP 302");
      expect(result.stdout).toContain("redirect not followed");
      // The redirect target's query carries OAuth state: it must be withheld.
      expect(result.stdout).not.toContain("fake-state-value-0123456789");
      expect(result.stdout).toContain("[query withheld]");
      expect(mock.requests.flatMap((request) => request.forbiddenHeaderNames)).toEqual([]);
    } finally {
      await mock.close();
    }
  });

  it("fails loudly if the private Roblox status route ever answers an anonymous caller with 2xx", async () => {
    const mock = await startMockWorker({ robloxStatus: "public" });
    try {
      const result = await runScript(mock.origin);
      expect(result.status, "a public /oauth/roblox/status is a security regression and must fail the deploy check").not.toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("SECURITY REGRESSION");
      expect(output).toContain(PRIVATE_PATH);
      expect(output).toContain("Cloudflare Access");
      // The fix must not be to weaken the Worker or to expect 200 here.
      expect(output).toContain("Do not fix this by expecting 200 here");
      expect(mock.requests.flatMap((request) => request.forbiddenHeaderNames)).toEqual([]);
    } finally {
      await mock.close();
    }
  });

  it("reports a bounded, redacted body when an unexpected response breaks the check", async () => {
    const mock = await startMockWorker({ robloxStatus: "private", health: "hostile" });
    try {
      const result = await runScript(mock.origin);
      expect(result.status).not.toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("FAIL:");
      expect(output).toContain("/health");
      expect(output).toContain("HTTP 500");
      // No credential value, cookie, assertion, key or e-mail address is printed.
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
    const mock = await startMockWorker({ robloxStatus: "private", health: "huge" });
    try {
      const result = await runScript(mock.origin);
      expect(result.status).not.toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("HTTP 503");
      expect(output).toContain("truncated at cap");
      // The secret sits 4 MiB into the body: far beyond the cap, so unread.
      expect(output).not.toContain(FAKE.clientSecret);
      const failureLine = output.split("\n").find((line) => line.includes("FAIL:")) ?? "";
      expect(failureLine.length).toBeLessThan(MAX_DIAGNOSTIC_CHARS + 1200);
    } finally {
      await mock.close();
    }
  });

  it("runs the optional protected probe only with a real human assertion, and never prints it", async () => {
    const mock = await startMockWorker({ robloxStatus: "private", protectedStatus: true });
    const assertion = fakeAssertion();
    try {
      const result = await runScript(mock.origin, { SMOKE_CF_ACCESS_JWT: assertion });
      expect(result.stderr, `protected probe failed: ${result.stderr}`).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`protected ${PRIVATE_PATH}: HTTP 200`);
      expect(result.stdout).toContain("connected=true");
      // The credential is reported as a fingerprint only.
      expect(result.stdout).not.toContain(assertion);
      expect(result.stdout).toMatch(/sha256:[0-9a-f]{12}/);
      // Private account detail from the authenticated payload is not echoed.
      expect(result.stdout).not.toContain(FAKE.robloxUser);
      expect(result.stdout).not.toContain(FAKE.bearer);
      // The anonymous refusal check still ran, and the assertion went to exactly
      // one place: the private route. No Authorization header, no cookie.
      expect(result.stdout).toMatch(/\/oauth\/roblox\/status: HTTP 401/);
      const assertionBearers = mock.requests.filter((request) => request.forbiddenHeaderNames.includes("cf-access-jwt-assertion"));
      expect(assertionBearers).toHaveLength(1);
      expect(assertionBearers[0]!.pathname).toBe(PRIVATE_PATH);
      expect(mock.requests.filter((request) => request.forbiddenHeaderNames.includes("authorization"))).toEqual([]);
      expect(mock.requests.filter((request) => request.forbiddenHeaderNames.includes("cookie"))).toEqual([]);
    } finally {
      await mock.close();
    }
  });

  it("refuses to run the protected probe with a service token, because the Worker rejects those by design", async () => {
    const mock = await startMockWorker({ robloxStatus: "private", protectedStatus: true });
    const serviceToken = fakeAssertion({ type: "app-token", sub: "fake-service-token-subject" });
    try {
      const result = await runScript(mock.origin, { SMOKE_CF_ACCESS_JWT: serviceToken });
      expect(result.status).not.toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("service tokens are rejected by design");
      expect(output).not.toContain(serviceToken);
      // The opt-in probe must not have reached the Worker with a bad identity.
      expect(mock.requests.filter((request) => request.forbiddenHeaderNames.includes("cf-access-jwt-assertion"))).toEqual([]);
    } finally {
      await mock.close();
    }
  });

  it("rejects an expired assertion with a precise reason instead of a confusing 401", async () => {
    const mock = await startMockWorker({ robloxStatus: "private", protectedStatus: true });
    const now = Math.floor(Date.now() / 1000);
    const expired = fakeAssertion({ iat: now - 7200, exp: now - 3600 });
    try {
      const result = await runScript(mock.origin, { SMOKE_CF_ACCESS_JWT: expired });
      expect(result.status).not.toBe(0);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("expired");
      expect(output).not.toContain(expired);
    } finally {
      await mock.close();
    }
  });

  it("reports a missing JSON-RPC payload without trying to read the body twice", async () => {
    // A broken proxy or an edge cache can answer 200 with an empty body. The
    // diagnostic must still be readable: the stream was already consumed by
    // `response.text()`, so the summary has to be built from what is in hand.
    const mock = await startMockWorker({ robloxStatus: "private", mcpEmpty: true });
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
    expect(paths, "the private Roblox status route must never be in the 200-expected list").not.toContain(PRIVATE_PATH);
    // …and it must still be checked, as a refusal.
    expect(source).toContain(`const PRIVATE_ROBLOX_STATUS_PATH = "${PRIVATE_PATH}"`);
    expect(source).toContain("checkPrivateRobloxStatusRefusesAnonymous()");
  });

  it("reads no Roblox or Access secret from the environment, only the opt-in assertion", () => {
    const envReads = [...source.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
    expect(envReads).toEqual(["SMOKE_CF_ACCESS_JWT"]);
    expect(source).not.toMatch(/process\.env\.(ROBLOX_|CLOUDFLARE_|MCP_AUTH_)/);
    // No credential is ever hardcoded in the script either.
    expect(source).not.toMatch(/(CF-Access-Jwt-Assertion|Authorization)["']?\s*[:=]\s*["']?(?!assertion\b)[A-Za-z0-9._~+/=-]{16,}/);
  });

  it("keeps the public CI step credential-free", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const index = workflow.indexOf("scripts/verify-mcp.mjs");
    expect(index, "the deploy workflow must still run the smoke check").toBeGreaterThan(-1);
    const step = workflow.slice(Math.max(0, index - 600), index + 400);
    expect(step).not.toContain("SMOKE_CF_ACCESS_JWT");
    expect(step).not.toMatch(/ROBLOX_[A-Z_]*SECRET/);
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
      // Any marker is fine; the more specific ones (e.g. `[jwt-redacted]`) are
      // preserved on purpose because they aid diagnosis without leaking.
      expect(out, `${input.slice(0, 30)}… produced no redaction marker`).toMatch(/\[[a-z-]*redacted\]/);
    }
  });

  it("redacts Worker-style SCREAMING_SNAKE secret assignments and provider keys", () => {
    // `_` is a word character, so a `\b`-anchored rule silently skips exactly
    // these names. Both the quoted and the bare assignment must be covered.
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
    // Over-redaction would make the smoke check useless, so the safe shapes a
    // deploy failure legitimately reports must survive untouched.
    for (const text of [
      "BROWSER_PROVIDER=cloudflare",
      "MCP_PUBLIC_ORIGIN=https://demo-mcp.amidevz.workers.dev",
      "OAUTH_STATE_TTL_SECONDS=600",
      "ROBLOX_OAUTH_SCOPES=openid profile",
      "missing ROBLOX_TOKEN_KEY secret",
      '{"error":"unauthenticated","message":"A verified human Cloudflare Access identity is required.","retryable":false}',
      "storage=durable-object tokenEncryption=aes-gcm-256 connected=true",
    ]) {
      expect(redactSecrets(text), `${text.slice(0, 40)}… was mangled`).toBe(text);
    }
  });

  it("bounds the printed preview and marks truncation", () => {
    // "z" is deliberately not a hex digit, so the long-hex rule cannot fire.
    const bounded = redactSecrets("z".repeat(MAX_DIAGNOSTIC_CHARS * 4));
    expect(bounded.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CHARS + 64);
    expect(bounded).toContain("truncated");
  });

  it("withholds the preview entirely if a credential shape survives redaction", () => {
    // A single-segment assertion fragment: the three-part JWT rule cannot match
    // it, so the survivor net must withhold the whole preview instead.
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
