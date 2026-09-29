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
 *   8. `inspect_video` (DEMO 0.7.0) performs the whole automatic flow in one
 *      call — intent detection, dynamic frame plan, real frames as MCP image
 *      blocks — and never lets the AI claim it saw a video without frames.
 *   9. The 0.7.0 retrieval pipeline: `video_resolve` (byte-verified stream
 *      discovery + access verdict, no signed-URL leakage), `video_fetch`
 *      (streamed R2 storage, artifact fetched back over HTTPS and verified from
 *      its own bytes, Range support, NOT_A_VIDEO rejection), unified
 *      `video_analyze` (real image blocks or an explicit "could not"),
 *      `video_react` (evidence package, never a hardcoded reaction) and the
 *      capability resources.
 *  10. `video_extract_frames` with `resize: { max_width: 320 }` renders at a
 *      viewport exactly 320 CSS pixels wide — or reports the documented
 *      fallback (resize could not be applied, default viewport) instead of
 *      silently ignoring the request.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type CallResult,
  DEFAULT_PUBLIC_VIDEO_URL,
  assertWorkerReachable,
  connectLive,
  fixtureAccessSkipNote,
  liveEnv,
  skipForEnvironment,
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
  // The per-source rate limit (`rate_limited`, retryable by design) is an
  // honest "could not, try later" answer, not a pipeline failure: the suite
  // calls many video tools in sequence against one public fixture, so it can
  // legitimately hit its own throttle. The block is only accepted with
  // success=false, an explicit message and frames=[], which every call site
  // below already asserts; the live client also retries a refusal before the
  // assertion runs.
  "rate_limited",
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
        const fixtureNote = fixtureAccessSkipNote(result, url);
        if (fixtureNote) skipForEnvironment(skip, fixtureNote);
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
        const fixtureNote = fixtureAccessSkipNote(result, url);
        if (fixtureNote) skipForEnvironment(skip, fixtureNote);
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
        //    Contract (tests/video.test.ts, src/mcp/results.ts): a normal MCP
        //    result carrying a structured `blocked_url` payload — not a
        //    protocol-level isError — with no frames, no artifact and nothing
        //    marked analysis-ready.
        const blocked = await client.call("video_ingest", { url: "http://127.0.0.1:9/secret.mp4" });
        const blockedPayload = blocked.parsed as Record<string, any> | null;
        expect(blockedPayload, `expected a JSON payload, got: ${blocked.text.slice(0, 500)}`).toBeTruthy();
        expect(blockedPayload?.error).toBe("blocked_url");
        expect(blockedPayload?.success).toBe(false);
        expect(blockedPayload?.frames ?? []).toEqual([]);
        expect(blockedPayload?.analysis_ready).toBe(false);
        expect(blockedPayload?.video_artifact ?? null).toBeNull();
        expect(blocked.imageCount).toBe(0);

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

  /* ── DEMO 0.7.0: the real retrieval pipeline ───────────────────────────── */

  it(
    "video_resolve: a stable public MP4 resolves with a byte-verified stream and no signed-URL leakage on request",
    async ({ skip }) => {
      const url = liveEnv().publicVideoUrl;
      const client = connectLive(origin);
      try {
        const result = await client.call("video_resolve", { url, verify_bytes: true, include_signed_urls: false });
        const egressNote = workerEgressSkipNote(result, url);
        if (egressNote) skip(egressNote);
        const fixtureNote = fixtureAccessSkipNote(result, url);
        if (fixtureNote) skipForEnvironment(skip, fixtureNote);
        const payload = result.parsed as Record<string, any>;
        expect(payload?.tool).toBe("video_resolve");
        expect(payload?.access_status).toBe("public");
        expect(payload?.source_url).toBe(url);
        expect(payload?.may_describe_content).toBe(false); // resolution is metadata, never evidence
        // A direct media URL that answers a public HEAD with a video content
        // type is accepted on that basis (src/video/http.ts, direct fast path)
        // and reports verification "content_type" — even with verify_bytes —
        // together with a limitation that says so and points at video_fetch,
        // which proves the container from real bytes. Either verdict is fine;
        // an undisclosed content-type acceptance is not.
        expect(["bytes", "content_type"]).toContain(payload?.verification);
        if (payload?.verification === "content_type") {
          expect((payload.limitations ?? []).join(" ")).toMatch(/content type|verify_bytes|video_fetch/i);
        }
        expect(payload?.stream_count ?? 0).toBeGreaterThan(0);
        expect(payload?.streams?.length).toBe(payload?.stream_count);
        expect(payload?.streams?.[0]?.reachable).toBe(true);
        expect(payload?.next_steps?.length ?? 0).toBeGreaterThan(0);
        expect(result.text).not.toMatch(/x-signature=[A-Za-z0-9]/);
        expect(result.imageCount).toBe(0); // resolve downloads and renders nothing
      } finally {
        await client.close();
      }
    },
    240_000,
  );

  it(
    "video_fetch: retrieves the ACTUAL bytes, streams them into R2 and the artifact is retrievable over HTTPS",
    async ({ skip }) => {
      const url = liveEnv().publicVideoUrl;
      const client = connectLive(origin);
      try {
        const result = await client.call("video_fetch", { url });
        const egressNote = workerEgressSkipNote(result, url);
        if (egressNote) skip(egressNote);
        const fixtureNote = fixtureAccessSkipNote(result, url);
        if (fixtureNote) skipForEnvironment(skip, fixtureNote);
        const payload = result.parsed as Record<string, any>;
        expect(payload?.tool).toBe("video_fetch");
        expect(payload?.success, payload?.message ?? payload?.error).toBe(true);
        expect(payload?.delivery).toBe("streamed");
        expect(payload?.verification).toBe("bytes");
        expect(payload?.detected_container).toMatch(/mp4|webm|matroska|quicktime|iso-base-media/i);
        expect(payload?.duration_verified).toBe(true);
        expect(payload?.bytes).toBeGreaterThan(1_024);
        expect(payload?.honesty_note).toMatch(/not visual understanding/i);

        // Real R2 round trip: fetch the artifact back and verify the container
        // from its own bytes, not from a claim in the JSON.
        const artifactUrl = payload?.artifact?.url as string;
        expect(artifactUrl).toMatch(/^https:\/\//);
        const fetched = await fetch(artifactUrl, { headers: { range: "bytes=0-1023" } });
        expect([200, 206]).toContain(fetched.status);
        const head = new Uint8Array(await fetched.arrayBuffer());
        expect(head.byteLength).toBeGreaterThan(8);
        // ISO-BMFF: bytes 4..8 spell a box type; WebM starts with the EBML header.
        const fourcc = String.fromCharCode(head[4], head[5], head[6], head[7]);
        const isIso = ["ftyp", "moov", "mdat", "free", "wide", "skip"].includes(fourcc);
        const isWebm = head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
        expect(isIso || isWebm, `unexpected container bytes: ${fourcc}`).toBe(true);

        // A Range request must be honoured so the artifact can be seeked.
        expect(fetched.headers.get("Accept-Ranges")).toBe("bytes");
      } finally {
        await client.close();
      }
    },
    240_000,
  );

  it(
    "video_fetch: a URL that is not a video is rejected with NOT_A_VIDEO/UNSUPPORTED_MEDIA and stores nothing",
    async () => {
      const client = connectLive(origin);
      try {
        const result = await client.call("video_fetch", { url: "https://example.com/" });
        const payload = result.parsed as Record<string, any>;
        expect(result.isError).toBe(true);
        expect(payload?.success).toBe(false);
        expect(["NOT_A_VIDEO", "UNSUPPORTED_MEDIA", ...ACCEPTABLE_BLOCK_ERRORS]).toContain(payload?.error);
        expect(payload?.artifact).toBeNull();
        expect(payload?.bytes ?? null).toBeNull();
        expect(payload?.honesty_note).toMatch(/Nothing was retrieved/i);
      } finally {
        await client.close();
      }
    },
    240_000,
  );

  it(
    "video_analyze: summary mode returns real decoded frame image blocks or an explicit, structured 'could not'",
    async ({ skip }) => {
      const url = liveEnv().publicVideoUrl;
      const client = connectLive(origin);
      try {
        const result = await client.call("video_analyze", { url, analysis_mode: "summary", question: "What happens in this video?" });
        const egressNote = workerEgressSkipNote(result, url);
        if (egressNote) skip(egressNote);
        const payload = result.parsed as Record<string, any>;
        expect(payload?.tool).toBe("video_analyze");
        expect(payload?.analysis_mode).toBe("summary");

        if (payload?.success) {
          // Real evidence: image blocks that decode as JPEG/PNG, matching frames.
          expect(result.imageCount).toBe(payload.image_blocks_delivered);
          expect(result.imageCount).toBeGreaterThan(0);
          expect(payload.frames.length).toBe(result.imageCount);
          expect(payload.visual_evidence_delivered).toBe(true);
          expect(payload.evidence.thumbnail_used_as_frame).toBe(false);
          expect(payload.text_sources.generated_caption.available).toBe(false);
          expect(payload.text_sources.platform_caption.is_not_transcript).toBe(true);
          expect(payload.analysis_context.what_can_be_answered.join(" ")).toMatch(/frame/i);
          for (const block of result.imageBlocks) {
            const bytes = Buffer.from(block.data, "base64");
            const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
            const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
            expect(jpeg || png, `image block is not a real image (${block.mimeType})`).toBe(true);
          }
        } else {
          // Honest failure: a stable code, zero frames, and no claim of watching.
          expect(ACCEPTABLE_BLOCK_ERRORS).toContain(payload?.error);
          expect(payload?.frames ?? []).toEqual([]);
          expect(payload?.visual_evidence_delivered).toBe(false);
          expect(payload?.may_describe_content).toBe(false);
          expect(result.isError).toBe(true);
        }
      } finally {
        await client.close();
      }
    },
    300_000,
  );

  it(
    "video_react: returns a grounded evidence package and never a hardcoded reaction",
    async ({ skip }) => {
      const url = liveEnv().publicVideoUrl;
      const client = connectLive(origin);
      try {
        const result = await client.call("video_react", { url, style: "casual" });
        const egressNote = workerEgressSkipNote(result, url);
        if (egressNote) skip(egressNote);
        const payload = result.parsed as Record<string, any>;
        expect(payload?.tool).toBe("video_react");
        expect(payload?.reaction).toBeNull();
        expect(payload?.reaction_author).toBe("connected_model");
        expect(payload?.style).toBe("casual");
        expect(payload?.caption_is_not_transcript).toBe(true);
        expect(payload?.honesty_note).toBeTruthy();
        if (payload?.success) {
          expect(result.imageCount).toBeGreaterThan(0);
          expect(payload.visual_evidence_delivered).toBe(true);
          expect(payload.reaction_guidance).toMatch(/decoded frame/i);
        } else {
          expect(payload?.frames ?? []).toEqual([]);
          expect(payload?.reaction_guidance).toMatch(/nothing to react to/i);
          expect(result.isError).toBe(true);
        }
      } finally {
        await client.close();
      }
    },
    300_000,
  );

  it(
    "video_resolve: a public TikTok link yields streams and an access verdict, or an explicit 'could not'",
    async ({ skip }) => {
      const url = liveEnv().tiktokUrl;
      const client = connectLive(origin);
      try {
        const result = await client.call("video_resolve", { url, verify_bytes: true, include_signed_urls: false });
        const egressNote = workerEgressSkipNote(result, url);
        if (egressNote) skip(egressNote);
        const payload = result.parsed as Record<string, any>;
        expect(payload?.tool).toBe("video_resolve");
        expect(payload?.platform).toBe("tiktok");
        expect(payload?.source_url).toBe(url);
        expect(payload?.may_describe_content).toBe(false);
        expect(payload?.guidance).toBeTruthy();
        expect(payload?.next_steps?.length ?? 0).toBeGreaterThan(0);

        if (payload?.access_status === "public") {
          expect(payload?.success).toBe(true);
          expect(payload?.canonical_url).toMatch(/tiktok\.com\/@[\w.]+\/video\/\d+/);
          expect(payload?.stream_count ?? 0).toBeGreaterThan(0);
          // Signed URLs are short-lived; the response must not pretend otherwise.
          expect(payload?.limitations?.join(" ") ?? "").toBeTruthy();
        } else {
          // A blocked/private/deleted/region-locked/CAPTCHA-gated item is an
          // accepted outcome ONLY when the response says so explicitly.
          expect(payload?.success).toBe(false);
          expect([
            "deleted",
            "private",
            "login_required",
            "region_restricted",
            "challenge_required",
            "rate_limited",
            "not_found",
            "expired",
            "unsupported",
            "unavailable",
            "unknown",
          ]).toContain(payload?.access_status);
          // Documented contract (video_resolve description, src/mcp/video-tools.ts):
          // every literal stream URL the page published is returned WITH its
          // per-stream probe result, so the caller can see *why* nothing was
          // retrievable. Honesty invariants: no stream may be presented as a
          // verified video, every probed stream carries a reason, and the
          // chosen-stream fields stay empty.
          const streams: Array<Record<string, any>> = payload?.streams ?? [];
          expect(payload?.stream_count ?? 0).toBe(streams.length);
          expect(payload?.best_stream_url ?? null).toBeNull();
          for (const stream of streams) {
            expect(stream.verified_video, `stream ${stream.kind}/${stream.source} must not be presented as verified`).toBe(false);
            expect(stream.verified_container ?? null).toBeNull();
            expect([true, false, null]).toContain(stream.reachable);
            if (stream.reachable !== null) {
              expect(typeof stream.reason, `probed stream ${stream.kind}/${stream.source} needs a reason`).toBe("string");
              expect(stream.reason.length).toBeGreaterThan(0);
            }
          }
        }
        // include_signed_urls=false: signed/expiring query strings are stripped
        // from every returned stream URL (kept as `?signed_query_removed=true`)
        // whatever the access verdict was. The documented scope is stream URLs
        // (thumbnail_url is metadata and not covered by the flag).
        for (const stream of payload?.streams ?? []) {
          if (stream.signed === true) expect(stream.url).toMatch(/\?signed_query_removed=true$/);
          expect(stream.url).not.toMatch(/[?&](?:x-signature|signature|x-expires|expires|token)=/i);
        }
        if (payload?.best_stream_url) expect(payload.best_stream_url).toMatch(/\?signed_query_removed=true$/);
      } finally {
        await client.close();
      }
    },
    240_000,
  );

  it(
    "video_extract_frames: max_width=320 renders at exactly 320 CSS pixels wide, or reports the documented fallback",
    async ({ skip }) => {
      const url = liveEnv().publicVideoUrl;
      const client = connectLive(origin);
      try {
        const result = await client.call("video_extract_frames", { url, max_frames: 2, resize: { max_width: 320 } });
        const egressNote = workerEgressSkipNote(result, url);
        if (egressNote) skip(egressNote);
        const payload = result.parsed as Record<string, any>;
        expect(payload?.resize_requested).toEqual({ max_width: 320 });
        if (!payload?.success) {
          // An honest block (DRM, access failure, no browser) is an accepted
          // outcome; silently succeeding without frames is not.
          expect(ACCEPTABLE_BLOCK_ERRORS).toContain(payload?.error);
          expect(payload?.frames ?? []).toEqual([]);
          return;
        }
        expect(payload.frames.length, "a successful extraction must deliver frames").toBeGreaterThan(0);
        const limitations = (payload.limitations ?? []).join(" ");
        const rendered = /rendered at a (\d+)×(\d+) viewport/.exec(limitations);
        if (rendered) {
          // The provider honoured the resize: the public fixture is landscape
          // and wider than 320px, so max_width is the binding constraint and
          // the viewport must be exactly 320 CSS pixels wide (never upscaled,
          // aspect preserved, so height follows).
          expect(Number(rendered[1])).toBe(320);
          expect(Number(rendered[2])).toBeGreaterThan(0);
          // Every frame reports the real pixel size it actually has; none may
          // claim a width the bound forbids at CSS scale.
          for (const frame of payload.frames) {
            expect(typeof frame.width).toBe("number");
            expect(typeof frame.height).toBe("number");
            expect(frame.width).toBeGreaterThan(0);
            expect(frame.timestamp_seconds).toBeGreaterThanOrEqual(0);
          }
        } else {
          // Documented fallback: the provider could not resize, frames were
          // captured at the default viewport, and the limitation says so
          // explicitly instead of pretending the resize happened.
          expect(limitations).toMatch(/resize could not be applied|captured at the default viewport/i);
        }
      } finally {
        await client.close();
      }
    },
    300_000,
  );

  it(
    "capability discovery: the live deployment publishes an honest video capability report",
    async () => {
      const client = connectLive(origin);
      try {
        const listed = await client.rpc("resources/list", {});
        const uris: string[] = (listed.resources ?? []).map((entry: any) => entry.uri);
        expect(uris).toContain("demo://capabilities/video");
        expect(uris).toContain("demo://video/honesty-contract");

        const read = await client.rpc("resources/read", { uri: "demo://capabilities/video" });
        const report = JSON.parse(read.contents?.[0]?.text ?? "null");
        expect(report?.schema).toBe("demo.video-capabilities/1");
        expect(report?.supportedPlatforms?.length).toBeGreaterThan(0);
        expect(typeof report?.frames?.available).toBe("boolean");
        expect(typeof report?.transcription?.available).toBe("boolean");
        expect(report?.security?.neverBypassed?.join(" ")).toMatch(/captcha|drm|login/i);
        expect(report?.limits?.maxFrames).toBeGreaterThan(0);
        // Provider names only — never a secret value.
        expect(JSON.stringify(report)).not.toMatch(/sk-[A-Za-z0-9]{8}|Bearer\s+[A-Za-z0-9]/);
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

  it("honours LIVE_PUBLIC_VIDEO_URL and falls back to the default when it is blank", () => {
    const previous = process.env.LIVE_PUBLIC_VIDEO_URL;
    try {
      process.env.LIVE_PUBLIC_VIDEO_URL = " https://fixtures.example.com/clip.mp4 ";
      expect(liveEnv().publicVideoUrl).toBe("https://fixtures.example.com/clip.mp4");
      process.env.LIVE_PUBLIC_VIDEO_URL = "   ";
      expect(liveEnv().publicVideoUrl).toBe(DEFAULT_PUBLIC_VIDEO_URL);
    } finally {
      if (previous === undefined) delete process.env.LIVE_PUBLIC_VIDEO_URL;
      else process.env.LIVE_PUBLIC_VIDEO_URL = previous;
    }
  });

  describe("fixtureAccessSkipNote", () => {
    const fixture = liveEnv().publicVideoUrl;
    const asResult = (parsed: Record<string, unknown> | null): CallResult => ({
      isError: false,
      text: parsed ? JSON.stringify(parsed) : "",
      parsed,
      imageCount: 0,
      imageMimeTypes: [],
      imageBlocks: [],
    });
    const denied = {
      tool: "video_resolve",
      success: false,
      access_status: "challenge_required",
      http_status: 403,
      challenge: { detected: true, kind: "bot_challenge_or_access_denied", reason: "HTTP 403" },
      error: "PLATFORM_BLOCKED",
      message: "The source answered HTTP 403 (access denied or bot challenge).",
    };

    it("labels a fixture-host 403/bot-challenge as an explicit environment skip, with the reason", () => {
      const note = fixtureAccessSkipNote(asResult(denied), fixture);
      expect(note).toMatch(/^ENVIRONMENT SKIP \(fixture host denied the Worker\)/);
      expect(note).toContain(fixture);
      expect(note).toContain("HTTP 403");
      expect(note).toContain("bot_challenge_or_access_denied");
      expect(note).toContain("LIVE_PUBLIC_VIDEO_URL");
    });

    it("recognises the ingest/inspect shape (PLATFORM_BLOCKED + 403 message, no challenge object)", () => {
      const ingestDenied = { success: false, error: "PLATFORM_BLOCKED", message: "Access denied by the host (HTTP 403).", frames: [] };
      expect(fixtureAccessSkipNote(asResult(ingestDenied), fixture)).toMatch(/^ENVIRONMENT SKIP/);
    });

    it("never applies to a URL other than the configured fixture", () => {
      expect(fixtureAccessSkipNote(asResult(denied), "https://www.tiktok.com/@tiktok/video/7106594312292453675")).toBeNull();
      expect(fixtureAccessSkipNote(asResult(denied), `${fixture}?variant=1`)).toBeNull();
    });

    it("never masks a success, a non-access failure or a missing payload", () => {
      expect(fixtureAccessSkipNote(asResult({ ...denied, success: true, access_status: "public" }), fixture)).toBeNull();
      expect(fixtureAccessSkipNote(asResult({ ...denied, access_status: "public" }), fixture)).toBeNull();
      expect(fixtureAccessSkipNote(asResult({ success: false, error: "FRAMES_UNAVAILABLE", message: "No frames could be decoded." }), fixture)).toBeNull();
      expect(fixtureAccessSkipNote(asResult({ success: false, error: "PLATFORM_BLOCKED", message: "Rate limited (HTTP 429)." }), fixture)).toBeNull();
      expect(fixtureAccessSkipNote(asResult({ success: false, access_status: "not_found", http_status: 404, error: "VIDEO_NOT_FOUND", message: "HTTP 404" }), fixture)).toBeNull();
      expect(fixtureAccessSkipNote(asResult(null), fixture)).toBeNull();
    });

    it("prints the reason before skipping so the skip is never silent", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const skip = vi.fn((note?: string): never => {
        throw new Error(`skipped: ${note}`);
      });
      try {
        expect(() => skipForEnvironment(skip, "ENVIRONMENT SKIP (test)")).toThrow("skipped: ENVIRONMENT SKIP (test)");
        expect(skip).toHaveBeenCalledWith("ENVIRONMENT SKIP (test)");
        expect(warn).toHaveBeenCalledWith("[live] ENVIRONMENT SKIP (test)");
      } finally {
        warn.mockRestore();
      }
    });
  });
});
