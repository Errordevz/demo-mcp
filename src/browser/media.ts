/**
 * MediaInspector.
 *
 * Reports media the page already exposes to the browser: <video>/<audio>
 * elements, posters, dimensions, OpenGraph/Twitter/JSON-LD metadata and — for
 * public TikTok pages — the structured hydration payload TikTok ships with the
 * page.
 *
 * Frame sampling is *rendered-frame capture*: the browser seeks an already
 * loaded <video> element and DEMO screenshots the pixels on screen. Nothing is
 * downloaded, no stream is re-fetched, no DRM-encrypted content is touched and
 * no access control is bypassed. If the browser cannot decode or is not allowed
 * to show the frames, DEMO says so instead of guessing.
 */

import { BrowserError } from "../core/errors.js";
import { LIMITS, clamp } from "../core/limits.js";
import { safeLog } from "../core/redact.js";
import {
  collectMediaInfo,
  prepareVideoForSampling,
  seekVideo,
  type ImageCandidate,
  type MediaElementInfo,
  type MediaPayload,
} from "./page-scripts.js";
import { toInlineImage } from "./screenshot.js";
import type { ScreenshotManager } from "./screenshot.js";
import { isTikTokUrl, parseTikTok, type TikTokInfo } from "./tiktok.js";
import type { PageHandle, ScreenshotType } from "./types.js";

export interface MediaMetadata {
  openGraph: Record<string, string>;
  twitter: Record<string, string>;
  standard: Record<string, string>;
}

export interface MediaReport {
  url: string;
  title: string;
  platform: "tiktok" | "generic";
  hasVideoElement: boolean;
  meta: MediaMetadata;
  jsonLd: Array<{ ok: true; data: unknown } | { ok: false; error: string; raw: string }>;
  media: {
    videos: MediaElementInfo[];
    audios: MediaElementInfo[];
    images: ImageCandidate[];
  };
  tiktok: TikTokInfo | null;
  limitations: string[];
  inspectedAt: string;
}

export function buildMediaReport(payload: MediaPayload): MediaReport {
  const openGraph: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  const standard: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload.meta)) {
    if (key.startsWith("og:") || key.startsWith("article:") || key.startsWith("video:") || key.startsWith("music:")) openGraph[key] = value;
    else if (key.startsWith("twitter:")) twitter[key] = value;
    else standard[key] = value;
  }

  const jsonLd = payload.jsonLd.map((raw) => {
    try {
      return { ok: true as const, data: JSON.parse(raw) };
    } catch (error) {
      return { ok: false as const, error: String(error).slice(0, 200), raw: raw.slice(0, 500) };
    }
  });

  const platform: "tiktok" | "generic" = isTikTokUrl(payload.url) ? "tiktok" : "generic";
  const tiktok = platform === "tiktok" ? parseTikTok({ url: payload.url, meta: payload.meta, rawStates: payload.rawStates }) : null;

  const limitations: string[] = [
    "Only media metadata exposed to the rendered page is reported. DEMO does not download media files or call private APIs.",
  ];
  if (platform === "tiktok" && !tiktok) {
    limitations.push(
      "TikTok did not expose a readable video payload. Common causes: a verification challenge, a login wall, region restrictions, or a layout change.",
    );
  }
  if (!payload.videos.length && !payload.audios.length) {
    limitations.push("No HTML5 <video> or <audio> element is present in the rendered DOM.");
  }
  for (const video of payload.videos) {
    if (video.protectedMedia) limitations.push("A video element uses Encrypted Media Extensions (DRM); its frames cannot be captured.");
    if (video.errorCode) limitations.push(`Video #${video.index} reported media error code ${video.errorCode}: ${video.errorMessage ?? "unknown"}`);
    if (!video.durationSeconds) limitations.push(`Video #${video.index} has no decodable duration (readyState ${video.readyState}).`);
  }
  if (tiktok) limitations.push(...tiktok.limitations);

  return {
    url: payload.url,
    title: payload.title,
    platform,
    hasVideoElement: payload.videos.length > 0,
    meta: { openGraph, twitter, standard },
    jsonLd,
    media: { videos: payload.videos, audios: payload.audios, images: payload.images },
    tiktok,
    limitations: [...new Set(limitations)],
    inspectedAt: new Date().toISOString(),
  };
}

export interface FrameSamplingOptions {
  count?: number;
  index?: number;
  selector?: string | null;
  /** Explicit timestamps in seconds. Overrides evenly spaced sampling. */
  timestamps?: number[];
  type?: ScreenshotType;
  inline?: boolean;
  /** Upper bound for count/timestamp clamping. Defaults to
   * `LIMITS.framesMaxCount`; the public video pipeline passes its own higher
   * cap (`LIMITS.videoFramesMaxCount`). Browser tools never raise it. */
  maxFrames?: number;
}

export interface SampledFrame {
  index: number;
  timeSeconds: number;
  url: string | null;
  mimeType: string | null;
  bytes: number;
  inlineData?: string | null;
  ok: boolean;
  error?: string | null;
}

export interface FrameSamplingReport {
  available: boolean;
  reason: string | null;
  videoIndex: number;
  durationSeconds: number | null;
  intrinsicSize: { width: number | null; height: number | null } | null;
  frames: SampledFrame[];
  limitations: string[];
  capturedAt: string;
}

export class MediaInspector {
  constructor(private readonly screenshots: ScreenshotManager) {}

  async inspect(page: PageHandle, options: { selector?: string | null } = {}): Promise<MediaReport> {
    const payload = await page.evaluate(collectMediaInfo, {
      maxMediaElements: LIMITS.maxMediaElements,
      maxImages: LIMITS.maxImageCandidates,
      maxRawStateChars: LIMITS.maxRawStateChars,
      selector: options.selector ?? null,
    } as Parameters<typeof collectMediaInfo>[0]);
    return buildMediaReport(payload);
  }

  /** Rendered-frame sampling from a publicly playable <video> element. */
  async sampleFrames(page: PageHandle, options: FrameSamplingOptions = {}): Promise<FrameSamplingReport> {
    const frameCap = Math.max(1, options.maxFrames ?? LIMITS.framesMaxCount);
    const requestedCount = clamp(options.count ?? LIMITS.framesDefaultCount, 1, frameCap);
    const index = Math.max(0, options.index ?? 0);
    const type: ScreenshotType = options.type ?? "png";
    const selector = options.selector ?? null;
    const startedAt = Date.now();
    const limitations: string[] = [];

    const prepared = await page.evaluate(prepareVideoForSampling, { index, selector, muted: true });
    if (!prepared.found) {
      return {
        available: false,
        reason: "No <video> element was found on the page, so there are no frames to sample.",
        videoIndex: index,
        durationSeconds: null,
        intrinsicSize: null,
        frames: [],
        limitations: ["Frame sampling only works on pages with an HTML5 video element that the browser can decode."],
        capturedAt: new Date().toISOString(),
      };
    }
    if (prepared.protectedMedia) {
      return {
        available: false,
        reason: "The video is protected by Encrypted Media Extensions (DRM); its frames cannot be captured.",
        videoIndex: index,
        durationSeconds: prepared.durationSeconds,
        intrinsicSize: { width: prepared.intrinsicWidth, height: prepared.intrinsicHeight },
        frames: [],
        limitations: ["DRM-protected media is never decrypted or re-encoded by DEMO."],
        capturedAt: new Date().toISOString(),
      };
    }
    const duration = prepared.durationSeconds;
    if (duration === null || duration <= 0) {
      return {
        available: false,
        reason: "The video duration is unknown (the browser has not decoded any media).",
        videoIndex: index,
        durationSeconds: duration,
        intrinsicSize: { width: prepared.intrinsicWidth, height: prepared.intrinsicHeight },
        frames: [],
        limitations: [
          "The browser reported no decodable duration. The site may block playback for this session, or the media may need a human to complete a challenge first.",
          ...(prepared.errorMessage ? [`Media error: ${prepared.errorMessage}`] : []),
        ],
        capturedAt: new Date().toISOString(),
      };
    }

    await page.evaluate((arg: { index: number; selector: string | null }) => {
      const scope: Element | Document = (() => {
        if (arg.selector) {
          try {
            const found = document.querySelector(arg.selector);
            if (found) return found;
          } catch {
            /* ignore */
          }
        }
        return document;
      })();
      const video = scope.querySelectorAll("video")[arg.index] as HTMLVideoElement | undefined;
      video?.scrollIntoView({ block: "center", inline: "center" });
    }, { index, selector });

    const timestamps = normaliseTimestamps(options.timestamps, requestedCount, duration, frameCap);
    const frames: SampledFrame[] = [];
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));

    for (let i = 0; i < timestamps.length; i++) {
      if (Date.now() - startedAt > LIMITS.framesTimeoutMs) {
        limitations.push(`Stopped after ${frames.length} frame(s): the ${LIMITS.framesTimeoutMs / 1000}s capture budget was reached.`);
        break;
      }
      const time = timestamps[i];
      const seek = await page.evaluate(seekVideo, { index, selector, time, timeoutMs: 8_000 });
      await new Promise((resolve) => setTimeout(resolve, LIMITS.frameSeekSettleMs));
      if (!seek.ok) {
        frames.push({ index: i, timeSeconds: time, url: null, mimeType: null, bytes: 0, ok: false, error: seek.error });
        continue;
      }
      const rect = await currentVideoRect(page, index, selector);
      const clip = intersectClip(rect, viewport);
      try {
        const bytes = await page.screenshot({ type, fullPage: false, ...(clip ? { clip } : {}) });
        let stored: Awaited<ReturnType<ScreenshotManager["store"]>> | null = null;
        if (this.screenshots.available) {
          try {
            stored = await this.screenshots.store(bytes, type, {
              source: "browser_video_frames",
              url: page.url(),
              frameIndex: i,
              timeSeconds: time,
              videoIndex: index,
            });
          } catch (error) {
            safeLog("warn", "frame-storage-failed", { time, message: String(error) });
            if (!options.inline) throw error;
          }
        }
        const inlineData = options.inline ? await toInlineImage(bytes, type) : null;
        if (!stored && !inlineData) throw new BrowserError("FRAMES_UNAVAILABLE", "The frame was decoded but could not be exposed: R2 storage is unavailable and the image exceeds the inline MCP size cap.");
        frames.push({
          index: i,
          timeSeconds: time,
          url: stored?.url ?? null,
          mimeType: stored?.mimeType ?? `image/${type === "jpeg" ? "jpeg" : type}`,
          bytes: bytes.byteLength,
          ...(inlineData ? { inlineData } : {}),
          ok: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        safeLog("warn", "frame-capture-failed", { time, message });
        frames.push({ index: i, timeSeconds: time, url: null, mimeType: null, bytes: 0, ok: false, error: message.slice(0, 300) });
      }
    }

    limitations.push(
      "Frames are screenshots of the rendered video element, captured at the requested timestamps. Frame accuracy depends on the browser's seeking granularity.",
    );
    if (!prepared.intrinsicWidth) limitations.push("The video reported no intrinsic size before sampling; some frames may be blank.");

    return {
      available: frames.some((frame) => frame.ok),
      reason: frames.some((frame) => frame.ok) ? null : "No frames could be captured from the video element.",
      videoIndex: index,
      durationSeconds: duration,
      intrinsicSize: { width: prepared.intrinsicWidth, height: prepared.intrinsicHeight },
      frames,
      limitations: [...new Set(limitations)],
      capturedAt: new Date().toISOString(),
    };
  }
}

function normaliseTimestamps(requested: number[] | undefined, count: number, duration: number, cap: number = LIMITS.framesMaxCount): number[] {
  if (requested && requested.length > 0) {
    const cleaned = requested
      .filter((value) => Number.isFinite(value) && value >= 0)
      .slice(0, cap)
      .map((value) => Math.min(Number(value.toFixed(3)), Math.max(0, duration - 0.05)));
    if (cleaned.length > 0) return cleaned;
  }
  const total = clamp(count, 1, cap);
  const safeDuration = Math.max(0.2, duration - 0.1);
  const step = safeDuration / total;
  return Array.from({ length: total }, (_unused, i) => Number(Math.min(safeDuration, step * (i + 0.5)).toFixed(3)));
}

async function currentVideoRect(
  page: PageHandle,
  index: number,
  selector: string | null,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const rect = await page.evaluate(
    (arg: { index: number; selector: string | null }) => {
      const scope: Element | Document = (() => {
        if (arg.selector) {
          try {
            const found = document.querySelector(arg.selector);
            if (found) return found;
          } catch {
            /* ignore */
          }
        }
        return document;
      })();
      const video = scope.querySelectorAll("video")[arg.index] as HTMLVideoElement | undefined;
      if (!video) return null;
      const box = video.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) return null;
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    },
    { index, selector },
  );
  return rect ?? null;
}

function intersectClip(
  rect: { x: number; y: number; width: number; height: number } | null,
  viewport: { width: number; height: number },
): { x: number; y: number; width: number; height: number } | null {
  if (!rect) return null;
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const right = Math.min(viewport.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(viewport.height, Math.ceil(rect.y + rect.height));
  const width = right - x;
  const height = bottom - y;
  if (width < 2 || height < 2) return null;
  return { x, y, width, height };
}

export function assertMediaCapability(inspector: MediaInspector): void {
  if (!inspector) throw new BrowserError("capability_unavailable", "Media inspector unavailable.", { capability: "media_inspector" });
}
