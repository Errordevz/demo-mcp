// Test-only preload hook, loaded in the audit-script child process via
// `node --import`. It rewrites fetches aimed at the Cloudflare API so they hit
// a local mock server instead of the real network, and forbids every other
// outbound fetch. Records nothing itself; the mock server records requests.
const target = process.env.AUDIT_MOCK_ORIGIN;
if (!target) throw new Error("AUDIT_MOCK_ORIGIN must point at the local mock server");
const mockOrigin = new URL(target).origin;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === "https://api.cloudflare.com") {
    url.protocol = mockOrigin.split(":")[0];
    url.host = mockOrigin.split("//")[1];
    return realFetch(url, init);
  }
  return Promise.reject(new Error(`audit test forbids non-Cloudflare fetch to ${url.origin}`));
};
