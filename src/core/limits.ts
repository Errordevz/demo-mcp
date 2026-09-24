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
  /** Stored browser-session state (tabs, pause records, handoff records with
   * their visited URLs) older than this is wiped the next time its Durable
   * Object wakes up, so idle sessions do not retain browsing metadata forever. */
  sessionStateRetentionMs: 7 * 24 * 60 * 60 * 1000,
  /** Hard cap for a single MCP JSON-RPC request body (Requests larger than
   * this are rejected with 413 before any handler runs). */
  maxMcpBodyBytes: 5_000_000,

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

  /** Public video pipeline. */
  videoMaxDownloadBytes: 50 * 1024 * 1024,
  videoMaxDownloadMb: 50,
  videoMaxDurationSeconds: 10 * 60,
  videoResolveTimeoutMs: 15_000,
  videoDownloadTimeoutMs: 45_000,
  videoMaxRedirects: 5,
  videoMaxHtmlBytes: 2 * 1024 * 1024,
  videoFramesDefaultIntervalSeconds: 8,
  /** Cap for the public video pipeline (`inspect_video` may plan up to this
   * many frames; browser tools stay at `framesMaxCount`). */
  videoFramesMaxCount: 16,
  videoFrameTimeoutMs: 45_000,
  videoAudioMaxSeconds: 120,
  videoAudioMaxBytes: 8 * 1024 * 1024,
  videoInlineMaxTotalBytes: 2 * 1024 * 1024,
  videoArtifactTtlSeconds: 60 * 60,
  videoMaxVisionFrames: 4,

  /** Stream discovery, verification and retrieval (`video_resolve`/`video_fetch`). */
  /** Literal media URLs collected from one page before ranking. */
  videoMaxStreamCandidates: 16,
  /** How many ranked candidates are actually probed with public requests. */
  videoMaxProbedStreams: 4,
  /** Leading sample read to prove the response really is a video container. */
  videoHeadProbeBytes: 128 * 1024,
  /** Trailing sample read to verify a duration when `moov` sits at the end. */
  videoTailProbeBytes: 512 * 1024,
  /** Maximum bytes accumulated in-memory to compute a SHA-256 when the runtime
   * has no incremental digest stream (Workers have `crypto.DigestStream`). */
  videoDigestBufferBytes: 8 * 1024 * 1024,
  /** Frame resize bounds (rendered by Chromium, never by a Worker-side codec). */
  videoFrameResizeMinPx: 64,
  videoFrameResizeMaxPx: 1_920,
  /** Caption/text fields returned to the model. */
  videoMaxCaptionChars: 2_000,

  /** Workflows (legacy `browser_run` / `browser_watch`). */
  maxWorkflowActions: 40,

  /* ────────────────────────── extended public capabilities (0.9.0) ───────── */
  /** Shared defaults for the read-only fetch-backed capabilities (feeds, PDFs,
   * images, web diff, monitoring, OpenAPI, Internet Archive, research). A tool
   * argument may only lower these, never raise them — same policy as video. */
  publicFetchTimeoutDefaultMs: 15_000,
  publicFetchTimeoutMaxMs: 30_000,
  publicFetchMaxBytes: 4_000_000,
  /** Generic webpage fetch (extraction, diff, monitor, research): bounded HTML. */
  webpageMaxHtmlBytes: 2_000_000,
  webpageExtractMaxChars: 200_000,
  /** Feeds. */
  feedMaxBytes: 3_000_000,
  feedMaxEntriesDefault: 20,
  feedMaxEntriesCap: 100,
  /** Internet Archive. */
  archiveCdxMaxRows: 500,
  archiveCdxMaxRowsCap: 2_000,
  archiveSnapshotMaxBytes: 6_000_000,
  /** PDFs. */
  pdfMaxBytesDefault: 25 * 1024 * 1024,
  pdfMaxBytesCap: 25 * 1024 * 1024,
  pdfMaxPagesCap: 500,
  pdfMaxTextChars: 400_000,
  pdfMaxSearchMatches: 100,
  pdfMaxOcrPages: 5,
  pdfScannedPageTextThreshold: 40,
  /** Images (analysis + screenshot comparison). */
  imageMaxBytes: 8 * 1024 * 1024,
  imageCompareMaxImages: 4,
  imageAnalysisMaxSideHint: 1_568,
  /** Snapshots + website monitoring (R2-backed, TTL via existing cleanup sweep). */
  snapshotRetentionDefaultSeconds: 7 * 24 * 60 * 60,
  snapshotRetentionMaxSeconds: 30 * 24 * 60 * 60,
  monitorMaxVersionsDefault: 10,
  monitorMaxVersionsCap: 50,
  monitorMaxPerDeploymentHint: 200,
  monitorMinCheckIntervalSeconds: 300,
  /** Diff engine. */
  diffMaxLinesDefault: 4_000,
  diffMaxLinesCap: 20_000,
  diffMaxOutputBytes: 1_000_000,
  /** OpenAPI documents. */
  openapiMaxBytes: 6_000_000,
  openapiMaxEndpointsCap: 400,
  openapiMaxSchemaPreviewChars: 2_000,
  /** JSON Schema validation. */
  jsonSchemaMaxBytes: 2_000_000,
  jsonSchemaMaxDepth: 64,
  jsonSchemaMaxErrors: 50,
  /** JWT inspection. */
  jwtMaxChars: 32_000,
  /** Cron. */
  cronMaxOccurrences: 20,
  cronSearchHorizonDays: 366 * 5,
  /** Git. */
  gitMaxPackBytes: 20 * 1024 * 1024,
  gitTimeoutDefaultMs: 25_000,
  gitTimeoutMaxMs: 60_000,
  gitDefaultDepth: 10,
  gitMaxDepth: 200,
  gitMaxLogEntries: 200,
  gitMaxFilesListed: 5_000,
  gitMaxTreeEntries: 2_000,
  gitMaxFileBytes: 1_000_000,
  gitMaxSearchFiles: 1_500,
  gitMaxBytesPerFileScanned: 512 * 1024,
  gitMaxPatchBytes: 1_500_000,
  /** Research orchestration (budgets are per MCP call; fetch caps inherit). */
  researchMaxSourcesCap: 10,
  researchMaxBytesPerSource: 1_200_000,
  researchEvidencePerSource: 6,
  researchTimeoutDefaultMs: 25_000,
  researchTimeoutMaxMs: 30_000,
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
