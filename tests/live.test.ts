import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectLive, liveEnv, LIVE_SKIP_REASON, skipIfUnavailable, startDevWorker } from "./helpers/live.js";

/**
 * Live tests drive the real Cloudflare Browser Rendering service. They only run
 * when all of the following are set:
 *
 *   DEMO_MCP_LIVE=1
 *   CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN
 *   a public LIVE_WORKER_URL or local Wrangler credentials
 *
 * The Worker must be deployed with the `BROWSER` (Browser Run), `SCREENSHOTS`
 * (R2) and `BROWSER_SESSIONS` (Durable Object) bindings. On a Workers Free plan
 * the service is limited to 3 concurrent sessions, 1 new session per 20 seconds
 * and 10 browser-minutes per day, so the suite is deliberately small.
 */
describe.skipIf(!liveEnv().enabled)("live Cloudflare browser", () => {
  let devWorker: { url: string; stop: () => Promise<void> } | null = null;

  beforeAll(async () => {
    if (liveEnv().local) devWorker = await startDevWorker();
  }, 180_000);

  afterAll(async () => {
    await devWorker?.stop();
    devWorker = null;
  });

  it(
    "opens a public page, screenshots it and reads it back",
    async ({ skip }) => {
      const client = connectLive(devWorker?.url);
      try {
        const opened = await client.call("browser_open", { url: "https://example.com/", wait_until: "load" });
        skipIfUnavailable(opened, "browser_open", skip);
        const payload = opened.parsed as { session: { id: string }; page: { id: string; finalUrl: string; title: string } };
        expect(payload.page.finalUrl).toMatch(/example\.com/);
        expect(payload.page.title.length).toBeGreaterThan(0);

        const shot = await client.call("browser_screenshot", { session_id: payload.session.id, full_page: true });
        expect(shot.isError).toBeFalsy();
        const shotPayload = shot.parsed as { screenshot: { id: string; url?: string; bytes: number; key: string } };
        expect(shotPayload.screenshot.bytes).toBeGreaterThan(1000);
        expect(shotPayload.screenshot.key).toMatch(/^screenshots\/[a-f0-9]{32,}\.png$/);

        if (shotPayload.screenshot.url) {
          const response = await fetch(shotPayload.screenshot.url);
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toMatch(/^image\//);
        }

        const read = await client.call("browser_read", { session_id: payload.session.id, max_text_chars: 2000 });
        expect(read.text).toMatch(/example/i);

        const snapshot = await client.call("browser_snapshot", { session_id: payload.session.id, kind: "accessibility" });
        expect(snapshot.text.length).toBeGreaterThan(20);

        const capabilities = await client.call("browser_capabilities", {});
        const caps = capabilities.parsed as Record<string, unknown>;
        expect(caps.browserAvailable).toBe(true);
      } finally {
        await client.close().catch(() => undefined);
      }
    },
    180_000,
  );

  it(
    "resolves a TikTok short link and reports honestly",
    async ({ skip }) => {
      const env = liveEnv();
      const client = connectLive(devWorker?.url);
      try {
        const result = await client.call("browser_open", {
          url: env.tiktokUrl,
          wait_until: "domcontentloaded",
          wait_for_network_idle: true,
        });
        skipIfUnavailable(result, "browser_open", skip);
        const payload = result.parsed as { page: { finalUrl: string }; challenge?: { required: boolean; status: string } };
        expect(payload.page.finalUrl).toMatch(/tiktok\.com/);

        const media = await client.call("browser_media_info", { session_id: (result.parsed as { session: { id: string } }).session.id });
        skipIfUnavailable(media, "browser_media_info", skip);
        const mediaPayload = media.parsed as { platform: string; limitations: string[]; tiktok: unknown | null };
        expect(mediaPayload.platform).toBe("tiktok");
        // Whether or not TikTok served the video, the report must be explicit
        // about what it could and could not see.
        expect(Array.isArray(mediaPayload.limitations)).toBe(true);
        if (!mediaPayload.tiktok) {
          expect(mediaPayload.limitations.join(" ")).toMatch(/verification|login|not expose|no/i);
        }
      } finally {
        await client.close().catch(() => undefined);
      }
    },
    240_000,
  );
});

describe("live test helper", () => {
  it("documents why live tests are disabled by default", () => {
    if (liveEnv().enabled) expect(LIVE_SKIP_REASON).toBeNull();
    else expect(LIVE_SKIP_REASON).toMatch(/DEMO_MCP_LIVE/);
  });
});
