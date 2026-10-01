/**
 * Shared types for the DEMO Reverse Engineering capability.
 *
 * The vocabulary here is deliberately small and explicit because the whole
 * capability is built around one rule inherited from the upstream
 * `PyModel/reverse-engineering-skill` methodology:
 *
 *   tool output is evidence; model reasoning interprets evidence.
 *
 * Nothing in this module may ever turn an `inferred` claim into an `observed`
 * one — that upgrade has to be earned by a second, independent tool.
 */

/** Evidence confidence labels. `web` and `unknown` complete the upstream set. */
export type EvidenceLabel = "observed" | "inferred" | "proposed" | "web" | "unknown";

export const EVIDENCE_LABELS: readonly EvidenceLabel[] = ["observed", "inferred", "proposed", "web", "unknown"];

/**
 * One machine-produced observation, or one explicitly-labelled human/model
 * hypothesis. Every field is required so an evidence entry can never be
 * "anonymous": a reader can always ask which tool produced it, against which
 * target, at which location, and how confident that tool is.
 */
export interface Evidence {
  /** Stable id inside one analysis (`ev-0001`). */
  id: string;
  label: EvidenceLabel;
  /** Which engine produced this: `demo.elf`, `demo.entropy`, `engine.ghidra`… */
  source: string;
  /** Target name or analysis id the observation belongs to. */
  target: string;
  /** Human-locatable position: `ELF header`, `section .text`, `packet 4`. */
  location: string;
  /** The claim in one sentence. */
  claim: string;
  /** The exact machine result (never paraphrased). */
  result: unknown;
  /** 0..1. 1.0 means the tool read the bytes directly. */
  confidence: number;
  /** ISO-8601 timestamp, or null when the observation is deterministic. */
  timestamp: string | null;
  /** Evidence ids from other sources that agree. Cross-checking is recorded. */
  crossCheckedWith?: string[];
}

/** Container families the deterministic parsers understand. */
export type ContainerKind =
  | "elf"
  | "pe"
  | "macho"
  | "wasm"
  | "java-class"
  | "jar"
  | "dex"
  | "dotnet"
  | "python-bytecode"
  | "asar"
  | "archive"
  | "pcap"
  | "sqlite"
  | "text"
  | "unknown";

/** What the caller wants out of the analysis. */
export const RE_OBJECTIVES = [
  "identify",
  "triage",
  "architecture",
  "functions",
  "symbols",
  "strings",
  "decompile",
  "protocol",
  "ipc",
  "behavior",
  "obfuscation",
  "clean-room",
  "compare",
  "vulnerability",
] as const;
export type ReverseEngineeringObjective = (typeof RE_OBJECTIVES)[number];

export const RE_DEPTHS = ["quick", "standard", "deep"] as const;
export type ReverseEngineeringDepth = (typeof RE_DEPTHS)[number];

/** How a target was supplied. */
export type TargetSource = "inline" | "url" | "artifact" | "workspace" | "capture";

export interface ResolvedTarget {
  /** Sanitized display name (never a filesystem path). */
  name: string;
  source: TargetSource;
  bytes: Uint8Array;
  sha256: string;
  /** Where the bytes actually came from, for the report. */
  origin: string;
  warnings: string[];
}

/** A generated, bounded artifact the model can ask for by id. */
export interface GeneratedArtifact {
  id: string;
  kind: "report" | "specification" | "evidence" | "metadata" | "hexdump" | "protocol-spec" | "clean-room" | "comparison";
  label: string;
  bytes: number;
  /** Storage key when the artifact was persisted, otherwise null. */
  storageKey: string | null;
  summary: string;
}

export interface AnalysisFinding {
  id: string;
  title: string;
  label: EvidenceLabel;
  detail: string;
  /** Evidence ids backing this finding. */
  evidence: string[];
  confidence: number;
  /** What is still missing before this could be stated as observed. */
  unknowns: string[];
}

export interface AnalysisDocument {
  schema: 1;
  analysisId: string;
  createdAt: string;
  target: {
    name: string;
    source: TargetSource;
    sha256: string;
    sizeBytes: number;
    origin: string;
  };
  objective: ReverseEngineeringObjective;
  depth: ReverseEngineeringDepth;
  dynamic: boolean;
  container: {
    kind: ContainerKind;
    label: string;
    arch: string | null;
    bits: number | null;
    endian: "little" | "big" | null;
    confidence: number;
  };
  /** Deterministic triage fields (container/arch/entropy/packing/symbols). */
  triage: Record<string, unknown>;
  evidence: Evidence[];
  findings: AnalysisFinding[];
  artifacts: GeneratedArtifact[];
  unknowns: string[];
  recommendedNext: string[];
  /** Engines that were actually used, by id. */
  enginesUsed: string[];
  /** Engines that would have helped but were unavailable. */
  enginesMissing: string[];
  warnings: string[];
}

/** Capability detection result — the shape required by the MCP contract. */
export interface CapabilityReport {
  available: CapabilityEntry[];
  missing: CapabilityEntry[];
  recommendedWorkflow: string[];
  /** Engines that only exist behind the optional analysis service. */
  requiresAnalysisService: string[];
}

export interface CapabilityEntry {
  id: string;
  title: string;
  detail: string;
  /** Free-form tags used for grouping in the UI and the report. */
  covers: string[];
}
