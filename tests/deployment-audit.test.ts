// Regression test for scripts/audit-mcp-deployment.mjs.
//
// Cloudflare's documented Worker download endpoint is
//   GET /accounts/{account_id}/workers/scripts/{name}
// while `/content` is not a valid route and returns HTTP 405. The test runs the
// real audit script against a local mock of the Cloudflare API and asserts the
// current MCP OAuth/Access/Roblox-encryption checks without printing secrets or
// downloaded source.
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
  `createMcpHandler(server);`,
  `function requireMcpScope() { return "decision:use"; }`,
  `securitySchemes`,
  `oauth-protected-resource`,
  `CF-Access-Jwt-Assertion`,
  `/oauth/roblox/callback`,
  `ROBLOX_TOKEN_KEY`,
].join("\n");

function respond(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "GET" && req.url === `${scriptBase}/settings`) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      result: {
        bindings: [
          { type: "durable_object_namespace", name: "MCP_AUTH" },
          { type: "durable_object_namespace", name: "ROBLOX_AUTH" },
          { type: "secret_text", name: "ROBLOX_CLIENT_SECRET" },
          { type: "secret_text", name: "ROBLOX_TOKEN_KEY" },
          { type: "plain_text", name: "BROWSER_KEEPALIVE_MS", text: "300000" },
          { type: "plain_text", name: "BROWSER_PROVIDER", text: "cloudflare" },
          { type: "plain_text", name: "DEMO_PLATFORM_ORIGIN", text: "https://demo-platform.pages.dev" },
          { type: "plain_text", name: "MCP_PUBLIC_ORIGIN", text: "https://demo-mcp.amidevz.workers.dev" },
          { type: "plain_text", name: "MCP_AUTH_ACCESS_TEAM_DOMAIN", text: "<your-team>.cloudflareaccess.com" },
          { type: "plain_text", name: "MCP_AUTH_ACCESS_AUD", text: "<your-cloudflare-access-application-aud-tag>" },
          { type: "plain_text", name: "MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS", text: "900" },
          { type: "plain_text", name: "MCP_AUTH_RATE_LIMIT_PER_MINUTE", text: "30" },
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

it("audits the deployed Worker from the documented script endpoint without revealing credentials or code", async () => {
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
    delete childEnv.GITHUB_ACTIONS;
    childEnv.AUDIT_MOCK_ORIGIN = `http://127.0.0.1:${address.port}`;
    childEnv.CLOUDFLARE_ACCOUNT_ID = accountId;
    childEnv.CLOUDFLARE_API_TOKEN = fakeToken;

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

    expect(result.stderr, `audit script failed: ${result.stderr}`).toBe("");
    expect(result.status, `audit script exited nonzero: ${result.stderr}`).toBe(0);
    expect(requests.map(request => `${request.method} ${request.url}`)).toEqual([
      `GET ${scriptBase}/settings`,
      `GET ${scriptBase}`,
    ]);

    const report = JSON.parse(result.stdout);
    expect(report.importantVarsMatch).toEqual({
      BROWSER_KEEPALIVE_MS: true,
      BROWSER_PROVIDER: true,
      DEMO_PLATFORM_ORIGIN: true,
      MCP_PUBLIC_ORIGIN: true,
      MCP_AUTH_ACCESS_TEAM_DOMAIN: true,
      MCP_AUTH_ACCESS_AUD: true,
      MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS: true,
      MCP_AUTH_RATE_LIMIT_PER_MINUTE: true,
      OAUTH_STATE_TTL_SECONDS: true,
      ROBLOX_OAUTH_SCOPES: true,
    });
    expect(report.bindingNames).toContain("MCP_AUTH");
    expect(report.bindingNames).toContain("ROBLOX_AUTH");
    expect(report.bindingNames).toContain("ROBLOX_TOKEN_KEY");
    expect(report.codeMarkers).toEqual({
      mcpTransport: true,
      perToolOAuth: true,
      securitySchemes: true,
      protectedResourceMetadata: true,
      accessIdentityVerifier: true,
      robloxOAuthCallback: true,
      robloxTokenEncryption: true,
    });
    expect(result.stdout).not.toContain(fakeToken);
    expect(result.stdout).not.toContain("requireMcpScope");
    expect(typeof report.downloadedContentSha256).toBe("string");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
});
