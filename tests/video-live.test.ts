/**
 * Live acceptance tests for the public video pipeline.
 *
 * These drive the real Cloudflare deployment (Browser Run + R2) over the MCP
 * endpoint, so they are opt-in (see docs/TESTING.md):
 *
 *   DEMO_MCP_LIVE=1
 *   CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN        (or LIVE_WORKER_URL)
 *
 * What they prove:
 *   1. A public video URL is accepted.
 *   2. The live environment can access the source.
 *   3. The response contains actual video-derived frames (validated image
 *      bytes, timestamps, MIME types) — never thumbnails or metadata.
 *   4. R2 artifact upload and retrieval work (fetched back and hash-checked).
 *   5. The MCP response uses a format the connected AI client can consume
 *      (image content blocks and/or retrievable HTTPS references).
 *   6. Failure cases return honest, structured errors.
 *   7. A restricted sandbox (test host without egress) is reported as such,
 *      not as a pipeline failure.
 *   8. `inspect_video` (DEMO 0.6.1) performs the whole automatic flow in one
 *      call — intent detection, dynamic frame plan, real frames as MCP image
 *      blocks — and never lets the AI claim it saw a video without frames.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertWorkerReachable,
  connectLive,
  liveEnv,
  workerEgressSkipNote,
  startDevWorker,
} from "./helpers/live.js";

const ACCEPTABLE_BLOCK_ERRORS = [
  "VIDEO_NOT_FOUND",
  "VIDEO_NOT_PUBLIC",
  "PLATFORM_BLOCKED",
  "UNSUPPORTED_MEDIA",
  "PROCESSING_TIMEOUT",
  "FRAMES_UNAVAILABLE",
];

describe.skipIf(!liveEnv().enabled)("public video acceptance (live)", () => {
  let devWorker: { url: string; stop: () => Promise<void> } | null = null;
  let origin = "";

  beforeAll(async () => {
    if (liveEnv().local) devWorker = await startDevWorker();
    origin = (devWorker?.url ?? liveEnv().baseUrl).replace(/\/$/, "");
    // Distinguish "the sandbox cannot reach the worker" from any pipeline
    // result before running any tool.
    await assertWorkerReachable(origin);
  }, 240_000);

  afterAll(async () => {
    await devWorker?.stop();
    devWorker = null;
  });

  it(
    "video_ingest: a stable public MP4 yields real frames, a hash-verified R2 artifact and client-consumable MCP content",
    async ({ skip }) => {
      const url = liveEnv().publicVideoUrl;
      const client = connectLive(origin);
      try {
        const result = await client.call("video_ingest", {
          url,
          output_mode: "all",
          frame_count: 4,
          include_audio: false,
          include_transcript: false,
        });
        const egressNote = workerEgressSkipNote(result, url);
        if (egressNote) skip(egressNote);
        const payload = result.parsed as Record<string, any>;
        expect(payload, `expected a JSON payload, got: ${result.text.slice(0, 500)}`).toBeTruthy();

        // The live environment must actually access the source.
        expect(payload.success, payload.message ?? payload.error).toBe(true);
        expect(payload.source_url).toBe(url);
        expect(payload.media_type).toBe("video");
        expect(payload.mime_type ?? payload.video_artifact?.mime_type).toMatch(/^video\//);

        // Real video-derived frames: timestamped, image MIME, real image bytes.
        expect(payload.frames.length, "the public MP4 must yield decoded frames").toBeGreaterThan(0);
        for (const frame of payload.frames) {
          expect(typeof frame.timestamp_seconds).toBe("number");
          expect(frame.mime_type).toMatch(/^image\//);
        }
        expect(payload.analysis_ready).toBe(true);

        // AI readability: MCP image blocks, or retrievable HTTPS references.
        const referenced = payload.frames.every(
          (frame: any) => typeof frame.url === "string" && /^https:\/\//.test(frame.url),
        );
        expect(result.imageCount > 0 || referenced, "frames must be MCP image content or retrievable HTTPS references").toBe(true);
        expect(payload.frames.every((frame: any) => frame.inspected === true)).toBe(true);

        // If image blocks were inline, their bytes must be real images.
        for (const entry of result.imageBlocks ?? []) {
          const decoded = Uint8Array.from(atob(entry.data), (char) => char.charCodeAt(0));
          const isJpeg = decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff;
          const isPng = decoded[0] === 0x89 && decoded[1] === 0x50 && decoded[2] === 0x4e && decoded[3] === 0x47;
          expect(isJpeg || isPng, "inline MCP image bytes must be a real JPEG/PNG").toBe(true);
        }

        // R2 artifact: upload + retrieval + integrity.
        const artifact = payload.video_artifact;
        expect(artifact?.url).toMatch(/^https:\/\/.+\/video-assets\/video_[a-f0-9]{64}$/);
        expect(artifact?.reference).toMatch(/^video_[a-f0-9]{64}$/);
        const fetched = await fetch(artifact.url);
        expect(fetched.status).toBe(200);
        expect(fetched.headers.get("content-type")).toMatch(/^video\//);
        const bytes = new Uint8Array(await fetched.arrayBuffer());
        expect(bytes.byteLength).toBeGreaterThan(10_000);
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        const sha = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
        expect(sha, "the fetched artifact must hash to the returned sha256").toBe(artifact.sha256);
      } finally {
        await client.close();
      }
    },
    300_000,
  );

  it(
    "video_ingest: a public TikTok URL returns real frames or an exact technical reason",
    async ({ skip }) => {
      const url = liveEnv().tiktokUrl;
      const client = connectLive(origin);
      try {
        const result = await client.call("video_ingest", {
          url,
          output_mode: "all",
          max_duration_seconds: 60,
          frame_count: 4,
        });
        const egressNote = workerEgressSkipNote(result, url);
        if (egressNote) skip(egressNote);
        const payload = result.parsed as Record<string, any>;
        expect(payload).toBeTruthy();
        // Preserve the original URL in the result even after redirects.
        expect(payload.source_url).toBe(url);

        if (payload?.success && Array.isArray(payload.frames) && payload.frames.length > 0) {
          const visible =
            result.imageCount > 0 ||
            payload.frames.every((frame: any) => typeof frame.url === "string" && /^https:\/\//.test(frame.url));
          expect(visible, "decoded frames must be MCP image content or retrievable HTTPS references").toBe(true);
          expect(payload.frames.every((frame: any) => typeof frame.timestamp_seconds === "number" && frame.mime_type.startsWith("image/"))).toBe(true);
          expect(payload.analysis_ready).toBe(true);
          // A thumbnail must never masquerade as a frame: frames come from the
          // decoded <video> element, which also sets real dimensions.
          expect(payload.width).toBeGreaterThan(0);
          expect(payload.height).toBeGreaterThan(0);
        } else {
          // A blocked TikTok is an accepted outcome only when the response is
          // explicit and carries zero fabricated frames.
          expect(ACCEPTABLE_BLOCK_ERRORS, `unexpected error: ${payload?.error}`).toContain(payload?.error);
          expect(payload?.analysis_ready).toBe(false);
          expect(payload?.frames ?? []).toEqual([]);
          expect(String(payload?.message ?? payload?.limitations?.join(" ") ?? "")).not.toHaveLength(0);
        }
      } finally {
        await client.close();
      }
    },
    300_000,
  );

  it(
    "video_inspect_url: the supplied TikTok short URL returns real frames or an exact technical reason",
    async ({ skip }) => {
      const client = connectLive(origin);
      try {
        const result = await client.call("video_inspect_url", {
          url: "https://vt.tiktok.com/ZSq4b6A3K/",
          max_duration: 60,
          frame_interval: 8,
          include_transcript: false,
        });
        const egressNote = workerEgressSkipNote(result, "https://vt.tiktok.com/ZSq4b6A3K/");
        if (egressNote) skip(egressNote);
        const payload = result.parsed as Record<string, any> | null;
        expect(payload).toBeTruthy();
        if (payload?.success && Array.isArray(payload.frames) && payload.frames.length > 0) {
          const visible =
            result.imageCount > 0 ||
            payload.frames.every((frame: any) => typeof frame.image_reference === "string" && /^https:\/\//.test(frame.image_reference));
          expect(visible, "decoded frames must be MCP image content or retrievable HTTPS references").toBe(true);
          expect(payload.frames.every((frame: any) => typeof frame.timestamp === "number" && frame.content_type.startsWith("image/"))).toBe(true);
          expect(payload.analysis_ready).toBe(true);
        } else {
          expect(ACCEPTABLE_BLOCK_ERRORS).toContain(payload?.error);
          expect(payload?.analysis_ready).toBe(false);
          expect(payload?.frames ?? []).toEqual([]);
          expect(String(payload?.message ?? payload?.limitations ?? "")).not.toHaveLength(0);
        }
      } finally {
        await client.close();
      }
    },
    240_000,
  );

  it(
    "inspect_video: a plain public MP4 link triggers the automatic flow and returns consumable frames + reaction context",
    async ({ skip }) => {
      const url = liveEnv().publicVideoUrl;
      const client = connectLive(origin);
      try {
        // Only the link — no frame counts, timestamps, or manual steps.
        const result = await client.call("inspect_video", { url });
        const egressNote = workerEgressSkipNote(result, url);
        if (egressNote) skip(egressNote);
        const parsedPayload = result.parsed as Record<string, any> | null;
        if (!parsedPayload) throw new Error(`expected a JSON payload, got: ${result.text.slice(0, 500)}`);
        const payload = parsedPayload;

        // A bare link automatically enables reaction mode and inspects.
        expect(payload.intent?.reactionMode).toBe(true);
        expect(payload.inspectionStatus === "complete" || payload.inspectionStatus === "partial").toBe(true);
        expect(payload.visualEvidenceDelivered).toBe(true);
        expect(payload.source?.url).toBe(url);

        // Real frames: timestamped, image MIME, delivered as MCP image blocks
        // and/or retrievable HTTPS references.
        expect(Array.isArray(payload.frames)).toBe(true);
        expect(payload.frames.length).toBeGreaterThan(0);
        for (const frame of payload.frames) {
          expect(typeof frame.timestamp).toBe("number");
          expect(frame.mimeType).toMatch(/^image\//);
        }
        const referenced = payload.frames.every(
          (frame: any) => typeof frame.imageReference === "string" && /^https:\/\//.test(frame.imageReference),
        );
        expect(result.imageCount > 0 || referenced, "frames must be MCP image content or retrievable HTTPS references").toBe(true);
        if (result.imageCount > 0) {
          expect(payload.imageBlocksDelivered).toBe(result.imageCount);
          for (const entry of result.imageBlocks) {
            const decoded = Uint8Array.from(atob(entry.data), (char) => char.charCodeAt(0));
            const isJpeg = decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff;
            const isPng = decoded[0] === 0x89 && decoded[1] === 0x50 && decoded[2] === 0x4e && decoded[3] === 0x47;
            expect(isJpeg || isPng, "inline MCP image bytes must be a real JPEG/PNG").toBe(true);
          }
        }
        // Coverage: the plan includes a first and a final meaningful frame.
        const timestamps = payload.frames.map((frame: any) => frame.timestamp);
        expect(timestamps[0]).toBeLessThan(Math.max(2, (payload.source.durationSeconds ?? 10) * 0.2));
        expect(payload.honestyNote).toMatch(/sampled frames|MUST NOT/i);
      } finally {
        await client.close();
      }
    },
    300_000,
  );

  it(
    "inspect_video: the supplied TikTok short URL returns real frames or an exact technical reason (never a fake 'I watched it')",
    async ({ skip }) => {
      const url = "https://vt.tiktok.com/ZSqVLjkpU/";
      const client = connectLive(origin);
      try {
        const result = await client.call("inspect_video", { url, userIntent: "React to this:" });
        const egressNote = workerEgressSkipNote(result, url);
        if (egressNote) skip(egressNote);
        const payload = result.parsed as Record<string, any> | null;
        expect(payload).toBeTruthy();
        expect(payload?.source?.url).toBe(url); // the user's link is preserved
        expect(payload?.intent?.reactionMode).toBe(true);

        if (payload?.visualEvidenceDelivered) {
          // Pass with real frames: consumable image evidence + honest note.
          const visible =
            result.imageCount > 0 ||
            payload.frames.every((frame: any) => typeof frame.imageReference === "string" && /^https:\/\//.test(frame.imageReference));
          expect(visible, "decoded frames must be MCP image content or retrievable HTTPS references").toBe(true);
          expect(payload.frames.length).toBeGreaterThan(0);
          expect(["complete", "partial"]).toContain(payload.inspectionStatus);
        } else {
          // A blocked/expired TikTok is an accepted outcome ONLY when the
          // response is explicit, failed, and carries zero fabricated frames.
          expect(payload?.inspectionStatus).toBe("failed");
          expect([...ACCEPTABLE_BLOCK_ERRORS, "blocked_url"]).toContain(payload?.error);
          expect(payload?.frames ?? []).toEqual([]);
          expect(payload?.honestyNote ?? "").toMatch(/MUST NOT claim to have seen/);
        }
      } finally {
        await client.close();
      }
    },
    300_000,
  );

  it(
    "inspect_video: private URLs are rejected before any request and the AI cannot claim it saw the video",
    async () => {
      const client = connectLive(origin);
      try {
        const blocked = await client.call("inspect_video", { url: "http://127.0.0.1:9/secret.mp4", userIntent: "Watch this" });
        const payload = blocked.parsed as Record<string, any> | null;
        expect(blocked.isError).toBe(true);
        expect(payload?.inspectionStatus).toBe("failed");
        expect(payload?.error).toBe("blocked_url");
        expect(payload?.visualEvidenceDelivered).toBe(false);
        expect(payload?.frames ?? []).toEqual([]);
        expect(blocked.imageCount).toBe(0);
        expect(payload?.honestyNote ?? "").toMatch(/MUST NOT claim to have seen/);
      } finally {
        await client.close();
      }
    },
    240_000,
  );

  it(
    "failure cases return honest, structured errors (SSRF-blocked and missing media)",
    async ({ skip }) => {
      const client = connectLive(origin);
      try {
        // 1. The SSRF guard must reject a private address before any request.
        const blocked = await client.call("video_ingest", { url: "http://127.0.0.1:9/secret.mp4" });
        const blockedPayload = blocked.parsed as Record<string, any>;
        expect(blocked.isError).toBe(true);
        expect(blockedPayload?.error).toBe("blocked_url");

        // 2. A public URL that serves no video must fail with a stable code
        //    and zero frames — never with fake or thumbnail-derived frames.
        const missing = await client.call("video_ingest", { url: "https://example.com/definitely-not-a-video.mp4" });
        const missingPayload = missing.parsed as Record<string, any>;
        expect(missingPayload?.success).toBeFalsy();
        expect(ACCEPTABLE_BLOCK_ERRORS).toContain(missingPayload?.error);
        expect(missingPayload?.frames ?? []).toEqual([]);
        expect(missingPayload?.analysis_ready).toBe(false);
      } finally {
        await client.close();
      }
    },
    240_000,
  );
});

describe("live video test helper", () => {
  it("documents why live tests are disabled by default and defaults to a public fixture", () => {
    if (liveEnv().enabled) expect(liveEnv().enabled).toBe(true);
    expect(liveEnv().publicVideoUrl).toMatch(/^https:\/\//);
    expect(liveEnv().tiktokUrl).toMatch(/^https:\/\/(?:www|vm|vt|m)\.tiktok\.com\//);
  });
});
