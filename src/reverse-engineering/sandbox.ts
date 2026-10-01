/**
 * Authorization and sandbox policy.
 *
 * Static analysis is the default and always safe: DEMO reads bytes as data.
 * Dynamic analysis is opt-in, requires an explicit authorization statement, and
 * is refused outright unless a sandbox is actually available. There is no code
 * path in this capability that executes a target, so "dynamic" here means
 * "ask the configured analysis service to run it under its own isolation", and
 * if that service is not configured the request is refused rather than faked.
 *
 * The capability is also explicit about what it will never do, regardless of
 * what a caller asks for. Those refusals are data, not comments, so the MCP
 * layer can report them back.
 */

import type { ReverseEngineeringPolicy } from "./config.js";

/** Who authorised this target, and for what. */
export interface Authorization {
  /** `local-artifact`: the user supplied the bytes and owns them. */
  scope: "local-artifact" | "authorized-target" | "public-source" | "captured-traffic";
  /** Free-text statement of authority, capped by the schema. */
  statement: string;
  /** Whether the caller explicitly confirmed they are authorised to analyse it. */
  confirmed: boolean;
}

export interface SandboxPolicy {
  /** CPU budget for one dynamic run. */
  cpuMs: number;
  /** Wall-clock budget for one dynamic run. */
  wallMs: number;
  /** Memory ceiling. */
  memoryMb: number;
  /** Network isolation mode. `none` is the default and the only safe default. */
  network: "none" | "loopback-only" | "consented";
  /** Filesystem isolation mode. */
  filesystem: "isolated-workspace" | "read-only-workspace";
  /** Maximum concurrent child processes. */
  maxProcesses: number;
  /** Whether the sandbox can actually be enforced by the execution environment. */
  enforceable: boolean;
}

export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = {
  cpuMs: 5_000,
  wallMs: 15_000,
  memoryMb: 256,
  network: "none",
  filesystem: "isolated-workspace",
  maxProcesses: 1,
  enforceable: false,
};

/**
 * What this capability refuses to implement, no matter how the request is
 * phrased. Surfaced verbatim by `reverse_capabilities` so a caller can see the
 * boundary instead of discovering it by failure.
 */
export const REFUSED_OPERATIONS: readonly string[] = [
  "credential theft or extraction from a live system",
  "malware deployment, propagation or persistence",
  "destructive exploitation or patching of third-party systems",
  "unauthorized access to systems, accounts or data",
  "stealth, evasion or anti-forensics against a real target",
  "automated abuse of live services (scraping, brute force, rate-limit circumvention)",
  "arbitrary shell or command execution on behalf of a caller",
  "decryption of protected archives or credentials supplied by a caller",
];

export interface DynamicEvaluation {
  allowed: boolean;
  reason: string | null;
  /** What the caller would have to provide for the request to be allowed. */
  requirements: string[];
  /** Policy that would apply if it were allowed. */
  policy: SandboxPolicy;
}

/**
 * Decide whether a dynamic run may proceed.
 *
 * The rules, in order:
 *   1. `dynamic` must be explicitly requested (default false).
 *   2. The deployment must allow dynamic analysis (`RE_DYNAMIC_ENABLED`).
 *   3. An analysis service with a sandbox must be configured.
 *   4. The caller must supply an authorization with a confirmed statement.
 *   5. The authorization scope must be compatible with running the target.
 */
export function evaluateDynamicRequest(
  request: { dynamic?: boolean; authorization?: Authorization | null },
  policy: ReverseEngineeringPolicy,
  sandbox: SandboxPolicy = DEFAULT_SANDBOX_POLICY,
): DynamicEvaluation {
  const requirements: string[] = [];
  if (!request.dynamic) {
    return {
      allowed: false,
      reason: "Dynamic analysis was not requested. Static analysis is the default and has already run.",
      requirements,
      policy: sandbox,
    };
  }
  if (!policy.enabled) requirements.push("Set RE_ENABLED=true.");
  if (!policy.dynamicAllowed) requirements.push("Set RE_DYNAMIC_ENABLED=true on the deployment (default false).");
  if (!policy.analyzerUrl) requirements.push("Configure the external analysis service (server-side RE_ANALYZER_URL).");
  if (!sandbox.enforceable) requirements.push("The execution environment must report an enforceable sandbox.");
  if (!request.authorization?.confirmed) {
    requirements.push("Pass authorization with confirmed: true and a statement of authority.");
  }
  if (request.authorization && request.authorization.scope === "public-source") {
    requirements.push("A public-source target is not authorized to be executed; supply the bytes as a local artifact or an authorized target.");
  }

  const authorizationOk = Boolean(request.authorization?.confirmed) && request.authorization?.scope !== "public-source";
  const allowed = policy.enabled && policy.dynamicAllowed && Boolean(policy.analyzerUrl) && sandbox.enforceable && authorizationOk;

  return {
    allowed,
    reason: allowed
      ? null
      : "Dynamic analysis is not permitted in this configuration. DEMO will not execute a target outside an isolated, explicitly authorized sandbox.",
    requirements,
    policy: sandbox,
  };
}

/** Resource limits for the deterministic (static) pass, derived from policy. */
export interface StaticBudgets {
  maxBytes: number;
  maxAnalysisMs: number;
  maxStrings: number;
  maxSections: number;
  maxSymbols: number;
}

export function staticBudgets(policy: ReverseEngineeringPolicy, depth: "quick" | "standard" | "deep"): StaticBudgets {
  const scale = depth === "quick" ? 0.5 : depth === "deep" ? 2 : 1;
  return {
    maxBytes: policy.maxTargetBytes,
    maxAnalysisMs: policy.maxAnalysisMs,
    maxStrings: Math.round(200 * scale),
    maxSections: Math.round(200 * scale),
    maxSymbols: Math.round(500 * scale),
  };
}

/** Human-readable safety contract, reported by `reverse_capabilities`. */
export function safetyContract(): string[] {
  return [
    "Static analysis only by default: bytes are read as data and never executed.",
    "Dynamic analysis is opt-in (dynamic: true) and additionally requires RE_DYNAMIC_ENABLED, a configured analysis service, an enforceable sandbox and an explicit authorization.",
    "Dynamic runs are CPU-, memory-, wall-clock- and process-limited, with filesystem isolation and no network access unless explicitly consented.",
    "Never execute a file merely because it was uploaded: an upload produces evidence, never a process.",
    "No arbitrary command execution is exposed: the analysis service accepts a closed allow-list of operations.",
    "Uploaded targets are never re-hosted, never forwarded to a third party and expire with the analysis artifacts.",
  ];
}
