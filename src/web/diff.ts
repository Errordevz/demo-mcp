/**
 * Web-content diff (DEMO 0.9) — fetch current page → extract → compare.
 *
 * The diff itself is the shared `core/text-diff` engine; snapshots persist on
 * DEMO's existing R2 bucket through `web/storage` (TTL + cleanup like every
 * other artifact). Normalization (`normalizeForDiff`) strips obvious dynamic
 * noise (timestamps, counters, tokens) before comparison so "changed" means
 * content changed.
 */

import { BrowserError } from "../core/errors.js";
import { LIMITS, clamp } from "../core/limits.js";
import { changedSections, diffLines, normalizeForDiff, splitLines, summarizeDiff, toUnifiedDiff, type ChangedSection } from "../core/text-diff.js";
import { toPlainText, toMarkdown, type ExtractedPage } from "./extract.js";
import { fetchPublicPage } from "./fetch-page.js";
import { WebSnapshotStore, sha256Hex, type SnapshotDocument } from "./storage.js";

export type NormalizationPreset = "web-noise" | "whitespace" | "none";

export interface WebDiffResult {
  url: string;
  finalUrl: string;
  status: number;
  normalization: NormalizationPreset;
  baseline: { source: "supplied" | "snapshot" | "stored-latest" | "none"; snapshotKey: string | null; fetchedAt: string | null; chars: number | null };
  current: { fetchedAt: string; title: string | null; chars: number; fingerprint: string };
  summary: ReturnType<typeof summarizeDiff>;
  sections: ChangedSection[];
  unifiedDiff: string | null;
  added: string[];
  removed: string[];
  changed: Array<{ before: string; after: string }>;
  stored: { snapshotKey: string; expiresAt: string } | null;
  message: string;
}

export interface WebDiffOptions {
  env: Record<string, unknown> | undefined;
  url: string;
  previousText?: string | null;
  snapshotKey?: string | null;
  normalization?: NormalizationPreset;
  storeSnapshot?: boolean;
  timeoutMs?: number;
  maxChars?: number;
  includeUnifiedDiff?: boolean;
  /** Pre-fetched current text (used by web_monitor to avoid double fetching). */
  currentText?: string | null;
  currentPage?: ExtractedPage | null;
}

/** Fetch (or reuse) the current page and diff it against a baseline. */
export async function computeWebDiff(options: WebDiffOptions): Promise<WebDiffResult> {
  const normalization = options.normalization ?? "web-noise";
  const store = WebSnapshotStore.fromEnv(options.env);

  // Baseline resolution order: explicit previous_text → snapshot_key → none.
  // Resolved BEFORE the fetch so a bad/expired baseline (or missing storage)
  // fails fast without spending a request.
  let baselineText: string | null = null;
  let baselineSource: WebDiffResult["baseline"]["source"] = "none";
  let baselineKey: string | null = null;
  let baselineFetchedAt: string | null = null;
  if (options.previousText != null) {
    baselineText = options.previousText;
    baselineSource = "supplied";
  } else if (options.snapshotKey) {
    if (!store.available) throw storageUnavailable();
    const snapshot = await store.readSnapshot(options.snapshotKey);
    if (!snapshot) throw new BrowserError("page_not_found", "That snapshot key does not exist (it may have been cleaned up after its retention window).", { retryable: false });
    baselineText = snapshot.text;
    baselineSource = "snapshot";
    baselineKey = options.snapshotKey;
    baselineFetchedAt = snapshot.fetchedAt;
  }

  let currentText = options.currentText ?? null;
  let page = options.currentPage ?? null;
  let status = 200;
  let finalUrl = options.url;
  if (currentText === null) {
    const fetched = await fetchPublicPage(options.url, {
      env: options.env,
      scope: "web_diff",
      timeoutMs: options.timeoutMs,
      maxChars: options.maxChars ?? LIMITS.webpageExtractMaxChars,
    });
    page = fetched.page;
    currentText = toPlainText(fetched.page);
    status = fetched.status;
    finalUrl = fetched.finalUrl;
  }

  const currentNormalized = normalizeForDiff(currentText, normalization);
  const fingerprint = await sha256Hex(currentNormalized);
  const now = new Date().toISOString();

  let stored: WebDiffResult["stored"] = null;
  if (options.storeSnapshot) {
    if (!store.available) throw storageUnavailable();
    const saved = await store.storeSnapshot({
      url: options.url,
      finalUrl,
      fetchedAt: now,
      status,
      title: page?.title ?? null,
      text: currentNormalized,
      normalization,
      source: "web_diff",
    });
    stored = { snapshotKey: saved.key, expiresAt: saved.expiresAt };
  }

  if (baselineText === null) {
    return {
      url: options.url,
      finalUrl,
      status,
      normalization,
      baseline: { source: "none", snapshotKey: null, fetchedAt: null, chars: null },
      current: { fetchedAt: now, title: page?.title ?? null, chars: currentNormalized.length, fingerprint },
      summary: { added_lines: 0, removed_lines: 0, unchanged_lines: splitLines(currentNormalized).length, similarity: 1, changed: 0, identical: true, truncated: false },
      sections: [],
      unifiedDiff: null,
      added: [],
      removed: [],
      changed: [],
      stored,
      message: stored
        ? "No baseline was supplied, so nothing was compared — the current page was stored as a baseline snapshot. Diff it later by passing snapshot_key."
        : "No baseline supplied and storage is not in use: pass previous_text or snapshot_key to compare.",
    };
  }

  const baselineNormalized = normalizeForDiff(baselineText, normalization);
  const diff = diffLines(baselineNormalized, currentNormalized, { maxLines: LIMITS.diffMaxLinesDefault });
  const sections = changedSections(diff);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: Array<{ before: string; after: string }> = [];
  for (const section of sections) {
    if (section.removed.length && section.added.length) {
      const pairs = Math.max(section.removed.length, section.added.length);
      for (let i = 0; i < pairs; i++) {
        if (section.removed[i] !== undefined && section.added[i] !== undefined) changed.push({ before: section.removed[i], after: section.added[i] });
        else if (section.added[i] !== undefined) added.push(section.added[i]);
        else if (section.removed[i] !== undefined) removed.push(section.removed[i]);
      }
    } else {
      added.push(...section.added);
      removed.push(...section.removed);
    }
  }
  const summary = summarizeDiff(diff);
  return {
    url: options.url,
    finalUrl,
    status,
    normalization,
    baseline: { source: baselineSource, snapshotKey: baselineKey, fetchedAt: baselineFetchedAt, chars: baselineNormalized.length },
    current: { fetchedAt: now, title: page?.title ?? null, chars: currentNormalized.length, fingerprint },
    summary,
    sections: sections.slice(0, 50),
    unifiedDiff: options.includeUnifiedDiff === false ? null : toUnifiedDiff(diff, `previous (${baselineSource})`, `current ${now}`, 2).slice(0, LIMITS.diffMaxOutputBytes),
    added: added.slice(0, 200),
    removed: removed.slice(0, 200),
    changed: changed.slice(0, 200),
    stored,
    message: summary.identical
      ? `No content change detected (normalization: ${normalization}).`
      : `${summary.added_lines} added / ${summary.removed_lines} removed line(s) versus the ${baselineSource} baseline (similarity ${summary.similarity}).`,
  };
}

function storageUnavailable(): BrowserError {
  return new BrowserError("capability_unavailable", "Web snapshot storage is not configured. Bind SCREENSHOTS (R2) — snapshots and monitors reuse DEMO's existing artifact bucket.", {
    capability: "web_snapshot_storage",
    hint: "No new storage system is required; any R2 bucket already used for screenshots works.",
  });
}

export interface StoredSnapshotSummary {
  snapshotKey: string;
  fingerprint: string;
  chars: number;
  expiresAt: string;
  normalization: string;
  markdown?: string;
}

/** Helper used by tools: store a snapshot of a fetched/extracted page. */
export async function storePageSnapshot(
  env: Record<string, unknown> | undefined,
  options: { url: string; finalUrl: string; status: number; page: ExtractedPage; normalization?: NormalizationPreset; source?: SnapshotDocument["source"]; includeMarkdown?: boolean },
): Promise<StoredSnapshotSummary> {
  const store = WebSnapshotStore.fromEnv(env);
  if (!store.available) throw storageUnavailable();
  const normalization = options.normalization ?? "web-noise";
  const text = normalizeForDiff(toPlainText(options.page), normalization);
  const saved = await store.storeSnapshot({
    url: options.url,
    finalUrl: options.finalUrl,
    fetchedAt: new Date().toISOString(),
    status: options.status,
    title: options.page.title,
    text,
    normalization,
    source: options.source ?? "manual",
  });
  return {
    snapshotKey: saved.key,
    fingerprint: saved.fingerprint,
    chars: saved.chars,
    expiresAt: saved.expiresAt,
    normalization,
    ...(options.includeMarkdown ? { markdown: toMarkdown(options.page).slice(0, LIMITS.webpageExtractMaxChars) } : {}),
  };
}

export function clampDiffLines(value: number | undefined): number {
  return clamp(value ?? LIMITS.diffMaxLinesDefault, 50, LIMITS.diffMaxLinesCap);
}
