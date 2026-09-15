/**
 * Resource limits for the browser subsystem.
 *
 * Everything here exists to keep a single MCP call bounded: Cloudflare
 * Workers have CPU/wall-clock limits, R2 objects have size limits, Browser Run
 * has concurrency and browser-hour limits, and MCP clients have result size
 * limits. Nothing here weakens security; these are availability guards.
 */

export const LIMITS = {
  /** Navigation timeouts (milliseconds). */
  navigationTimeoutDefaultMs: 45_000,
  navigationTimeoutMaxMs: 120_000,
  /** Whole-operation budget enforced by the runtime where possible. */
  operationTimeoutDefaultMs: 60_000,
  operationTimeoutMaxMs: 120_000,
  /** Waiting helpers (`browser_wait`). */
  waitDefaultMs: 5_000,
  waitMaxMs: 120_000,

  /** Browser Run `keep_alive`: 10s minimum, 600s (10 min) maximum. */
  keepAliveMinMs: 10_000,
  keepAliveMaxMs: 600_000,
  keepAliveDefaultMs: 300_000,
  /** Heartbeat period used while a session is paused for a human. */
  heartbeatIntervalMs: 60_000,
  /** Maximum time a session may stay paused waiting for a human. */
  pauseDefaultMs: 600_000,
  pauseMaxMs: 1_800_000,
  /** Session is considered dead after this much inactivity. */
  sessionIdleTtlMs: 600_000,

  /** Tabs per session. */
  maxTabsPerSession: 10,
  maxSessionsPerAccountHint: 30,

  /** Screenshots. */
  screenshotMaxBytes: 10 * 1024 * 1024,
  inlineImageMaxBytes: 512 * 1024,
  fullPageMaxHeightPx: 30_000,
  viewportWidthDefault: 1280,
  viewportHeightDefault: 900,

  /** Text / DOM payloads. */
  maxTextChars: 200_000,
  maxReadTextChars: 20_000,
  maxHtmlChars: 200_000,
  maxLinks: 200,
  maxSnapshotNodes: 400,
  maxSnapshotDepth: 12,
  maxInteractiveElements: 150,
  maxConsoleMessages: 200,

  /** Media inspection. */
  maxJsonLdBlocks: 10,
  maxMediaElements: 20,
  maxImageCandidates: 20,
  maxRawStateChars: 300_000,

  /** Video frame sampling. */
  framesDefaultCount: 4,
  framesMaxCount: 8,
  framesTimeoutMs: 30_000,
  frameSeekSettleMs: 700,

  /** Workflows (legacy `browser_run` / `browser_watch`). */
  maxWorkflowActions: 40,
} as const;

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export function clampKeepAlive(value: number | undefined): number {
  return clamp(value ?? LIMITS.keepAliveDefaultMs, LIMITS.keepAliveMinMs, LIMITS.keepAliveMaxMs);
}

export function clampTimeout(value: number | undefined, fallback: number, max: number): number {
  const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return clamp(candidate, 1_000, max);
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated ${value.length - max} chars]` : value;
}
