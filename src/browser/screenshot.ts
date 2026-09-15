/**
 * Screenshot storage.
 *
 * Screenshot binaries never travel through the MCP result by default: they are
 * written to Cloudflare R2 and returned as high-entropy URLs. That keeps tool
 * results small enough for any MCP client and lets the user open the image in a
 * browser. Inline base64 is opt-in and capped.
 */

import { BrowserError } from "../core/errors.js";
import { LIMITS } from "../core/limits.js";
import { safeLog } from "../core/redact.js";
import type { ScreenshotType } from "./types.js";

/** Structural subset of `R2Bucket` so this module stays runtime-agnostic. */
export interface ObjectStore {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: {
      httpMetadata?: { contentType?: string; cacheControl?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
}

export interface StoredImage {
  id: string;
  url: string;
  mimeType: string;
  extension: "png" | "jpg" | "webp";
  bytes: number;
}

function randomId(): string {
  const a = crypto.randomUUID().replaceAll("-", "");
  const b = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  return `${a}${b}`;
}

export function mimeTypeFor(type: ScreenshotType): string {
  return type === "jpeg" ? "image/jpeg" : `image/${type}`;
}

export class ScreenshotManager {
  constructor(
    private readonly bucket: ObjectStore | undefined | null,
    private readonly baseUrl: string,
  ) {}

  get available(): boolean {
    return Boolean(this.bucket);
  }

  unavailableReason(): string | null {
    return this.bucket
      ? null
      : "Screenshot storage is not configured. Create the demo-mcp-screenshots R2 bucket and bind it as SCREENSHOTS.";
  }

  private assertAvailable(): ObjectStore {
    if (!this.bucket) {
      throw new BrowserError("capability_unavailable", this.unavailableReason() ?? "Screenshot storage unavailable.", {
        capability: "screenshot_storage",
        hint: "npx wrangler r2 bucket create demo-mcp-screenshots",
      });
    }
    return this.bucket;
  }

  async store(
    bytes: Uint8Array,
    type: ScreenshotType,
    meta: Record<string, string | number | boolean | null | undefined>,
    options: { prefix?: string } = {},
  ): Promise<StoredImage> {
    const bucket = this.assertAvailable();
    if (bytes.byteLength > LIMITS.screenshotMaxBytes) {
      throw new BrowserError(
        "size_limit_exceeded",
        `Screenshot is ${(bytes.byteLength / 1_048_576).toFixed(2)} MB, above the ${LIMITS.screenshotMaxBytes / 1_048_576} MB limit.`,
        { hint: "Use full_page: false, a smaller viewport, or a CSS selector to capture less." },
      );
    }
    const id = randomId();
    const extension: StoredImage["extension"] = type === "jpeg" ? "jpg" : type;
    const prefix = options.prefix ?? "screenshots";
    const key = `${prefix}/${id}`;
    const customMetadata: Record<string, string> = { createdAt: new Date().toISOString() };
    for (const [name, value] of Object.entries(meta)) {
      if (value === undefined || value === null) continue;
      customMetadata[name.slice(0, 100)] = String(value).slice(0, 500);
    }
    await bucket.put(key, bytes, {
      httpMetadata: { contentType: mimeTypeFor(type), cacheControl: "private, max-age=3600" },
      customMetadata,
    });
    safeLog("log", "screenshot-stored", { id, bytes: bytes.byteLength, type });
    return {
      id,
      url: `${this.baseUrl.replace(/\/$/, "")}/${prefix}/${id}`,
      mimeType: mimeTypeFor(type),
      extension,
      bytes: bytes.byteLength,
    };
  }
}

/**
 * Inline image payload for MCP clients that render images. Only used when the
 * caller opts in and the image is small.
 */
export async function toInlineImage(bytes: Uint8Array, type: ScreenshotType): Promise<string | null> {
  if (bytes.byteLength > LIMITS.inlineImageMaxBytes) return null;
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
