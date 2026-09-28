/**
 * Generic image analysis (DEMO 0.9) on DEMO's existing Workers AI vision
 * binding — the same `AI.run(model, { image, prompt })` pipeline the video
 * tools already use (VIDEO_VISION_MODEL, default llava). No second vision API
 * is introduced; when the AI binding is absent, retrieval + metadata still work
 * and every AI-derived field reports `unavailable` instead of being invented.
 */

import { BrowserError } from "../core/errors.js";
import { createSsrfGuard, guardedFetchBytes } from "../core/guarded-fetch.js";
import { LIMITS, clamp } from "../core/limits.js";
import { publicToolRateLimiter } from "../core/rate-limit.js";
import { detectMediaSignature, imageDimensions } from "../video/probe.js";

export interface ImageMetadata {
  url: string | null;
  finalUrl: string | null;
  contentType: string | null;
  bytes: number;
  format: string | null;
  width: number | null;
  height: number | null;
  aspectRatio: number | null;
  sha256: string | null;
}

export interface FetchedImage {
  bytes: Uint8Array;
  metadata: ImageMetadata;
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/bmp", "image/avif", "image/x-icon", "image/svg", "image/"];

export async function fetchPublicImage(env: Record<string, unknown> | undefined, url: string, options: { scope?: string; timeoutMs?: number } = {}): Promise<FetchedImage> {
  publicToolRateLimiter.charge(env, options.scope ?? "image_analyze", url);
  const guard = createSsrfGuard(env);
  const result = await guardedFetchBytes(url, {
    guard,
    timeoutMs: clamp(options.timeoutMs ?? LIMITS.publicFetchTimeoutDefaultMs, 1_000, LIMITS.publicFetchTimeoutMaxMs),
    maxBytes: LIMITS.imageMaxBytes,
    acceptContentTypes: IMAGE_TYPES,
    headers: { accept: "image/*;q=0.9,*/*;q=0.1", "user-agent": "DEMO-MCP/1.0.0 (+image analysis; public read-only)" },
  });
  const signature = detectMediaSignature(result.bytes, result.contentType);
  const dimensions = imageDimensions(result.bytes);
  const sha256 = await sha256Hex(result.bytes);
  const width = dimensions?.width ?? null;
  const height = dimensions?.height ?? null;
  return {
    bytes: result.bytes,
    metadata: {
      url,
      finalUrl: result.finalUrl,
      contentType: result.contentType,
      bytes: result.bytes.byteLength,
      format: signature.container ?? (result.contentType ?? "").split("/")[1] ?? null,
      width,
      height,
      aspectRatio: width && height ? Math.round((width / height) * 1000) / 1000 : null,
      sha256,
    },
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface VisionAnalysis {
  status: "ok" | "unavailable" | "failed";
  provider: string | null;
  model: string | null;
  text: string | null;
  message: string;
}

function aiBinding(env: Record<string, unknown> | undefined): { run: (model: string, input: unknown) => Promise<unknown> } | null {
  const candidate = env?.AI as { run?: unknown } | undefined;
  return candidate && typeof candidate.run === "function" ? (candidate as { run: (model: string, input: unknown) => Promise<unknown> }) : null;
}

/**
 * Run one vision prompt over one image via the existing Workers AI binding.
 * The prompt is always DEMO-authored; user text never reaches the model
 * verbatim (same curation rule the video pipeline follows).
 */
export async function analyzeImageWithAi(
  env: Record<string, unknown> | undefined,
  image: Uint8Array,
  prompt: string,
): Promise<VisionAnalysis> {
  const ai = aiBinding(env);
  const model = String(env?.VIDEO_VISION_MODEL ?? "@cf/llava-hf/llava-1.5-7b-hf");
  if (!ai) {
    return {
      status: "unavailable",
      provider: null,
      model: null,
      text: null,
      message: "Vision analysis is unavailable: this deployment has no Workers AI binding (AI). Retrieval and metadata still work; DEMO does not claim descriptions or text it could not verify.",
    };
  }
  try {
    const copy = new Uint8Array(image.byteLength);
    copy.set(image);
    const raw = (await ai.run(model, { image: copy.buffer, prompt })) as unknown;
    const text = extractModelText(raw);
    return {
      status: "ok",
      provider: `cloudflare-ai:${model}`,
      model,
      text: text ? text.slice(0, 8_000) : null,
      message: "Model-generated analysis: verify critical details against the image itself.",
    };
  } catch (error) {
    return {
      status: "failed",
      provider: `cloudflare-ai:${model}`,
      model,
      text: null,
      message: `The vision model rejected this image (${String(error instanceof Error ? error.message : error).slice(0, 160)}).`,
    };
  }
}

function extractModelText(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    for (const key of ["description", "text", "result", "output", "response"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
      if (value && typeof value === "object") {
        const nested = (value as Record<string, unknown>).description ?? (value as Record<string, unknown>).text;
        if (typeof nested === "string" && nested.trim()) return nested;
      }
    }
  }
  return null;
}

export const PROMPTS = {
  describe:
    "Describe this image factually: main subject, setting, colors and any notable objects or people. Keep it under 120 words. Do not guess at things not visible; say when something is uncertain.",
  ocr: "Read and transcribe ALL visible text in this image, preserving line breaks and reading order. Return only the transcribed text. If there is no visible text, return an empty string.",
  analyze:
    "Inspect this image and return compact JSON with keys: visible_text (array of strings), objects_people (array), scene_description (string), mood (string), notable_details (array). Only report what is visible in the pixels.",
} as const;

export interface ImageCompareSimilarity {
  dimensions: { sameAspect: boolean; ratio: number | null };
  bytes: { a: number; b: number; ratio: number };
  identicalBytes: boolean;
  /** Coarse heuristic in [0,1]; 1 only when bytes are identical. */
  similarity: number;
  note: string;
}

/**
 * Multi-image comparison: per-image metadata + description, plus a coarse
 * similarity measure from dimensions/bytes. Pixel-level comparison belongs to
 * `screenshot_diff` (browser-based); this stays honest about being coarse.
 */
export function compareImages(images: ImageMetadata[]): { pairs: Array<{ a: string; b: string; similarity: ImageCompareSimilarity }>; note: string } {
  const pairs: Array<{ a: string; b: string; similarity: ImageCompareSimilarity }> = [];
  for (let i = 0; i < images.length; i++) {
    for (let j = i + 1; j < images.length; j++) {
      const a = images[i];
      const b = images[j];
      const sameAspect = Boolean(a.aspectRatio && b.aspectRatio && Math.abs(a.aspectRatio - b.aspectRatio) < 0.02);
      const byteRatio = a.bytes > 0 ? Math.min(a.bytes, b.bytes) / Math.max(a.bytes, b.bytes) : 0;
      const identical = Boolean(a.sha256 && b.sha256 && a.sha256 === b.sha256);
      const dimensionScore = a.width && b.width && a.height && b.height ? (Math.min(a.width, b.width) / Math.max(a.width, b.width) + Math.min(a.height, b.height) / Math.max(a.height, b.height)) / 2 : 0.5;
      const similarity = identical ? 1 : Math.round((0.45 * dimensionScore + 0.25 * byteRatio + (sameAspect ? 0.2 : 0.05)) * 1000) / 1000;
      pairs.push({
        a: a.url ?? a.finalUrl ?? "image-a",
        b: b.url ?? b.finalUrl ?? "image-b",
        similarity: {
          dimensions: { sameAspect, ratio: a.aspectRatio && b.aspectRatio ? Math.round((Math.min(a.aspectRatio, b.aspectRatio) / Math.max(a.aspectRatio, b.aspectRatio)) * 1000) / 1000 : null },
          bytes: { a: a.bytes, b: b.bytes, ratio: Math.round(byteRatio * 1000) / 1000 },
          identicalBytes: identical,
          similarity,
          note: identical ? "The two images are byte-identical." : "Coarse similarity from dimensions and size only — use screenshot_diff (browser pixel comparison) for visual difference regions.",
        },
      });
    }
  }
  return { pairs, note: "Pairwise metadata similarity plus optional per-image descriptions; no pixel diffing happens here." };
}

export function assertImageCount(count: number): void {
  if (count > LIMITS.imageCompareMaxImages) {
    throw new BrowserError("invalid_input", `At most ${LIMITS.imageCompareMaxImages} images per comparison (got ${count}).`, { retryable: false });
  }
}
