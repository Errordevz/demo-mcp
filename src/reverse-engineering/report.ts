/**
 * Evidence-labelled report builder.
 *
 * Ports upstream `references/08-output-standards.md`: a deliverable leads with
 * impact, separates the *spec* (what it does) from the *how-I-know* (the
 * evidence), and lists unknowns instead of hiding them.
 *
 * The builder's job is mechanical and non-negotiable: it groups every finding by
 * its label, refuses to promote a label, and appends the single-source list so a
 * reader can see exactly which conclusions still need a second opinion.
 */

import type { AnalysisDocument, AnalysisFinding, Evidence, EvidenceLabel } from "./types.js";
import { strongestLabel } from "./evidence.js";

export interface ReportSection {
  id: string;
  title: string;
  /** Rendered markdown-ish text, bounded. */
  body: string;
}

export interface AnalysisReport {
  schema: 1;
  analysisId: string;
  generatedAt: string;
  target: { name: string; sha256: string; sizeBytes: number; source: string };
  objective: string;
  depth: string;
  dynamic: boolean;
  executiveSummary: string;
  container: { kind: string; label: string; arch: string | null; confidence: number };
  sections: ReportSection[];
  findings: AnalysisFinding[];
  evidenceCounts: Record<EvidenceLabel, number>;
  singleSourcedClaims: Array<{ id: string; claim: string; source: string; label: EvidenceLabel }>;
  unknowns: string[];
  recommendedNext: string[];
  enginesUsed: string[];
  enginesMissing: string[];
  artifacts: AnalysisDocument["artifacts"];
  safetyContract: string[];
}

/** Build the structured report from a completed analysis document. */
export function buildReport(document: AnalysisDocument, safety: string[]): AnalysisReport {
  const counts: Record<EvidenceLabel, number> = { observed: 0, inferred: 0, proposed: 0, web: 0, unknown: 0 };
  for (const entry of document.evidence) counts[entry.label] += 1;

  const singleSourced = document.evidence
    .filter((entry) => entry.label !== "unknown" && !(entry.crossCheckedWith ?? []).length)
    .map((entry) => ({ id: entry.id, claim: entry.claim, source: entry.source, label: entry.label }));

  const triage = document.triage as Record<string, unknown>;
  const containerLabel = String((triage.container as { label?: string } | undefined)?.label ?? document.container.label);

  const sections: ReportSection[] = [
    {
      id: "executive-summary",
      title: "Executive summary",
      body: [
        `${document.target.name} is a ${containerLabel} (${document.target.sizeBytes} bytes, sha256 ${document.target.sha256.slice(0, 16)}…).`,
        `Objective: ${document.objective} at ${document.depth} depth; dynamic analysis ${document.dynamic ? "was requested" : "was not requested"}.`,
        summarySentence(document),
      ].join("\n\n"),
    },
    {
      id: "triage",
      title: "Triage table",
      body: renderTriageTable(document),
    },
    {
      id: "architecture",
      title: "Architecture summary",
      body: renderArchitecture(document),
    },
    {
      id: "findings",
      title: "Findings",
      body: document.findings.length
        ? document.findings.map((finding) => `### ${finding.title}\n\n${finding.detail}\n\n**Label:** ${finding.label} · **Confidence:** ${finding.confidence} · **Evidence:** ${finding.evidence.join(", ") || "none"}`).join("\n\n")
        : "No findings were produced for this objective.",
    },
    {
      id: "observed",
      title: "Observed",
      body: renderEvidenceGroup(document.evidence, "observed"),
    },
    {
      id: "inferred",
      title: "Inferred",
      body: renderEvidenceGroup(document.evidence, "inferred"),
    },
    {
      id: "proposed",
      title: "Proposed",
      body: renderEvidenceGroup(document.evidence, "proposed"),
    },
    {
      id: "unknown",
      title: "Unknown / unverified",
      body: document.unknowns.length ? document.unknowns.map((entry) => `- ${entry}`).join("\n") : "- Nothing was left unlabelled.",
    },
    {
      id: "artifacts",
      title: "Generated artifacts",
      body: document.artifacts.length
        ? document.artifacts.map((artifact) => `- \`${artifact.id}\` — ${artifact.label} (${artifact.bytes} bytes)${artifact.storageKey ? ` → ${artifact.storageKey}` : ""}`).join("\n")
        : "- No artifacts were generated.",
    },
    {
      id: "next-steps",
      title: "Recommended next steps",
      body: document.recommendedNext.length ? document.recommendedNext.map((entry) => `- ${entry}`).join("\n") : "- None.",
    },
  ];

  return {
    schema: 1,
    analysisId: document.analysisId,
    generatedAt: new Date().toISOString(),
    target: { name: document.target.name, sha256: document.target.sha256, sizeBytes: document.target.sizeBytes, source: document.target.source },
    objective: document.objective,
    depth: document.depth,
    dynamic: document.dynamic,
    executiveSummary: sections[0]!.body,
    container: { kind: document.container.kind, label: document.container.label, arch: document.container.arch, confidence: document.container.confidence },
    sections,
    findings: document.findings,
    evidenceCounts: counts,
    singleSourcedClaims: singleSourced.slice(0, 50),
    unknowns: document.unknowns,
    recommendedNext: document.recommendedNext,
    enginesUsed: document.enginesUsed,
    enginesMissing: document.enginesMissing,
    artifacts: document.artifacts,
    safetyContract: safety,
  };
}

function summarySentence(document: AnalysisDocument): string {
  const triage = document.triage as Record<string, unknown>;
  const obfuscation = triage.obfuscation as { summary?: string } | undefined;
  const surface = triage.surface as { strings?: number } | undefined;
  const symbols = triage.symbols as { total?: number; status?: string } | undefined;
  const parts: string[] = [];
  if (symbols?.total) parts.push(`${symbols.total} symbols (${symbols.status})`);
  if (surface?.strings) parts.push(`${surface.strings} strings`);
  if (obfuscation?.summary) parts.push(obfuscation.summary);
  return parts.length ? `Deterministic evidence: ${parts.join("; ")}.` : "No deterministic surface evidence was collected.";
}

function renderTriageTable(document: AnalysisDocument): string {
  const triage = document.triage as Record<string, unknown>;
  const container = triage.container as { label?: string; arch?: string | null; bits?: number | null; endian?: string | null } | undefined;
  const entropy = triage.entropy as { overall?: number; classification?: string } | undefined;
  const symbols = triage.symbols as { status?: string; total?: number } | undefined;
  const toolchain = triage.toolchain as { hints?: string[] } | undefined;
  const entry = triage.entry as { point?: string | null } | undefined;
  const rows: Array<[string, string]> = [
    ["Container", container?.label ?? document.container.label],
    ["Architecture", `${container?.arch ?? "unknown"}${container?.bits ? ` (${container.bits}-bit)` : ""}${container?.endian ? `, ${container.endian}-endian` : ""}`],
    ["Entropy", entropy ? `${entropy.overall} bits/byte (${entropy.classification})` : "not computed"],
    ["Symbols", symbols ? `${symbols.status} — ${symbols.total ?? 0} symbols` : "not computed"],
    ["Toolchain", toolchain?.hints?.length ? toolchain.hints.join(", ") : "no hints"],
    ["Entry point", entry?.point ?? "none identified"],
    ["Target size", `${document.target.sizeBytes} bytes`],
    ["SHA-256", document.target.sha256],
  ];
  return rows.map(([key, value]) => `| ${key} | ${value} |`).join("\n");
}

function renderArchitecture(document: AnalysisDocument): string {
  const triage = document.triage as Record<string, unknown>;
  const imports = (triage.imports as string[] | undefined) ?? [];
  const formatSpecific = (triage.formatSpecific as Record<string, unknown> | undefined) ?? {};
  const lines: string[] = [];
  lines.push(`Container: ${document.container.kind}; architecture: ${document.container.arch ?? "unknown"}.`);
  if (imports.length) lines.push(`External dependencies: ${imports.slice(0, 12).join(", ")}${imports.length > 12 ? " …" : ""}.`);
  const keys = Object.keys(formatSpecific);
  if (keys.length) lines.push(`Format-specific detail available for: ${keys.join(", ")}.`);
  lines.push("A component diagram requires either the source or a decompiler; neither is available in the deterministic pass, so none is drawn here.");
  return lines.join("\n\n");
}

function renderEvidenceGroup(evidence: Evidence[], label: EvidenceLabel): string {
  const entries = evidence.filter((entry) => entry.label === label);
  if (entries.length === 0) return `_No ${label} claims were produced._`;
  return entries
    .slice(0, 60)
    .map((entry) => `- **${entry.id}** (${entry.source} @ ${entry.location}) — ${entry.claim}${entry.crossCheckedWith?.length ? ` _[cross-checked with ${entry.crossCheckedWith.join(", ")}]_` : " _[single source]_"}`)
    .join("\n");
}

/** Render a report as bounded plain text for a tool result. */
export function renderReportText(report: AnalysisReport, maxChars = 24_000): string {
  const parts: string[] = [`# Reverse engineering report — ${report.target.name}`, `Analysis: ${report.analysisId} · objective: ${report.objective} · depth: ${report.depth} · dynamic: ${report.dynamic}`, ""];
  for (const section of report.sections) {
    parts.push(`## ${section.title}`, section.body, "");
  }
  parts.push("## Evidence counts", `observed: ${report.evidenceCounts.observed} · inferred: ${report.evidenceCounts.inferred} · proposed: ${report.evidenceCounts.proposed} · web: ${report.evidenceCounts.web} · unknown: ${report.evidenceCounts.unknown}`);
  parts.push("", "## Safety contract", ...report.safetyContract.map((entry) => `- ${entry}`));
  const text = parts.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} characters; use reverse_evidence for the full list]` : text;
}

/** Highest label across a finding's evidence — used to keep findings honest. */
export function labelForFinding(finding: AnalysisFinding, evidence: Evidence[]): EvidenceLabel {
  const backing = evidence.filter((entry) => finding.evidence.includes(entry.id));
  return backing.length ? strongestLabel(backing) : finding.label;
}
