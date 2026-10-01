// Read-only production audit, intended for the existing authenticated CI runner.
// Output is limited to binding NAMES, expected-value comparisons and code markers.
// Never print the API response, deployed bundle, credentials or binding values.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
assert(account && token, "Cloudflare deployment credentials are required in the runner");
const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers/scripts/demo-mcp`;
async function get(path) {
  const response = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  assert(response.ok, `Cloudflare read-only audit ${path}: HTTP ${response.status}`);
  return response;
}
const settings = await (await get("/settings")).json();
assert.equal(settings.success, true, "Cloudflare settings audit failed");
const bindings = settings.result.bindings;
assert(Array.isArray(bindings));
const content = await (await get("")).text();
const expected = {
  BROWSER_KEEPALIVE_MS: "300000",
  BROWSER_PROVIDER: "cloudflare",
  DEMO_PLATFORM_ORIGIN: "https://demo-platform.pages.dev",
  MCP_PUBLIC_ORIGIN: "https://demo-mcp.amidevz.workers.dev",
  MCP_AUTH_ACCESS_TEAM_DOMAIN: "<your-team>.cloudflareaccess.com",
  MCP_AUTH_ACCESS_AUD: "<your-cloudflare-access-application-aud-tag>",
  MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "900",
  MCP_AUTH_RATE_LIMIT_PER_MINUTE: "30",
};
const report = {
  worker: "demo-mcp",
  bindingNames: bindings.map(binding => binding.name).sort(),
  importantVarsMatch: Object.fromEntries(Object.entries(expected).map(([name, value]) => [name, bindings.find(binding => binding.name === name)?.text === value])),
  // Wrangler's unminified production bundle retains these policy markers.
  // These are evidence markers, not a claim of executing the deployed code.
  codeMarkers: {
    mcpTransport: content.includes("createMcpHandler"),
    perToolOAuth: content.includes("requireMcpScope"),
    securitySchemes: content.includes("securitySchemes"),
    protectedResourceMetadata: content.includes("oauth-protected-resource"),
    accessIdentityVerifier: content.includes("CF-Access-Jwt-Assertion"),
  },
  downloadedContentSha256: createHash("sha256").update(content).digest("hex"),
};
console.log(JSON.stringify(report, null, 2));
if (process.env.GITHUB_ACTIONS) console.log(`::notice title=MCP deployment audit::${JSON.stringify(report)}`);
