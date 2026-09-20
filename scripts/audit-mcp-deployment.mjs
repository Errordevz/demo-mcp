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
  OAUTH_STATE_TTL_SECONDS: "600",
  ROBLOX_OAUTH_SCOPES: "openid profile",
};
const report = {
  worker: "demo-mcp",
  bindingNames: bindings.map(binding => binding.name).sort(),
  demoApiKeyConfigured: bindings.some(binding => binding.name === "DEMO_API_KEY"),
  importantVarsMatch: Object.fromEntries(Object.entries(expected).map(([name, value]) => [name, bindings.find(binding => binding.name === name)?.text === value])),
  // Wrangler's unminified production bundle retains these route guard names.
  // These are evidence markers, not a claim of executing the deployed code.
  codeMarkers: {
    platformTransportGuard: /authError\s*=\s*unauthorized\(request,\s*env\)/.test(content),
    workerTransportGuard: /if\s*\(!authorized\(request,\s*env\)\)/.test(content),
    unauthorizedResponse: /error:\s*["']Unauthorized["']/.test(content),
    mcpTransport: content.includes("createMcpHandler"),
    robloxOAuthCallback: content.includes("/oauth/roblox/callback"),
  },
  downloadedContentSha256: createHash("sha256").update(content).digest("hex"),
};
console.log(JSON.stringify(report, null, 2));
if (process.env.GITHUB_ACTIONS) console.log(`::notice title=MCP deployment audit::${JSON.stringify(report)}`);
