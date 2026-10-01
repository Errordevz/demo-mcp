/**
 * Artifact comparison.
 *
 * Two targets are compared mechanically: hashes, container/architecture, size,
 * entropy, symbol overlap, section-name overlap and import overlap. The output
 * is a per-dimension similarity plus the *specific* differences, because
 * "these two binaries are 82% similar" is useless and "the second build adds
 * these 14 symbols and drops this import" is actionable.
 *
 * Everything here is derived from parsed metadata. No behavioural claim is made:
 * two builds that differ in one constant may or may not behave differently.
 */

import type { TriageReport } from "./triage.js";

export interface CompareDimension {
  dimension: string;
  same: boolean;
  left: string;
  right: string;
  similarity: number | null;
  note: string;
}

export interface CompareResult {
  schema: 1;
  left: { name: string; sha256: string };
  right: { name: string; sha256: string };
  identical: boolean;
  dimensions: CompareDimension[];
  onlyInLeft: { symbols: string[]; imports: string[]; sections: string[]; strings: string[] };
  onlyInRight: { symbols: string[]; imports: string[]; sections: string[]; strings: string[] };
  shared: { symbols: string[]; imports: string[]; sections: string[] };
  overallSimilarity: number | null;
  interpretation: string;
}

function jaccard(a: Set<string>, b: Set<string>): number | null {
  if (a.size === 0 && b.size === 0) return null;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? null : Math.round((intersection / union) * 1000) / 1000;
}

function difference(a: Set<string>, b: Set<string>, limit = 60): string[] {
  return [...a].filter((value) => !b.has(value)).slice(0, limit);
}

function shared(a: Set<string>, b: Set<string>, limit = 60): string[] {
  return [...a].filter((value) => b.has(value)).slice(0, limit);
}

/** Compare two completed triage reports. */
export function compareTriages(left: TriageReport, right: TriageReport, leftName: string, rightName: string): CompareResult {
  const leftSymbols = new Set(left.symbols.sample);
  const rightSymbols = new Set(right.symbols.sample);
  const leftImports = new Set(left.imports);
  const rightImports = new Set(right.imports);
  const leftSections = new Set(left.entropy.sections.map((section) => section.name));
  const rightSections = new Set(right.entropy.sections.map((section) => section.name));
  const leftStrings = new Set(left.surface.notable.map((entry) => entry.value));
  const rightStrings = new Set(right.surface.notable.map((entry) => entry.value));

  const identical = left.sha256 === right.sha256;
  const dimensions: CompareDimension[] = [
    {
      dimension: "sha256",
      same: identical,
      left: left.sha256,
      right: right.sha256,
      similarity: identical ? 1 : 0,
      note: identical ? "Byte-for-byte identical." : "The targets are not byte-identical.",
    },
    {
      dimension: "container",
      same: left.container.kind === right.container.kind,
      left: `${left.container.label} (${left.container.arch ?? "?"})`,
      right: `${right.container.label} (${right.container.arch ?? "?"})`,
      similarity: left.container.kind === right.container.kind ? 1 : 0,
      note: left.container.kind === right.container.kind ? "Same container family." : "Different container families — most other dimensions are not comparable.",
    },
    {
      dimension: "size",
      same: left.sizeBytes === right.sizeBytes,
      left: `${left.sizeBytes} bytes`,
      right: `${right.sizeBytes} bytes`,
      similarity: null,
      note: `Size difference: ${Math.abs(left.sizeBytes - right.sizeBytes)} bytes (${left.sizeBytes === 0 ? 0 : Math.round((Math.abs(left.sizeBytes - right.sizeBytes) / Math.max(left.sizeBytes, right.sizeBytes)) * 100)}%).`,
    },
    {
      dimension: "entropy",
      same: Math.abs(left.entropy.overall - right.entropy.overall) < 0.15,
      left: `${left.entropy.overall} (${left.entropy.classification})`,
      right: `${right.entropy.overall} (${right.entropy.classification})`,
      similarity: null,
      note: "A large entropy gap between same-family binaries usually means one is packed, compressed or encrypted.",
    },
    {
      dimension: "symbols",
      same: jaccard(leftSymbols, rightSymbols) === 1,
      left: `${leftSymbols.size} symbols`,
      right: `${rightSymbols.size} symbols`,
      similarity: jaccard(leftSymbols, rightSymbols),
      note: "Overlap of the parsed symbol surfaces.",
    },
    {
      dimension: "imports",
      same: jaccard(leftImports, rightImports) === 1,
      left: `${leftImports.size} imports`,
      right: `${rightImports.size} imports`,
      similarity: jaccard(leftImports, rightImports),
      note: "Overlap of the dependency surfaces.",
    },
    {
      dimension: "sections",
      same: jaccard(leftSections, rightSections) === 1,
      left: `${leftSections.size} sections`,
      right: `${rightSections.size} sections`,
      similarity: jaccard(leftSections, rightSections),
      note: "Overlap of the section/segment names.",
    },
    {
      dimension: "toolchain",
      same: left.toolchain.hints.sort().join("|") === right.toolchain.hints.sort().join("|"),
      left: left.toolchain.hints.join(", ") || "none",
      right: right.toolchain.hints.join(", ") || "none",
      similarity: null,
      note: "Toolchain fingerprints inferred from strings, comments and section names.",
    },
    {
      dimension: "notable strings",
      same: jaccard(leftStrings, rightStrings) === 1,
      left: `${leftStrings.size} notable strings`,
      right: `${rightStrings.size} notable strings`,
      similarity: jaccard(leftStrings, rightStrings),
      note: "Overlap of URLs, paths, crypto markers and error strings.",
    },
  ];

  const scores = dimensions.map((entry) => entry.similarity).filter((value): value is number => value !== null);
  const overall = scores.length ? Math.round((scores.reduce((sum, value) => sum + value, 0) / scores.length) * 1000) / 1000 : null;

  const interpretation = identical
    ? "The two targets are byte-identical; no comparison is needed."
    : `The targets differ in ${dimensions.filter((entry) => !entry.same).length} of ${dimensions.length} measured dimensions (overall similarity ${overall ?? "n/a"}).`;

  return {
    schema: 1,
    left: { name: leftName, sha256: left.sha256 },
    right: { name: rightName, sha256: right.sha256 },
    identical,
    dimensions,
    onlyInLeft: {
      symbols: difference(leftSymbols, rightSymbols),
      imports: difference(leftImports, rightImports),
      sections: difference(leftSections, rightSections),
      strings: difference(leftStrings, rightStrings),
    },
    onlyInRight: {
      symbols: difference(rightSymbols, leftSymbols),
      imports: difference(rightImports, leftImports),
      sections: difference(rightSections, leftSections),
      strings: difference(rightStrings, leftStrings),
    },
    shared: {
      symbols: shared(leftSymbols, rightSymbols),
      imports: shared(leftImports, rightImports),
      sections: shared(leftSections, rightSections),
    },
    overallSimilarity: overall,
    interpretation,
  };
}
