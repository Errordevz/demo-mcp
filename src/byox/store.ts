/**
 * Build Your Own X — persistence and refresh.
 *
 * The catalog lives in the deployment's existing R2 bucket (the same bucket the
 * screenshot and video-artifact stores already use, under a `byox/` prefix), so
 * this feature adds no binding and no migration. Three objects:
 *
 *   byox/index.json  the parsed catalog (titles, categories, languages, links)
 *   byox/state.json  refresh state: validators, hashes, timestamps, counters
 *   byox/source.md   the README text the index was built from (bounded)
 *
 * Refresh is incremental and failure-safe:
 *   - `If-None-Match` turns an unchanged upstream into a 304 and a timestamp bump;
 *   - a response that parses into fewer than `BYOX_MIN_TUTORIALS` entries is
 *     rejected, so a truncated body or an error page can never replace a good
 *     index;
 *   - any network/parse failure keeps the previous index and reports `stale`
 *     with the reason, instead of pretending the catalog is fresh;
 *   - a minimum interval (default 1 h) bounds upstream traffic, with `force`
 *     available to administrators.
 *
 * DEMO stores references only. Tutorial text is never copied: `byox_read_tutorial`
 * fetches an individual page on demand through the SSRF guard and returns a
 * bounded excerpt plus the canonical link, or says plainly that the page could
 * not be read.
 */

import { guardedFetchText } from "../core/guarded-fetch.js";
import { createSsrfGuard } from "../core/guarded-fetch.js";
import { BrowserError } from "../core/errors.js";
import { BYOX_MIN_TUTORIALS, diffByoxIndexes, parseByoxReadme, type ByoxIndex, type ByoxIndexDiff } from "./catalog.js";

export interface ByoxEnv {
  /** The deployment's administrator key (see `src/core/admin.ts`). */
  DEMO_API_KEY?: string;
  /** Existing R2 bucket (screenshots + video artifacts + this catalog). */
  SCREENSHOTS?: R2Bucket;
  /** Upstream README; overridable for tests and mirrors. */
  BYOX_README_URL?: string;
  /** Minimum seconds between refreshes (60–604800, default 3600). */
  BYOX_REFRESH_MIN_INTERVAL_SECONDS?: string;
  /** Seconds after which the catalog is reported as stale (default 86400). */
  BYOX_STALE_AFTER_SECONDS?: string;
  /** Maximum upstream bytes accepted (default 3 MB). */
  BYOX_MAX_BYTES?: string;
}

const INDEX_KEY = "byox/index.json";
const STATE_KEY = "byox/state.json";
const SOURCE_KEY = "byox/source.md";
const DEFAULT_README_URL = "https://raw.githubusercontent.com/codecrafters-io/build-your-own-x/master/README.md";

export interface ByoxStoreState {
  version: 1;
  etag: string | null;
  lastModified: string | null;
  sha256: string;
  bytes: number;
  fetchedAt: string;
  lastCheckedAt: string;
  lastError: string | null;
  refreshCount: number;
  /** Subset of the diff produced by the last real refresh. */
  lastDiff: ByoxIndexDiff | null;
}

export interface ByoxLoadResult {
  index: ByoxIndex | null;
  stale: boolean;
  ageSeconds: number | null;
  state: ByoxStoreState | null;
  /** Why the catalog is unavailable or stale; never a fabricated success. */
  reason: string | null;
  storage: "r2" | "unavailable";
}

export interface ByoxRefreshResult {
  refreshed: boolean;
  unchanged: boolean;
  index: ByoxIndex | null;
  diff: ByoxIndexDiff | null;
  stale: boolean;
  reason: string | null;
  checkedAt: string;
  storage: "r2" | "unavailable";
}

function boundedNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export function byoxConfig(env: ByoxEnv) {
  return {
    readmeUrl: (env.BYOX_README_URL ?? "").trim() || DEFAULT_README_URL,
    minIntervalSeconds: boundedNumber(env.BYOX_REFRESH_MIN_INTERVAL_SECONDS, 3600, 60, 604_800),
    staleAfterSeconds: boundedNumber(env.BYOX_STALE_AFTER_SECONDS, 86_400, 300, 2_592_000),
    maxBytes: boundedNumber(env.BYOX_MAX_BYTES, 3_000_000, 100_000, 8_000_000),
  };
}

/** In-isolate cache so a search does not read R2 on every call. */
let cache: { key: string; loadedAt: number; result: ByoxLoadResult } | null = null;
const CACHE_MS = 60_000;

export function clearByoxCacheForTests(): void {
  cache = null;
}

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key).catch(() => null);
  if (!object) return null;
  try {
    return (await object.json()) as T;
  } catch {
    return null;
  }
}

export async function sha256HexOfText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Load the stored catalog, honouring the isolate cache and the staleness rule. */
export async function loadByoxIndex(env: ByoxEnv, options: { now?: number; maxAgeSeconds?: number } = {}): Promise<ByoxLoadResult> {
  const bucket = env.SCREENSHOTS;
  const now = options.now ?? Date.now();
  if (!bucket) {
    return { index: null, stale: true, ageSeconds: null, state: null, reason: "This deployment has no R2 binding, so the catalog cannot be stored.", storage: "unavailable" };
  }
  const config = byoxConfig(env);
  const cacheKey = `${config.readmeUrl}:${options.maxAgeSeconds ?? "default"}`;
  if (!options.maxAgeSeconds && cache && cache.key === cacheKey && now - cache.loadedAt < CACHE_MS) return cache.result;

  const index = await readJson<ByoxIndex>(bucket, INDEX_KEY);
  const state = await readJson<ByoxStoreState>(bucket, STATE_KEY);
  if (!index) {
    const result: ByoxLoadResult = { index: null, stale: true, ageSeconds: null, state, reason: "The catalog has not been indexed yet. An administrator must run byox_refresh_index (or POST /byox/refresh with the admin key).", storage: "r2" };
    cache = { key: cacheKey, loadedAt: now, result };
    return result;
  }
  const checkedAt = Date.parse(state?.lastCheckedAt ?? index.source.lastCheckedAt);
  const ageSeconds = Number.isFinite(checkedAt) ? Math.max(0, Math.floor((now - checkedAt) / 1000)) : null;
  const stale = ageSeconds === null || ageSeconds > config.staleAfterSeconds;
  const result: ByoxLoadResult = {
    index,
    stale,
    ageSeconds,
    state,
    reason: stale ? (state?.lastError ?? `The catalog was last checked ${ageSeconds === null ? "at an unknown time" : `${Math.round(ageSeconds / 3600)} h ago`}. Run byox_refresh_index to update it.`) : null,
    storage: "r2",
  };
  cache = { key: cacheKey, loadedAt: now, result };
  return result;
}

/**
 * Refresh the catalog from upstream. `force` bypasses the minimum-interval
 * throttle (administrators only) but never bypasses the parse sanity check.
 */
export async function refreshByoxIndex(
  env: ByoxEnv,
  options: { force?: boolean; now?: number; fetchImpl?: typeof fetch; guard?: (url: string) => Promise<string> } = {},
): Promise<ByoxRefreshResult> {
  const bucket = env.SCREENSHOTS;
  const now = options.now ?? Date.now();
  const checkedAt = new Date(now).toISOString();
  if (!bucket) {
    return { refreshed: false, unchanged: false, index: null, diff: null, stale: true, reason: "This deployment has no R2 binding, so the catalog cannot be stored.", checkedAt, storage: "unavailable" };
  }
  const config = byoxConfig(env);
  const previous = await loadByoxIndex(env, { now, maxAgeSeconds: 0 });
  const state = previous.state;

  if (!options.force && state) {
    const lastChecked = Date.parse(state.lastCheckedAt);
    if (Number.isFinite(lastChecked)) {
      const elapsed = Math.floor((now - lastChecked) / 1000);
      if (elapsed < config.minIntervalSeconds) {
        return {
          refreshed: false,
          unchanged: true,
          index: previous.index,
          diff: null,
          stale: previous.stale,
          reason: `Not refreshed: the catalog was checked ${elapsed}s ago and the minimum interval is ${config.minIntervalSeconds}s.`,
          checkedAt: state.lastCheckedAt,
          storage: "r2",
        };
      }
    }
  }

  const guard = options.guard ?? createSsrfGuard(env as Record<string, unknown>);
  let fetched;
  try {
    fetched = await guardedFetchText(config.readmeUrl, {
      method: "GET",
      guard,
      maxRedirects: 3,
      maxBodyBytes: config.maxBytes,
      ...(state?.etag ? { headers: { "if-none-match": state.etag, "user-agent": "DEMO-MCP/byox-indexer" } } : { headers: { "user-agent": "DEMO-MCP/byox-indexer" } }),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  } catch (error) {
    const reason = `The catalog could not be fetched from ${config.readmeUrl}: ${error instanceof Error ? error.message : String(error)}`;
    if (state) {
      const preserved: ByoxStoreState = { ...state, lastCheckedAt: checkedAt, lastError: reason };
      await bucket.put(STATE_KEY, JSON.stringify(preserved));
    }
    cache = null;
    return { refreshed: false, unchanged: false, index: previous.index, diff: null, stale: true, reason, checkedAt, storage: "r2" };
  }

  if (fetched.status === 304 && previous.index) {
    const next: ByoxStoreState = {
      ...(state ?? {
        version: 1,
        etag: fetched.etag ?? null,
        lastModified: fetched.lastModified ?? null,
        sha256: previous.index.source.sha256,
        bytes: previous.index.source.bytes,
        fetchedAt: previous.index.source.fetchedAt,
        lastCheckedAt: checkedAt,
        lastError: null,
        refreshCount: 1,
        lastDiff: null,
      }),
      etag: fetched.etag ?? state?.etag ?? null,
      lastModified: fetched.lastModified ?? state?.lastModified ?? null,
      lastCheckedAt: checkedAt,
      lastError: null,
    };
    await bucket.put(STATE_KEY, JSON.stringify(next));
    const index: ByoxIndex = { ...previous.index, source: { ...previous.index.source, etag: next.etag, lastModified: next.lastModified, lastCheckedAt: checkedAt, refreshCount: next.refreshCount } };
    await bucket.put(INDEX_KEY, JSON.stringify(index));
    cache = null;
    return { refreshed: true, unchanged: true, index, diff: null, stale: false, reason: "Upstream reported no change (HTTP 304).", checkedAt, storage: "r2" };
  }

  if (fetched.status !== 200) {
    const reason = `The catalog fetch returned HTTP ${fetched.status} from ${fetched.finalUrl}.`;
    if (state) {
      await bucket.put(STATE_KEY, JSON.stringify({ ...state, lastCheckedAt: checkedAt, lastError: reason }));
    }
    cache = null;
    return { refreshed: false, unchanged: false, index: previous.index, diff: null, stale: true, reason, checkedAt, storage: "r2" };
  }

  if (fetched.truncated) {
    const reason = `The catalog exceeded the ${config.maxBytes}-byte cap and was not indexed (a partial README would silently lose entries).`;
    if (state) {
      await bucket.put(STATE_KEY, JSON.stringify({ ...state, lastCheckedAt: checkedAt, lastError: reason }));
    }
    cache = null;
    return { refreshed: false, unchanged: false, index: previous.index, diff: null, stale: true, reason, checkedAt, storage: "r2" };
  }

  const sha256 = await sha256HexOfText(fetched.body);
  const unchanged = Boolean(previous.index && state?.sha256 === sha256);
  let parsed;
  try {
    parsed = parseByoxReadme(fetched.body, {
      readmeUrl: config.readmeUrl,
      etag: fetched.etag ?? null,
      lastModified: fetched.lastModified ?? null,
      sha256,
      fetchedAt: checkedAt,
    });
  } catch (error) {
    const reason = `The catalog text could not be parsed: ${error instanceof Error ? error.message : String(error)}`;
    if (state) {
      await bucket.put(STATE_KEY, JSON.stringify({ ...state, lastCheckedAt: checkedAt, lastError: reason }));
    }
    cache = null;
    return { refreshed: false, unchanged: false, index: previous.index, diff: null, stale: true, reason, checkedAt, storage: "r2" };
  }

  if (parsed.index.counts.tutorials < BYOX_MIN_TUTORIALS) {
    const reason = `Refusing to replace the catalog: the fetched README parsed into only ${parsed.index.counts.tutorials} tutorials (minimum ${BYOX_MIN_TUTORIALS}). The previous index was kept.`;
    if (state) {
      await bucket.put(STATE_KEY, JSON.stringify({ ...state, lastCheckedAt: checkedAt, lastError: reason }));
    }
    cache = null;
    return { refreshed: false, unchanged: false, index: previous.index, diff: null, stale: true, reason, checkedAt, storage: "r2" };
  }

  const diff = diffByoxIndexes(previous.index, parsed.index);
  const index: ByoxIndex = {
    ...parsed.index,
    source: {
      ...parsed.index.source,
      etag: fetched.etag ?? null,
      lastModified: fetched.lastModified ?? null,
      fetchedAt: unchanged ? (previous.index?.source.fetchedAt ?? checkedAt) : checkedAt,
      lastCheckedAt: checkedAt,
      refreshCount: (state?.refreshCount ?? 0) + 1,
    },
  };
  const nextState: ByoxStoreState = {
    version: 1,
    etag: index.source.etag,
    lastModified: index.source.lastModified,
    sha256,
    bytes: fetched.body.length,
    fetchedAt: index.source.fetchedAt,
    lastCheckedAt: checkedAt,
    lastError: null,
    refreshCount: index.source.refreshCount,
    lastDiff: diff,
  };

  // Write the source text first: if the index write fails, the next refresh
  // still has a consistent state hash to compare against.
  await bucket.put(SOURCE_KEY, fetched.body.slice(0, config.maxBytes), { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
  await bucket.put(INDEX_KEY, JSON.stringify(index));
  await bucket.put(STATE_KEY, JSON.stringify(nextState));
  cache = null;
  return {
    refreshed: true,
    unchanged,
    index,
    diff,
    stale: false,
    reason: unchanged ? "Upstream content is identical to the stored index (hash match)." : null,
    checkedAt,
    storage: "r2",
  };
}

/** The raw README snapshot kept for auditing a refresh (bounded, references only). */
export async function readByoxSourceSnapshot(env: ByoxEnv): Promise<{ text: string; bytes: number } | null> {
  const bucket = env.SCREENSHOTS;
  if (!bucket) return null;
  const object = await bucket.get(SOURCE_KEY).catch(() => null);
  if (!object) return null;
  const text = await object.text();
  return { text, bytes: text.length };
}

/** Read one tutorial page on demand — bounded, guarded, never cached as content. */
export async function readTutorialPage(
  env: ByoxEnv,
  url: string,
  options: { fetchImpl?: typeof fetch; guard?: (url: string) => Promise<string>; maxBytes?: number; maxChars?: number } = {},
): Promise<{ status: number; finalUrl: string; contentType: string | null; text: string; truncated: boolean; bytes: number }> {
  const guard = options.guard ?? createSsrfGuard(env as Record<string, unknown>);
  const maxBytes = Math.min(1_500_000, Math.max(20_000, options.maxBytes ?? 400_000));
  const result = await guardedFetchText(url, {
    method: "GET",
    guard,
    maxRedirects: 4,
    maxBodyBytes: maxBytes,
    fetchImpl: options.fetchImpl,
  });
  const maxChars = Math.min(60_000, Math.max(1_000, options.maxChars ?? 20_000));
  const text = result.body.length > maxChars ? `${result.body.slice(0, maxChars)}\n…[truncated by DEMO]` : result.body;
  return { status: result.status, finalUrl: result.finalUrl, contentType: result.contentType, text, truncated: result.truncated || result.body.length > maxChars, bytes: result.body.length };
}

/** Small helper so tools can raise the same honest error shape everywhere. */
export function byoxUnavailable(reason: string): BrowserError {
  return new BrowserError("capability_unavailable", reason, {
    hint: "The Build Your Own X catalog needs the SCREENSHOTS R2 binding and a reachable upstream README. An administrator can run byox_refresh_index (MCP, admin key) or POST /byox/refresh.",
    capability: "byox",
  });
}
