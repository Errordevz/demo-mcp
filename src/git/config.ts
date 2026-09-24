/**
 * Git policy configuration (DEMO 0.9).
 *
 * Public Git only: DEMO inspects public repositories over the normal Git
 * smart-HTTP protocol (`https://…/repo.git` on GitHub, GitLab, Codeberg, Gitea
 * or any compatible server) with **no API key and no OAuth**. There is
 * deliberately no credential flow here — no env var accepts a token, no
 * auth callback can be wired to it, and private repositories get a clear
 * `auth_required` refusal. Every value is policy (size/time/count caps); none
 * of them is a secret, and none may be widened beyond the hard caps.
 */

import { LIMITS, clamp } from "../core/limits.js";
import { configuredNumber } from "../core/rate-limit.js";

export interface GitEnv {
  /** Hard ceiling on bytes downloaded per Git operation (pack + refs). */
  GIT_MAX_PACK_MB?: string | number;
  /** Wall-clock budget per Git network operation. */
  GIT_REQUEST_TIMEOUT_MS?: string | number;
  /** Git operations per minute, per repository target (isolate-local). */
  GIT_RATE_LIMIT_PER_MINUTE?: string | number;
  /** Deepest history a caller may request (commits walked from a ref). */
  GIT_MAX_DEPTH?: string | number;
  /** Total bytes a single in-memory temporary repository may occupy. */
  GIT_MEMORY_MAX_MB?: string | number;
  /** How long a temporary clone may be reused inside one isolate. */
  GIT_TEMP_REPO_TTL_MS?: string | number;
}

export interface GitPolicy {
  maxPackBytes: number;
  requestTimeoutMs: number;
  rateLimitPerMinute: number;
  maxDepth: number;
  memoryMaxBytes: number;
  tempRepoTtlMs: number;
}

export function resolveGitPolicy(env: Record<string, unknown> | undefined): GitPolicy {
  const values = (env ?? {}) as GitEnv;
  const maxPackMb = configuredNumber(values.GIT_MAX_PACK_MB, LIMITS.gitMaxPackBytes / (1024 * 1024), 1, 25);
  return {
    maxPackBytes: maxPackMb * 1024 * 1024,
    requestTimeoutMs: clamp(configuredNumber(values.GIT_REQUEST_TIMEOUT_MS, LIMITS.gitTimeoutDefaultMs, 2_000, LIMITS.gitTimeoutMaxMs), 2_000, LIMITS.gitTimeoutMaxMs),
    rateLimitPerMinute: configuredNumber(values.GIT_RATE_LIMIT_PER_MINUTE, 6, 1, 60),
    maxDepth: configuredNumber(values.GIT_MAX_DEPTH, LIMITS.gitMaxDepth, 1, LIMITS.gitMaxDepth),
    memoryMaxBytes: configuredNumber(values.GIT_MEMORY_MAX_MB, 48, 8, 64) * 1024 * 1024,
    tempRepoTtlMs: clamp(configuredNumber(values.GIT_TEMP_REPO_TTL_MS, 600_000, 60_000, 900_000), 60_000, 900_000),
  };
}

/** Presence-only flags for `demo_ping` / `/health` / platform telemetry. */
export function gitFlags(env: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  const policy = resolveGitPolicy(env);
  return {
    gitPublicOnly: true,
    gitNoApiKeyRequired: true,
    gitMaxPackMb: Math.round(policy.maxPackBytes / (1024 * 1024)),
    gitRateLimitPerMinute: policy.rateLimitPerMinute,
    gitCredentialsSupported: false,
  };
}
