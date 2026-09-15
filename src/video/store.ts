import { BrowserError } from "../core/errors.js";
import { LIMITS } from "../core/limits.js";
import type { VideoArtifact } from "./types.js";

/** Small structural R2 surface so the Worker and tests can share this module. */
export interface VideoObjectStore {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array> | string,
    options?: {
      httpMetadata?: { contentType?: string; cacheControl?: string; contentDisposition?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  get?(key: string): Promise<VideoObject | null>;
  head?(key: string): Promise<{ size?: number; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } | null>;
  delete?(key: string): Promise<void>;
}

export interface VideoObject {
  body: ReadableStream<Uint8Array>;
  size?: number;
  httpMetadata?: { contentType?: string; cacheControl?: string };
  customMetadata?: Record<string, string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
  writeHttpMetadata?(headers: Headers): void;
}

export type ArtifactKind = "video" | "audio";

function randomHashFallback(): string {
  return `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 64);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function asHash(value: string): string {
  return /^[a-f0-9]{64}$/.test(value) ? value : randomHashFallback();
}

function keyFor(kind: ArtifactKind, hash: string): string {
  return `video-artifacts/${kind}/${hash}`;
}

function referenceFor(kind: ArtifactKind, hash: string): string {
  return `${kind}_${hash}`;
}

function splitReference(reference: string): { kind: ArtifactKind; hash: string } | null {
  const match = /^(video|audio)_([a-f0-9]{64})$/.exec(reference.trim());
  return match ? { kind: match[1] as ArtifactKind, hash: match[2] } : null;
}

/**
 * R2-backed expiring artifact storage. The same SCREENSHOTS bucket is used by
 * default so existing deployments do not need a new mandatory binding; callers
 * may provide VIDEO_ARTIFACTS when they want a separate bucket.
 */
export class VideoArtifactStore {
  readonly bucket: VideoObjectStore | null;
  readonly baseUrl: string;
  readonly ttlSeconds: number;

  constructor(bucket: VideoObjectStore | undefined | null, baseUrl: string, ttlSeconds?: number) {
    this.bucket = bucket ?? null;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    const configured = Number(ttlSeconds ?? LIMITS.videoArtifactTtlSeconds);
    this.ttlSeconds = Number.isFinite(configured) ? Math.max(60, Math.min(Math.trunc(configured), 86_400)) : LIMITS.videoArtifactTtlSeconds;
  }

  get available(): boolean {
    return Boolean(this.bucket);
  }

  unavailableReason(): string {
    return "Temporary video storage is not configured. Bind SCREENSHOTS (or VIDEO_ARTIFACTS) to a Cloudflare R2 bucket.";
  }

  async store(
    bytes: Uint8Array,
    kind: ArtifactKind,
    contentType: string,
    metadata: { durationSeconds?: number | null; width?: number | null; height?: number | null; source?: string } = {},
  ): Promise<VideoArtifact> {
    if (!this.bucket) throw new BrowserError("capability_unavailable", this.unavailableReason(), { capability: "video_artifact_storage" });
    if (bytes.byteLength > LIMITS.videoMaxDownloadBytes && kind === "video") {
      throw new BrowserError("DOWNLOAD_TOO_LARGE", "The video artifact is above the configured storage limit.");
    }
    if (bytes.byteLength > LIMITS.videoAudioMaxBytes && kind === "audio") {
      throw new BrowserError("DOWNLOAD_TOO_LARGE", "The extracted audio artifact is above the configured storage limit.");
    }
    const hash = asHash(await sha256Hex(bytes));
    const key = keyFor(kind, hash);
    const expiresAtMs = Date.now() + this.ttlSeconds * 1000;
    const expiresAt = new Date(expiresAtMs).toISOString();

    // Content-addressed keys make retries/cache hits safe. A stale object is
    // overwritten, while a live object is left untouched.
    const existing = await this.bucket.head?.(key).catch(() => null);
    const existingExpiry = existing?.customMetadata?.expiresAt ? Date.parse(existing.customMetadata.expiresAt) : 0;
    if (!existing || !existingExpiry || existingExpiry <= Date.now()) {
      const customMetadata: Record<string, string> = {
        createdAt: new Date().toISOString(),
        expiresAt,
        sha256: hash,
        kind,
        ...(metadata.source ? { source: metadata.source.slice(0, 500) } : {}),
        ...(metadata.durationSeconds !== undefined && metadata.durationSeconds !== null ? { durationSeconds: String(metadata.durationSeconds) } : {}),
        ...(metadata.width !== undefined && metadata.width !== null ? { width: String(metadata.width) } : {}),
        ...(metadata.height !== undefined && metadata.height !== null ? { height: String(metadata.height) } : {}),
      };
      await this.bucket.put(key, bytes, {
        httpMetadata: { contentType, cacheControl: `private, max-age=${Math.min(this.ttlSeconds, 3600)}` },
        customMetadata,
      });
    }

    return {
      reference: referenceFor(kind, hash),
      kind,
      url: `${this.baseUrl}/video-assets/${referenceFor(kind, hash)}`,
      contentType,
      bytes: bytes.byteLength,
      sha256: hash,
      expiresAt: existingExpiry > Date.now() ? (existing?.customMetadata?.expiresAt as string) : expiresAt,
      durationSeconds: metadata.durationSeconds ?? null,
      width: metadata.width ?? null,
      height: metadata.height ?? null,
    };
  }

  parse(reference: string): { kind: ArtifactKind; hash: string } | null {
    return splitReference(reference);
  }

  key(reference: string): string | null {
    const parsed = splitReference(reference);
    return parsed ? keyFor(parsed.kind, parsed.hash) : null;
  }

  async get(reference: string): Promise<{ bytes: Uint8Array; contentType: string; metadata: Record<string, string> } | null> {
    if (!this.bucket?.get) return null;
    const parsed = splitReference(reference);
    if (!parsed) return null;
    const object = await this.bucket.get(keyFor(parsed.kind, parsed.hash));
    if (!object) return null;
    const metadata = object.customMetadata ?? {};
    const expiresAt = metadata.expiresAt ? Date.parse(metadata.expiresAt) : 0;
    if (expiresAt && expiresAt <= Date.now()) {
      await this.bucket.delete?.(keyFor(parsed.kind, parsed.hash)).catch(() => undefined);
      return null;
    }
    const buffer = object.arrayBuffer ? await object.arrayBuffer() : await streamToArrayBuffer(object.body);
    return { bytes: new Uint8Array(buffer), contentType: object.httpMetadata?.contentType ?? (parsed.kind === "audio" ? "audio/webm" : "video/mp4"), metadata };
  }

  async objectForRoute(reference: string): Promise<VideoObject | null> {
    if (!this.bucket?.get) return null;
    const parsed = splitReference(reference);
    if (!parsed) return null;
    const key = keyFor(parsed.kind, parsed.hash);
    const object = await this.bucket.get(key);
    if (!object) return null;
    const expiresAt = object.customMetadata?.expiresAt ? Date.parse(object.customMetadata.expiresAt) : 0;
    if (expiresAt && expiresAt <= Date.now()) {
      await this.bucket.delete?.(key).catch(() => undefined);
      return null;
    }
    return object;
  }
}

async function streamToArrayBuffer(stream: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

export function artifactBaseUrl(requestUrl: string | null | undefined): string {
  if (requestUrl) {
    try {
      return `${new URL(requestUrl).origin}`;
    } catch {
      /* fall through */
    }
  }
  return "https://demo-mcp.www-notamirrblx.workers.dev";
}
