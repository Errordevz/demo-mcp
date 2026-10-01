/**
 * Reverse-engineering capability configuration.
 *
 * Policy only, and every value is non-secret. The optional external analysis
 * service is described but deliberately NOT defaulted here, exactly like
 * `LAYA_BASE_URL`: an endpoint is per-deployment infrastructure, and a committed
 * endpoint is a deployment nobody reviewed. Credentials never appear at all —
 * `RE_ANALYZER_KEY` is a Worker secret.
 *
 * Safe defaults: the whole capability is static, bounded and inert without a
 * configured analysis service. Deploying this file cannot start a single byte
 * of dynamic instrumentation.
 */

export interface ReverseEngineeringPolicy {
  /** Master switch. Off = the tools report `capability_unavailable`. */
  enabled: boolean;
  /** Maximum accepted target size. A tool argument may only lower this. */
  maxTargetBytes: number;
  /** Wall-clock budget for one analysis (Worker CPU limits apply on top). */
  maxAnalysisMs: number;
  /** Dynamic analysis requires an explicit opt-in *and* a sandbox. */
  dynamicAllowed: boolean;
  /** TTL for stored analysis artifacts (R2 expiring objects). */
  artifactTtlSeconds: number;
  /** Per-minute budget for the whole capability. */
  rateLimitPerMinute: number;
  /** Optional external analysis service (headless Ghidra / binutils / radare2). */
  analyzerUrl: string | null;
  analyzerTimeoutMs: number;
  /** Whether the analyzer credential is configured (never its value). */
  analyzerKeyConfigured: boolean;
}

const DEFAULTS = {
  enabled: true,
  maxTargetMb: 16,
  maxAnalysisMs: 20_000,
  dynamicAllowed: false,
  artifactTtlSeconds: 3_600,
  rateLimitPerMinute: 12,
  analyzerTimeoutMs: 8_000,
} as const;

/** Absolute ceilings: a tool argument or an env var can never exceed these. */
export const RE_CAPS = {
  maxTargetBytes: 64 * 1024 * 1024,
  maxAnalysisMs: 60_000,
  artifactTtlSeconds: 7 * 24 * 60 * 60,
  rateLimitPerMinute: 120,
  analyzerTimeoutMs: 30_000,
} as const;

function bool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

export function resolveReverseEngineeringPolicy(env: Record<string, unknown> | undefined): ReverseEngineeringPolicy {
  const analyzerUrl = String(env?.RE_ANALYZER_URL ?? "").trim().replace(/\/+$/, "");
  return {
    enabled: bool(env?.RE_ENABLED, DEFAULTS.enabled),
    // The MB argument is clamped against the published ceiling, so an operator can
    // shrink the cap freely but cannot grow it past 64 MiB by accident.
    maxTargetBytes: num(env?.RE_MAX_TARGET_MB, DEFAULTS.maxTargetMb, 1, Math.floor(RE_CAPS.maxTargetBytes / (1024 * 1024))) * 1024 * 1024,
    maxAnalysisMs: num(env?.RE_MAX_ANALYSIS_MS, DEFAULTS.maxAnalysisMs, 1_000, RE_CAPS.maxAnalysisMs),
    dynamicAllowed: bool(env?.RE_DYNAMIC_ENABLED, DEFAULTS.dynamicAllowed),
    artifactTtlSeconds: num(env?.RE_ARTIFACT_TTL_SECONDS, DEFAULTS.artifactTtlSeconds, 300, RE_CAPS.artifactTtlSeconds),
    rateLimitPerMinute: num(env?.RE_RATE_LIMIT_PER_MINUTE, DEFAULTS.rateLimitPerMinute, 1, RE_CAPS.rateLimitPerMinute),
    analyzerUrl: analyzerUrl || null,
    analyzerTimeoutMs: num(env?.RE_ANALYZER_TIMEOUT_MS, DEFAULTS.analyzerTimeoutMs, 1_000, RE_CAPS.analyzerTimeoutMs),
    analyzerKeyConfigured: Boolean(String(env?.RE_ANALYZER_KEY ?? "").trim()),
  };
}

/** Safe, non-secret capability flags for /health, /platform/stats and the UI. */
export function reverseEngineeringFlags(env: Record<string, unknown> | undefined): Record<string, unknown> {
  const policy = resolveReverseEngineeringPolicy(env);
  return {
    reverseEngineering: policy.enabled,
    reverseEngineeringDynamic: policy.enabled && policy.dynamicAllowed,
    reverseEngineeringAnalyzer: Boolean(policy.analyzerUrl),
    reverseEngineeringArtifacts: policy.artifactTtlSeconds > 0,
  };
}

/**
 * The resolved configuration the router and the MCP layer consume.
 *
 * `ReverseEngineeringPolicy` is the raw policy; this adds the derived values
 * (`dynamicEnabled`, the artifact caps) so that no other module has to remember
 * that `dynamicAllowed` means "dynamic *may* be enabled, subject to
 * authorization" while `dynamicEnabled` means "dynamic analysis may run here".
 */
export interface ReverseEngineeringEnvConfig extends ReverseEngineeringPolicy {
  /** Dynamic analysis may run, if and only if every other gate also passes. */
  dynamicEnabled: boolean;
  caps: {
    maxTargetBytes: number;
    maxArtifactBytes: number;
    maxAnalysisMs: number;
    artifactTtlSeconds: number;
    rateLimitPerMinute: number;
  };
}

export function resolveReverseEngineeringConfig(env: Record<string, unknown> | undefined): ReverseEngineeringEnvConfig {
  const policy = resolveReverseEngineeringPolicy(env);
  return {
    ...policy,
    dynamicEnabled: policy.enabled && policy.dynamicAllowed,
    caps: {
      maxTargetBytes: policy.maxTargetBytes,
      // Artifacts are bounded well below the target cap: an artifact that is
      // bigger than the thing it describes is a storage accident waiting.
      maxArtifactBytes: Math.min(policy.maxTargetBytes, 2 * 1024 * 1024),
      maxAnalysisMs: policy.maxAnalysisMs,
      artifactTtlSeconds: policy.artifactTtlSeconds,
      rateLimitPerMinute: policy.rateLimitPerMinute,
    },
  };
}
