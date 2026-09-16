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
  get?(key: string, options?: { range?: { offset?: number; length?: number } }): Promise<VideoObject | null>;
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

/** A fresh 64-hex token for streamed (non-content-addressed) artifacts. */
function randomToken(): string {
  return randomHashFallback();
}

function copyBytes(value: Uint8Array): Uint8Array {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Cloudflare Workers expose `crypto.DigestStream`, an incremental SHA-256 that
 * makes content hashing a streaming operation. It does not exist in Node, so
 * the caller falls back to a bounded accumulation and reports `sha256: null`
 * when the object is larger than that bound — never a fabricated hash.
 */
function createDigestStream(): { writable: WritableStream<Uint8Array>; readable: ReadableStream<ArrayBuffer | Uint8Array> } | null {
  const candidate = (crypto as unknown as { DigestStream?: new (algorithm: string) => { writable: WritableStream<Uint8Array>; readable: ReadableStream<ArrayBuffer | Uint8Array> } }).DigestStream;
  if (typeof candidate !== "function") return null;
  try {
    return new candidate("SHA-256");
  } catch {
    return null;
  }
}

/** Options for `VideoArtifactStore.storeStream`. */
export interface StreamStoreOptions {
  /** Hard byte ceiling; the stream is aborted past it. */
  maxBytes: number;
  /** Leading bytes retained for container-signature verification. */
  headBytes?: number;
  /** Accumulation bound for hashing when `crypto.DigestStream` is unavailable. */
  digestBufferBytes?: number;
  /** Wall-clock budget for the whole streamed body. */
  timeoutMs?: number;
}

/** Outcome of a streamed upload. */
export interface StreamStoreOutcome {
  /** `null` when the stream was aborted: nothing was persisted. */
  artifact: VideoArtifact | null;
  /** The leading sample that was retained for verification. */
  head: Uint8Array;
  /** Bytes that passed through the transform before completion or abort. */
  bytes: number;
  /** Real SHA-256 of the stored object, or null when it could not be computed. */
  sha256: string | null;
  /** False for streamed artifacts: their key is a random token, not the digest. */
  contentAddressed: boolean;
  aborted: { code: "DOWNLOAD_TOO_LARGE" | "PROCESSING_TIMEOUT"; message: string } | null;
  timedOut: boolean;
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

  /**
   * Stream a response body into R2 without ever buffering the whole file.
   *
   * This is the Cloudflare-correct way to retrieve a video: a Worker has ~128
   * MiB of memory and no local disk, so a 50 MiB MP4 must be piped, not held.
   * The stream passes through a bounded transform that
   *
   *   1. counts bytes and aborts past `maxBytes` (`DOWNLOAD_TOO_LARGE`),
   *   2. retains only the first `headBytes` so the caller can prove the bytes
   *      are a real video container,
   *   3. computes SHA-256 with `crypto.DigestStream` when the runtime provides
   *      it (Cloudflare Workers) and otherwise accumulates up to
   *      `digestBufferBytes` — beyond that the hash is reported as `null`
   *      instead of being faked,
   *   4. aborts on a wall-clock timeout (`PROCESSING_TIMEOUT`).
   *
   * On any abort the partial object is deleted and `artifact` is `null`: a
   * failed retrieval is never reported as a successful download.
   */
  async storeStream(
    stream: ReadableStream<Uint8Array>,
    kind: ArtifactKind,
    contentType: string,
    metadata: { durationSeconds?: number | null; width?: number | null; height?: number | null; source?: string } = {},
    options: StreamStoreOptions,
  ): Promise<StreamStoreOutcome> {
    if (!this.bucket) throw new BrowserError("capability_unavailable", this.unavailableReason(), { capability: "video_artifact_storage" });
    const maxBytes = Math.max(1, options.maxBytes);
    const headCap = Math.max(0, Math.min(options.headBytes ?? LIMITS.videoHeadProbeBytes, LIMITS.videoHeadProbeBytes));
    const digestCap = Math.max(0, options.digestBufferBytes ?? LIMITS.videoDigestBufferBytes);
    const timeoutMs = Math.max(1_000, options.timeoutMs ?? LIMITS.videoDownloadTimeoutMs);

    const token = randomToken();
    const key = keyFor(kind, token);
    const headChunks: Uint8Array[] = [];
    const digestChunks: Uint8Array[] = [];
    let headLength = 0;
    let digestLength = 0;
    let total = 0;
    let timedOut = false;
    let abort: { code: "DOWNLOAD_TOO_LARGE" | "PROCESSING_TIMEOUT"; message: string } | null = null;
    let controllerRef: TransformStreamDefaultController<Uint8Array> | null = null;

    const digestStream = createDigestStream();
    const timer = setTimeout(() => {
      timedOut = true;
      abort = { code: "PROCESSING_TIMEOUT", message: `Streaming the video body exceeded the ${timeoutMs}ms budget.` };
      controllerRef?.error(new BrowserError("PROCESSING_TIMEOUT", abort.message, { retryable: true }));
    }, timeoutMs);

    const transform = new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        controllerRef = controller;
      },
      transform(chunk, controller) {
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer);
        total += bytes.byteLength;
        if (total > maxBytes) {
          abort = { code: "DOWNLOAD_TOO_LARGE", message: `The public video exceeded the ${formatMb(maxBytes)} streaming limit after ${formatMb(total)}.` };
          controller.error(new BrowserError("DOWNLOAD_TOO_LARGE", abort.message));
          return;
        }
        if (headLength < headCap) {
          const take = bytes.subarray(0, Math.min(bytes.byteLength, headCap - headLength));
          headChunks.push(copyBytes(take));
          headLength += take.byteLength;
        }
        if (!digestStream && digestLength < digestCap) {
          const take = bytes.subarray(0, Math.min(bytes.byteLength, digestCap - digestLength));
          digestChunks.push(copyBytes(take));
          digestLength += take.byteLength;
        }
        controller.enqueue(bytes);
      },
    });

    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000).toISOString();
    const customMetadata: Record<string, string> = {
      createdAt: new Date().toISOString(),
      expiresAt,
      kind,
      // Only the original public page URL is persisted — never a signed CDN URL.
      ...(metadata.source ? { source: metadata.source.slice(0, 500) } : {}),
      ...(metadata.durationSeconds !== undefined && metadata.durationSeconds !== null ? { durationSeconds: String(metadata.durationSeconds) } : {}),
      ...(metadata.width !== undefined && metadata.width !== null ? { width: String(metadata.width) } : {}),
      ...(metadata.height !== undefined && metadata.height !== null ? { height: String(metadata.height) } : {}),
    };

    let sha256: string | null = null;
    let putError: unknown = null;
    try {
      const [forStore, forDigest] = stream.pipeThrough(transform).tee();
      const putPromise = this.bucket.put(key, forStore, {
        httpMetadata: { contentType, cacheControl: `private, max-age=${Math.min(this.ttlSeconds, 3600)}` },
        customMetadata,
      }).catch((error: unknown) => {
        putError = error;
      });
      try {
        if (digestStream) {
          await forDigest.pipeTo(digestStream.writable);
          const digest = await new Response(digestStream.readable).arrayBuffer();
          sha256 = toHex(new Uint8Array(digest));
        } else {
          await forDigest.pipeTo(new WritableStream<Uint8Array>({ write() {} }));
          // Only claim a hash that covers the whole object.
          if (digestLength === total && total <= digestCap) sha256 = await sha256Hex(concatBytes(digestChunks));
        }
      } catch {
        /* the abort reason is recorded in `abort` */
      }
      await putPromise;
    } catch (error) {
      if (!abort) abort = { code: "PROCESSING_TIMEOUT", message: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timer);
    }

    const head = concatBytes(headChunks);
    if (abort || putError) {
      await this.bucket.delete?.(key).catch(() => undefined);
      return { artifact: null, head, bytes: total, sha256: null, contentAddressed: false, aborted: abort ?? { code: "PROCESSING_TIMEOUT", message: putError instanceof Error ? putError.message : String(putError) }, timedOut };
    }

    return {
      artifact: {
        reference: referenceFor(kind, token),
        kind,
        url: `${this.baseUrl}/video-assets/${referenceFor(kind, token)}`,
        contentType,
        bytes: total,
        // The token is random, not a content hash, because a streamed upload
        // cannot know its digest before the object key is chosen.
        sha256: sha256 ?? token,
        expiresAt,
        durationSeconds: metadata.durationSeconds ?? null,
        width: metadata.width ?? null,
        height: metadata.height ?? null,
      },
      head,
      bytes: total,
      sha256,
      contentAddressed: false,
      aborted: null,
      timedOut,
    };
  }

  /** Bounded range read of a stored artifact (used to verify a tail `moov`). */
  async getRange(reference: string, offset: number, length: number): Promise<{ bytes: Uint8Array; size: number | null } | null> {
    if (!this.bucket?.get) return null;
    const parsed = splitReference(reference);
    if (!parsed) return null;
    const key = keyFor(parsed.kind, parsed.hash);
    const head = await this.bucket.head?.(key).catch(() => null);
    const size = head?.size ?? null;
    try {
      const object = await this.bucket.get(key, { range: { offset: Math.max(0, offset), length: Math.max(1, length) } });
      if (!object) return null;
      const buffer = object.arrayBuffer ? await object.arrayBuffer() : await streamToArrayBuffer(object.body);
      return { bytes: new Uint8Array(buffer), size: size ?? object.size ?? null };
    } catch {
      return null;
    }
  }

  /** Rewrite an artifact's stored duration/dimension metadata in place. */
  async patchMetadata(reference: string, patch: Record<string, string>): Promise<void> {
    if (!this.bucket?.get) return;
    const parsed = splitReference(reference);
    if (!parsed) return;
    const key = keyFor(parsed.kind, parsed.hash);
    const object = await this.bucket.get(key).catch(() => null);
    if (!object) return;
    const buffer = object.arrayBuffer ? await object.arrayBuffer() : await streamToArrayBuffer(object.body);
    await this.bucket.put(key, new Uint8Array(buffer), {
      httpMetadata: {
        contentType: object.httpMetadata?.contentType ?? (parsed.kind === "audio" ? "audio/webm" : "video/mp4"),
        cacheControl: object.httpMetadata?.cacheControl ?? `private, max-age=${Math.min(this.ttlSeconds, 3600)}`,
      },
      customMetadata: { ...(object.customMetadata ?? {}), ...patch },
    });
  }

  /**
   * Promote a streamed (random-token) artifact to its content-addressed key.
   *
   * `storeStream` must choose the R2 key before the digest is known, so it
   * writes to a random token. The legacy `video_download_public` /
   * `video_ingest` contract is content-addressed (`video_<sha256>`), so after
   * the stream's SHA-256 is known the object is copied to the hash key and the
   * token object is deleted. A live object already at the hash key is reused
   * (retries/cache hits stay safe) and the token is still cleaned up.
   *
   * The copy streams R2 -> R2 without buffering the file in the Worker when the
   * runtime exposes a readable body; the in-memory fallback only runs in tests.
   * `extraMetadata` (verified duration/container) is applied to the final
   * object in the same copy so no second rewrite is needed. Returns the
   * content-addressed artifact, or `null` when the promotion could not be
   * performed (caller keeps the token artifact).
   */
  async promoteToContentAddress(
    tokenReference: string,
    sha256: string,
    fallback: { bytes: number; contentType: string; durationSeconds: number | null; width: number | null; height: number | null; expiresAt: string },
    extraMetadata: Record<string, string> = {},
  ): Promise<VideoArtifact | null> {
    if (!this.bucket?.get) return null;
    const parsed = splitReference(tokenReference);
    if (!parsed || !/^[a-f0-9]{64}$/.test(sha256) || parsed.hash === sha256) return null;
    const tokenKey = keyFor(parsed.kind, parsed.hash);
    const hashKey = keyFor(parsed.kind, sha256);
    const hashReference = referenceFor(parsed.kind, sha256);

    // A live object already at the hash key wins; the token is just garbage.
    const existing = await this.bucket.head?.(hashKey).catch(() => null);
    const existingExpiry = existing?.customMetadata?.expiresAt ? Date.parse(existing.customMetadata.expiresAt) : 0;
    if (existing && existingExpiry > Date.now()) {
      await this.bucket.delete?.(tokenKey).catch(() => undefined);
      const meta = existing.customMetadata ?? {};
      return {
        reference: hashReference,
        kind: parsed.kind,
        url: `${this.baseUrl}/video-assets/${hashReference}`,
        contentType: existing.httpMetadata?.contentType ?? fallback.contentType,
        bytes: existing.size ?? fallback.bytes,
        sha256,
        expiresAt: meta.expiresAt ?? fallback.expiresAt,
        durationSeconds: meta.durationSeconds !== undefined ? Number(meta.durationSeconds) : fallback.durationSeconds,
        width: meta.width !== undefined ? Number(meta.width) : fallback.width,
        height: meta.height !== undefined ? Number(meta.height) : fallback.height,
      };
    }

    const object = await this.bucket.get(tokenKey).catch(() => null);
    if (!object) return null;
    const httpMetadata = {
      contentType: object.httpMetadata?.contentType ?? fallback.contentType,
      cacheControl: object.httpMetadata?.cacheControl ?? `private, max-age=${Math.min(this.ttlSeconds, 3600)}`,
    };
    const customMetadata: Record<string, string> = {
      ...(object.customMetadata ?? {}),
      sha256,
      kind: parsed.kind,
      ...extraMetadata,
    };
    try {
      const body = (object as VideoObject).body as ReadableStream<Uint8Array> | null | undefined;
      if (body && typeof (body as ReadableStream<Uint8Array>).getReader === "function") {
        await this.bucket.put(hashKey, body as ReadableStream<Uint8Array>, { httpMetadata, customMetadata });
      } else if (object.arrayBuffer) {
        const buffer = await object.arrayBuffer();
        await this.bucket.put(hashKey, new Uint8Array(buffer), { httpMetadata, customMetadata });
      } else {
        return null;
      }
    } catch {
      return null;
    }
    await this.bucket.delete?.(tokenKey).catch(() => undefined);
    return {
      reference: hashReference,
      kind: parsed.kind,
      url: `${this.baseUrl}/video-assets/${hashReference}`,
      contentType: httpMetadata.contentType,
      bytes: object.size ?? fallback.bytes,
      sha256,
      expiresAt: customMetadata.expiresAt ?? fallback.expiresAt,
      durationSeconds: customMetadata.durationSeconds !== undefined ? Number(customMetadata.durationSeconds) : fallback.durationSeconds,
      width: customMetadata.width !== undefined ? Number(customMetadata.width) : fallback.width,
      height: customMetadata.height !== undefined ? Number(customMetadata.height) : fallback.height,
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

  /**
   * Distinguish "expired" from "never existed" for a reference.
   *
   * The acceptance tests require an expired signed URL / expired artifact to be
   * reported as expired rather than as a generic not-found, so the caller can
   * tell the user to re-resolve instead of assuming the video is gone.
   */
  async referenceStatus(reference: string): Promise<"ok" | "expired" | "invalid" | "missing" | "storage_unavailable"> {
    if (!this.bucket) return "storage_unavailable";
    const parsed = splitReference(reference);
    if (!parsed) return "invalid";
    const key = keyFor(parsed.kind, parsed.hash);
    const head = await this.bucket.head?.(key).catch(() => null);
    if (!head) {
      // Without `head` we cannot tell expiry from absence; fall back to a get.
      if (!this.bucket.get) return "missing";
      const object = await this.bucket.get(key).catch(() => null);
      if (!object) return "missing";
      const expiresAt = object.customMetadata?.expiresAt ? Date.parse(object.customMetadata.expiresAt) : 0;
      return expiresAt && expiresAt <= Date.now() ? "expired" : "ok";
    }
    const expiresAt = head.customMetadata?.expiresAt ? Date.parse(head.customMetadata.expiresAt) : 0;
    if (expiresAt && expiresAt <= Date.now()) {
      await this.bucket.delete?.(key).catch(() => undefined);
      return "expired";
    }
    return "ok";
  }

  /** Delete a stored artifact immediately (used when verification fails). */
  async delete(reference: string): Promise<boolean> {
    if (!this.bucket?.delete) return false;
    const parsed = splitReference(reference);
    if (!parsed) return false;
    await this.bucket.delete(keyFor(parsed.kind, parsed.hash)).catch(() => undefined);
    return true;
  }

  /**
   * Read a stored artifact for the public `/video-assets/:reference` route.
   *
   * `range` is honoured so an `<video>` element (or `curl -r`) can seek into a
   * stored artifact without DEMO buffering the file; R2 serves the slice.
   */
  async objectForRoute(reference: string, range?: R2Range | null): Promise<VideoObject | null> {
    if (!this.bucket?.get) return null;
    const parsed = splitReference(reference);
    if (!parsed) return null;
    const key = keyFor(parsed.kind, parsed.hash);
    const object = await this.bucket.get(key, range ? { range } : undefined);
    if (!object) return null;
    const expiresAt = object.customMetadata?.expiresAt ? Date.parse(object.customMetadata.expiresAt) : 0;
    if (expiresAt && expiresAt <= Date.now()) {
      await this.bucket.delete?.(key).catch(() => undefined);
      return null;
    }
    return object;
  }

  /**
   * Route-level state for a reference: `"invalid"` (malformed), `"missing"`
   * (never existed) or `"expired"` (existed but the TTL elapsed). Callers turn
   * these into honest 400/404/410 responses.
   */
  async routeStatus(reference: string): Promise<"invalid" | "missing" | "expired" | "ok" | "storage_unavailable"> {
    if (!this.bucket?.get) return "storage_unavailable";
    const parsed = splitReference(reference);
    if (!parsed) return "invalid";
    const key = keyFor(parsed.kind, parsed.hash);
    const head = await this.bucket.head?.(key).catch(() => null);
    if (!head) return "missing";
    const expiresAt = head.customMetadata?.expiresAt ? Date.parse(head.customMetadata.expiresAt) : 0;
    if (expiresAt && expiresAt <= Date.now()) {
      await this.bucket.delete?.(key).catch(() => undefined);
      return "expired";
    }
    return "ok";
  }
}

/** A byte range in the shape R2's `get()` accepts. */
export interface R2Range {
  offset?: number;
  length?: number;
  suffix?: number;
}

/** Parse a `Range: bytes=...` header into an R2 range, or null when absent. */
export function parseRangeHeader(header: string | null, size: number | null): R2Range | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return null;
  const startText = match[1];
  const endText = match[2];
  if (!startText && !endText) return null;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { suffix };
  }
  const offset = Number(startText);
  if (!Number.isFinite(offset) || offset < 0) return null;
  if (size !== null && offset >= size) return null;
  if (!endText) return { offset };
  const end = Number(endText);
  if (!Number.isFinite(end) || end < offset) return null;
  const length = size !== null ? Math.min(end, size - 1) - offset + 1 : end - offset + 1;
  if (length <= 0) return null;
  return { offset, length };
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
