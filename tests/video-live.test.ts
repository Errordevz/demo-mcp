import { describe, expect, it } from "vitest";
import { connectLive, liveEnv, skipIfUnavailable } from "./helpers/live.js";

describe.skipIf(!liveEnv().enabled)("public video acceptance", () => {
  it(
    "tests the supplied public TikTok short URL for real frames or an exact technical reason",
    async ({ skip }) => {
      const client = connectLive();
      try {
        const result = await client.call("video_inspect_url", {
          url: "https://vt.tiktok.com/ZSq4b6A3K/",
          max_duration: 60,
          frame_interval: 8,
          include_transcript: false,
        });
        skipIfUnavailable(result, "video_inspect_url", skip);
        const payload = result.parsed as Record<string, any> | null;
        expect(payload).toBeTruthy();
        if (payload?.success && Array.isArray(payload.frames) && payload.frames.length > 0) {
          const visible = result.imageCount > 0 || payload.frames.every((frame: any) => typeof frame.image_reference === "string" && /^https:\/\//.test(frame.image_reference));
          expect(visible, "decoded frames must be MCP image content or retrievable HTTPS references").toBe(true);
          expect(payload.frames.every((frame: any) => typeof frame.timestamp === "number" && frame.content_type.startsWith("image/"))).toBe(true);
          expect(payload.analysis_ready).toBe(true);
        } else {
          // A blocked TikTok is an accepted outcome only when the response is
          // explicit. A metadata-only thumbnail must not masquerade as a frame.
          expect(["VIDEO_NOT_FOUND", "VIDEO_NOT_PUBLIC", "PLATFORM_BLOCKED", "UNSUPPORTED_MEDIA", "PROCESSING_TIMEOUT", "FRAMES_UNAVAILABLE"]).toContain(payload?.error);
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
});
