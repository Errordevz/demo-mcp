/**
 * Internet Archive + Wayback Machine client (DEMO 0.9) — public APIs only, no
 * API key required for any of these endpoints, and every request goes through
 * DEMO's SSRF-guarded HTTP stack.
 *
 * Sources (all public, no auth):
 *   - Wayback availability API  https://archive.org/wayback/available
 *   - Wayback CDX server        https://web.archive.org/cdx/search/cdx
 *   - Wayback snapshot replay   https://web.archive.org/web/<ts>id_/<url>
 *   - Archive.org search        https://archive.org/advancedsearch.php
 *   - Archive.org item metadata https://archive.org/metadata/<identifier>
 *
 * Honesty rules this module implements:
 *   - "no snapshot exists" is a normal, structured outcome (`snapshot: null`),
 *   - restricted/blocked items report `restricted: true` with the status,
 *   - upstream throttling (429/503/509) maps to a stable `rate_limited`,
 *   - results always carry both the *original* URL and the archive timestamp.
 */

import { BrowserError } from "../core/errors.js";
import { createSsrfGuard, guardedFetchBytes, guardedFetchJson } from "../core/guarded-fetch.js";
import { LIMITS, clamp } from "../core/limits.js";
import { publicToolRateLimiter } from "../core/rate-limit.js";
import { extractPage, toPlainText, type ExtractedPage } from "../web/extract.js";

/** Pinned public origins — a misconfigured variable cannot redirect these. */
export const ARCHIVE_ORIGINS = {
  wayback: "https://web.archive.org",
  archive: "https://archive.org",
} as const;

export interface ArchiveEnv {
  ARCHIVE_RATE_LIMIT_PER_MINUTE?: string | number;
}

function charge(env: Record<string, unknown> | undefined, operation: string, target: string): void {
  publicToolRateLimiter.charge(env, operation, target);
}

/* ─────────────────────────────── Wayback ─────────────────────────────────── */

export interface WaybackSnapshot {
  timestamp: string;
  originalUrl: string;
  archiveUrl: string;
  status: string | null;
  mimetype: string | null;
  digest: string | null;
  length: string | null;
}

export interface WaybackAvailability {
  available: boolean;
  snapshot: WaybackSnapshot | null;
  closestTo: string | null;
  message: string;
  checkedAt: string;
}

/** Find the closest snapshot to `timestamp` (or "now") for a URL. */
export async function waybackClosest(env: Record<string, unknown> | undefined, originalUrl: string, timestamp?: string | null): Promise<WaybackAvailability> {
  charge(env, "wayback", originalUrl);
  const guard = createSsrfGuard(env);
  // Validate the *original* URL too: the archive only echoes what exists, and
  // DEMO must not become a proxy that reaches targets its own guard would deny.
  const target = await guard(originalUrl);
  const stamp = normalizeTimestamp(timestamp);
  const query = new URLSearchParams({ url: target, ...(stamp ? { timestamp: stamp } : {}) });
  const result = await guardedFetchJson<{ archived_snapshots?: Record<string, { url?: string; timestamp?: string; status?: string; mimetype?: string; digest?: string; length?: string }> }>(
    `${ARCHIVE_ORIGINS.archive}/wayback/available?${query.toString()}`,
    { guard, timeoutMs: 15_000, maxBytes: 500_000, headers: { accept: "application/json" } },
  );
  const entry = result.json.archived_snapshots?.closest ?? null;
  if (!entry?.timestamp || !entry.url) {
    return {
      available: false,
      snapshot: null,
      closestTo: stamp ?? new Date().toISOString(),
      message: `No Wayback Machine snapshot exists for ${target}${stamp ? ` around ${stamp}` : ""}. The archive does not capture every URL — this is not an error.`,
      checkedAt: new Date().toISOString(),
    };
  }
  return {
    available: true,
    snapshot: {
      timestamp: entry.timestamp,
      originalUrl: target,
      archiveUrl: entry.url,
      status: entry.status ?? null,
      mimetype: entry.mimetype ?? null,
      digest: entry.digest ?? null,
      length: entry.length ?? null,
    },
    closestTo: stamp ?? new Date().toISOString(),
    message: `A snapshot was found at ${entry.timestamp}. The archived copy is the page as the archive captured it on that date; the original URL is ${target}.`,
    checkedAt: new Date().toISOString(),
  };
}

export interface CdxRow {
  timestamp: string;
  originalUrl: string;
  archiveUrl: string;
  status: string | null;
  mimetype: string | null;
  digest: string | null;
  length: string | null;
}

export interface SnapshotListing {
  originalUrl: string;
  from: string | null;
  to: string | null;
  snapshots: CdxRow[];
  truncated: boolean;
  message: string;
}

/**
 * List snapshots around a date / within a window using the CDX server.
 * `limit` bounds rows returned (max 2000); `collapse` defaults to timestamp day
 * so callers get "snapshots around a requested date" rather than raw noise.
 */
export async function waybackSnapshots(
  env: Record<string, unknown> | undefined,
  originalUrl: string,
  options: { from?: string | null; to?: string | null; limit?: number; matchType?: "exact" | "prefix" | "host"; collapse?: "day" | "none" | "digest" } = {},
): Promise<SnapshotListing> {
  charge(env, "wayback-list", originalUrl);
  const guard = createSsrfGuard(env);
  const target = await guard(originalUrl);
  const limit = clamp(options.limit ?? 50, 1, LIMITS.archiveCdxMaxRowsCap);
  const params = new URLSearchParams({
    url: target,
    output: "json",
    limit: String(limit),
    fl: "timestamp,original,statuscode,mimetype,digest,length",
    filter: "statuscode:200",
  });
  if (options.from) params.set("from", normalizeTimestamp(options.from) ?? "");
  if (options.to) params.set("to", normalizeTimestamp(options.to) ?? "");
  params.set("matchType", options.matchType ?? "exact");
  if ((options.collapse ?? "day") !== "none") params.set("collapse", options.collapse === "digest" ? "digest" : "timestamp:8");

  const result = await guardedFetchJson<Array<string[] | string>>(`${ARCHIVE_ORIGINS.wayback}/cdx/search/cdx?${params.toString()}`, {
    guard,
    timeoutMs: 15_000,
    maxBytes: 2_000_000,
    headers: { accept: "application/json" },
  });
  const rows = Array.isArray(result.json) ? result.json : [];
  // First row is the CDX header when present.
  const body = rows.filter((row) => Array.isArray(row)) as string[][];
  const snapshots: CdxRow[] = body
    .filter((row) => row[0] && /^\d{14}$/.test(row[0]))
    .map((row) => ({
      timestamp: row[0],
      originalUrl: row[1] ?? target,
      archiveUrl: `${ARCHIVE_ORIGINS.wayback}/web/${row[0]}/${row[1] ?? target}`,
      status: row[2] ?? null,
      mimetype: row[3] ?? null,
      digest: row[4] ?? null,
      length: row[5] ?? null,
    }));
  return {
    originalUrl: target,
    from: options.from ?? null,
    to: options.to ?? null,
    snapshots: snapshots.slice(0, limit),
    truncated: snapshots.length > limit,
    message:
      snapshots.length === 0
        ? `The Wayback Machine has no matching snapshots for ${target} in the requested window. Not every URL is archived.`
        : `Found ${snapshots.length} snapshot(s). Each entry preserves the original URL and the capture timestamp.`,
  };
}

export interface RetrievedSnapshot {
  originalUrl: string;
  timestamp: string;
  archiveUrl: string;
  status: number;
  contentType: string | null;
  extracted: ExtractedPage | null;
  text: string | null;
  bytes: number;
  message: string;
}

/**
 * Retrieve an archived webpage when a snapshot exists. `id_` suffix returns
 * the original captured bytes without the Wayback toolbar; extraction runs on
 * the captured markup exactly like live pages.
 */
export async function waybackRetrieve(
  env: Record<string, unknown> | undefined,
  originalUrl: string,
  options: { timestamp?: string | null; extract?: "text" | "structured" | "none" } = {},
): Promise<RetrievedSnapshot> {
  charge(env, "wayback-retrieve", originalUrl);
  const guard = createSsrfGuard(env);
  const target = await guard(originalUrl);
  const availability = await waybackClosest(env, originalUrl, options.timestamp);
  if (!availability.available || !availability.snapshot) {
    throw new BrowserError("page_not_found", availability.message, {
      retryable: false,
      hint: "Try wayback mode: snapshots to list captures around a date, or search for other archived resources.",
    });
  }
  const snapshot = availability.snapshot;
  // Rewrite the archive URL to `id_` form (raw capture) and fetch it.
  const replayUrl = `${ARCHIVE_ORIGINS.wayback}/web/${snapshot.timestamp}id_/${target}`;
  const result = await guardedFetchBytes(replayUrl, {
    guard,
    timeoutMs: 20_000,
    maxBytes: LIMITS.archiveSnapshotMaxBytes,
    acceptContentTypes: ["text/html", "application/xhtml", "text/plain", "application/pdf", "application/json", "text/xml", "application/xml", "image/", "text/"],
    headers: { accept: "text/html,application/xhtml+xml,text/plain,*/*;q=0.5" },
  });
  const text = new TextDecoder("utf-8", { fatal: false }).decode(result.bytes);
  const wantsExtraction = (options.extract ?? "text") !== "none" && /html|xhtml/i.test(result.contentType ?? "text/html");
  const extracted = wantsExtraction ? extractPage(text, { url: target }) : null;
  return {
    originalUrl: target,
    timestamp: snapshot.timestamp,
    archiveUrl: snapshot.archiveUrl,
    status: result.status,
    contentType: result.contentType,
    extracted,
    text: wantsExtraction && extracted ? toPlainText(extracted) : text.slice(0, LIMITS.archiveSnapshotMaxBytes / 4),
    bytes: result.bytes.byteLength,
    message: `Retrieved the archived capture of ${target} from ${snapshot.timestamp}. Content is the page as of that timestamp and may differ from the live page.`,
  };
}

/* ───────────────────────────── archive.org items ─────────────────────────── */

export interface ArchiveSearchItem {
  identifier: string;
  title: string | null;
  mediatype: string | null;
  description: string | null;
  date: string | null;
  year: number | null;
  creator: string | null;
  collection: string[] | string | null;
  itemUrl: string;
}

export interface ArchiveSearchResult {
  query: string;
  scope: "web" | "items";
  total: number;
  items: ArchiveSearchItem[];
  message: string;
}

/** Search archive.org items (mediatype texts/audio/movies/software/…) — no key. */
export async function archiveSearchItems(
  env: Record<string, unknown> | undefined,
  query: string,
  options: { limit?: number; page?: number; mediatype?: string; sort?: string } = {},
): Promise<ArchiveSearchResult> {
  charge(env, "archive-search", query);
  const guard = createSsrfGuard(env);
  const limit = clamp(options.limit ?? 10, 1, 50);
  const page = clamp(options.page ?? 1, 1, 100);
  const params = new URLSearchParams({
    q: `${query.slice(0, 400)}${options.mediatype ? ` AND mediatype:${options.mediatype}` : ""}`,
    rows: String(limit),
    page: String(page),
    output: "json",
    sort: options.sort ?? "downloads desc",
  });
  params.set("fl[]", "identifier,title,mediatype,description,date,year,creator,collection");
  const queryText = params.toString();
  const result = await guardedFetchJson<{ response?: { numFound?: number; docs?: Array<Record<string, unknown>> } }>(
    `${ARCHIVE_ORIGINS.archive}/advancedsearch.php?${queryText}`,
    { guard, timeoutMs: 15_000, maxBytes: 3_000_000, headers: { accept: "application/json" } },
  );
  const docs = result.json.response?.docs ?? [];
  const items: ArchiveSearchItem[] = docs.slice(0, limit).map((doc) => ({
    identifier: String(doc.identifier ?? "").slice(0, 200),
    title: typeof doc.title === "string" ? doc.title.slice(0, 400) : Array.isArray(doc.title) ? String(doc.title[0]).slice(0, 400) : null,
    mediatype: typeof doc.mediatype === "string" ? doc.mediatype : null,
    description: typeof doc.description === "string" ? doc.description.slice(0, 800) : Array.isArray(doc.description) ? String(doc.description[0]).slice(0, 800) : null,
    date: typeof doc.date === "string" ? doc.date.slice(0, 40) : null,
    year: typeof doc.year === "number" ? doc.year : null,
    creator: typeof doc.creator === "string" ? doc.creator.slice(0, 200) : Array.isArray(doc.creator) ? String(doc.creator[0]).slice(0, 200) : null,
    collection: (doc.collection as string[] | string | undefined) ?? null,
    itemUrl: `https://archive.org/details/${encodeURIComponent(String(doc.identifier ?? ""))}`,
  }));
  return {
    query,
    scope: "items",
    total: result.json.response?.numFound ?? items.length,
    items,
    message: items.length === 0 ? "No archive.org items matched this query." : `Found ${items.length} item(s). Use archive mode: item to inspect metadata and files of any identifier.`,
  };
}

export interface ArchiveItemFile {
  name: string;
  source: string | null;
  format: string | null;
  length: number | null;
  md5: string | null;
  sha1: string | null;
  mtime: string | null;
}

export interface ArchiveItem {
  identifier: string;
  title: string | null;
  description: string | null;
  date: string | null;
  creator: string | null;
  collection: string[] | string | null;
  mediatype: string | null;
  publisher: string | null;
  subject: string[] | string | null;
  licenseurl: string | null;
  server: string | null;
  dir: string | null;
  workableServers: string[] | null;
  metadata: Record<string, unknown>;
  files: ArchiveItemFile[];
  filesTruncated: boolean;
  filesAvailable: number;
  itemUrl: string;
  restricted: boolean;
  message: string;
}

/** Item metadata + file listing via the public /metadata/<id> endpoint. */
export async function archiveItem(env: Record<string, unknown> | undefined, identifier: string, options: { maxFiles?: number } = {}): Promise<ArchiveItem> {
  charge(env, "archive-item", identifier);
  const guard = createSsrfGuard(env);
  const id = identifier.trim();
  if (!/^[A-Za-z0-9][\w.:-]{0,199}$/.test(id) || id.includes("..") || id.includes("//")) {
    throw new BrowserError("invalid_input", "An archive.org identifier must start with a letter or digit and may contain letters, digits and - _ . : only (no path segments).", { retryable: false });
  }
  const result = await guardedFetchJson<{ metadata?: Record<string, unknown>; files?: Array<Record<string, unknown>>; server?: string; dir?: string; workable_servers?: string[]; error?: string }>(
    `${ARCHIVE_ORIGINS.archive}/metadata/${encodeURIComponent(id)}`,
    { guard, timeoutMs: 15_000 },
  );
  const body = result.json;
  if (body.error) {
    throw new BrowserError("page_not_found", `The archive item "${id}" is not available: ${String(body.error).slice(0, 160)}`, {
      retryable: false,
      hint: "Check the identifier (see archive mode: search). Restricted items report access-restricted instead.",
    });
  }
  const maxFiles = clamp(options.maxFiles ?? 100, 1, 500);
  const files = (body.files ?? []).slice(0, maxFiles).map((file) => ({
    name: String(file.name ?? "").slice(0, 400),
    source: typeof file.source === "string" ? file.source : null,
    format: typeof file.format === "string" ? file.format : null,
    length: Number.isFinite(Number(file.length)) ? Number(file.length) : null,
    md5: typeof file.md5 === "string" ? file.md5 : null,
    sha1: typeof file.sha1 === "string" ? file.sha1 : null,
    mtime: typeof file.mtime === "string" ? file.mtime : null,
  }));
  const metadata = body.metadata ?? {};
  const restricted = /true/i.test(String(metadata.access_restricted ?? "")) || Boolean(metadata.access_restricted_item);
  const value = (key: string): unknown => metadata[key];
  const stringOrArray = (key: string): string[] | string | null => {
    const raw = value(key);
    if (typeof raw === "string") return raw.slice(0, 400);
    if (Array.isArray(raw)) return raw.slice(0, 20).map((entry) => String(entry).slice(0, 200));
    return null;
  };
  return {
    identifier: id,
    title: typeof metadata.title === "string" ? metadata.title.slice(0, 400) : null,
    description: typeof metadata.description === "string" ? metadata.description.slice(0, 1_200) : null,
    date: typeof metadata.date === "string" ? metadata.date.slice(0, 40) : null,
    creator: typeof metadata.creator === "string" ? metadata.creator.slice(0, 200) : null,
    collection: stringOrArray("collection"),
    mediatype: typeof metadata.mediatype === "string" ? metadata.mediatype : null,
    publisher: typeof metadata.publisher === "string" ? metadata.publisher.slice(0, 200) : null,
    subject: stringOrArray("subject"),
    licenseurl: typeof metadata.licenseurl === "string" ? metadata.licenseurl.slice(0, 300) : null,
    server: body.server ?? null,
    dir: body.dir ?? null,
    workableServers: body.workable_servers ?? null,
    metadata: Object.fromEntries(Object.entries(metadata).slice(0, 60).map(([key, entry]) => [key, typeof entry === "string" ? entry.slice(0, 400) : entry])),
    files,
    filesTruncated: (body.files ?? []).length > maxFiles,
    filesAvailable: (body.files ?? []).length,
    itemUrl: `https://archive.org/details/${encodeURIComponent(id)}`,
    restricted,
    message: restricted
      ? "This item exists but access is restricted ( lending or login-gated ). DEMO reports the restriction instead of attempting to bypass it."
      : `${files.length} file(s) listed${(body.files ?? []).length > maxFiles ? ` (truncated at ${maxFiles})` : ""}. File contents are served from archive.org's public download paths; use the Wayback tools for archived web pages.`,
  };
}

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{14}$/.test(raw)) return raw;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new BrowserError("invalid_input", "Timestamps must be ISO-8601 or Wayback format YYYYMMDDhhmmss.");
  }
  return new Date(parsed).toISOString().replace(/[-:T]/g, "").slice(0, 14);
}
