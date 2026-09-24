/**
 * Website monitoring primitives (DEMO 0.9) on DEMO's existing R2 bucket.
 *
 * A monitor is a bounded record: one URL, an interval, a normalized snapshot
 * fingerprint and a trimmed history of check results. Checks are explicit —
 * a call to `web_monitor` (mode: check) or the *opt-in* scheduled sweep — so
 * registering a URL never silently creates an unlimited recurring job. Every
 * check goes through the shared SSRF-guarded fetch with the same timeouts,
 * size limits and rate limits as every other public capability.
 */

import { BrowserError } from "../core/errors.js";
import { LIMITS, clamp } from "../core/limits.js";
import { normalizeForDiff, diffLines, changedSections, summarizeDiff } from "../core/text-diff.js";
import { toPlainText } from "./extract.js";
import { fetchPublicPage } from "./fetch-page.js";
import {
  WebSnapshotStore,
  clampMonitorInterval,
  clampMonitorVersions,
  sha256Hex,
  trimVersions,
  type MonitorDocument,
  type MonitorVersion,
} from "./storage.js";

export interface MonitorSummary {
  id: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
  intervalSeconds: number;
  baselineFingerprint: string | null;
  lastFingerprint: string | null;
  versions: MonitorVersion[];
  maxVersions: number;
  retentionSeconds: number;
}

export interface MonitorCheckResult {
  monitor: MonitorSummary;
  changed: boolean;
  due: boolean;
  checked: boolean;
  changeSummary: {
    added: number;
    removed: number;
    similarity: number;
    sections: Array<{ removed: string[]; added: string[] }>;
  } | null;
  snapshotKey: string | null;
  currentChars: number | null;
  message: string;
}

function toSummary(document: MonitorDocument): MonitorSummary {
  return {
    id: document.id,
    url: document.url,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    lastCheckedAt: document.lastCheckedAt,
    intervalSeconds: document.intervalSeconds,
    baselineFingerprint: document.baselineFingerprint,
    lastFingerprint: document.lastFingerprint,
    versions: document.versions.slice(-10),
    maxVersions: document.maxVersions,
    retentionSeconds: document.retentionSeconds,
  };
}

function storageUnavailable(): BrowserError {
  return new BrowserError("capability_unavailable", "Website monitoring needs DEMO's existing R2 artifact bucket (bind SCREENSHOTS). Monitors are stored as expiring objects — no database was added.", {
    capability: "web_snapshot_storage",
  });
}

export interface AddMonitorOptions {
  env: Record<string, unknown> | undefined;
  url: string;
  intervalSeconds?: number;
  maxVersions?: number;
  retentionSeconds?: number;
  normalize?: "web-noise" | "whitespace" | "none";
}

/** Register a URL for change checks and store its first normalized snapshot. */
export async function addMonitor(options: AddMonitorOptions): Promise<MonitorCheckResult> {
  const store = WebSnapshotStore.fromEnv(options.env);
  if (!store.available) throw storageUnavailable();
  // Enforce the deployment monitor budget before creating anything.
  const existing = await store.listMonitors(LIMITS.monitorMaxPerDeploymentHint);
  if (existing.length >= LIMITS.monitorMaxPerDeploymentHint) {
    throw new BrowserError("size_limit_exceeded", `This deployment already tracks ${existing.length} monitors (max ${LIMITS.monitorMaxPerDeploymentHint}). Remove one first — DEMO does not create unbounded monitoring jobs.`, {
      retryable: false,
    });
  }
  const fetched = await fetchPublicPage(options.url, { env: options.env, scope: "web_monitor", skipRateCharge: false });
  const text = normalizeForDiff(toPlainText(fetched.page), options.normalize ?? "web-noise");
  const fingerprint = await sha256Hex(text);
  const snapshot = await store.storeSnapshot({
    url: options.url,
    finalUrl: fetched.finalUrl,
    fetchedAt: new Date().toISOString(),
    status: fetched.status,
    title: fetched.page.title,
    text,
    normalization: options.normalize ?? "web-noise",
    source: "web_monitor",
  });
  const now = new Date().toISOString();
  const document: MonitorDocument = {
    schema: 1,
    id: store.newMonitorId(),
    url: options.url,
    createdAt: now,
    updatedAt: now,
    lastCheckedAt: now,
    intervalSeconds: clampMonitorInterval(options.intervalSeconds),
    normalize: options.normalize ?? "web-noise",
    maxVersions: clampMonitorVersions(options.maxVersions),
    retentionSeconds: clamp(options.retentionSeconds ?? store.retentionSeconds ?? LIMITS.snapshotRetentionDefaultSeconds, 3_600, LIMITS.snapshotRetentionMaxSeconds),
    lastFingerprint: fingerprint,
    baselineFingerprint: fingerprint,
    versions: [{ checkedAt: now, fingerprint, status: fetched.status, changed: false, summary: "baseline snapshot", snapshotKey: snapshot.key }],
  };
  await store.saveMonitor(document);
  return {
    monitor: toSummary(document),
    changed: false,
    due: false,
    checked: true,
    changeSummary: null,
    snapshotKey: snapshot.key,
    currentChars: text.length,
    message: `Monitor registered for ${options.url}. Checks are explicit (web_monitor mode: check) or the opt-in hourly scheduled sweep; interval ${document.intervalSeconds}s. Baseline stored (fingerprint ${fingerprint.slice(0, 12)}…).`,
  };
}

export interface CheckMonitorOptions {
  env: Record<string, unknown> | undefined;
  id: string;
  force?: boolean;
  storeSnapshots?: boolean;
}

/** Fetch the URL now and report the change summary against the last check. */
export async function checkMonitor(options: CheckMonitorOptions): Promise<MonitorCheckResult> {
  const store = WebSnapshotStore.fromEnv(options.env);
  if (!store.available) throw storageUnavailable();
  const document = await store.loadMonitor(options.id);
  if (!document) throw new BrowserError("page_not_found", "No such monitor. List monitors with web_monitor mode: list.", { retryable: false });

  const nowMs = Date.now();
  const lastMs = document.lastCheckedAt ? Date.parse(document.lastCheckedAt) : 0;
  const due = nowMs - lastMs >= document.intervalSeconds * 1_000;
  if (!due && !options.force) {
    return {
      monitor: toSummary(document),
      changed: document.versions.length > 0 && document.versions[document.versions.length - 1].changed,
      due: false,
      checked: false,
      changeSummary: null,
      snapshotKey: document.versions[document.versions.length - 1]?.snapshotKey ?? null,
      currentChars: null,
      message: `Not due: the next check is allowed at ${new Date(lastMs + document.intervalSeconds * 1000).toISOString()} (interval ${document.intervalSeconds}s). Pass force: true to check anyway.`,
    };
  }

  const fetched = await fetchPublicPage(document.url, { env: options.env, scope: "web_monitor" });
  const text = normalizeForDiff(toPlainText(fetched.page), document.normalize as "web-noise" | "whitespace" | "none");
  const fingerprint = await sha256Hex(text);
  const previous = document.versions[document.versions.length - 1];
  const changed = Boolean(previous) && previous.fingerprint !== fingerprint;
  let changeSummary: MonitorCheckResult["changeSummary"] = null;
  let summaryText: string | undefined;
  if (changed && previous?.snapshotKey) {
    const previousSnapshot = await store.readSnapshot(previous.snapshotKey).catch(() => null);
    if (previousSnapshot) {
      const diff = diffLines(previousSnapshot.text, text, { maxLines: LIMITS.diffMaxLinesDefault });
      const sections = changedSections(diff).slice(0, 20);
      changeSummary = {
        added: diff.added,
        removed: diff.removed,
        similarity: diff.similarity,
        sections: sections.map((section) => ({ removed: section.removed.slice(0, 5), added: section.added.slice(0, 5) })),
      };
      const summary = summarizeDiff(diff);
      summaryText = `+${summary.added_lines}/-${summary.removed_lines} lines`;
    }
  }

  let snapshotKey: string | null = previous?.snapshotKey ?? null;
  if (options.storeSnapshots !== false) {
    const snapshot = await store.storeSnapshot({
      url: document.url,
      finalUrl: fetched.finalUrl,
      fetchedAt: new Date().toISOString(),
      status: fetched.status,
      title: fetched.page.title,
      text,
      normalization: document.normalize,
      source: "web_monitor",
    });
    snapshotKey = snapshot.key;
  }

  const version: MonitorVersion = {
    checkedAt: new Date().toISOString(),
    fingerprint,
    status: fetched.status,
    changed,
    ...(summaryText ? { summary: summaryText } : {}),
    ...(snapshotKey ? { snapshotKey } : {}),
  };
  document.versions = trimVersions([...document.versions, version], document.maxVersions);
  document.lastCheckedAt = version.checkedAt;
  document.updatedAt = version.checkedAt;
  document.lastFingerprint = fingerprint;
  await store.saveMonitor(document);

  return {
    monitor: toSummary(document),
    changed,
    due: true,
    checked: true,
    changeSummary,
    snapshotKey,
    currentChars: text.length,
    message: changed
      ? `Content changed since the previous check (${summaryText ?? "fingerprint differs"}). ${document.versions.length} version(s) retained (max ${document.maxVersions}).`
      : "No content change since the previous check (after noise normalization).",
  };
}

/** Load one monitor record (history/inspection) without fetching anything. */
export async function getMonitor(env: Record<string, unknown> | undefined, id: string): Promise<MonitorSummary> {
  const store = WebSnapshotStore.fromEnv(env);
  if (!store.available) throw storageUnavailable();
  const document = await store.loadMonitor(id);
  if (!document) throw new BrowserError("page_not_found", "No such monitor. List monitors with web_monitor mode: list.", { retryable: false });
  return toSummary(document);
}

export async function listMonitors(env: Record<string, unknown> | undefined, limit = 20): Promise<{ monitors: Array<MonitorSummary & { expiresAt: string | null }>; message: string }> {
  const store = WebSnapshotStore.fromEnv(env);
  if (!store.available) throw storageUnavailable();
  const listed = await store.listMonitors(limit);
  const monitors: Array<MonitorSummary & { expiresAt: string | null }> = [];
  for (const entry of listed) {
    const document = await store.loadMonitor(entry.id).catch(() => null);
    if (document) monitors.push({ ...toSummary(document), expiresAt: entry.expiresAt });
  }
  return {
    monitors,
    message: `${monitors.length} monitor(s). Checks run only when requested (mode: check) or via the opt-in scheduled sweep (WEB_MONITOR_SCHEDULED_CHECKS=true).`,
  };
}

export async function removeMonitor(env: Record<string, unknown> | undefined, id: string): Promise<{ removed: boolean; message: string }> {
  const store = WebSnapshotStore.fromEnv(env);
  if (!store.available) throw storageUnavailable();
  const removed = await store.deleteMonitor(id);
  return { removed, message: removed ? "Monitor removed. Stored snapshots remain until their TTL cleanup." : "No monitor with that id existed." };
}

/** Monitors whose interval elapsed — used by the opt-in scheduled sweep. */
export async function checkDueMonitors(env: Record<string, unknown> | undefined, options: { maxChecks?: number } = {}): Promise<{ checked: number; changed: number; results: MonitorCheckResult[]; message: string }> {
  const store = WebSnapshotStore.fromEnv(env);
  if (!store.available) return { checked: 0, changed: 0, results: [], message: "Monitoring storage unavailable; scheduled sweep skipped." };
  const maxChecks = clamp(options.maxChecks ?? 5, 1, 20);
  const listed = await store.listMonitors(50);
  const now = Date.now();
  const results: MonitorCheckResult[] = [];
  let changed = 0;
  for (const entry of listed) {
    if (results.length >= maxChecks) break;
    const document = await store.loadMonitor(entry.id).catch(() => null);
    if (!document) continue;
    const lastMs = document.lastCheckedAt ? Date.parse(document.lastCheckedAt) : 0;
    if (now - lastMs < document.intervalSeconds * 1_000) continue;
    try {
      const result = await checkMonitor({ env, id: entry.id, force: true });
      results.push(result);
      if (result.changed) changed++;
    } catch (error) {
      results.push({
        monitor: toSummary(document),
        changed: false,
        due: true,
        checked: false,
        changeSummary: null,
        snapshotKey: null,
        currentChars: null,
        message: `Check failed: ${String(error instanceof Error ? error.message : error).slice(0, 160)}`,
      });
    }
  }
  return {
    checked: results.filter((result) => result.checked).length,
    changed,
    results,
    message: `Sweep complete: ${results.length} due monitor(s) processed (budget ${maxChecks}).`,
  };
}
