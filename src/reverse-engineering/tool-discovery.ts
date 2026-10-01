/**
 * Capability detection.
 *
 * The upstream skill's first phase is "Phase 0 — tool access": know what you can
 * actually drive before you plan anything. DEMO runs on Cloudflare Workers, so
 * there is no `file`, no `objdump` and no Ghidra *inside* the Worker — and
 * pretending otherwise is exactly the failure mode this module exists to
 * prevent. It therefore reports three honest lists:
 *
 *   available  — engines that really run here (the deterministic parsers) plus,
 *                when configured, the real inventory reported by the external
 *                analysis service;
 *   missing    — the classic RE toolchain, with the reason it is absent;
 *   recommended — the smallest workflow for the detected container.
 *
 * A caller can never be told a tool exists when it does not: every entry is
 * either a code path in this repository or a response from a configured
 * service.
 */

import type { ContainerKind } from "./types.js";

export interface DetectedEngine {
  id: string;
  title: string;
  detail: string;
  /** Free-form tags: container families and workflow phases this engine covers. */
  covers: string[];
  /** Where it runs. */
  runtime: "worker" | "analysis-service";
}

/** Deterministic engines shipped inside DEMO. Always available. */
export const WORKER_ENGINES: readonly DetectedEngine[] = [
  { id: "demo.triage", title: "Deterministic triage", detail: "Container, architecture, endianness, entry points, packing and toolchain hints — computed from the artifact.", covers: ["triage", "identify", "architecture"], runtime: "worker" },
  { id: "demo.entropy", title: "Shannon entropy", detail: "Whole-file, per-section and per-block entropy plus byte statistics, computed by code.", covers: ["obfuscation", "triage"], runtime: "worker" },
  { id: "demo.strings", title: "String extraction", detail: "ASCII and UTF-16LE strings with offsets, bounded, plus notable-pattern grouping.", covers: ["strings", "triage", "behavior"], runtime: "worker" },
  { id: "demo.elf", title: "ELF parser", detail: "Header, sections, symbols, dynamic section, program headers, build-id, Go buildinfo.", covers: ["elf", "symbols", "functions", "architecture"], runtime: "worker" },
  { id: "demo.pe", title: "PE/COFF parser", detail: "Header, data directories, sections, exports, imports, CodeView PDB path, CLR/.NET metadata.", covers: ["pe", "dotnet", "symbols", "architecture"], runtime: "worker" },
  { id: "demo.macho", title: "Mach-O parser", detail: "Load commands, segments/sections, dylibs, UUID, entry point, symbol table, fat containers.", covers: ["macho", "symbols", "architecture"], runtime: "worker" },
  { id: "demo.wasm", title: "WebAssembly parser", detail: "Sections, imports, exports, memory/table/global counts and the name custom section.", covers: ["wasm", "symbols", "architecture"], runtime: "worker" },
  { id: "demo.jvm", title: "JVM class parser", detail: "Constant pool, access flags, this/super class, interfaces, fields, methods, SourceFile.", covers: ["java-class", "jar", "symbols", "architecture"], runtime: "worker" },
  { id: "demo.dex", title: "Android DEX parser", detail: "DEX header, checksum, signature and the id tables.", covers: ["dex", "symbols"], runtime: "worker" },
  { id: "demo.dotnet", title: ".NET metadata reader", detail: "CLR runtime version and the metadata stream table.", covers: ["dotnet", "architecture"], runtime: "worker" },
  { id: "demo.python-bytecode", title: "Python bytecode header", detail: "Magic → version mapping and header flags, so the decompiler is version-gated.", covers: ["python-bytecode", "identify"], runtime: "worker" },
  { id: "demo.asar", title: "Electron ASAR reader", detail: "Pickled JSON header: entry count, sizes and the top-level layout. Members are never extracted.", covers: ["asar", "architecture"], runtime: "worker" },
  { id: "demo.zip", title: "ZIP/JAR/APK directory reader", detail: "Central directory listing with explicit decompression-bomb guards. No member is ever decompressed.", covers: ["jar", "archive", "identify"], runtime: "worker" },
  { id: "demo.pcap", title: "PCAP / PCAPNG reader", detail: "Packet inventory, per-flow reassembly and length histograms, bounded.", covers: ["pcap", "protocol", "ipc"], runtime: "worker" },
  { id: "demo.protocol", title: "Protocol framing analysis", detail: "Column-wise alignment, length-prefix, counter and checksum candidate detection across messages.", covers: ["protocol", "ipc"], runtime: "worker" },
  { id: "demo.go-metadata", title: "Go metadata recovery", detail: "Locates .gopclntab, validates the magic and recovers candidate function names from stripped binaries.", covers: ["elf", "go", "symbols"], runtime: "worker" },
  { id: "demo.rust-symbols", title: "Rust/Swift symbol demangling", detail: "Detects and demangles Rust v0 and legacy mangled symbols and Swift `$s` symbols.", covers: ["elf", "rust", "swift", "symbols"], runtime: "worker" },
  { id: "demo.struct-validation", title: "Struct layout validation", detail: "Validates recovered field offsets, sizes, alignment holes and overlaps mechanically.", covers: ["clean-room", "protocol", "architecture"], runtime: "worker" },
  { id: "demo.cleanroom", title: "Clean-room specification", detail: "Freezes an evidence-referenced behavioural specification and derives golden test cases.", covers: ["clean-room", "compare"], runtime: "worker" },
  { id: "demo.compare", title: "Artifact comparison", detail: "Compares two artifacts, captures or implementations and reports the evidence-labelled differences.", covers: ["compare", "protocol", "clean-room"], runtime: "worker" },
];

/**
 * The classic RE toolchain, and why it is absent from a Worker. Reported so a
 * caller knows what would help and how to get it — never claimed as present.
 */
export const EXTERNAL_TOOLS: readonly DetectedEngine[] = [
  { id: "file", title: "file(1)", detail: "libmagic identification.", covers: ["triage"], runtime: "analysis-service" },
  { id: "strings", title: "strings(1)", detail: "Native string extraction (DEMO has an in-process equivalent).", covers: ["strings"], runtime: "analysis-service" },
  { id: "readelf", title: "readelf", detail: "ELF headers, sections, symbols, relocations, notes.", covers: ["elf"], runtime: "analysis-service" },
  { id: "objdump", title: "objdump", detail: "Disassembly and section dumping.", covers: ["elf", "functions", "decompile"], runtime: "analysis-service" },
  { id: "nm", title: "nm", detail: "Symbol tables.", covers: ["symbols"], runtime: "analysis-service" },
  { id: "otool", title: "otool", detail: "Mach-O load commands and sections.", covers: ["macho"], runtime: "analysis-service" },
  { id: "llvm", title: "LLVM binutils", detail: "llvm-objdump / llvm-readelf / llvm-nm.", covers: ["elf", "functions"], runtime: "analysis-service" },
  { id: "ghidra", title: "Ghidra headless", detail: "Decompilation, xrefs and type recovery.", covers: ["decompile", "functions"], runtime: "analysis-service" },
  { id: "radare2", title: "radare2 / rizin", detail: "Disassembly, analysis and scripting.", covers: ["decompile", "functions"], runtime: "analysis-service" },
  { id: "frida", title: "Frida", detail: "Dynamic instrumentation (explicit opt-in, sandboxed).", covers: ["behavior", "ipc"], runtime: "analysis-service" },
  { id: "jadx", title: "Jadx", detail: "Android DEX/APK decompilation.", covers: ["dex", "decompile"], runtime: "analysis-service" },
  { id: "apktool", title: "apktool", detail: "APK resource and manifest decoding.", covers: ["dex"], runtime: "analysis-service" },
  { id: "javap", title: "javap", detail: "JVM bytecode disassembly.", covers: ["java-class", "decompile"], runtime: "analysis-service" },
  { id: "dotnet", title: "ildasm / ILSpy", detail: ".NET IL disassembly and decompilation.", covers: ["dotnet", "decompile"], runtime: "analysis-service" },
  { id: "wasm", title: "wasm2wat / wasm-tools", detail: "WASM to WAT/IR conversion.", covers: ["wasm", "decompile"], runtime: "analysis-service" },
  { id: "go", title: "go tool nm / GoReSym", detail: "Authoritative Go symbol recovery from pclntab.", covers: ["go", "symbols"], runtime: "analysis-service" },
  { id: "rust", title: "rustfilt", detail: "Rust symbol demangling (DEMO has an in-process subset).", covers: ["rust", "symbols"], runtime: "analysis-service" },
  { id: "z3", title: "Z3 / angr", detail: "SMT solving and symbolic execution for obfuscated control flow.", covers: ["obfuscation", "decompile"], runtime: "analysis-service" },
  { id: "binwalk", title: "binwalk", detail: "Embedded-file and firmware carving.", covers: ["archive", "identify"], runtime: "analysis-service" },
  { id: "tshark", title: "tshark / WireMCP", detail: "Deep packet analysis.", covers: ["pcap", "protocol"], runtime: "analysis-service" },
];

export interface CapabilityDetection {
  available: DetectedEngine[];
  missing: DetectedEngine[];
  recommendedWorkflow: string[];
  requiresAnalysisService: string[];
  /** The analysis service's own reported inventory, when it answered. */
  serviceInventory: Array<{ id: string; title: string }> | null;
}

export interface DetectionInput {
  analyzerUrl: string | null;
  /** The analyzer's reported tool inventory, or null when it did not answer. */
  serviceTools?: Array<{ id: string; title: string }> | null;
  container?: ContainerKind | null;
  objective?: string | null;
  dynamic?: boolean;
}

/** Build the capability report for a container and objective. */
export function detectCapabilities(input: DetectionInput): CapabilityDetection {
  const available: DetectedEngine[] = [...WORKER_ENGINES];
  const serviceInventory = input.serviceTools ?? null;
  if (serviceInventory) {
    for (const tool of serviceInventory) {
      available.push({ id: `service.${tool.id}`, title: tool.title, detail: "Reported by the configured external analysis service.", covers: ["decompile", "functions", "behavior"], runtime: "analysis-service" });
    }
  }

  const serviceToolIds = new Set((serviceInventory ?? []).map((tool) => tool.id));
  const missing = EXTERNAL_TOOLS.filter((tool) => !serviceToolIds.has(tool.id)).map((tool) => ({
    ...tool,
    detail: input.analyzerUrl
      ? `${tool.detail} The configured analysis service did not report it.`
      : `${tool.detail} Not available inside the DEMO Worker runtime; configure the external analysis service (RE_ANALYZER_URL) to run it under isolation.`,
  }));

  return {
    available,
    missing,
    recommendedWorkflow: recommendWorkflow(input.container ?? null, input.objective ?? null, Boolean(input.dynamic)),
    requiresAnalysisService: input.analyzerUrl ? [] : ["decompile", "functions", "behavior", "ipc", "obfuscation:dynamic"],
    serviceInventory,
  };
}

/** The smallest workflow that answers the objective for this container. */
export function recommendWorkflow(container: ContainerKind | null, objective: string | null, dynamic: boolean): string[] {
  const steps: string[] = ["triage"];
  const kind = container ?? "unknown";

  if (objective === "identify" || objective === "triage") return ["triage", "strings"];
  if (objective === "strings") return ["triage", "strings"];
  if (objective === "symbols") {
    steps.push("symbols");
    if (kind === "elf" || kind === "macho" || kind === "pe") steps.push("language-metadata");
    return steps;
  }
  if (objective === "architecture") {
    steps.push("sections", "entry-points", "imports-exports");
    if (kind === "wasm") steps.push("wasm-abi");
    return steps;
  }
  if (objective === "functions") {
    steps.push("symbols", "function-boundaries");
    if (!dynamic) steps.push("request-analysis-service-for-decompilation");
    return steps;
  }
  if (objective === "decompile") {
    steps.push("symbols", "disassembly");
    steps.push(dynamic ? "sandboxed-decompilation" : "request-analysis-service-for-decompilation");
    return steps;
  }
  if (objective === "protocol") {
    steps.push("packet-inventory", "framing-inference", "field-inference", "state-machine", "protocol-specification");
    return steps;
  }
  if (objective === "ipc") {
    steps.push("packet-inventory", "framing-inference", "ipc-surface", "state-machine");
    return steps;
  }
  if (objective === "behavior") {
    steps.push("strings", "imports-exports", "notable-strings");
    steps.push(dynamic ? "sandboxed-instrumentation" : "request-analysis-service-for-instrumentation");
    return steps;
  }
  if (objective === "obfuscation") {
    steps.push("entropy-profile", "packing-detection", "string-encryption-heuristics");
    steps.push(dynamic ? "sandboxed-unpacking" : "request-analysis-service-for-unpacking");
    return steps;
  }
  if (objective === "clean-room") {
    steps.push("strings", "protocol-or-format-evidence", "specification-freeze", "golden-tests");
    return steps;
  }
  if (objective === "compare") return ["triage", "artifact-comparison"];
  if (objective === "vulnerability") {
    steps.push("entropy-profile", "notable-strings", "imports-exports", "input-sinks", "defensive-summary");
    return steps;
  }

  // Default: the upstream default is "understand behavior".
  steps.push("sections", "symbols", "strings", "notable-strings", "findings");
  return steps;
}

