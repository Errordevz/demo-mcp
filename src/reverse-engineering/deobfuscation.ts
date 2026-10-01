/**
 * Obfuscation and packing detection.
 *
 * Ports upstream `references/06-deobfuscation-dyn.md` at the level DEMO can
 * reach deterministically: identify the obfuscation *strategy* from measurable
 * signals (entropy, section names, import surface, string statistics, single-byte
 * XOR scores), then say which neutralisation is available here and which needs
 * the analysis service.
 *
 * The rule the module enforces: an obfuscation finding is always a hypothesis
 * about *how* the code is hidden, never a claim about what the code does.
 */

import type { ByteReader } from "./binary-reader.js";
import { ENTROPY_PACKED_THRESHOLD, bestXorKey, blockEntropy, byteStats, classifyEntropy, printableRatio, shannonEntropy } from "./entropy.js";
import type { NotableString } from "./strings.js";

export interface PackingSignal {
  indicator: string;
  detail: string;
  /** Where it was observed. */
  location: string;
}

export interface PackingAssessment {
  likelyPacked: boolean;
  confidence: number;
  overallEntropy: number;
  classification: string;
  highEntropyRegions: Array<{ location: string; entropy: number; size: number }>;
  signals: PackingSignal[];
  packers: string[];
  /** What DEMO can do about it without the analysis service. */
  availableNeutralisation: string[];
  /** What needs a heavier engine. */
  requiresAnalysisService: string[];
}

export interface StringEncryptionAssessment {
  candidates: Array<{ offset: number; size: number; entropy: number; bestXorKey: number; score: number; preview: string }>;
  notes: string[];
}

export interface ObfuscationProfile {
  packing: PackingAssessment;
  stringEncryption: StringEncryptionAssessment;
  antiAnalysis: Array<{ marker: string; offset: number }>;
  controlFlow: {
    /** Control-flow analysis needs a disassembler; DEMO says so. */
    analysisAvailable: false;
    note: string;
  };
  summary: string;
}

const PACKER_MARKERS: ReadonlyArray<readonly [string, RegExp]> = [
  ["UPX", /UPX!/i],
  ["VMProtect", /VMProtect|\.vmp[01]\b/i],
  ["Themida", /Themida/i],
  ["ASPack", /ASPack|\.aspack\b/i],
  ["PECompact", /PECompact|\.PEC2\b/i],
  ["MPRESS", /MPRESS|\.MPRESS[12]\b/i],
  ["Obsidium", /Obsidium/i],
  ["Enigma", /Enigma\s*Protector/i],
  ["NSPack", /\.nsp[0-3]\b/i],
];

const PACKED_SECTION_NAMES: ReadonlyArray<readonly [string, string]> = [
  [".aspack", "ASPack"],
  [".nsp", "NSPack"],
  [".vmp0", "VMProtect"],
  [".vmp1", "VMProtect"],
  [".themida", "Themida"],
  [".enigma", "Enigma"],
  [".MPRESS1", "MPRESS"],
  [".Upack", "Upack"],
  [".petite", "Petite"],
];

const ANTI_ANALYSIS_MARKERS: ReadonlyArray<readonly [string, RegExp]> = [
  ["IsDebuggerPresent", /IsDebuggerPresent/i],
  ["CheckRemoteDebuggerPresent", /CheckRemoteDebuggerPresent/i],
  ["NtQueryInformationProcess", /NtQueryInformationProcess/i],
  ["ptrace", /\bptrace\b/i],
  ["anti-debug", /anti-?debug/i],
  ["cpuid", /\bcpuid\b/i],
  ["rdtsc", /\brdtsc\b/i],
  ["virtual-machine", /VMware|VirtualBox|VBOX|QEMU|Parallels/i],
  ["sandbox", /\bsandbox\b|\bsandboxie\b|\bcuckoo\b|\bwine\b/i],
  ["debugger-driver", /\bSbieDll|dbghelp|ollydbg|x64dbg\b/i],
];

export interface SectionLike {
  name: string;
  offset: number;
  size: number;
  entropy: number | null;
}

/** Assess packing from entropy, section names and the import surface. */
export function assessPacking(reader: ByteReader, sections: SectionLike[], notable: NotableString[], importCount: number | null): PackingAssessment {
  const bytes = reader.bytes;
  const overallEntropy = shannonEntropy(bytes);
  const classification = classifyEntropy(overallEntropy);
  const signals: PackingSignal[] = [];
  const packers: string[] = [];

  const highEntropyRegions = sections
    .filter((section) => section.entropy !== null && section.entropy > ENTROPY_PACKED_THRESHOLD && section.size > 64)
    .map((section) => ({ location: section.name, entropy: section.entropy!, size: section.size }));

  if (highEntropyRegions.length > 0) {
    signals.push({
      indicator: "high-entropy region",
      detail: `${highEntropyRegions.length} region(s) exceed ${ENTROPY_PACKED_THRESHOLD} bits/byte, the threshold for compressed or encrypted content.`,
      location: highEntropyRegions.map((region) => region.location).join(", "),
    });
  }

  for (const [name, packer] of PACKED_SECTION_NAMES) {
    const match = sections.find((section) => section.name.toLowerCase().includes(name.toLowerCase()));
    if (match) {
      packers.push(packer);
      signals.push({ indicator: "packer section name", detail: `Section "${match.name}" is characteristic of ${packer}.`, location: match.name });
    }
  }

  for (const entry of notable) {
    for (const [packer, pattern] of PACKER_MARKERS) {
      if (pattern.test(entry.value)) {
        if (!packers.includes(packer)) packers.push(packer);
        signals.push({ indicator: "packer string", detail: `String at 0x${entry.offset.toString(16)} matches the ${packer} signature.`, location: `0x${entry.offset.toString(16)}` });
      }
    }
  }

  if (importCount !== null && importCount > 0 && importCount < 6 && bytes.byteLength > 200_000) {
    signals.push({
      indicator: "thin import surface",
      detail: `Only ${importCount} imported functions for a ${Math.round(bytes.byteLength / 1024)} KiB binary: typical of a packed stub that resolves the real imports at runtime.`,
      location: "import table",
    });
  }

  const codeSections = sections.filter((section) => section.entropy !== null && section.size > 1024);
  const tinyCodeSection = codeSections.length > 0 && Math.min(...codeSections.map((section) => section.size)) < 4096;
  if (tinyCodeSection && highEntropyRegions.length > 0) {
    signals.push({ indicator: "stub-like code section", detail: "A small code section beside a high-entropy region is the classic unpacking-stub layout.", location: "section table" });
  }

  const likelyPacked = highEntropyRegions.length > 0 || packers.length > 0;
  const confidence = likelyPacked ? Math.min(0.9, 0.4 + 0.15 * signals.length + (packers.length ? 0.2 : 0)) : 0.1;

  return {
    likelyPacked,
    confidence: Math.round(confidence * 100) / 100,
    overallEntropy,
    classification,
    highEntropyRegions,
    signals,
    packers,
    availableNeutralisation: [
      "entropy profile (already computed)",
      "string and section inventory (already computed)",
      "bounded single-byte XOR key search over high-entropy blobs",
    ],
    requiresAnalysisService: [
      "static unpacking (UPX -d and equivalents)",
      "memory-dump unpacking and import-table rebuild",
      "symbolic execution / SMT for control-flow flattening and opaque predicates",
      "VM-handler identification and bytecode-ISA lifting",
    ],
  };
}

/** Look for encrypted string blobs and try the cheapest possible attack. */
export function assessStringEncryption(reader: ByteReader): StringEncryptionAssessment {
  const bytes = reader.bytes;
  const candidates: StringEncryptionAssessment["candidates"] = [];
  const notes: string[] = [];

  const blocks = blockEntropy(bytes, 4096, 64);
  for (const block of blocks) {
    if (block.entropy < 6.0 || block.size < 512) continue;
    const window = bytes.subarray(block.offset, block.offset + block.size);
    const stats = byteStats(window);
    // A blob that is high-entropy *and* almost entirely non-printable is a
    // plausible ciphertext region; one that is mostly printable is probably
    // just compressed data or a resource.
    if (stats.printableRatio > 0.6) continue;
    const best = bestXorKey(window);
    if (best.score < 0.7) continue;
    candidates.push({
      offset: block.offset,
      size: block.size,
      entropy: block.entropy,
      bestXorKey: best.key,
      score: best.score,
      preview: best.preview.slice(0, 96),
    });
    if (candidates.length >= 8) break;
  }

  if (candidates.length > 0) {
    notes.push(
      "Each candidate is a region whose single-byte-XOR decode produces mostly printable ASCII. That is a *hypothesis* about the transform, not proof: confirm by checking that the decoded text appears at a call site in the disassembly.",
    );
  } else {
    notes.push("No block matched the single-byte-XOR printable-ASCII heuristic. String encryption may use a multi-byte key, a stream cipher or nothing at all.");
  }

  return { candidates, notes };
}

/** Collect anti-analysis markers from the string surface. */
export function collectAntiAnalysisMarkers(notable: NotableString[], strings: Array<{ value: string; offset: number }>): Array<{ marker: string; offset: number }> {
  const out: Array<{ marker: string; offset: number }> = [];
  const seen = new Set<string>();
  const pool = [...notable.map((entry) => ({ value: entry.value, offset: entry.offset })), ...strings.map((entry) => ({ value: entry.value, offset: entry.offset }))];
  for (const entry of pool) {
    for (const [marker, pattern] of ANTI_ANALYSIS_MARKERS) {
      if (seen.has(marker)) continue;
      if (pattern.test(entry.value)) {
        out.push({ marker, offset: entry.offset });
        seen.add(marker);
      }
    }
  }
  return out;
}

/** Build the full obfuscation profile for one target. */
export function analyzeObfuscation(
  reader: ByteReader,
  sections: SectionLike[],
  notable: NotableString[],
  strings: Array<{ value: string; offset: number }>,
  importCount: number | null,
): ObfuscationProfile {
  const packing = assessPacking(reader, sections, notable, importCount);
  const stringEncryption = assessStringEncryption(reader);
  const antiAnalysis = collectAntiAnalysisMarkers(notable, strings);

  const parts: string[] = [];
  parts.push(packing.likelyPacked ? `Packing is likely (${packing.classification}, ${packing.highEntropyRegions.length} high-entropy region(s)).` : `No packing signal (overall entropy ${packing.overallEntropy}, ${packing.classification}).`);
  parts.push(stringEncryption.candidates.length > 0 ? `${stringEncryption.candidates.length} encrypted-string candidate(s).` : "No encrypted-string candidates.");
  parts.push(antiAnalysis.length > 0 ? `Anti-analysis markers: ${antiAnalysis.map((entry) => entry.marker).join(", ")}.` : "No anti-analysis markers in the string surface.");

  return {
    packing,
    stringEncryption,
    antiAnalysis,
    controlFlow: {
      analysisAvailable: false,
      note: "Control-flow flattening, opaque predicates and mixed boolean-arithmetic detection require a disassembler and (for opaque predicates) an SMT solver. Configure the external analysis service to enable them; DEMO will not guess at control flow.",
    },
    summary: parts.join(" "),
  };
}

export { printableRatio };
