/**
 * The reverse-engineering router.
 *
 * One entry point, `runReverseRequest`, which every MCP tool delegates to. It
 * enforces, in order:
 *
 *   1. the capability is enabled (`RE_ENABLED`);
 *   2. the target resolves from one of four allowed sources and is size-capped;
 *   3. static budgets are applied to the deterministic pass;
 *   4. any dynamic step goes through `evaluateDynamicRequest`, which refuses by
 *      default and needs an explicit authorization;
 *   5. every conclusion is stored as labelled evidence before it is returned.
 *
 * There is no shell here, no `exec`, no path the caller can pass to a subprocess.
 * Everything this module does is parse bytes, check arithmetic, or hand an
 * allow-listed operation to the configured analysis service.
 */

import { decodeBase64Bounded, fileNameFromUrl, resolveTarget, sanitizeTargetName, sha256Hex, type LoadTargetContext } from "./workspace.js";
import type { ReverseEngineeringEnvConfig } from "./config.js";
import { EvidenceStore } from "./evidence.js";
import type { Evidence, EvidenceLabel, TargetSource } from "./types.js";
import { produceProtocolSpecification, type MessageSample, type ProtocolSpecification } from "./protocol-analysis.js";
import { triageTarget, type TriageReport } from "./triage.js";
import { buildReport, renderReportText, type AnalysisReport } from "./report.js";
import { compareTriages, type CompareResult } from "./compare.js";
import { deriveGoldenCases, compareAgainstGolden, freezeSpecification, type CleanRoomComparison, type CleanRoomObservation, type CleanRoomSpecification, type GoldenCase } from "./cleanroom.js";
import type { ObfuscationProfile } from "./deobfuscation.js";
import { validateStructLayout, type StructFieldInput, type StructValidation } from "./struct.js";
import { detectCapabilities, recommendWorkflow, WORKER_ENGINES, EXTERNAL_TOOLS } from "./tool-discovery.js";
import { DEFAULT_SANDBOX_POLICY, evaluateDynamicRequest, safetyContract, staticBudgets, type Authorization, type SandboxPolicy } from "./sandbox.js";
import type { ReverseEngineeringStore } from "./store.js";
import type { AnalysisDocument } from "./types.js";

export interface ReverseContext {
  config: ReverseEngineeringEnvConfig;
  store: ReverseEngineeringStore;
  /** SSRF-guarded byte fetch, supplied by the caller. */
  fetchBytes(url: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType: string | null; finalUrl: string }>;
  now(): Date;
}

/** EvidenceStore wants an ISO clock; the context owns the Date. */
function evidenceClock(ctx: ReverseContext): () => string {
  return () => ctx.now().toISOString();
}

export type ReverseAction =
  | "capabilities"
  | "triage"
  | "analyze"
  | "protocol"
  | "deobfuscate"
  | "cleanroom"
  | "evidence"
  | "report"
  | "compare"
  | "dynamic";

export interface ReverseTargetInput {
  /** Base64 of the target bytes, inline. */
  inlineBase64?: string;
  name?: string;
  /** A URL the service may fetch through DEMO's SSRF guard. */
  url?: string;
  /** A previously stored artifact id. */
  artifactId?: string;
  /** A path inside the isolated reverse-engineering workspace. */
  workspacePath?: string;
}

export interface ReverseRequest {
  action: ReverseAction;
  target?: ReverseTargetInput;
  /** Second target, for compare. */
  compareWith?: ReverseTargetInput;
  objective?: string;
  depth?: "quick" | "standard" | "deep";
  dynamic?: boolean;
  authorization?: { confirmed?: boolean; scope?: string; statement?: string; justification?: string };
  limits?: { maxBytes?: number; cpuMs?: number; wallMs?: number; memoryMb?: number; maxProcesses?: number; network?: "none" | "loopback-only" | "consented" };
  /** Captured messages for protocol analysis. */
  messages?: Array<{ label?: string; hex?: string; base64?: string; text?: string }>;
  /** Observed message-label sequences, one per session. */
  sessions?: string[][];
  opcodes?: Array<{ name: string; code: number; direction?: string }>;
  /** Clean-room inputs. */
  observations?: CleanRoomObservation[];
  captures?: Array<{ hex?: string; base64?: string; description: string; evidenceId?: string }>;
  golden?: GoldenCase[];
  comparisons?: Array<{ id: string; actualOutput: string; encoding?: "hex" | "base64" | "utf8" }>;
  purpose?: string;
  /** Struct layout to validate. */
  struct?: { fields?: Array<{ name?: string; offset?: unknown; size?: unknown; type?: string }>; total_size?: unknown; align?: unknown };
  /** Evidence query. */
  evidence?: { analysisId?: string; label?: EvidenceLabel; query?: string; limit?: number; includeSuperseded?: boolean };
  /** Report/compare options. */
  report?: { analysisId?: string; maxChars?: number };
  compare?: { analysisIds?: string[] };
}

export interface ReverseResponse {
  ok: boolean;
  action: ReverseAction;
  analysisId: string | null;
  /** One-paragraph answer for the model. */
  summary: string;
  data: Record<string, unknown>;
  evidence: Array<{ id: string; label: EvidenceLabel; claim: string; source: string }>;
  artifacts: Array<{ id: string; label: string; bytes: number; storageKey: string | null }>;
  warnings: string[];
  enginesUsed: string[];
  enginesMissing: string[];
  error: { code: string; message: string } | null;
}

class ReverseError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReverseError";
  }
}

const DOCUMENTS = new Map<string, AnalysisDocument>();
const MAX_DOCUMENTS = 64;

export function reverseRequestActions(): ReverseAction[] {
  return ["capabilities", "triage", "analyze", "protocol", "deobfuscate", "cleanroom", "evidence", "report", "compare", "dynamic"];
}

export async function runReverseRequest(ctx: ReverseContext, request: ReverseRequest): Promise<ReverseResponse> {
  try {
    if (ctx.config.enabled === false) throw new ReverseError("capability_unavailable", "Reverse engineering is disabled on this deployment (RE_ENABLED=false).");
    if (!reverseRequestActions().includes(request.action)) throw new ReverseError("invalid_input", `Unknown action "${String(request.action)}".`);

    switch (request.action) {
      case "capabilities":
        return capabilitiesResponse(ctx);
      case "triage":
        return (await triageResponse(ctx, request)).response;
      case "analyze":
        return await analyzeResponse(ctx, request);
      case "protocol":
        return protocolResponse(ctx, request);
      case "deobfuscate":
        return await deobfuscateResponse(ctx, request);
      case "cleanroom":
        return cleanroomResponse(ctx, request);
      case "evidence":
        return evidenceResponse(ctx, request);
      case "report":
        return await reportResponse(ctx, request);
      case "compare":
        return await compareResponse(ctx, request);
      case "dynamic":
        return await dynamicResponse(ctx, request);
      default:
        throw new ReverseError("invalid_input", `Unhandled action "${String(request.action)}".`);
    }
  } catch (error) {
    if (error instanceof ReverseError) {
      return { ok: false, action: request.action, analysisId: null, summary: error.message, data: {}, evidence: [], artifacts: [], warnings: [], enginesUsed: [], enginesMissing: [], error: { code: error.code, message: error.message } };
    }
    // A BrowserError raised by the shared workspace/SSRF layers already carries a
    // stable code; it is reported as that code rather than as a generic failure.
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, action: request.action, analysisId: null, summary: message, data: {}, evidence: [], artifacts: [], warnings: [], enginesUsed: [], enginesMissing: [], error: { code, message } };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, action: request.action, analysisId: null, summary: `The analysis failed: ${message}`, data: {}, evidence: [], artifacts: [], warnings: [], enginesUsed: [], enginesMissing: [], error: { code: "analysis_failed", message } };
  }
}

/* ------------------------------------------------------------ capabilities */

export function capabilitiesResponse(ctx: ReverseContext): ReverseResponse {
  const objective = "understand-behavior";
  const inventory = detectCapabilities({
    analyzerUrl: ctx.config.analyzerUrl,
    serviceTools: [],
    container: null,
    objective,
    dynamic: ctx.config.dynamicEnabled,
  });
  return {
    ok: true,
    action: "capabilities",
    analysisId: null,
    summary: `${inventory.available.length} of ${WORKER_ENGINES.length + EXTERNAL_TOOLS.length} engines are available in this deployment; dynamic analysis is ${ctx.config.dynamicEnabled ? "enabled (and still needs authorization)" : "disabled"}.`,
    data: {
      engines: WORKER_ENGINES,
      externalTools: EXTERNAL_TOOLS,
      available: inventory.available,
      missing: inventory.missing,
      requiresAnalysisService: inventory.requiresAnalysisService,
      serviceInventory: inventory.serviceInventory,
      recommendedWorkflow: recommendWorkflow(null, objective, ctx.config.dynamicEnabled),
      caps: ctx.config.caps,
      flags: {
        reEnabled: ctx.config.enabled,
        reDynamicEnabled: ctx.config.dynamicEnabled,
        reAnalyzerConfigured: Boolean(ctx.config.analyzerUrl),
        reAnalyzerTimeoutMs: ctx.config.analyzerTimeoutMs,
        reArtifactTtlSeconds: ctx.config.artifactTtlSeconds,
        reRateLimitPerMinute: ctx.config.rateLimitPerMinute,
      },
      safetyContract: safetyContract(),
      sandboxPolicy: DEFAULT_SANDBOX_POLICY,
      storage: ctx.store.available ? "r2" : "memory-only",
      evidenceLabels: ["observed", "inferred", "proposed", "web", "unknown"],
      actions: reverseRequestActions(),
    },
    evidence: [],
    artifacts: [],
    warnings: ctx.store.available ? [] : ["R2 is not bound in this deployment: artifacts are cached in the isolate only and are lost when it restarts."],
    enginesUsed: [],
    enginesMissing: inventory.missing.map((engine) => engine.id),
    error: null,
  };
}

/* ---------------------------------------------------------------- pipeline */

interface LoadedTarget {
  name: string;
  source: TargetSource;
  bytes: Uint8Array;
  sha256: string;
  origin: string;
}

/**
 * Resolve the target from exactly one of the four allowed sources, through
 * `resolveTarget`, so that naming, path validation and size capping are applied
 * identically no matter which action is running.
 */
async function loadTarget(ctx: ReverseContext, input: ReverseTargetInput | undefined, what: string): Promise<LoadedTarget> {
  if (!input) throw new ReverseError("invalid_input", `A ${what} is required for this action.`);
  const provided = [input.inlineBase64, input.url, input.artifactId, input.workspacePath].filter((value) => Boolean(value));
  if (provided.length !== 1) {
    throw new ReverseError("invalid_input", `The ${what} must resolve from exactly one source: inlineBase64, url, artifactId or workspacePath.`);
  }
  const maxBytes = ctx.config.caps.maxTargetBytes;
  const ref = {
    ...(input.inlineBase64 ? { data_base64: input.inlineBase64 } : {}),
    ...(input.url ? { url: input.url } : {}),
    ...(input.artifactId ? { artifact_key: input.artifactId } : {}),
    ...(input.workspacePath ? { path: input.workspacePath } : {}),
    name: input.name,
  };
  const loadContext: LoadTargetContext = {
    maxBytes,
    fetchBytes: async (url, limit) => {
      const fetched = await ctx.fetchBytes(url, limit);
      return { bytes: fetched.bytes, finalUrl: fetched.finalUrl };
    },
    readArtifact: async (key) => (await ctx.store.get(key))?.cachedBody ?? null,
    readWorkspacePath: async (path) => (await ctx.store.get(path))?.cachedBody ?? null,
  };
  const resolved = await resolveTarget(ref, loadContext);
  if (resolved.bytes.byteLength === 0) throw new ReverseError("invalid_input", `The ${what} is empty.`);
  if (resolved.bytes.byteLength > maxBytes) throw new ReverseError("size_limit_exceeded", `The ${what} is ${resolved.bytes.byteLength} bytes, above the ${maxBytes}-byte limit.`);
  return {
    name: sanitizeTargetName(resolved.name, input.name ?? "target.bin"),
    source: resolved.source,
    bytes: resolved.bytes,
    sha256: resolved.sha256,
    origin: resolved.origin,
  };
}

function basenameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split("/").filter(Boolean).pop() ?? parsed.hostname;
  } catch {
    return null;
  }
}

function documentStoreId(): string {
  return `analysis-${Math.random().toString(36).slice(2, 10)}`;
}

function rememberDocument(document: AnalysisDocument): void {
  DOCUMENTS.set(document.analysisId, document);
  while (DOCUMENTS.size > MAX_DOCUMENTS) {
    const oldest = DOCUMENTS.keys().next().value;
    if (oldest === undefined) break;
    DOCUMENTS.delete(oldest);
  }
}

async function findDocument(ctx: ReverseContext, analysisId: string | undefined): Promise<AnalysisDocument | null> {
  if (!analysisId) return null;
  const local = DOCUMENTS.get(analysisId);
  if (local) return local;
  const artifact = await ctx.store.get(analysisId);
  if (!artifact?.cachedBody) return null;
  try {
    return JSON.parse(new TextDecoder().decode(artifact.cachedBody)) as AnalysisDocument;
  } catch {
    return null;
  }
}

interface AnalysisOutcome {
  response: ReverseResponse;
  document: AnalysisDocument;
}

async function runAnalysis(
  ctx: ReverseContext,
  request: ReverseRequest,
  label: string,
): Promise<AnalysisOutcome> {
  const target = await loadTarget(ctx, request.target, "target");
  const store = new EvidenceStore(evidenceClock(ctx));
  const budgets = staticBudgets(ctx.config, request.depth ?? "standard");
  const analysisId = `${request.action}-${documentStoreId()}`;

  const { report, engines } = triageTarget(target, budgets, store);

  const objective = (request.objective ?? "understand-behavior") as AnalysisDocument["objective"];
  const container = report.container.kind;

  const findings: AnalysisDocument["findings"] = [];
  const unknowns: string[] = [];
  const recommendedNext: string[] = [...report.warnings.slice(0, 3)];
  let extra: Record<string, unknown> = {};

  const symbolEvidence = store.query({ query: "symbol" })[0];
  findings.push({
    id: "container-identification",
    title: `The target is a ${report.container.label}`,
    detail: `${report.container.label}${report.container.arch ? ` for ${report.container.arch}` : ""}${report.container.bits ? ` (${report.container.bits}-bit)` : ""}. Magic ${report.container.magic ?? "unknown"}.`,
    label: "observed",
    evidence: store.query({ query: "file magic" }).map((entry) => entry.id),
    confidence: report.container.confidence,
    unknowns: report.container.arch ? [] : ["The architecture is not identified, so no instruction-level analysis is possible yet."],
  });

  if (report.obfuscation.packing.likelyPacked) {
    findings.push({
      id: "packing",
      title: "Packing or obfuscation is likely",
      detail: report.obfuscation.packing.signals.map((signal) => `${signal.indicator}: ${signal.detail}`).join(" ") || report.obfuscation.summary,
      label: "inferred",
      evidence: store.query({ query: "packing" }).map((entry) => entry.id),
      confidence: report.obfuscation.packing.confidence,
      unknowns: ["Which packer, and what the unpacked code does, both require unpacking or disassembly."],
    });
    recommendedNext.push("Unpack before deeper analysis: run UPX -d or an equivalent unpacker, or delegate unpacking to the configured analysis service.");
  }
  if (symbolEvidence) {
    findings.push({
      id: "symbol-surface",
      title: `Symbol surface: ${report.symbols.status}`,
      detail: `${report.symbols.total} symbols (${report.symbols.exported} exported, ${report.symbols.imported} imported).`,
      label: "observed",
      evidence: [symbolEvidence.id],
      confidence: 0.9,
      unknowns: report.symbols.status === "stripped" ? ["No symbol names survive; recovered names would have to come from Go pclntab, string analysis or dynamic instrumentation."] : [],
    });
  }
  if (report.symbols.status === "stripped") {
    recommendedNext.push("The symbol table is stripped; Go pclntab recovery, string analysis and dynamic instrumentation are the available routes to names.");
  }
  const toolchainEvidence = store.query({ query: "toolchain" })[0];
  if (toolchainEvidence) {
    findings.push({
      id: "toolchain",
      title: "Toolchain fingerprint",
      detail: report.toolchain.hints.join(", "),
      label: "inferred",
      evidence: [toolchainEvidence.id],
      confidence: 0.6,
      unknowns: ["Toolchain hints come from strings and comments, so they are not a substitute for a compiler-identification pass."],
    });
  }

  for (const hypothesis of report.hypotheses) {
    store.add({
      label: hypothesis.startsWith("unknown:") ? "unknown" : "proposed",
      source: "demo.triage",
      target: target.name,
      location: "analysis synthesis",
      claim: hypothesis.replace(/^(proposed|unknown):\s*/, ""),
      result: { hypothesis },
    });
  }
  unknowns.push(...report.hypotheses.filter((entry) => entry.startsWith("unknown:")).map((entry) => entry.replace(/^unknown:\s*/, "")));
  unknowns.push(...store.unknowns().map((entry) => entry.claim));

  if (objective === "protocol") {
    const spec = protocolResponse(ctx, request, store).data.specification as ProtocolSpecification;
    extra = { specification: spec };
    unknowns.push(...spec.unknowns);
    findings.push({
      id: "protocol-specification",
      title: `Protocol framing: ${spec.framing.style}`,
      detail: spec.framing.detail,
      label: spec.framing.style === "unknown" ? "unknown" : "inferred",
      evidence: store.entries.map((entry) => entry.id),
      confidence: spec.framing.confidence,
      unknowns: spec.unknowns,
    });
  } else if (objective === "clean-room") {
    const room = cleanroomResponse(ctx, request, store);
    extra = { cleanRoom: room.data };
  } else if (objective === "obfuscation") {
    extra = { obfuscation: report.obfuscation };
    findings.push({
      id: "obfuscation",
      title: "Obfuscation assessment",
      detail: report.obfuscation.summary,
      label: "inferred",
      evidence: store.query({ query: "packing" }).map((entry) => entry.id),
      confidence: report.obfuscation.packing.confidence,
      unknowns: ["Whether the obfuscation affects control flow, data flow or only strings, requires disassembly."],
    });
  } else if (objective === "compare" && request.compareWith) {
    const comparison = await compareResponse(ctx, request, store);
    extra = { comparison: comparison.data };
    findings.push({
      id: "comparison",
      title: "Artifact comparison",
      detail: (comparison.data.comparison as CompareResult).interpretation,
      label: "inferred",
      evidence: [],
      confidence: 0.8,
      unknowns: ["A metadata comparison says nothing about behavioural difference."],
    });
  }

  const enginesMissing = detectCapabilities({
    analyzerUrl: ctx.config.analyzerUrl,
    serviceTools: [],
    container,
    objective,
    dynamic: ctx.config.dynamicEnabled,
  }).missing.map((engine) => engine.id);

  const document: AnalysisDocument = {
    schema: 1,
    analysisId,
    target: { name: target.name, sha256: target.sha256, sizeBytes: target.bytes.byteLength, source: target.source, origin: target.origin },
    container: {
      kind: report.container.kind,
      label: report.container.label,
      arch: report.container.arch,
      bits: report.container.bits,
      endian: report.container.endian,
      confidence: report.container.confidence,
    },
    objective: (request.objective ?? "understand-behavior") as AnalysisDocument["objective"],
    depth: request.depth ?? "standard",
    dynamic: Boolean(request.dynamic),
    triage: report as unknown as Record<string, unknown>,
    evidence: store.entries,
    findings,
    unknowns: [...new Set(unknowns)].slice(0, 40),
    recommendedNext: [...new Set(recommendedNext)].slice(0, 12),
    enginesUsed: engines,
    enginesMissing,
    artifacts: [],
    warnings: [],
    createdAt: ctx.now().toISOString(),
  };

  rememberDocument(document);
  await persistDocument(ctx, document);

  const response = finalize(ctx, document, label, extra, store);
  return { response, document };
}

async function persistDocument(ctx: ReverseContext, document: AnalysisDocument): Promise<void> {
  const body = JSON.stringify(document);
  if (body.length > ctx.config.caps.maxArtifactBytes) return;
  const artifact = await ctx.store.put(
    { id: document.analysisId, analysisId: document.analysisId, label: "analysis document", contentType: "application/json", body },
    ctx.config.artifactTtlSeconds,
  );
  document.artifacts = [
    ...document.artifacts,
    { id: artifact.id, kind: "metadata", label: artifact.label, bytes: artifact.bytes, storageKey: artifact.storageKey, summary: "The full analysis document: triage, evidence, findings, unknowns and recommendations." },
  ];
}

function finalize(ctx: ReverseContext, document: AnalysisDocument, label: string, extra: Record<string, unknown>, store: EvidenceStore): ReverseResponse {
  const capabilities = detectCapabilities({
    analyzerUrl: ctx.config.analyzerUrl,
    serviceTools: [],
    container: document.container.kind,
    objective: document.objective,
    dynamic: ctx.config.dynamicEnabled,
  });
  const warnings: string[] = [];
  if (obfuscationLikely(document)) warnings.push("The target looks packed: treat every string and symbol below as belonging to the stub, not to the real logic.");
  if (document.enginesMissing.length > 0) warnings.push(`Missing engines: ${document.enginesMissing.join(", ")}.`);

  return {
    ok: true,
    action: label as ReverseAction,
    analysisId: document.analysisId,
    summary: summarize(document, extra),
    data: {
      container: document.container,
      triage: document.triage,
      findings: document.findings,
      unknowns: document.unknowns,
      recommendedNext: document.recommendedNext,
      ...extra,
    },
    evidence: store.entries.map((entry) => ({ id: entry.id, label: entry.label, claim: entry.claim, source: entry.source })),
    artifacts: document.artifacts,
    warnings,
    enginesUsed: document.enginesUsed,
    enginesMissing: document.enginesMissing,
    error: null,
  };
}

function obfuscationLikely(document: AnalysisDocument): boolean {
  const triage = document.triage as { obfuscation?: { packing?: { likelyPacked?: boolean } } };
  return Boolean(triage.obfuscation?.packing?.likelyPacked);
}

function summarize(document: AnalysisDocument, extra: Record<string, unknown>): string {
  const parts = [`${document.target.name} is a ${document.container.label} (${document.target.sizeBytes} bytes, sha256 ${document.target.sha256.slice(0, 16)}…).`];
  parts.push(`${document.findings.length} finding(s), ${document.evidence.length} evidence entr(ies), ${document.unknowns.length} unknown(s).`);
  const spec = extra.specification as ProtocolSpecification | undefined;
  if (spec) parts.push(`Protocol framing: ${spec.framing.style} — ${spec.framing.detail}`);
  const comparison = extra.comparison as CompareResult | undefined;
  if (comparison) parts.push(comparison.interpretation);
  const obf = extra.obfuscation as ObfuscationProfile | undefined;
  if (obf) parts.push(obf.summary);
  parts.push(`Use action "evidence" or "report" with analysisId ${document.analysisId} for the full detail.`);
  return parts.join(" ");
}

/* -------------------------------------------------------------- per-action */

async function triageResponse(ctx: ReverseContext, request: ReverseRequest): Promise<AnalysisOutcome> {
  return runAnalysis(ctx, { ...request, objective: request.objective ?? "triage" }, "triage");
}

async function analyzeResponse(ctx: ReverseContext, request: ReverseRequest): Promise<ReverseResponse> {
  const { response } = await runAnalysis(ctx, request, "analyze");
  return response;
}

async function deobfuscateResponse(ctx: ReverseContext, request: ReverseRequest): Promise<ReverseResponse> {
  const target = await loadTarget(ctx, request.target, "target");
  const store = new EvidenceStore(evidenceClock(ctx));
  const { report } = triageTarget(target, staticBudgets(ctx.config, "standard"), store);
  const document: AnalysisDocument = {
    schema: 1,
    analysisId: `deobfuscate-${documentStoreId()}`,
    target: { name: target.name, sha256: target.sha256, sizeBytes: target.bytes.byteLength, source: target.source, origin: target.origin },
    container: {
      kind: report.container.kind,
      label: report.container.label,
      arch: report.container.arch,
      bits: report.container.bits,
      endian: report.container.endian,
      confidence: report.container.confidence,
    },
    objective: "obfuscation",
    depth: request.depth ?? "standard",
    dynamic: false,
    triage: report as unknown as Record<string, unknown>,
    evidence: store.entries,
    findings: [],
    unknowns: [],
    recommendedNext: report.obfuscation.packing.requiresAnalysisService,
    enginesUsed: ["demo.entropy", "demo.triage"],
    enginesMissing: detectCapabilities({ analyzerUrl: ctx.config.analyzerUrl, serviceTools: [], container: report.container.kind, objective: "obfuscation", dynamic: false }).missing.map((engine) => engine.id),
    artifacts: [],
    warnings: [],
    createdAt: ctx.now().toISOString(),
  };
  rememberDocument(document);
  await persistDocument(ctx, document);
  const response = finalize(ctx, document, "deobfuscate", { obfuscation: report.obfuscation }, store);
  return response;
}

function parseMessages(inputs: NonNullable<ReverseRequest["messages"]>): MessageSample[] {
  const out: MessageSample[] = [];
  for (const entry of inputs.slice(0, 64)) {
    if (entry.hex) out.push({ label: entry.label, bytes: fromHex(entry.hex) });
    else if (entry.base64) out.push({ label: entry.label, bytes: decodeBase64Bounded(entry.base64, 1024 * 1024) });
    else if (entry.text) out.push({ label: entry.label, bytes: new TextEncoder().encode(entry.text) });
  }
  return out;
}

function fromHex(value: string): Uint8Array {
  const clean = value.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.byteLength; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function protocolResponse(ctx: ReverseContext, request: ReverseRequest, store = new EvidenceStore(() => new Date().toISOString())): ReverseResponse {
  const samples = parseMessages(request.messages ?? []);
  if (samples.length < 2) {
    return {
      ok: false,
      action: "protocol",
      analysisId: null,
      summary: "Protocol analysis needs at least two captured messages.",
      data: {},
      evidence: [],
      artifacts: [],
      warnings: [],
      enginesUsed: [],
      enginesMissing: [],
      error: { code: "invalid_input", message: "Supply at least two messages (hex, base64 or text) so column-wise inference has something to align." },
    };
  }
  const specification = produceProtocolSpecification(samples, {
    opcodes: request.opcodes ?? [],
    sessions: request.sessions ?? [],
  });
  store.add({
    label: "observed",
    source: "demo.protocol-analysis",
    target: "captured messages",
    location: `column alignment over ${samples.length} messages`,
    claim: specification.framing.detail,
    result: { framing: specification.framing, lengthPrefixes: specification.framing.lengthPrefixes, checksums: specification.framing.checksums },
    confidence: specification.framing.confidence,
  });
  for (const field of specification.fields) {
    if (field.role === "unknown") continue;
    store.add({
      label: field.role === "magic" || field.role === "length" ? "observed" : "inferred",
      source: "demo.protocol-analysis",
      target: "captured messages",
      location: `offset ${field.offset ?? "?"}`,
      claim: `${field.name} (${field.type}) looks like a ${field.role}: ${field.evidence.join("; ")}`,
      result: field,
      confidence: field.confidence,
    });
  }
  for (const unknown of specification.unknowns) {
    store.add({ label: "unknown", source: "demo.protocol-analysis", target: "captured messages", location: "unclassified", claim: unknown });
  }
  return {
    ok: true,
    action: "protocol",
    analysisId: null,
    summary: `${samples.length} messages aligned; framing: ${specification.framing.style} — ${specification.framing.detail} ${specification.unknowns.length ? `${specification.unknowns.length} field(s) remain unclassified.` : ""}`,
    data: {
      specification,
      framing: specification.framing,
      fields: specification.fields,
      stateMachine: specification.stateMachine,
      messages: specification.messages,
      evidence: store.entries,
      evidenceCounts: store.counts(),
    },
    evidence: store.entries.map((entry) => ({ id: entry.id, label: entry.label, claim: entry.claim, source: entry.source })),
    artifacts: [],
    warnings: specification.unknowns.length ? [`${specification.unknowns.length} unclassified field(s): do not assign them a meaning without more evidence.`] : [],
    enginesUsed: ["demo.protocol-analysis", "demo.pcap"],
    enginesMissing: [],
    error: null,
  };
}

function cleanroomResponse(ctx: ReverseContext, request: ReverseRequest, store = new EvidenceStore(() => new Date().toISOString())): ReverseResponse {
  if (!request.observations?.length) {
    return {
      ok: false,
      action: "cleanroom",
      analysisId: null,
      summary: "Clean-room work starts from observations; none were supplied.",
      data: {},
      evidence: [],
      artifacts: [],
      warnings: [],
      enginesUsed: [],
      enginesMissing: [],
      error: { code: "invalid_input", message: "Supply at least one observation with a label, a source and a location." },
    };
  }
  const specification: CleanRoomSpecification = freezeSpecification({
    target: request.target?.name ?? "target",
    purpose: request.purpose ?? "Behavioural reimplementation of the observed target.",
    observations: request.observations,
    now: ctx.now().toISOString(),
  });
  const golden = deriveGoldenCases({
    captures: (request.captures ?? []).map((entry) => ({ bytes: entry.hex ? fromHex(entry.hex) : entry.base64 ? decodeBase64Bounded(entry.base64, 1024 * 1024) : new Uint8Array(), description: entry.description, evidenceId: entry.evidenceId })),
    supplied: request.golden ?? [],
  });
  const comparison: CleanRoomComparison = compareAgainstGolden(golden, request.comparisons ?? []);

  for (const observation of request.observations) {
    store.add({
      label: observation.label,
      source: observation.source,
      target: request.target?.name ?? "target",
      location: observation.location,
      claim: observation.statement,
      confidence: observation.label === "observed" ? 0.9 : observation.label === "inferred" ? 0.7 : 0.4,
    });
  }

  return {
    ok: true,
    action: "cleanroom",
    analysisId: null,
    summary: `Specification frozen with ${request.observations.length} observation(s); ${golden.length} golden case(s); comparison verdict: ${comparison.verdict}.`,
    data: { specification, goldenCases: golden, comparison, evidence: store.entries, evidenceCounts: store.counts() },
    evidence: store.entries.map((entry) => ({ id: entry.id, label: entry.label, claim: entry.claim, source: entry.source })),
    artifacts: [],
    warnings: [
      "The specification deliberately contains no decompiled code or original identifiers.",
      "DEMO never executes the reimplementation or the original target: the caller supplies the captured outputs.",
    ],
    enginesUsed: ["demo.cleanroom", "demo.evidence"],
    enginesMissing: [],
    error: null,
  };
}

function evidenceResponse(ctx: ReverseContext, request: ReverseRequest): ReverseResponse {
  const analysisId = request.evidence?.analysisId ?? request.report?.analysisId;
  if (!analysisId) {
    const known = [...DOCUMENTS.keys()];
    return {
      ok: false,
      action: "evidence",
      analysisId: null,
      summary: known.length ? `Known analyses in this isolate: ${known.join(", ")}.` : "No analysis is known in this isolate.",
      data: { knownAnalyses: known },
      evidence: [],
      artifacts: [],
      warnings: ["Analyses are kept per isolate; pass the analysisId returned by the analysis that produced them."],
      enginesUsed: [],
      enginesMissing: [],
      error: { code: "invalid_input", message: "Supply evidence.analysisId." },
    };
  }
  const document = findDocumentSync(analysisId);
  if (!document) {
    return {
      ok: false,
      action: "evidence",
      analysisId,
      summary: `Analysis "${analysisId}" is not available in this isolate.`,
      data: {},
      evidence: [],
      artifacts: [],
      warnings: ["The analysis may have expired, or it ran in a different isolate. Re-run the analysis to obtain a new id."],
      enginesUsed: [],
      enginesMissing: [],
      error: { code: "artifact_expired", message: `Analysis "${analysisId}" is not available.` },
    };
  }
  const store = new EvidenceStore(evidenceClock(ctx), document.evidence);
  const entries = store.query({
    label: request.evidence?.label,
    query: request.evidence?.query,
    includeSuperseded: request.evidence?.includeSuperseded ?? false,
  });
  const limit = Math.max(1, Math.min(200, request.evidence?.limit ?? 50));
  return {
    ok: true,
    action: "evidence",
    analysisId,
    summary: `${entries.length} matching evidence entr(ies) for ${analysisId} (of ${document.evidence.length} total).`,
    data: { evidence: entries.slice(0, limit), counts: store.counts(), total: document.evidence.length, returned: Math.min(entries.length, limit) },
    evidence: entries.slice(0, limit).map((entry) => ({ id: entry.id, label: entry.label, claim: entry.claim, source: entry.source })),
    artifacts: document.artifacts,
    warnings: store.unknowns().length ? [`${store.unknowns().length} entr(ies) are still unknown.`] : [],
    enginesUsed: document.enginesUsed,
    enginesMissing: document.enginesMissing,
    error: null,
  };
}

function findDocumentSync(analysisId: string): AnalysisDocument | null {
  return DOCUMENTS.get(analysisId) ?? null;
}

async function reportResponse(ctx: ReverseContext, request: ReverseRequest): Promise<ReverseResponse> {
  const analysisId = request.report?.analysisId ?? request.evidence?.analysisId;
  let document = await findDocument(ctx, analysisId);
  if (!document && request.target) {
    const outcome = await runAnalysis(ctx, { ...request, objective: request.objective ?? "understand-behavior" }, "report");
    document = outcome.document;
  }
  if (!document) {
    return {
      ok: false,
      action: "report",
      analysisId: analysisId ?? null,
      summary: analysisId ? `Analysis "${analysisId}" is not available in this isolate.` : "Supply either report.analysisId or a target to analyse.",
      data: {},
      evidence: [],
      artifacts: [],
      warnings: [],
      enginesUsed: [],
      enginesMissing: [],
      error: { code: analysisId ? "artifact_expired" : "invalid_input", message: `No analysis document is available for "${analysisId ?? "(none)"}".` },
    };
  }
  const report = buildReport(document, safetyContract());
  return {
    ok: true,
    action: "report",
    analysisId: document.analysisId,
    summary: report.executiveSummary.split("\n\n")[1] ?? report.executiveSummary,
    data: {
      report,
      text: renderReportText(report, request.report?.maxChars ?? 24_000),
      evidenceCounts: report.evidenceCounts,
      singleSourcedClaims: report.singleSourcedClaims,
      unknowns: report.unknowns,
    },
    evidence: document.evidence.slice(0, 50).map((entry) => ({ id: entry.id, label: entry.label, claim: entry.claim, source: entry.source })),
    artifacts: document.artifacts,
    warnings: report.singleSourcedClaims.length > 10 ? [`${report.singleSourcedClaims.length} claim(s) rest on a single source.`] : [],
    enginesUsed: document.enginesUsed,
    enginesMissing: document.enginesMissing,
    error: null,
  };
}

async function compareResponse(ctx: ReverseContext, request: ReverseRequest, store = new EvidenceStore(() => new Date().toISOString())): Promise<ReverseResponse> {
  const ids = request.compare?.analysisIds ?? [];
  if (ids.length >= 2) {
    const left = await findDocument(ctx, ids[0]);
    const right = await findDocument(ctx, ids[1]);
    if (!left || !right) {
      return {
        ok: false,
        action: "compare",
        analysisId: null,
        summary: "Both analysis ids must be available in this isolate.",
        data: { known: [...DOCUMENTS.keys()] },
        evidence: [],
        artifacts: [],
        warnings: [],
        enginesUsed: [],
        enginesMissing: [],
        error: { code: "artifact_expired", message: "One or both analysis documents are unavailable." },
      };
    }
    const result = compareTriages(left.triage as unknown as TriageReport, right.triage as unknown as TriageReport, left.target.name, right.target.name);
    return {
      ok: true,
      action: "compare",
      analysisId: null,
      summary: result.interpretation,
      data: { comparison: result, evidence: store.entries },
      evidence: [],
      artifacts: [],
      warnings: [],
      enginesUsed: ["demo.compare"],
      enginesMissing: [],
      error: null,
    };
  }

  const leftTarget = await loadTarget(ctx, request.target, "target");
  const rightTarget = await loadTarget(ctx, request.compareWith, "compareWith target");
  const leftStore = new EvidenceStore(evidenceClock(ctx));
  const rightStore = new EvidenceStore(evidenceClock(ctx));
  const { report: left } = triageTarget(leftTarget, staticBudgets(ctx.config, "quick"), leftStore);
  const { report: right } = triageTarget(rightTarget, staticBudgets(ctx.config, "quick"), rightStore);
  const result = compareTriages(left, right, leftTarget.name, rightTarget.name);
  store.add({ label: "inferred", source: "demo.compare", target: leftTarget.name, location: "artifact comparison", claim: result.interpretation, result });
  return {
    ok: true,
    action: "compare",
    analysisId: null,
    summary: result.interpretation,
    data: {
      comparison: result,
      left: { sha256: left.sha256, size: left.sizeBytes, container: left.container },
      right: { sha256: right.sha256, size: right.sizeBytes, container: right.container },
      evidence: store.entries,
    },
    evidence: store.entries.map((entry) => ({ id: entry.id, label: entry.label, claim: entry.claim, source: entry.source })),
    artifacts: [],
    warnings: result.identical ? [] : ["A metadata comparison is not a behavioural comparison: identical surfaces can still behave differently."],
    enginesUsed: ["demo.compare", "demo.triage"],
    enginesMissing: [],
    error: null,
  };
}

async function dynamicResponse(ctx: ReverseContext, request: ReverseRequest): Promise<ReverseResponse> {
  const target = await loadTarget(ctx, request.target, "target");
  const policy = sandboxPolicy(request);
  const authorization: Authorization = {
    confirmed: Boolean(request.authorization?.confirmed),
    scope: (request.authorization?.scope as Authorization["scope"]) ?? "public-source",
    statement: request.authorization?.statement ?? "",
  };
  const decision = evaluateDynamicRequest({ dynamic: true, authorization }, ctx.config, policy);
  const requirements = decision.requirements;
  const reasons = requirements.length
    ? requirements
    : decision.allowed
      ? [`Authorized under the enforced policy: cpu ${policy.cpuMs} ms, wall ${policy.wallMs} ms, ${policy.memoryMb} MB, ${policy.maxProcesses} process(es), network ${policy.network}.`]
      : ["Dynamic analysis is not permitted in this configuration."];

  const store = new EvidenceStore(evidenceClock(ctx));
  if (!decision.allowed) {
    for (const reason of requirements) store.add({ label: "unknown", source: "demo.sandbox", target: target.name, location: "dynamic analysis", claim: reason });
  } else {
    store.add({
      label: "proposed",
      source: "demo.sandbox",
      target: target.name,
      location: "dynamic authorization",
      claim: `Dynamic analysis is authorized for a target the caller owns; it will run only inside the configured analysis service under the enforced policy.`,
      result: { policy, authorization: { confirmed: authorization.confirmed, scope: authorization.scope } },
    });
  }

  return {
    ok: decision.allowed,
    action: "dynamic",
    analysisId: null,
    summary: decision.allowed
      ? `The dynamic request is authorized. It will be executed only by the configured analysis service, under an enforced policy (cpu ${policy.cpuMs} ms, wall ${policy.wallMs} ms, ${policy.memoryMb} MB, network ${policy.network}).`
      : `Dynamic analysis refused: ${reasons.join(" ")} Static analysis has already run and is available from this response.`,
    data: {
      decision,
      policy,
      requirements,
      staticAlternative: decision.allowed
        ? null
        : "The deterministic pass already produced container, architecture, sections, symbols, imports, entropy and string evidence for this target; ask for action \"analyze\" to see it.",
      authorization: { confirmed: authorization.confirmed, scope: authorization.scope },
      safetyContract: safetyContract(),
    },
    evidence: store.entries.map((entry) => ({ id: entry.id, label: entry.label, claim: entry.claim, source: entry.source })),
    artifacts: [],
    warnings: decision.allowed
      ? ["Dynamic analysis runs outside this Worker, in the operator's own sandbox, under the stated policy."]
      : requirements,
    enginesUsed: decision.allowed ? ["demo.analysis-service"] : [],
    enginesMissing: decision.allowed ? [] : ["dynamic instrumentation"],
    error: decision.allowed ? null : { code: "capability_unavailable", message: requirements.join(" ") },
  };
}

function sandboxPolicy(request: ReverseRequest): SandboxPolicy {
  const policy: SandboxPolicy = { ...DEFAULT_SANDBOX_POLICY, ...request.limits };
  policy.network = request.limits?.network ?? "none";
  return policy;
}

/* ------------------------------------------------------------------ extras */

/** Validate a recovered struct layout; exposed as a helper for tools. */
export function runStructValidation(input: ReverseRequest["struct"]): StructValidation {
  return validateStructLayout((input ?? {}) as { fields?: StructFieldInput[]; total_size?: unknown; align?: unknown });
}
