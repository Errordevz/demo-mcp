// Regression test for scripts/audit-mcp-deployment.mjs.
//
// Cloudflare's documented Worker download endpoint is
//   GET /accounts/{account_id}/workers/scripts/{name}
// while `/content` is not a valid route and returns HTTP 405, which previously
// broke the "Deploy + live video tests" workflow before deployment.
//
// The test runs the real script in a child process against a local mock of the
// Cloudflare API (fetch is redirected by tests/helpers/audit-fetch-redirect.mjs,
// so no real network is used) and asserts which endpoints were requested.
// Secrets used here are fixtures; the assertions also verify the script never
// prints the token or the downloaded bundle source.
import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "audit-mcp-deployment.mjs");
const hookPath = path.join(repoRoot, "tests", "helpers", "audit-fetch-redirect.mjs");
const accountId = "test-account-id";
const scriptBase = `/client/v4/accounts/${accountId}/workers/scripts/demo-mcp`;
const fakeToken = "fake-cloudflare-token-never-a-real-secret";
// Tiny fixture standing in for the deployed bundle; not the real Worker source.
const workerBundleFixture = [
  `const authError = unauthorized(request, env);`,
  `if (!authorized(request, env)) { throw new Error("error: Unauthorized"); }`,
  `createMcpHandler(server); // /oauth/roblox/callback`,
  ``,
].join("\n");

function respond(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "GET" && req.url === `${scriptBase}/settings`) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      result: {
        bindings: [
          { type: "secret_text", name: "DEMO_API_KEY" },
          { type: "plain_text", name: "BROWSER_KEEPALIVE_MS", text: "300000" },
          { type: "plain_text", name: "BROWSER_PROVIDER", text: "cloudflare" },
          { type: "plain_text", name: "DEMO_PLATFORM_ORIGIN", text: "https://demo-platform.pages.dev" },
          { type: "plain_text", name: "OAUTH_STATE_TTL_SECONDS", text: "600" },
          { type: "plain_text", name: "ROBLOX_OAUTH_SCOPES", text: "openid profile" },
        ],
      },
    }));
    return;
  }
  if (req.method === "GET" && req.url === scriptBase) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(workerBundleFixture);
    return;
  }
  // Any other route — including the buggy `/content` — mirrors the API's 405.
  res.writeHead(405, { "content-type": "application/json" });
  res.end(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Method not allowed" }] }));
}

it("audit downloads the deployed Worker from the documented script endpoint", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? "GET", url: req.url ?? "/" });
    respond(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server did not report a port");
  try {
    const childEnv = { ...process.env };
    delete childEnv.GITHUB_ACTIONS; // keep the child's stdout to the plain JSON report
    childEnv.AUDIT_MOCK_ORIGIN = `http://127.0.0.1:${address.port}`;
    childEnv.CLOUDFLARE_ACCOUNT_ID = accountId;
    childEnv.CLOUDFLARE_API_TOKEN = fakeToken;

    // Async spawn (not spawnSync): the mock server lives in this process, and a
    // synchronous wait would block the event loop it needs to answer requests.
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(hookPath).href, scriptPath],
      { env: childEnv, cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", chunk => stdout.push(chunk as Buffer));
    child.stderr.on("data", chunk => stderr.push(chunk as Buffer));
    const [code, signal] = (await once(child, "close", { signal: AbortSignal.timeout(60_000) })) as [number, NodeJS.Signals | null];
    const result = {
      status: code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    };
    if (signal) throw new Error(`audit script was killed by ${signal}`);

    // The child's own error/success handling is the behavior under test; a
    // failure surfaces here with its assertion message on stderr.
    expect(result.stderr, `audit script failed: ${result.stderr}`).toBe("");
    expect(result.status, `audit script exited nonzero: ${result.stderr}`).toBe(0);

    // Exactly two read-only requests, settings first, then the script download
    // on the documented endpoint — and never the 405-prone `/content` route.
    expect(requests.map(request => `${request.method} ${request.url}`)).toEqual([
      `GET ${scriptBase}/settings`,
      `GET ${scriptBase}`,
    ]);

    // The settings-derived checks still ran and matched the fixture bindings.
    const report = JSON.parse(result.stdout);
    expect(report.importantVarsMatch).toEqual({
      BROWSER_KEEPALIVE_MS: true,
      BROWSER_PROVIDER: true,
      DEMO_PLATFORM_ORIGIN: true,
      OAUTH_STATE_TTL_SECONDS: true,
      ROBLOX_OAUTH_SCOPES: true,
    });
    expect(report.demoApiKeyConfigured).toBe(true);
    expect(report.bindingNames).toContain("DEMO_API_KEY");

    // The report is metadata only: no token, no bundle source.
    expect(result.stdout).not.toContain(fakeToken);
    expect(result.stdout).not.toContain("unauthorized(request, env)");
    expect(typeof report.downloadedContentSha256).toBe("string");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
});
