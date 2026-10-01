/**
 * Deterministic triage — the first phase of every analysis.
 *
 * Upstream is blunt about this: "No skipping triage — wrong toolchain assumption
 * wastes an hour and produces wrong code." This module is the mechanical half of
 * that phase, and it produces the evidence everything else cites:
 *
 *   container · architecture · entry points · sections · symbols · imports ·
 *   entropy profile · packing assessment · string surface · toolchain hints
 *
 * Every value here comes from a parser, and every one of them becomes an
 * `observed` evidence entry with the tool that produced it. The *hypotheses*
 * about what the program does are produced separately and labelled `proposed`.
 */

import { ByteReader } from "./binary-reader.js";
import { detectContainer, type ContainerProfile } from "./containers.js";
import { blockEntropy, classifyEntropy, shannonEntropy } from "./entropy.js";
import { extractStrings, type NotableString } from "./strings.js";
import { parseElf, type ElfReport } from "./elf.js";
import { parsePe, type PeReport } from "./pe.js";
import { parseMachO, parseFatHeader, type MachoReport } from "./macho.js";
import { parseWasm, type WasmReport } from "./wasm.js";
import {
  parseAsar,
  parseDex,
  parseDotNetMetadata,
  parseJavaClass,
  parsePyc,
  listZipEntries,
  type AsarReport,
  type DexReport,
  type JavaClassReport,
  type ZipReport,
} from "./managed.js";
import { parsePcap, type PcapReport } from "./pcap.js";
import { extractGoMetadata, type GoMetadata } from "./modern-binaries.js";
import { analyzeObfuscation, type ObfuscationProfile, type SectionLike } from "./deobfuscation.js";
import { EvidenceStore } from "./evidence.js";
import type { StaticBudgets } from "./sandbox.js";

export interface TriageReport {
  container: ContainerProfile;
  sizeBytes: number;
  sha256: string;
  entropy: {
    overall: number;
    classification: string;
    sections: Array<{ name: string; offset: number; size: number; entropy: number | null }>;
    highEntropyBlocks: Array<{ offset: number; size: number; entropy: number }>;
  };
  entry: { point: string | null; notes: string[] };
  symbols: {
    status: "full" | "partial" | "stripped" | "none" | "not-applicable";
    total: number;
    exported: number;
    imported: number;
    sample: string[];
  };
  imports: string[];
  surface: {
    strings: number;
    stringsReturned: number;
    notable: NotableString[];
  };
  toolchain: { hints: string[]; evidence: string[] };
  obfuscation: ObfuscationProfile;
  formatSpecific: Record<string, unknown>;
  hypotheses: string[];
  warnings: string[];
}

export interface TriageResult {
  report: TriageReport;
  /** Parsers that ran, for the "engines used" list. */
  engines: string[];
}

const TOOLCHAIN_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/GCC:\s|GNU C\d|\.comment.*GCC/i, "GCC"],
  [/clang version|Apple clang/i, "Clang"],
  [/rustc|core::panicking|_R[A-Za-z0-9]{6,}/i, "Rust"],
  [/go1\.\d+\.\d+|runtime\.|go\.buildid|go:buildid/i, "Go"],
  [/MSVC|Visual C\+\+|__security_check_cookie|__chkstk/i, "MSVC"],
  [/UPX!|\.upx[01]\b/i, "UPX"],
  [/VMProtect|Themida|ASPack/i, "commercial packer"],
  [/mscorlib|\.NET|CoreCLR|System\.Private\.CoreLib/i, ".NET"],
  [/CPython|PyInstaller|MEIPASS|python3\.\d+/i, "Python"],
  [/Electron|app\.asar|node\.js/i, "Electron/Node"],
  [/Nuitka/i, "Nuitka"],
  [/Swift|\$s[A-Za-z0-9_]{4,}/i, "Swift"],
  [/Kotlin|kotlin\./i, "Kotlin"],
  [/Java|java\./i, "Java"],
  [/DexLib|dalvik/i, "Dalvik"],
];

/** Run the whole deterministic triage pass over one target. */
export function triageTarget(target: { name: string; bytes: Uint8Array; sha256: string }, budgets: StaticBudgets, store: EvidenceStore): TriageResult {
  const reader = new ByteReader(target.bytes);
  const engines: string[] = [];
  const container = detectContainer(reader);
  engines.push("demo.triage");

  const overall = shannonEntropy(target.bytes);
  const elf = container.kind === "elf" ? parseElf(reader) : null;
  const pe = container.kind === "pe" || container.kind === "dotnet" ? parsePe(reader) : null;
  const macho = container.kind === "macho" ? parseMachO(reader) : null;
  const wasm = container.kind === "wasm" ? parseWasm(reader) : null;
  const javaClass = container.kind === "java-class" ? parseJavaClass(reader) : null;
  const dex = container.kind === "dex" ? parseDex(reader) : null;
  const zip = container.kind === "jar" || container.kind === "archive" ? listZipEntries(reader) : null;
  const asar = container.kind === "asar" ? parseAsar(reader) : null;
  const pcap = container.kind === "pcap" ? parsePcap(reader) : null;
  const pyc = container.kind === "python-bytecode" ? parsePyc(reader) : null;
  const dotnetMeta = container.kind === "dotnet" ? parseDotNetMetadata(reader) : null;
  if (elf) engines.push("demo.elf");
  if (pe) engines.push("demo.pe");
  if (macho) engines.push("demo.macho");
  if (wasm) engines.push("demo.wasm");
  if (javaClass) engines.push("demo.jvm");
  if (dex) engines.push("demo.dex");
  if (zip) engines.push("demo.zip");
  if (asar) engines.push("demo.asar");
  if (pcap) engines.push("demo.pcap");
  if (dotnetMeta || pe?.isDotNet) engines.push("demo.dotnet");

  /* ------------------------------------------------------------- evidence -- */
  store.add({
    label: "observed",
    source: "demo.triage",
    target: target.name,
    location: "file magic",
    claim: container.label,
    result: { magic: container.magic, kind: container.kind, arch: container.arch, bits: container.bits, endian: container.endian, notes: container.notes },
  });
  store.add({
    label: "observed",
    source: "demo.entropy",
    target: target.name,
    location: "whole file",
    claim: `Overall Shannon entropy is ${overall} bits/byte (${classifyEntropy(overall)}).`,
    result: { entropy: overall, sizeBytes: target.bytes.byteLength },
  });
  store.add({
    label: "observed",
    source: "demo.triage",
    target: target.name,
    location: "sha256",
    claim: `SHA-256 of the target is ${target.sha256}.`,
    result: { sha256: target.sha256 },
  });

  /* -------------------------------------------------------------- strings -- */
  const strings = extractStrings(reader, { max: budgets.maxStrings });
  engines.push("demo.strings");
  store.add({
    label: "observed",
    source: "demo.strings",
    target: target.name,
    location: "string table",
    claim: `${strings.total} strings of at least 6 printable characters were found (${strings.returned.length} returned).`,
    result: { total: strings.total, returned: strings.returned.length, truncated: strings.truncated },
  });

  /* ------------------------------------------------------------- sections -- */
  const sections: SectionLike[] = [];
  if (elf) {
    for (const section of elf.sections.slice(0, budgets.maxSections)) {
      sections.push({ name: section.name, offset: section.offset, size: section.size, entropy: section.entropy });
    }
  } else if (pe) {
    for (const section of pe.sections.slice(0, budgets.maxSections)) {
      sections.push({ name: section.name, offset: section.rawOffset, size: section.rawSize, entropy: section.entropy });
    }
  } else if (macho) {
    for (const section of macho.sections.slice(0, budgets.maxSections)) {
      sections.push({ name: `${section.segment},${section.name}`, offset: section.offset, size: section.size, entropy: section.entropy });
    }
  } else if (wasm) {
    for (const section of wasm.sections.slice(0, budgets.maxSections)) {
      sections.push({ name: section.name, offset: section.offset, size: section.size, entropy: section.entropy });
    }
  }

  if (sections.length > 0) {
    store.add({
      label: "observed",
      source: elf ? "demo.elf" : pe ? "demo.pe" : macho ? "demo.macho" : "demo.wasm",
      target: target.name,
      location: "section/segment table",
      claim: `${sections.length} sections were parsed; their entropies are computed from the file bytes.`,
      result: sections.slice(0, 40),
    });
  } else if (container.kind !== "text" && container.kind !== "unknown") {
    const blocks = blockEntropy(target.bytes, 4096, 64);
    const high = blocks.filter((block) => block.entropy > 7).slice(0, 12);
    store.add({
      label: "observed",
      source: "demo.entropy",
      target: target.name,
      location: "4 KiB blocks",
      claim: `No section table is available, so entropy is reported per 4 KiB block (${blocks.length} blocks, ${high.length} above 7.0 bits/byte).`,
      result: { blocks: blocks.slice(0, 16), highEntropyBlocks: high },
    });
  }

  const obfuscation = analyzeObfuscation(reader, sections, strings.notable, strings.returned.map((entry) => ({ value: entry.value, offset: entry.offset })), importCount(elf, pe, macho));
  engines.push("demo.entropy");
  store.add({
    label: "inferred",
    source: "demo.entropy",
    target: target.name,
    location: "packing assessment",
    claim: obfuscation.packing.likelyPacked
      ? `Packing is likely: ${obfuscation.packing.signals.map((signal) => signal.indicator).join(", ")}.`
      : "No packing signal was found in the entropy profile, section names or string surface.",
    result: { likelyPacked: obfuscation.packing.likelyPacked, confidence: obfuscation.packing.confidence, signals: obfuscation.packing.signals, packers: obfuscation.packing.packers },
  });

  /* -------------------------------------------------------------- symbols -- */
  const symbolNames = collectSymbolNames(elf, pe, macho, wasm, budgets.maxSymbols);
  const symbolStatus: TriageReport["symbols"]["status"] =
    container.kind === "text" || container.kind === "unknown" || container.kind === "pcap"
      ? "not-applicable"
      : symbolNames.total === 0
        ? elf || pe || macho
          ? "stripped"
          : "none"
        : symbolNames.exported > 0 || symbolNames.total > 16
          ? "full"
          : "partial";

  store.add({
    label: "observed",
    source: elf ? "demo.elf" : pe ? "demo.pe" : macho ? "demo.macho" : "demo.triage",
    target: target.name,
    location: "symbol table",
    claim: `${symbolNames.total} symbols were read (${symbolNames.exported} exported); the surface is ${symbolStatus}.`,
    result: { total: symbolNames.total, exported: symbolNames.exported, sample: symbolNames.sample.slice(0, 20) },
  });

  const imports = collectImports(elf, pe, macho, wasm);
  if (imports.length > 0) {
    store.add({
      label: "observed",
      source: elf ? "demo.elf" : pe ? "demo.pe" : macho ? "demo.macho" : "demo.wasm",
      target: target.name,
      location: "import table",
      claim: `${imports.length} imported dependencies were read.`,
      result: imports.slice(0, 60),
    });
  }

  /* --------------------------------------------------------------- entry --- */
  const entry = entryPoint(elf, pe, macho, wasm);
  if (entry.point) {
    store.add({ label: "observed", source: elf ? "demo.elf" : pe ? "demo.pe" : macho ? "demo.macho" : "demo.wasm", target: target.name, location: "entry point", claim: `Entry point is ${entry.point}.`, result: { entry: entry.point } });
  }

  /* ----------------------------------------------------------- toolchain --- */
  const toolchain = fingerprintToolchain(container, elf, pe, macho, strings.notable, strings.returned.map((entry) => entry.value), wasm);
  if (toolchain.hints.length > 0) {
    store.add({
      label: "inferred",
      source: "demo.triage",
      target: target.name,
      location: "toolchain fingerprint",
      claim: `Toolchain hints: ${toolchain.hints.join(", ")}.`,
      result: toolchain.evidence,
      confidence: 0.6,
    });
  }

  /* ------------------------------------------------------ language metadata */
  let goMetadata: GoMetadata | null = null;
  if (elf || macho) {
    const candidate = extractGoMetadata(reader, elf, macho, Math.min(200, budgets.maxSymbols));
    if (candidate.found || candidate.buildInfo) {
      goMetadata = candidate;
      engines.push("demo.go-metadata");
      store.add({
        label: candidate.symbolTablePresent ? "observed" : "inferred",
        source: "demo.go-metadata",
        target: target.name,
        location: `.gopclntab @0x${(candidate.offset ?? 0).toString(16)}`,
        claim: candidate.found
          ? `Go pclntab found (${candidate.versionLabel}), ${candidate.totalCandidates} candidate function name(s).`
          : `Go buildinfo present (${candidate.buildInfo}); no pclntab signature was located.`,
        result: { offset: candidate.offset, magic: candidate.magic, version: candidate.versionLabel, quantum: candidate.quantum, pointerSize: candidate.pointerSize, candidates: candidate.functionNameCandidates.slice(0, 40) },
        confidence: candidate.symbolTablePresent ? 0.9 : 0.7,
      });
    }
  }

  if (elf || pe || macho) {
    const symbols = [...(elf?.symbols ?? []).map((s) => s.name), ...(pe?.exports ?? []).map((s) => s.name ?? ""), ...(macho?.symbols ?? []).map((s) => s.name)].filter(Boolean);
    if (symbols.some((symbol) => symbol.startsWith("_R"))) engines.push("demo.rust-symbols");
    if (symbols.some((symbol) => symbol.startsWith("$s") || symbol.startsWith("_$s"))) engines.push("demo.rust-symbols");
  }

  /* ------------------------------------------------------------ assembly --- */
  const formatSpecific: Record<string, unknown> = {};
  if (elf) formatSpecific.elf = summarizeElf(elf);
  if (pe) formatSpecific.pe = summarizePe(pe);
  if (macho) formatSpecific.macho = summarizeMacho(macho);
  if (container.kind === "macho") formatSpecific.fatArchitectures = parseFatHeader(reader);
  if (wasm) formatSpecific.wasm = summarizeWasm(wasm);
  if (javaClass) formatSpecific.javaClass = summarizeJava(javaClass);
  if (dex) formatSpecific.dex = dex;
  if (zip) formatSpecific.zip = summarizeZip(zip);
  if (asar) formatSpecific.asar = asar;
  if (pcap) formatSpecific.pcap = summarizePcap(pcap);
  if (pyc) formatSpecific.pyc = pyc;
  if (dotnetMeta) formatSpecific.dotnetMetadata = dotnetMeta;
  if (goMetadata) formatSpecific.go = { version: goMetadata.versionLabel, candidates: goMetadata.functionNameCandidates.slice(0, 60), totalCandidates: goMetadata.totalCandidates };

  const warnings = [
    ...container.notes.filter((note) => note.startsWith("No known container") || note.startsWith("Leading bytes")),
    ...(elf?.warnings ?? []),
    ...(pe?.warnings ?? []),
    ...(macho?.warnings ?? []),
    ...(wasm?.warnings ?? []),
    ...(javaClass?.warnings ?? []),
    ...(dex?.warnings ?? []),
    ...(zip?.warnings ?? []),
    ...(asar?.warnings ?? []),
    ...(pcap?.warnings ?? []),
    ...obfuscation.packing.signals.map((signal) => `${signal.indicator}: ${signal.detail}`),
  ].slice(0, 40);

  const report: TriageReport = {
    container,
    sizeBytes: target.bytes.byteLength,
    sha256: target.sha256,
    entropy: {
      overall,
      classification: classifyEntropy(overall),
      sections,
      highEntropyBlocks: blockEntropy(target.bytes, 4096, 64)
        .filter((block) => block.entropy > 7)
        .slice(0, 12),
    },
    entry,
    symbols: { status: symbolStatus, total: symbolNames.total, exported: symbolNames.exported, imported: imports.length, sample: symbolNames.sample.slice(0, 20) },
    imports,
    surface: { strings: strings.total, stringsReturned: strings.returned.length, notable: strings.notable },
    toolchain,
    obfuscation,
    formatSpecific,
    hypotheses: buildHypotheses(container, toolchain.hints, strings.notable, imports, obfuscation),
    warnings,
  };

  /* ------------------------------------------------------------ synthesis -- */
  // The parsers above produce observations. These are the *hypotheses*, and they
  // are recorded as such — a proposed claim is never promoted to an observation
  // by being written down next to one.
  for (const hypothesis of report.hypotheses) {
    const isUnknown = hypothesis.startsWith("unknown:");
    store.add({
      label: isUnknown ? "unknown" : "proposed",
      source: "demo.triage",
      target: target.name,
      location: "analysis synthesis",
      claim: hypothesis.replace(/^(proposed|unknown):\s*/, ""),
      result: { hypothesis },
      confidence: isUnknown ? 0.1 : 0.4,
    });
  }

  return { report, engines };
}

function importCount(elf: ElfReport | null, pe: PeReport | null, macho: MachoReport | null): number | null {
  if (elf) return elf.dynamic.needed.length + elf.dynamicSymbols.filter((symbol) => symbol.shndx === "UNDEF").length;
  if (pe) return pe.imports.reduce((sum, entry) => sum + entry.functions.length, 0);
  if (macho) return macho.dylibs.length;
  return null;
}

function collectSymbolNames(elf: ElfReport | null, pe: PeReport | null, macho: MachoReport | null, wasm: WasmReport | null, limit: number) {
  const names: string[] = [];
  const exported = new Set<string>();
  if (elf) {
    for (const symbol of elf.symbols) if (symbol.name && symbol.bind !== "LOCAL") exported.add(symbol.name);
    for (const symbol of elf.dynamicSymbols) if (symbol.name && symbol.shndx !== "UNDEF") exported.add(symbol.name);
    names.push(...elf.symbols.map((s) => s.name), ...elf.dynamicSymbols.map((s) => s.name));
  }
  if (pe) {
    for (const symbol of pe.exports) if (symbol.name) exported.add(symbol.name);
    names.push(...pe.exports.map((s) => s.name ?? ""), ...pe.imports.flatMap((entry) => entry.functions));
  }
  if (macho) {
    for (const symbol of macho.symbols) if (symbol.type === "external") exported.add(symbol.name);
    names.push(...macho.symbols.map((s) => s.name));
  }
  if (wasm) {
    for (const entry of wasm.exports) exported.add(entry.name);
    names.push(...wasm.exports.map((entry) => entry.name), ...wasm.imports.map((entry) => `${entry.module}.${entry.field}`));
  }
  const clean = [...new Set(names.filter(Boolean))];
  return { total: clean.length, exported: exported.size, sample: clean.slice(0, limit) };
}

function collectImports(elf: ElfReport | null, pe: PeReport | null, macho: MachoReport | null, wasm: WasmReport | null): string[] {
  if (elf) return elf.dynamic.needed;
  if (pe) return pe.imports.map((entry) => entry.dll);
  if (macho) return macho.dylibs;
  if (wasm) return [...new Set(wasm.imports.map((entry) => entry.module))];
  return [];
}

function entryPoint(elf: ElfReport | null, pe: PeReport | null, macho: MachoReport | null, wasm: WasmReport | null): { point: string | null; notes: string[] } {
  const notes: string[] = [];
  if (elf) {
    notes.push(`e_type=${elf.type}; ${elf.programHeaders.filter((header) => header.type === "INTERP").length} INTERP segment(s).`);
    return { point: `0x${elf.entry.toString(16)}`, notes };
  }
  if (pe) return { point: `RVA 0x${pe.entryPoint.toString(16)} (image base 0x${pe.imageBase.toString(16)})`, notes: [`Subsystem: ${pe.subsystem}.`] };
  if (macho) return { point: macho.entry === null ? null : `file offset 0x${macho.entry.toString(16)}`, notes: [`filetype=${macho.filetype}.`] };
  if (wasm) return { point: wasm.startFunction === null ? null : `start function #${wasm.startFunction}`, notes: [] };
  return { point: null, notes };
}

function fingerprintToolchain(
  container: ContainerProfile,
  elf: ElfReport | null,
  pe: PeReport | null,
  macho: MachoReport | null,
  notable: NotableString[],
  strings: string[],
  wasm: WasmReport | null,
): { hints: string[]; evidence: string[] } {
  const hints = new Set<string>();
  const evidence: string[] = [];
  const haystack = [...notable.map((entry) => entry.value), ...strings.slice(0, 400)].join("\n");

  for (const [pattern, label] of TOOLCHAIN_PATTERNS) {
    if (pattern.test(haystack)) {
      hints.add(label);
      const match = haystack.match(pattern);
      if (match) evidence.push(`${label}: matched /${match[0].slice(0, 60)}/`);
    }
  }
  if (elf?.comment) {
    hints.add(elf.comment.trim().split("\n")[0]!.slice(0, 80));
    evidence.push(`.comment: ${elf.comment.trim().slice(0, 120)}`);
  }
  if (elf?.goBuildInfo) {
    hints.add("Go");
    evidence.push(`.go.buildinfo: ${elf.goBuildInfo}`);
  }
  if (pe?.pdbPath) {
    evidence.push(`CodeView PDB path: ${pe.pdbPath}`);
    if (/\.pdb$/i.test(pe.pdbPath)) hints.add("MSVC-style debug info");
  }
  if (pe?.isDotNet) hints.add(".NET (CLR)");
  if (macho?.sections.some((section) => section.segment === "__TEXT" && section.name === "__swift5_typeref")) hints.add("Swift");
  if (wasm?.imports.some((entry) => entry.module === "wasi_snapshot_preview1")) hints.add("WASI");
  if (container.kind === "python-bytecode") hints.add("CPython bytecode");

  return { hints: [...hints], evidence };
}

function buildHypotheses(container: ContainerProfile, toolchain: string[], notable: NotableString[], imports: string[], obfuscation: ObfuscationProfile): string[] {
  const out: string[] = [];
  out.push(`proposed: the target is a ${container.kind} artifact for ${container.arch ?? "an unidentified architecture"}.`);
  if (toolchain.length) out.push(`proposed: it was produced by ${toolchain.slice(0, 3).join(" / ")}.`);
  const url = notable.find((entry) => entry.theme === "url");
  if (url) out.push(`proposed: it contacts ${url.value.slice(0, 80)} (observed as a string, not as traffic).`);
  if (notable.some((entry) => entry.theme === "crypto-marker")) out.push("proposed: it performs cryptographic operations (a crypto API name appears in the string surface).");
  if (obfuscation.packing.likelyPacked) out.push("proposed: it is packed or obfuscated, so the visible code is a stub rather than the real logic.");
  if (imports.length) out.push(`proposed: it depends on ${imports.slice(0, 4).join(", ")}.`);
  out.push("unknown: what the program actually does at runtime — that requires behavioural evidence, which static analysis cannot supply.");
  return out;
}

function summarizeElf(elf: ElfReport) {
  return {
    bits: elf.bits,
    endian: elf.endian,
    type: elf.type,
    machine: elf.machine,
    osAbi: elf.osAbi,
    entry: `0x${elf.entry.toString(16)}`,
    buildId: elf.buildId,
    comment: elf.comment,
    goBuildInfo: elf.goBuildInfo,
    sections: elf.sections.slice(0, 60),
    dynamic: elf.dynamic,
    programHeaders: elf.programHeaders,
    symbolCount: elf.symbols.length,
    dynamicSymbolCount: elf.dynamicSymbols.length,
  };
}

function summarizePe(pe: PeReport) {
  return {
    machine: pe.machine,
    bits: pe.bits,
    subsystem: pe.subsystem,
    linkerVersion: pe.linkerVersion,
    timestamp: pe.timestamp,
    imageBase: `0x${pe.imageBase.toString(16)}`,
    entryPoint: `0x${pe.entryPoint.toString(16)}`,
    dllCharacteristics: pe.dllCharacteristics,
    pdbPath: pe.pdbPath,
    isDotNet: pe.isDotNet,
    dotnetRuntime: pe.dotnetRuntime,
    dotnetMetadataStreams: pe.dotnetMetadataStreams,
    exportName: pe.exportName,
    exportCount: pe.exports.length,
    importCount: pe.imports.length,
    imports: pe.imports.slice(0, 24),
    sections: pe.sections,
  };
}

function summarizeMacho(macho: MachoReport) {
  return {
    bits: macho.bits,
    endian: macho.endian,
    cputype: macho.cputype,
    filetype: macho.filetype,
    flags: macho.flags,
    uuid: macho.uuid,
    entry: macho.entry === null ? null : `0x${macho.entry.toString(16)}`,
    codeSignature: macho.codeSignature,
    dylibs: macho.dylibs.slice(0, 40),
    sections: macho.sections.slice(0, 60),
    symbolCount: macho.symbols.length,
  };
}

function summarizeWasm(wasm: WasmReport) {
  return {
    version: wasm.version,
    sections: wasm.sections,
    imports: wasm.imports.slice(0, 60),
    exports: wasm.exports.slice(0, 60),
    functionCount: wasm.functionCount,
    codeCount: wasm.codeCount,
    memoryCount: wasm.memoryCount,
    tableCount: wasm.tableCount,
    globalCount: wasm.globalCount,
    dataCount: wasm.dataCount,
    startFunction: wasm.startFunction,
    moduleName: wasm.moduleName,
    functionNames: wasm.functionNames.slice(0, 60),
    wasiImports: wasm.wasiImports,
  };
}

function summarizeJava(java: JavaClassReport) {
  return {
    javaVersion: java.javaVersion,
    access: java.access,
    thisClass: java.thisClass,
    superClass: java.superClass,
    interfaces: java.interfaces,
    fields: java.fields.slice(0, 60),
    methods: java.methods.slice(0, 60),
    sourceFile: java.sourceFile,
    constantPoolEntries: java.constantPoolEntries,
  };
}

function summarizeZip(zip: ZipReport) {
  return {
    entryCount: zip.entryCount,
    jarLike: zip.jarLike,
    apkLike: zip.apkLike,
    totalCompressed: zip.totalCompressed,
    totalUncompressed: zip.totalUncompressed,
    maxRatio: zip.maxRatio,
    encryptedEntries: zip.encryptedEntries,
    entries: zip.entries.slice(0, 60),
  };
}

function summarizePcap(pcap: PcapReport) {
  return {
    format: pcap.format,
    linkType: pcap.linkType,
    snaplen: pcap.snaplen,
    packetCount: pcap.packetCount,
    truncated: pcap.truncated,
    lengthHistogram: pcap.lengthHistogram,
    streams: pcap.streams,
    packets: pcap.packets.slice(0, 40),
  };
}
