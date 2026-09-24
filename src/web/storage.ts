/**
 * Snapshot + monitor storage (DEMO 0.9) on DEMO's existing R2 bucket.
 *
 * Deliberately *not* a new database: web_diff, web_monitor and screenshot
 * comparison all persist through this one store, which writes R2 objects with
 * `customMetadata.expiresAt` exactly like `ScreenshotManager` and
 * `VideoArtifactStore` do — so the Worker's existing scheduled cleanup sweep
 * and bucket lifecycle policy are the TTL mechanism for these objects too.
 *
 * State is content + timestamps only: no identity, no IP, no cookies, no
 * per-user tracking. Snapshot text is normalized extracted content, never the
 * raw DOM, so stored bytes stay small and comparable.
 */

import { BrowserError } from "../core/errors.js";
import { LIMITS, clamp } from "../core/limits.js";

/** Structural subset of `R2Bucket` (same approach as `VideoObjectStore`). */
export interface WebObjectStore {
  put(key: string, value: Uint8Array | ArrayBuffer | string, options?: { httpMetadata?: { contentType?: string; cacheControl?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<{ text?(): Promise<string>; arrayBuffer?(): Promise<ArrayBuffer>; body?: ReadableStream<Uint8Array>; customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } } | null>;
  head?(key: string): Promise<{ size?: number; customMetadata?: Record<string, string> } | null>;
  delete(key: string): Promise<void>;
  list?(options?: { prefix?: string; limit?: number }): Promise<{ objects: Array<{ key: string; size?: number; lastModified?: Date; customMetadata?: Record<string, string> }>; truncated?: boolean }>;
}

export interface SnapshotDocument {
  schema: 1;
  url: string;
  finalUrl: string;
  fetchedAt: string;
  status: number | null;
  title: string | null;
  /** Normalized extracted text (diff basis). */
  text: string;
  fingerprint: string;
  chars: number;
  /** "web-noise" | "whitespace" | "none" — recorded so re-diffs stay honest. */
  normalization: string;
  source: "web_diff" | "web_monitor" | "manual";
}

export interface MonitorVersion {
  checkedAt: string;
  fingerprint: string;
  status: number | null;
  changed: boolean;
  summary?: string;
  snapshotKey?: string;
  error?: string;
}

export interface MonitorDocument {
  schema: 1;
  id: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  intervalSeconds: number;
  normalize: string;
  maxVersions: number;
  retentionSeconds: number;
  lastFingerprint: string | null;
  versions: MonitorVersion[];
  /** Distinguishes "fetched and identical" from "never fetched". */
  baselineFingerprint: string | null;
}

function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  if (parsed.pathname === "/" && parsed.search === "") return `${parsed.protocol}//${parsed.host}/`;
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
}

export function snapshotPrefixFor(url: string): string {
  // Shard by host hash so `list` stays cheap; no user data in the key.
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "unknown";
    }
  })();
  let hash = 0;
  for (let i = 0; i < host.length; i++) hash = (hash * 31 + host.charCodeAt(i)) >>> 0;
  return `web-snap/${hash.toString(16).padStart(8, "0")}/`;
}

export async function sha256Hex(text: string): Promise<string> {
  // Copy into a fresh buffer: Workers require a standalone ArrayBuffer view.
  const bytes = new TextEncoder().encode(text);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  return `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export class WebSnapshotStore {
  constructor(
    readonly bucket: WebObjectStore | null,
    readonly retentionSeconds: number = LIMITS.snapshotRetentionDefaultSeconds,
  ) {}

  static fromEnv(env: Record<string, unknown> | undefined): WebSnapshotStore {
    const bucket = (env?.WEB_SNAPSHOTS ?? env?.SCREENSHOTS) as WebObjectStore | undefined;
    const retention = clamp(
      Number(env?.SNAPSHOT_RETENTION_SECONDS ?? LIMITS.snapshotRetentionDefaultSeconds),
      3_600,
      LIMITS.snapshotRetentionMaxSeconds,
    );
    return new WebSnapshotStore(bucket ?? null, Number.isFinite(retention) ? retention : LIMITS.snapshotRetentionDefaultSeconds);
  }

  get available(): boolean {
    return Boolean(this.bucket);
  }

  private assertAvailable(): WebObjectStore {
    if (!this.bucket) {
      throw new BrowserError("capability_unavailable", "Web snapshot storage is not configured. Bind SCREENSHOTS (an R2 bucket) — the monitor and diff history reuse DEMO's existing artifact bucket.", {
        capability: "web_snapshot_storage",
        hint: "Screenshots, snapshots and monitor state share the existing R2 bucket; no new storage system is required.",
      });
    }
    return this.bucket;
  }

  async storeSnapshot(document: Omit<SnapshotDocument, "schema" | "fingerprint" | "chars">): Promise<{ key: string; fingerprint: string; chars: number; expiresAt: string }> {
    const bucket = this.assertAvailable();
    const fingerprint = await sha256Hex(document.text);
    const key = `${snapshotPrefixFor(document.url)}s-${Date.now()}-${fingerprint.slice(0, 8)}.json`;
    const full: SnapshotDocument = { schema: 1, fingerprint, chars: document.text.length, ...document };
    const expiresAt = new Date(Date.now() + this.retentionSeconds * 1_000).toISOString();
    await bucket.put(key, JSON.stringify(full), {
      httpMetadata: { contentType: "application/json", cacheControl: "private, no-store" },
      customMetadata: { expiresAt, kind: "web-snapshot", fingerprint },
    });
    return { key, fingerprint, chars: full.chars, expiresAt };
  }

  async readSnapshot(key: string): Promise<SnapshotDocument | null> {
    const bucket = this.assertAvailable();
    if (!/^[a-z0-9-]+\/*.*\.json$/i.test(key) && !key.startsWith("web-snap/")) {
      throw new BrowserError("invalid_input", "snapshot_key must be a key returned by web_diff/web_monitor.");
    }
    const object = await bucket.get(key);
    if (!object) return null;
    const expiresAt = object.customMetadata?.expiresAt ? Date.parse(object.customMetadata.expiresAt) : 0;
    if (expiresAt && expiresAt <= Date.now()) {
      await bucket.delete(key).catch(() => undefined);
      throw new BrowserError("ARTIFACT_EXPIRED", "That snapshot passed its retention window and was deleted.", {
        hint: "Store a fresh snapshot with web_diff (store_snapshot: true) or web_monitor.",
      });
    }
    const text = object.text ? await object.text() : new TextDecoder().decode(await this.readStream(object));
    try {
      return JSON.parse(text) as SnapshotDocument;
    } catch {
      throw new BrowserError("internal", "The stored snapshot could not be decoded.");
    }
  }

  private async readStream(object: { body?: ReadableStream<Uint8Array> }): Promise<Uint8Array> {
    if (!object.body) return new Uint8Array();
    const reader = object.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total > LIMITS.webpageMaxHtmlBytes) throw new BrowserError("size_limit_exceeded", "Stored snapshot exceeds the read budget.");
      }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }

  /* ------------------------------------------------------------- monitors */

  monitorKey(id: string): string {
    if (!/^[a-f0-9]{48}$/.test(id)) throw new BrowserError("invalid_input", "monitor_id must be the identifier returned by web_monitor (mode: add).");
    return `web-mon/${id}.json`;
  }

  newMonitorId(): string {
    return randomToken();
  }

  async saveMonitor(document: MonitorDocument): Promise<void> {
    const bucket = this.assertAvailable();
    const expiresAt = new Date(Date.now() + document.retentionSeconds * 1_000).toISOString();
    await bucket.put(this.monitorKey(document.id), JSON.stringify(document), {
      httpMetadata: { contentType: "application/json", cacheControl: "private, no-store" },
      customMetadata: { expiresAt, kind: "web-monitor" },
    });
  }

  async loadMonitor(id: string): Promise<MonitorDocument | null> {
    const bucket = this.assertAvailable();
    const object = await bucket.get(this.monitorKey(id));
    if (!object) return null;
    const text = object.text ? await object.text() : new TextDecoder().decode(await this.readStream(object));
    try {
      return JSON.parse(text) as MonitorDocument;
    } catch {
      throw new BrowserError("internal", "The monitor record could not be decoded; re-create it with web_monitor.");
    }
  }

  async deleteMonitor(id: string): Promise<boolean> {
    const bucket = this.assertAvailable();
    const key = this.monitorKey(id);
    const exists = await bucket.get(key);
    if (!exists) return false;
    await bucket.delete(key);
    return true;
  }

  /** Bounded monitor listing (one R2 page; monitors are deliberately few). */
  async listMonitors(limit = 20): Promise<Array<{ id: string; key: string; size: number; expiresAt: string | null; lastModified: string | null }>> {
    const bucket = this.assertAvailable();
    if (!bucket.list) return [];
    const listed = await bucket.list({ prefix: "web-mon/", limit: Math.min(1_000, Math.max(limit * 10, 50)) });
    const out: Array<{ id: string; key: string; size: number; expiresAt: string | null; lastModified: string | null }> = [];
    for (const object of listed.objects.slice(0, LIMITS.monitorMaxPerDeploymentHint)) {
      const match = /^web-mon\/([a-f0-9]{48})\.json$/.exec(object.key);
      if (!match) continue;
      out.push({
        id: match[1],
        key: object.key,
        size: object.size ?? 0,
        expiresAt: object.customMetadata?.expiresAt ?? null,
        lastModified: object.lastModified ? new Date(object.lastModified).toISOString() : null,
      });
      if (out.length >= limit) break;
    }
    return out;
  }
}

export function clampMonitorInterval(value: number | undefined): number {
  return clamp(value ?? 3_600, LIMITS.monitorMinCheckIntervalSeconds, 7 * 24 * 60 * 60);
}

export function clampMonitorVersions(value: number | undefined): number {
  return clamp(value ?? LIMITS.monitorMaxVersionsDefault, 1, LIMITS.monitorMaxVersionsCap);
}

/** Trim version history to the retention count, oldest first. */
export function trimVersions(versions: MonitorVersion[], max: number): MonitorVersion[] {
  return versions.length > max ? versions.slice(versions.length - max) : versions;
}
