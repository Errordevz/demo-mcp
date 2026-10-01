/**
 * Reverse-engineering capability — the full contract.
 *
 * The tests below are deliberately behavioural rather than smoke tests: they
 * pin the *evidence rules* (labels are never promoted, single-source claims are
 * reported), the *security rules* (no execution, no arbitrary command, path
 * isolation, size caps, dynamic refusal) and the *math* (entropy, checksums,
 * struct layouts), because those are the properties that make the capability
 * trustworthy rather than merely functional.
 *
 * Every fixture is synthetic and built in tests/helpers/reverse-fixtures.ts: no
 * real product binary, no malware, nothing copyrighted.
 */

import { describe, expect, it } from "vitest";
import worker, { DEMO_TOOL_NAMES, TOOL_COUNT } from "../index.js";
import { REVERSE_TOOL_NAMES } from "../src/mcp/reverse-tools.js";
import { ByteReader } from "../src/reverse-engineering/binary-reader.js";
import { detectContainer } from "../src/reverse-engineering/containers.js";
import { shannonEntropy, blockEntropy, classifyEntropy, crc32, adler32, sum16, xor8, crc16, bestXorKey, ENTROPY_PACKED_THRESHOLD } from "../src/reverse-engineering/entropy.js";
import { parseElf } from "../src/reverse-engineering/elf.js";
import { parsePe } from "../src/reverse-engineering/pe.js";
import { parseMachO } from "../src/reverse-engineering/macho.js";
import { parseWasm } from "../src/reverse-engineering/wasm.js";
import { parsePcap } from "../src/reverse-engineering/pcap.js";
import { listZipEntries, parseJavaClass } from "../src/reverse-engineering/managed.js";
import { EvidenceStore } from "../src/reverse-engineering/evidence.js";
import { EXTERNAL_TOOLS, WORKER_ENGINES, detectCapabilities, recommendWorkflow } from "../src/reverse-engineering/tool-discovery.js";
import { ANALYZER_OPERATIONS, isAnalyzerOperation, runAnalyzerOperation } from "../src/reverse-engineering/engine.js";
import { DEFAULT_SANDBOX_POLICY, REFUSED_OPERATIONS, evaluateDynamicRequest, safetyContract, staticBudgets } from "../src/reverse-engineering/sandbox.js";
import { resolveReverseEngineeringConfig, resolveReverseEngineeringPolicy, RE_CAPS } from "../src/reverse-engineering/config.js";
import { WORKSPACE_ROOT, assertSafeWorkspacePath, decodeBase64Bounded, isInsideWorkspace, sanitizeAnalysisId } from "../src/reverse-engineering/workspace.js";
import { triageTarget } from "../src/reverse-engineering/triage.js";
import { analyzeFraming, produceProtocolSpecification } from "../src/reverse-engineering/protocol-analysis.js";
import { compareAgainstGolden, deriveGoldenCases, freezeSpecification } from "../src/reverse-engineering/cleanroom.js";
import { validateStructLayout } from "../src/reverse-engineering/struct.js";
import { compareTriages } from "../src/reverse-engineering/compare.js";
import { createReverseEngineeringStore } from "../src/reverse-engineering/store.js";
import { runReverseRequest, type ReverseContext } from "../src/reverse-engineering/router.js";
import { demangleRustV0, demangleSymbols, extractGoMetadata } from "../src/reverse-engineering/modern-binaries.js";
import { TOOL_CATALOG } from "../src/ui/tool-catalog.js";
import { CAPABILITY_CATEGORIES } from "../src/ui/content.js";
import {
  elfFixture,
  goPclntabFixture,
  javaClassFixture,
  machoFixture,
  peFixture,
  pseudoRandomBytes,
  pcapFixture,
  textFixture,
  unknownFixture,
  wasmFixture,
  zipFixture,
} from "./helpers/reverse-fixtures.js";

const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

function makeContext(overrides: Partial<ReverseContext["config"]> = {}, store = createReverseEngineeringStore(undefined)): ReverseContext {
  const base = resolveReverseEngineeringConfig({});
  return {
    config: { ...base, caps: { ...base.caps }, ...overrides },
    store,
    fetchBytes: async () => {
      throw new Error("no fetch in this test");
    },
    now: () => new Date("2026-10-01T00:00:00.000Z"),
  };
}

/* ------------------------------------------------------------ identification */

describe("container identification", () => {
  it("identifies ELF, PE, Mach-O, WASM, ZIP/JAR, Java class, PCAP and text", () => {
    const cases: Array<[string, Uint8Array, string]> = [
      ["elf", elfFixture(), "elf"],
      ["pe", peFixture(), "pe"],
      ["macho", machoFixture(), "macho"],
      ["wasm", wasmFixture(), "wasm"],
      ["zip", zipFixture(), "jar"],
      ["java-class", javaClassFixture(), "java-class"],
      ["pcap", pcapFixture(), "pcap"],
    ];
    for (const [name, bytes, kind] of cases) {
      const profile = detectContainer(new ByteReader(bytes));
      expect(profile.kind, name).toBe(kind);
      expect(profile.confidence, name).toBeGreaterThan(0.5);
    }
    const text = new TextEncoder().encode(textFixture());
    const textProfile = detectContainer(new ByteReader(text));
    expect(textProfile.kind).toBe("text");
    expect(textProfile.arch).toBeNull();
    expect(textProfile.confidence).toBeLessThan(1);
  });

  it("reads ELF architecture, bits, endianness, sections and entry point", () => {
    const elf = parseElf(new ByteReader(elfFixture()));
    expect(elf).not.toBeNull();
    expect(elf!.bits).toBe(64);
    expect(elf!.endian).toBe("little");
    expect(elf!.type).toContain("ET_EXEC");
    expect(elf!.machine).toContain("x86-64");
    expect(elf!.entry).toBe(0x401000);
    const names = elf!.sections.map((section) => section.name);
    expect(names).toContain(".text");
    expect(names).toContain(".shstrtab");
    const text = elf!.sections.find((section) => section.name === ".text");
    expect(text!.entropy).not.toBeNull();
    // 64 identical bytes carry no information.
    expect(text!.entropy).toBe(0);
  });

  it("reads PE machine, bits, subsystem and sections", () => {
    const pe = parsePe(new ByteReader(peFixture()));
    expect(pe).not.toBeNull();
    expect(pe!.bits).toBe(64);
    expect(pe!.machine).toContain("x86-64");
    expect(pe!.imageBase).toBe(0x140000000);
    expect(pe!.sections.map((section) => section.name)).toContain(".text");
  });

  it("reads Mach-O cputype, filetype and 64-bit width", () => {
    const macho = parseMachO(new ByteReader(machoFixture()));
    expect(macho).not.toBeNull();
    expect(macho!.bits).toBe(64);
    expect(macho!.filetype).toContain("MH_EXECUTE");
    expect(macho!.cputype).toBeTruthy();
  });

  it("reads WASM sections, version and counts", () => {
    const wasm = parseWasm(new ByteReader(wasmFixture()));
    expect(wasm).not.toBeNull();
    expect(wasm!.version).toBe(1);
    expect(wasm!.sections.map((section) => section.name)).toEqual(["type", "function"]);
  });

  it("reads a PCAP as data: two packets, two streams, nothing transmitted", () => {
    const pcap = parsePcap(new ByteReader(pcapFixture()));
    expect(pcap).not.toBeNull();
    expect(pcap!.format).toBe("pcap");
    expect(pcap!.packetCount).toBe(2);
    expect(pcap!.streams).toHaveLength(2);
    expect(pcap!.packets[0]!.src).toBe("10.0.0.1");
    expect(pcap!.packets[0]!.protocol).toBe("TCP");
  });

  it("reads a ZIP central directory without decompressing anything", () => {
    const zip = listZipEntries(new ByteReader(zipFixture()));
    expect(zip!.ok).toBe(true);
    expect(zip!.entryCount).toBe(1);
    expect(zip!.entries[0]!.name).toBe("demo.txt");
    expect(zip!.maxRatio).toBe(1);
  });

  it("reads a Java class header and its constant pool", () => {
    const java = parseJavaClass(new ByteReader(javaClassFixture()));
    expect(java!.majorVersion).toBe(61);
    expect(java!.javaVersion).toBe("Java 17");
    expect(java!.constantPoolEntries).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------ unknown files */

describe("unknown-file handling", () => {
  it("reports an undocumented container instead of guessing", () => {
    const profile = detectContainer(new ByteReader(unknownFixture()));
    expect(profile.kind).toBe("unknown");
    expect(profile.arch).toBeNull();
    expect(profile.notes.join(" ")).toContain("No known container matched");
  });

  it("never crashes on truncated or empty input", () => {
    for (const bytes of [new Uint8Array(), new Uint8Array([0x7f, 0x45]), new Uint8Array(4), new Uint8Array(3_000_000).fill(0xff)]) {
      const reader = new ByteReader(bytes);
      expect(() => detectContainer(reader)).not.toThrow();
      expect(parseElf(reader)).toBeNull();
      expect(parsePe(reader)).toBeNull();
      expect(parseMachO(reader)).toBeNull();
      expect(parseWasm(reader)).toBeNull();
      expect(parsePcap(reader)).toBeNull();
      expect(listZipEntries(reader)).toBeNull();
    }
  });

  it("surfaces the unknown as an `unknown` evidence label rather than hiding it", async () => {
    const bytes = unknownFixture();
    const store = new EvidenceStore(() => "2026-10-01T00:00:00.000Z");
    const { report } = triageTarget({ name: "mystery.bin", bytes, sha256: "abc" }, staticBudgets(resolveReverseEngineeringConfig({}), "quick"), store);
    expect(report.container.kind).toBe("unknown");
    expect(report.hypotheses.some((entry) => entry.startsWith("unknown:"))).toBe(true);
    expect(store.counts().unknown).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ entropy */

describe("entropy", () => {
  it("computes Shannon entropy, block entropy and the packed threshold", () => {
    const zeros = new Uint8Array(4096);
    expect(shannonEntropy(zeros)).toBe(0);
    expect(classifyEntropy(0)).toBe("empty");

    const random = pseudoRandomBytes(65_536, 7);
    expect(shannonEntropy(random)).toBeGreaterThan(7.4);
    expect(classifyEntropy(shannonEntropy(random))).toBe("packed-or-encrypted");

    const blocks = blockEntropy(random, 4096, 64);
    expect(blocks.length).toBe(16);
    for (const block of blocks) expect(block.entropy).toBeGreaterThan(ENTROPY_PACKED_THRESHOLD);
  });

  it("recomputes checksums exactly, which is what makes a checksum claim evidence", () => {
    const payload = new TextEncoder().encode("DEMO reverse engineering");
    expect(crc32(payload)).toBe(crc32(payload));
    expect(crc32(new Uint8Array([1, 2, 3]))).not.toBe(crc32(new Uint8Array([1, 2, 4])));
    expect(adler32(new Uint8Array([0x61, 0x62, 0x63]))).toBe(0x024d0127);
    // sum16 is the RFC 1071 one's-complement Internet checksum.
    expect(sum16(new Uint8Array([0x01, 0x02, 0x03]))).toBe(0xfbfd);
    expect(xor8(new Uint8Array([0x01, 0x02, 0x03]))).toBe(0);
    expect(crc16(new Uint8Array([0x01, 0x02, 0x03]))).toBeGreaterThan(0);
  });

  it("finds a single-byte XOR key only when the decode is printable", () => {
    const plain = new TextEncoder().encode("A quite long printable ASCII payload for the XOR heuristic to recover.");
    const key = 0x5a;
    const encoded = new Uint8Array(plain.map((byte) => byte ^ key));
    const best = bestXorKey(encoded);
    expect(best.key).toBe(key);
    expect(best.score).toBeGreaterThan(0.9);
    // Random bytes must not produce a confident key.
    const noise = bestXorKey(pseudoRandomBytes(4096, 3));
    expect(noise.score).toBeLessThan(0.9);
  });
});

/* ----------------------------------------------------------- evidence labels */

describe("evidence labels", () => {
  it("keeps observed, inferred, proposed, web and unknown distinct and countable", () => {
    const store = new EvidenceStore(() => "2026-10-01T00:00:00.000Z");
    store.add({ label: "observed", source: "demo.elf", target: "t", location: "header", claim: "The magic is ELF.", result: {} });
    store.add({ label: "inferred", source: "demo.triage", target: "t", location: "strings", claim: "Probably Go.", result: {} });
    store.add({ label: "proposed", source: "model", target: "t", location: "synthesis", claim: "It is a CLI tool.", result: {} });
    store.add({ label: "web", source: "web", target: "t", location: "n/a", claim: "The docs say X.", result: {} });
    store.add({ label: "unknown", source: "demo.triage", target: "t", location: "?", claim: "Unclassified field.", result: {} });
    const counts = store.counts();
    expect(counts).toEqual({ observed: 1, inferred: 1, proposed: 1, web: 1, unknown: 1 });
    expect(store.entries.map((entry) => entry.label)).toEqual(["observed", "inferred", "proposed", "web", "unknown"]);
  });

  it("never lets a label be promoted without naming a second, different source", () => {
    const store = new EvidenceStore(() => "2026-10-01T00:00:00.000Z");
    const left = store.add({ label: "inferred", source: "demo.strings", target: "t", location: "0x10", claim: "Rust runtime.", result: {} });
    const right = store.add({ label: "inferred", source: "demo.elf", target: "t", location: "symbols", claim: "Rust runtime.", result: {} });
    expect(left.crossCheckedWith).toBeUndefined();
    store.crossCheck(left.id, right.id);
    expect(left.crossCheckedWith).toContain(right.id);
    expect(right.crossCheckedWith).toContain(left.id);

    // The same tool twice is not a cross-check.
    const other = new EvidenceStore(() => "2026-10-01T00:00:00.000Z");
    const a = other.add({ label: "inferred", source: "demo.strings", target: "t", location: "0x10", claim: "Rust runtime.", result: {} });
    const b = other.add({ label: "inferred", source: "demo.strings", target: "t", location: "0x40", claim: "Rust runtime.", result: {} });
    other.crossCheck(a.id, b.id);
    expect(a.crossCheckedWith).toBeUndefined();
  });

  it("reports single-sourced claims instead of burying them", async () => {
    const bytes = elfFixture();
    const store = new EvidenceStore(() => "2026-10-01T00:00:00.000Z");
    triageTarget({ name: "demo.elf", bytes, sha256: "abc" }, staticBudgets(resolveReverseEngineeringConfig({}), "quick"), store);
    const response = await runReverseRequest(makeContext(), { action: "triage", target: { inlineBase64: Buffer.from(bytes).toString("base64"), name: "demo.elf" } });
    expect(response.ok).toBe(true);
    expect(response.data.unknowns).toBeDefined();
    expect(Array.isArray(response.data.unknowns)).toBe(true);
  });

  it("filters evidence by label and free text, and pages it", () => {
    const store = new EvidenceStore(() => "2026-10-01T00:00:00.000Z", [
      { id: "ev-0001", label: "observed", source: "demo.elf", target: "t", location: "header", claim: "ELF 64-bit", result: null, confidence: 1, timestamp: "2026-10-01T00:00:00.000Z" },
      { id: "ev-0002", label: "inferred", source: "demo.strings", target: "t", location: "0x40", claim: "Go runtime strings", result: null, confidence: 0.7, timestamp: null },
    ]);
    expect(store.query({ label: "observed" }).map((entry) => entry.id)).toEqual(["ev-0001"]);
    expect(store.query({ query: "runtime" }).map((entry) => entry.id)).toEqual(["ev-0002"]);
    const page = store.page({ limit: 1 });
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(page.labels).toEqual({ observed: 1, inferred: 1, proposed: 0, web: 0, unknown: 0 });
  });
});

/* ------------------------------------------------------- capability detection */

describe("capability detection", () => {
  it("lists the deterministic Worker engines and the external tools that need a service", () => {
    expect(WORKER_ENGINES.length).toBeGreaterThanOrEqual(20);
    expect(EXTERNAL_TOOLS.length).toBeGreaterThanOrEqual(20);
    for (const engine of WORKER_ENGINES) expect(engine.runtime).toBe("worker");
    for (const tool of EXTERNAL_TOOLS) expect(tool.runtime).toBe("analysis-service");
    const ids = new Set([...WORKER_ENGINES, ...EXTERNAL_TOOLS].map((entry) => entry.id));
    expect(ids.size).toBe(WORKER_ENGINES.length + EXTERNAL_TOOLS.length);
  });

  it("reports every heavy engine as missing until a service is configured", () => {
    const withoutService = detectCapabilities({ analyzerUrl: null, serviceTools: [], container: "elf", objective: "decompile", dynamic: false });
    expect(withoutService.missing.map((entry) => entry.id)).toContain("ghidra");
    expect(withoutService.requiresAnalysisService.length).toBeGreaterThan(0);

    const withService = detectCapabilities({ analyzerUrl: "https://analyzer.example", serviceTools: [{ id: "ghidra", title: "Ghidra" }], container: "elf", objective: "decompile", dynamic: false });
    expect(withService.missing.map((entry) => entry.id)).not.toContain("ghidra");
    expect(withService.serviceInventory).toEqual([{ id: "ghidra", title: "Ghidra" }]);
  });

  it("recommends a different workflow per container and objective", () => {
    expect(recommendWorkflow("elf", "identify", false)).toEqual(["triage", "strings"]);
    expect(recommendWorkflow("pcap", "protocol", false)).toEqual(["triage", "packet-inventory", "framing-inference", "field-inference", "state-machine", "protocol-specification"]);
    expect(recommendWorkflow("wasm", "architecture", false)).toContain("wasm-abi");
    expect(recommendWorkflow(null, "clean-room", false)).toContain("golden-tests");
    // A decompile workflow names the missing engine rather than pretending.
    expect(recommendWorkflow("elf", "decompile", false)).toContain("request-analysis-service-for-decompilation");
    expect(recommendWorkflow("elf", "decompile", true)).toContain("sandboxed-decompilation");
  });

  it("never advertises a capability this deployment does not have", async () => {
    const response = await runReverseRequest(makeContext({ dynamicEnabled: false, analyzerUrl: null }), { action: "capabilities" });
    expect(response.ok).toBe(true);
    const data = response.data as { flags: Record<string, unknown>; safetyContract: string[]; requiresAnalysisService: string[] };
    expect(data.flags.reDynamicEnabled).toBe(false);
    expect(data.flags.reAnalyzerConfigured).toBe(false);
    expect(data.requiresAnalysisService.length).toBeGreaterThan(0);
    expect(data.safetyContract.join(" ")).toContain("never executed");
  });

  it("refuses the whole capability when RE_ENABLED is false", async () => {
    const response = await runReverseRequest(makeContext({ enabled: false }), { action: "capabilities" });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("capability_unavailable");
  });
});

/* ------------------------------------------------------------ path isolation */

describe("workspace path isolation", () => {
  it("accepts only allow-listed workspace-relative paths", () => {
    // The root is prefixed, so a caller can never escape it by prefixing it.
    expect(assertSafeWorkspacePath("analysis-1/report.json")).toBe("re-workspace/analysis-1/report.json");
    expect(assertSafeWorkspacePath("re-workspace/analysis-1/sections.bin")).toBe("re-workspace/re-workspace/analysis-1/sections.bin");
    expect(isInsideWorkspace("re-workspace/a/b")).toBe(true);
    expect(sanitizeAnalysisId("re_abc123")).toBe("re_abc123");
  });

  it("refuses traversal, absolute paths, drive letters, home and NUL bytes", () => {
    for (const bad of [
      "../../etc/passwd",
      "/etc/passwd",
      "..",
      ".",
      "a/../../b",
      "\\\\server\\share",
      "C:\\Windows\\System32",
      "~/secrets",
      "re-workspace/\u0000evil",
      "re-workspace//double",
      "re-workspace/with space",
      "re-workspace/trailing/",
    ]) {
      expect(() => assertSafeWorkspacePath(bad), bad).toThrow();
    }
  });

  it("keeps every artifact under the workspace root", () => {
    expect(isInsideWorkspace("re-workspace/x")).toBe(true);
    expect(isInsideWorkspace("other/x")).toBe(false);
    expect(WORKSPACE_ROOT).toBe("re-workspace");
  });
});

/* --------------------------------------------------------- command allowlist */

describe("command allow-listing", () => {
  it("exposes a closed set of analysis operations and refuses anything else", () => {
    expect(ANALYZER_OPERATIONS).toContain("decompile");
    expect(ANALYZER_OPERATIONS).toContain("tool-inventory");
    expect(isAnalyzerOperation("decompile")).toBe(true);
    for (const forbidden of ["exec", "shell", "run", "spawn", "eval", "rm -rf", "bash", "cmd", "python", ""]) {
      expect(isAnalyzerOperation(forbidden), forbidden).toBe(false);
    }
  });

  it("refuses a non-allow-listed operation at the client, before any request", async () => {
    const response = await runAnalyzerOperation(
      { url: "https://analyzer.example", timeoutMs: 1000, apiKey: null, guard: async (url) => url },
      { operation: "rm -rf /" as never, bytes: new Uint8Array([1]), targetName: "t", limits: { cpuMs: 0, wallMs: 0, memoryMb: 0, network: "none", maxProcesses: 0 } },
    );
    expect(response.ok).toBe(false);
    expect(response.error).toContain("allow-listed");
  });

  it("routes the service URL through the SSRF guard and refuses a private target", async () => {
    let guardCalls = 0;
    const response = await runAnalyzerOperation(
      {
        url: "http://127.0.0.1:8787",
        timeoutMs: 500,
        apiKey: null,
        guard: async () => {
          guardCalls += 1;
          throw new Error("blocked by the SSRF guard");
        },
      },
      { operation: "identify", bytes: new Uint8Array([1]), targetName: "t", limits: { cpuMs: 0, wallMs: 0, memoryMb: 0, network: "none", maxProcesses: 0 } },
    );
    expect(guardCalls).toBe(1);
    expect(response.error).toContain("SSRF guard");
  });

  it("enforces a timeout instead of hanging on an unresponsive service", async () => {
    const response = await runAnalyzerOperation(
      {
        url: "https://analyzer.example",
        timeoutMs: 60,
        apiKey: null,
        guard: async (url) => url,
      },
      {
        operation: "disassemble",
        bytes: new Uint8Array([1, 2, 3]),
        targetName: "t",
        limits: { cpuMs: 0, wallMs: 0, memoryMb: 0, network: "none", maxProcesses: 0 },
      },
    );
    expect(response.ok).toBe(false);
    expect(response.error).toBeTruthy();
    expect(response.durationMs).toBeLessThan(5_000);
  });
});

/* --------------------------------------------------------- oversized targets */

describe("oversized input rejection", () => {
  it("refuses an inline payload above the deployment cap", async () => {
    const huge = Buffer.alloc(64 * 1024 + 16, 0x41).toString("base64");
    const base = resolveReverseEngineeringConfig({});
    const response = await runReverseRequest(makeContext({ caps: { ...base.caps, maxTargetBytes: 1024 } }), { action: "triage", target: { inlineBase64: huge, name: "huge.bin" } });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("size_limit_exceeded");
  });

  it("refuses invalid base64 instead of parsing garbage", () => {
    expect(() => decodeBase64Bounded("!!!not base64!!!", 1024)).toThrow();
    expect(decodeBase64Bounded(Buffer.from("ok").toString("base64"), 1024)).toEqual(new TextEncoder().encode("ok"));
    expect(() => decodeBase64Bounded(Buffer.alloc(2048, 0x41).toString("base64"), 1024)).toThrow();
  });

  it("refuses a target that resolves from more than one source", async () => {
    const bytes = elfFixture();
    const response = await runReverseRequest(makeContext(), {
      action: "triage",
      target: { inlineBase64: Buffer.from(bytes).toString("base64"), url: "https://example.test/x", name: "both.bin" },
    });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("invalid_input");
  });

  it("never lets a tool argument raise the deployment cap", () => {
    const policy = resolveReverseEngineeringConfig({ RE_MAX_TARGET_MB: "999999" });
    expect(policy.maxTargetBytes).toBeLessThanOrEqual(RE_CAPS.maxTargetBytes);
    expect(resolveReverseEngineeringConfig({ RE_ARTIFACT_TTL_SECONDS: "1" }).artifactTtlSeconds).toBeGreaterThanOrEqual(300);
    expect(resolveReverseEngineeringConfig({ RE_RATE_LIMIT_PER_MINUTE: "0" }).rateLimitPerMinute).toBeGreaterThanOrEqual(1);
  });
});

/* ------------------------------------------------------------- sandbox/dynamic */

describe("sandbox and dynamic analysis", () => {
  it("defaults to static analysis and an unenforceable sandbox", () => {
    expect(DEFAULT_SANDBOX_POLICY.network).toBe("none");
    expect(DEFAULT_SANDBOX_POLICY.enforceable).toBe(false);
    expect(DEFAULT_SANDBOX_POLICY.maxProcesses).toBeLessThanOrEqual(4);
    const policy = resolveReverseEngineeringPolicy({});
    expect(policy.dynamicAllowed).toBe(false);
  });

  it("refuses a dynamic run with no request, no opt-in, no service and no authorization", () => {
    const decision = evaluateDynamicRequest({ dynamic: false, authorization: null }, resolveReverseEngineeringConfig({}), DEFAULT_SANDBOX_POLICY);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("Static analysis is the default");
    expect(decision.policy.network).toBe("none");
  });

  it("refuses a dynamic run even when everything is configured but the authorization is missing", () => {
    const config = resolveReverseEngineeringConfig({ RE_DYNAMIC_ENABLED: "true", RE_ANALYZER_URL: "https://analyzer.example" });
    const decision = evaluateDynamicRequest({ dynamic: true, authorization: null }, config, { ...DEFAULT_SANDBOX_POLICY, enforceable: true });
    expect(decision.allowed).toBe(false);
    expect(decision.requirements.join(" ")).toContain("authorization");
  });

  it("refuses a public-source target from ever being executed", () => {
    const config = resolveReverseEngineeringConfig({ RE_DYNAMIC_ENABLED: "true", RE_ANALYZER_URL: "https://analyzer.example" });
    const decision = evaluateDynamicRequest(
      { dynamic: true, authorization: { confirmed: true, scope: "public-source", statement: "I said so" } },
      config,
      { ...DEFAULT_SANDBOX_POLICY, enforceable: true },
    );
    expect(decision.allowed).toBe(false);
  });

  it("allows a dynamic run only when every gate passes", () => {
    const config = resolveReverseEngineeringConfig({ RE_DYNAMIC_ENABLED: "true", RE_ANALYZER_URL: "https://analyzer.example" });
    const decision = evaluateDynamicRequest(
      { dynamic: true, authorization: { confirmed: true, scope: "local-artifact", statement: "I own these bytes" } },
      config,
      { ...DEFAULT_SANDBOX_POLICY, enforceable: true },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.policy.network).toBe("none");
  });

  it("states what it will never do, as data", () => {
    const contract = safetyContract();
    expect(contract.join(" ")).toContain("never executed");
    expect(REFUSED_OPERATIONS.join(" ")).toContain("arbitrary shell or command execution");
    expect(REFUSED_OPERATIONS.join(" ")).toContain("malware");
    expect(REFUSED_OPERATIONS.join(" ")).toContain("destructive");
  });

  it("reports a refused dynamic request through the router instead of faking it", async () => {
    const response = await runReverseRequest(makeContext({ dynamicEnabled: true, analyzerUrl: "https://analyzer.example" }), {
      action: "dynamic",
      target: { inlineBase64: Buffer.from(elfFixture()).toString("base64"), name: "demo.elf" },
      dynamic: true,
      authorization: { confirmed: false, scope: "local-artifact" },
    });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("capability_unavailable");
    expect(response.warnings.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------- clean-room */

describe("clean-room workflow", () => {
  const observations = [
    { id: "obs-1", statement: "The format always begins with the 4-byte magic 0x44524d4f.", source: "demo.triage", location: "offset 0", label: "observed" as const },
    { id: "obs-2", statement: "A 16-bit little-endian length field at offset 4 always equals the remaining bytes.", source: "demo.protocol-analysis", location: "offset 4", label: "observed" as const },
    { id: "obs-3", statement: "Every response echoes the request opcode.", source: "demo.protocol-analysis", location: "offset 6", label: "inferred" as const },
    { id: "obs-4", statement: "The session key is derived with an unknown KDF.", source: "model", location: "n/a", label: "unknown" as const },
  ];

  it("freezes a specification that excludes the original implementation", () => {
    const spec = freezeSpecification({ target: "demo.fmt", purpose: "Reimplement the container.", observations, now: "2026-10-01T00:00:00.000Z" });
    expect(spec.schema).toBe(1);
    expect(spec.inputs.length).toBeGreaterThan(0);
    expect(spec.excluded.join(" ")).toContain("Decompiled");
    expect(spec.excluded.join(" ")).toContain("verbatim code");
    expect(spec.unknowns).toHaveLength(1);
  });

  it("derives golden cases from captures and records that a capture alone proves nothing", () => {
    const golden = deriveGoldenCases({
      captures: [
        { bytes: new Uint8Array([0x44, 0x52, 0x4d, 0x4f, 0x02, 0x00, 0xaa, 0xbb]), description: "first capture", evidenceId: "ev-0001" },
        { bytes: new Uint8Array([0x44, 0x52, 0x4d, 0x4f, 0x03, 0x00, 0xcc, 0xdd, 0xee]), description: "second capture" },
      ],
    });
    expect(golden).toHaveLength(2);
    expect(golden[0]!.inputEncoding).toBe("hex");
    expect(golden[0]!.input).toBe("44524d4f0200aabb");
    expect(golden[0]!.fromEvidence).toBe("ev-0001");
    // A capture supplies the input; the expected output must be recorded
    // separately, so equivalence is never asserted from a capture alone.
    expect(golden[0]!.expectedOutput).toBeNull();
    const unverified = compareAgainstGolden(golden, [{ id: golden[0]!.id, actualOutput: golden[0]!.input }]);
    expect(unverified.verdict).toBe("differences-found");
    expect(unverified.results[0]!.detail).toContain("no recorded expected output");
  });

  it("compares a reimplementation against recorded outputs byte-exactly", () => {
    const golden = deriveGoldenCases({
      supplied: [
        { id: "g1", description: "echo request", input: "44524d4f0200aabb", expectedOutput: "44524d4f0200aabb", inputEncoding: "hex", expectedEncoding: "hex" },
        { id: "g2", description: "ack request", input: "44524d4f0300ccddee", expectedOutput: "44524d4f0300ccddee", inputEncoding: "hex", expectedEncoding: "hex" },
      ],
    });
    expect(golden).toHaveLength(2);

    const identical = compareAgainstGolden(golden, [
      { id: "g1", actualOutput: "44524d4f0200aabb" },
      { id: "g2", actualOutput: "44524d4f0300ccddee" },
    ]);
    expect(identical.verdict).toBe("behaviour-equivalent-on-captured-cases");
    expect(identical.matched).toBe(2);
    expect(identical.mismatched).toBe(0);
    expect(identical.unmatchedExpected).toBe(0);

    const different = compareAgainstGolden(golden, [{ id: "g1", actualOutput: "44524d4f0200aabbcc" }]);
    expect(different.verdict).toBe("differences-found");
    expect(different.results[0]!.firstDifference).toBe(8);
    expect(different.results[0]!.detail).toContain("First difference at byte 8");
    expect(different.unmatchedExpected).toBe(1);
  });

  it("reports an unexercised golden case rather than counting it as a pass", () => {
    const golden = deriveGoldenCases({ supplied: [{ id: "g1", description: "d", input: "00", expectedOutput: "01", inputEncoding: "hex", expectedEncoding: "hex" }] });
    const comparison = compareAgainstGolden(golden, []);
    expect(comparison.verdict).toBe("insufficient-cases");
    expect(comparison.unmatchedExpected).toBe(1);
    expect(comparison.notes.join(" ")).toContain("never exercised");
  });

  it("runs the clean-room action through the router and reports the verdict", async () => {
    const response = await runReverseRequest(makeContext(), { action: "cleanroom", observations, purpose: "Reimplement the container." });
    expect(response.ok).toBe(true);
    const data = response.data as { specification: { excluded: string[] }; comparison: { verdict: string } };
    expect(data.specification.excluded.length).toBeGreaterThan(0);
    expect(data.comparison.verdict).toBe("insufficient-cases");
  });
});

/* -------------------------------------------------------- protocol analysis */

describe("protocol-analysis workflow", () => {
  // "DRMO" magic, a monotonic sequence at offset 5, a 16-bit little-endian
  // message length at offset 8, then a small payload.
  const messages = [
    new Uint8Array([0x44, 0x52, 0x4d, 0x4f, 0x00, 0x01, 0x00, 0x00, 0x0c, 0x00, 0xde, 0xad]),
    new Uint8Array([0x44, 0x52, 0x4d, 0x4f, 0x00, 0x02, 0x00, 0x00, 0x0e, 0x00, 0xbe, 0xef, 0x01, 0x02]),
    new Uint8Array([0x44, 0x52, 0x4d, 0x4f, 0x00, 0x03, 0x00, 0x00, 0x0d, 0x00, 0xca, 0xfe, 0x03]),
  ];

  it("aligns messages column-wise and classifies magic, counter and length", () => {
    const framing = analyzeFraming(messages.map((bytes) => ({ bytes })));
    expect(framing.messageCount).toBe(3);
    const magic = framing.alignedColumns.find((column) => column.offset === 0);
    expect(magic!.constant).toBe(true);
    expect(magic!.constantValue).toBe("0x44");
    const flags = framing.alignedColumns.find((column) => column.offset === 6);
    expect(flags!.constant).toBe(true);
    const counter = framing.alignedColumns.find((column) => column.offset === 5);
    expect(counter!.monotonicIncreasing).toBe(true);
    expect(counter!.smallCardinality).toBe(true);
  });

  it("verifies a length prefix by matching the message length, and says so", () => {
    const spec = produceProtocolSpecification(messages.map((bytes) => ({ bytes })));
    expect(spec.framing.lengthPrefixes.length).toBeGreaterThan(0);
    const best = spec.framing.lengthPrefixes[0]!;
    expect(best.hits).toBe(best.total);
    expect(best.matches).toBe("message");
    const lengthField = spec.fields.find((field) => field.role === "length");
    expect(lengthField).toBeDefined();
    expect(lengthField!.evidence.join(" ")).toContain("message length");
  });

  it("leaves an unclassifiable column as `unknown` instead of inventing a meaning", () => {
    // More than eight distinct values per column, so no column qualifies as an
    // enum and none is constant or monotonic: they must stay `unknown`.
    const noisy = pseudoRandomBytes(12 * 4, 21).reduce<Uint8Array[]>((acc, _byte, index) => {
      if (index % 4 === 0) {
        const frame = new Uint8Array([0x44, 0, 0, 0]);
        frame.set(pseudoRandomBytes(3, 100 + index), 1);
        acc.push(frame);
      }
      return acc;
    }, []);
    const spec = produceProtocolSpecification(noisy.map((bytes) => ({ bytes })));
    const unknowns = spec.fields.filter((field) => field.role === "unknown");
    expect(unknowns.length).toBeGreaterThan(0);
    expect(unknowns[0]!.unknowns.join(" ")).toContain("Do not assign a meaning");
    expect(spec.unknowns.join(" ")).toContain("unclassified");
  });

  it("verifies a checksum by recomputation, and refuses to claim one that fails", () => {
    // crc32 (LE) over the whole frame minus the trailing 4 bytes.
    const body = (value: number): Uint8Array => new Uint8Array([0x44, 0x52, value & 0xff, 0x00]);
    const withCrc = (value: number): Uint8Array => {
      const head = body(value);
      const crc = crc32(head);
      return new Uint8Array([...head, crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, (crc >>> 24) & 0xff]);
    };
    const spec = produceProtocolSpecification([1, 2, 3, 4].map((value) => ({ bytes: withCrc(value) })));
    const checksum = spec.fields.find((field) => field.role === "checksum");
    expect(checksum).toBeDefined();
    expect(checksum!.evidence.join(" ")).toContain("crc32");

    const noCrc = produceProtocolSpecification([1, 2, 3, 4].map((value) => ({ bytes: new Uint8Array([0x44, 0x52, value, 0x00, 0x11, 0x22, 0x33, 0x44]) })));
    expect(noCrc.framing.checksums).toHaveLength(0);
    expect(noCrc.unknowns.join(" ")).toContain("No checksum algorithm matched");
  });

  it("reconstructs a state machine from observed transitions only", () => {
    const spec = produceProtocolSpecification(messages.map((bytes) => ({ bytes })), {
      sessions: [["HELLO", "AUTH", "DATA"], ["HELLO", "AUTH", "DATA", "ACK"]],
      opcodes: [{ name: "HELLO", code: 1, direction: "client→server" }],
    });
    expect(spec.stateMachine.states.length).toBeGreaterThan(2);
    const hello = spec.stateMachine.transitions.find((entry) => entry.from === "INITIAL" && entry.on === "HELLO");
    expect(hello!.observations).toBe(2);
    const auth = spec.stateMachine.transitions.find((entry) => entry.on === "AUTH");
    expect(auth!.observations).toBe(2);
    expect(spec.messages[0]!.name).toBe("HELLO");
    // States that emit nothing observed are reported, not invented.
    expect(spec.stateMachine.unobserved.length).toBeGreaterThan(0);
  });

  it("runs the protocol action through the router", async () => {
    const response = await runReverseRequest(makeContext(), {
      action: "protocol",
      messages: messages.map((bytes) => ({ hex: [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("") })),
      sessions: [["HELLO", "AUTH"]],
    });
    expect(response.ok).toBe(true);
    const spec = (response.data as { specification: { framing: { style: string }; fields: unknown[] } }).specification;
    expect(spec.framing.style).not.toBe("unknown");
    expect(spec.fields.length).toBeGreaterThan(0);
  });

  it("refuses protocol analysis with fewer than two messages", async () => {
    const response = await runReverseRequest(makeContext(), { action: "protocol", messages: [{ hex: "44" }] });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("invalid_input");
  });
});

/* -------------------------------------------------------------- deobfuscation */

describe("deobfuscation", () => {
  it("flags a packed-looking target from entropy and section names alone", async () => {
    // A large high-entropy payload with a packer-shaped section name.
    const w = new ByteReader(new Uint8Array());
    expect(w.length).toBe(0);
    const response = await runReverseRequest(makeContext(), {
      action: "deobfuscate",
      target: { inlineBase64: Buffer.from(pseudoRandomBytes(200_000, 9)).toString("base64"), name: "packed.bin" },
    });
    expect(response.ok).toBe(true);
    const obfuscation = (response.data as { obfuscation: { packing: { overallEntropy: number; requiresAnalysisService: string[] }; summary: string } }).obfuscation;
    expect(obfuscation.packing.overallEntropy).toBeGreaterThan(7);
    expect(obfuscation.packing.requiresAnalysisService.join(" ")).toContain("unpacking");
    expect(obfuscation.summary).toContain("entropy");
  });

  it("does not claim packing for a low-entropy target", async () => {
    const response = await runReverseRequest(makeContext(), {
      action: "deobfuscate",
      target: { inlineBase64: Buffer.from(elfFixture()).toString("base64"), name: "demo.elf" },
    });
    expect(response.ok).toBe(true);
    const obfuscation = (response.data as { obfuscation: { packing: { likelyPacked: boolean } } }).obfuscation;
    expect(obfuscation.packing.likelyPacked).toBe(false);
  });
});

/* ------------------------------------------------------------- modern binaries */

describe("modern binaries", () => {
  it("recovers Go pclntab metadata and candidate function names", () => {
    const go = extractGoMetadata(new ByteReader(goPclntabFixture()), null, null);
    expect(go.found).toBe(true);
    expect(go.versionLabel).toContain("Go 1.20");
    expect(go.quantum).toBe(1);
    expect(go.pointerSize).toBe(8);
    expect(go.functionNameCandidates).toContain("main.main");
    expect(go.functionNameCandidates).toContain("runtime.main");
  });

  it("reports missing pclntab rather than inventing names", () => {
    const go = extractGoMetadata(new ByteReader(unknownFixture()), null, null);
    expect(go.found).toBe(false);
    expect(go.functionNameCandidates).toHaveLength(0);
    expect(go.warnings.join(" ")).toContain("GoReSym");
  });

  it("demangles Rust v0 and legacy symbols without guessing", () => {
    expect(demangleRustV0("_RNvNtCs8fq2KUa2xqX_3std2rt10lang_start")).toBe("std::rt::lang_start");
    expect(demangleRustV0("_RNvCs8fq2KUa2xqX_4demo7handler5Serve")).toBe("demo::handler::Serve");
    // A legacy Itanium symbol demangles through the other scheme.
    const legacy = demangleSymbols(["_ZN4core3fmt9Formatter3pad17h1234567890abcdefE"]);
    expect(legacy[0]!.scheme).toBe("rust-legacy");
    expect(legacy[0]!.demangled).toBe("core::fmt::Formatter::pad");
    // Swift symbols are detected, counted and never fabricated.
    const swift = demangleSymbols(["$s4Demo7handlerC5ServeyyF"]);
    expect(swift[0]!.scheme).toBe("swift");
    expect(swift[0]!.demangled).toBe("$s4Demo7handlerC5ServeyyF");
    // Unparseable input is passed through, never fabricated.
    expect(demangleRustV0("_RZZZ")).toBeNull();
  });
});

/* -------------------------------------------------------------- struct layout */

describe("struct layout validation", () => {
  it("accepts a layout with no overlaps and computes the padding", () => {
    const result = validateStructLayout({
      fields: [
        { name: "magic", offset: 0, size: 4 },
        { name: "version", offset: 4, size: 2 },
        { name: "flags", offset: 6, size: 2 },
        { name: "length", offset: 8, size: 4 },
      ],
      total_size: 16,
    });
    expect(result.ok).toBe(true);
    expect(result.endOffset).toBe(12);
    expect(result.trailingPadding).toBe(4);
    expect(result.padding).toHaveLength(0);
  });

  it("rejects overlapping fields and a total size the fields exceed", () => {
    const overlap = validateStructLayout({
      fields: [
        { name: "a", offset: 0, size: 8 },
        { name: "b", offset: 4, size: 4 },
      ],
      total_size: 8,
    });
    expect(overlap.ok).toBe(false);
    expect(overlap.errors.join(" ")).toContain("Overlap");

    const tooSmall = validateStructLayout({ fields: [{ name: "a", offset: 0, size: 16 }], total_size: 8 });
    expect(tooSmall.ok).toBe(false);
    expect(tooSmall.errors.join(" ")).toContain("exceed the declared total size");
  });

  it("accepts hex strings for offsets and sizes, and checks alignment", () => {
    const result = validateStructLayout({ fields: [{ name: "a", offset: "0x0", size: "0x8" }, { name: "b", offset: "0x8", size: "0x8" }], total_size: "0x10", align: 8 });
    expect(result.ok).toBe(true);
    const misaligned = validateStructLayout({ fields: [{ name: "a", offset: 4, size: 4 }], align: 8 });
    expect(misaligned.ok).toBe(false);
    expect(misaligned.errors.join(" ")).toContain("not aligned");
  });
});

/* ------------------------------------------------------------------ router */

describe("router pipeline", () => {
  const elf = elfFixture();

  it("runs a full analysis with findings, evidence, unknowns and missing engines", async () => {
    const response = await runReverseRequest(makeContext(), {
      action: "analyze",
      target: { inlineBase64: Buffer.from(elf).toString("base64"), name: "demo.elf" },
      objective: "architecture",
    });
    expect(response.ok).toBe(true);
    expect(response.analysisId).toBeTruthy();
    expect(response.enginesUsed).toContain("demo.elf");
    expect(response.enginesUsed).toContain("demo.entropy");
    expect(response.enginesMissing).toContain("ghidra");
    expect((response.data.findings as unknown[]).length).toBeGreaterThan(0);
    expect((response.evidence as Array<{ label: string }>).some((entry) => entry.label === "observed")).toBe(true);
    expect((response.data.unknowns as string[]).length).toBeGreaterThan(0);
    expect(response.summary).toContain("demo.elf");
  });

  it("persists the analysis document and pages its evidence back out", async () => {
    const store = createReverseEngineeringStore(undefined);
    const ctx = makeContext({}, store);
    const first = await runReverseRequest(ctx, { action: "analyze", target: { inlineBase64: Buffer.from(elf).toString("base64"), name: "demo.elf" } });
    expect(first.ok).toBe(true);

    const evidence = await runReverseRequest(ctx, { action: "evidence", evidence: { analysisId: first.analysisId!, label: "observed", limit: 5 } });
    expect(evidence.ok).toBe(true);
    expect((evidence.data.returned as number) ?? 0).toBeGreaterThanOrEqual(0);
    const observed = evidence.data.evidence as Array<{ label: string; source: string }>;
    for (const entry of observed) expect(entry.label).toBe("observed");

    const report = await runReverseRequest(ctx, { action: "report", report: { analysisId: first.analysisId! } });
    expect(report.ok).toBe(true);
    const built = report.data.report as { sections: Array<{ id: string; title: string }>; evidenceCounts: Record<string, number>; singleSourcedClaims: unknown[] };
    expect(built.sections.map((section) => section.id)).toContain("observed");
    expect(built.sections.map((section) => section.id)).toContain("unknown");
    expect(built.evidenceCounts.observed).toBeGreaterThan(0);
    expect(built.singleSourcedClaims.length).toBeGreaterThan(0);
    expect((report.data.text as string)).toContain("Reverse engineering report");
  });

  it("reports an unknown analysis id instead of fabricating evidence", async () => {
    const response = await runReverseRequest(makeContext(), { action: "evidence", evidence: { analysisId: "does-not-exist" } });
    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe("artifact_expired");
  });

  it("compares two artifacts mechanically and names the differences", async () => {
    const response = await runReverseRequest(makeContext(), {
      action: "compare",
      target: { inlineBase64: Buffer.from(elf).toString("base64"), name: "a.elf" },
      compareWith: { inlineBase64: Buffer.from(unknownFixture()).toString("base64"), name: "b.bin" },
    });
    expect(response.ok).toBe(true);
    const comparison = response.data.comparison as { identical: boolean; dimensions: Array<{ dimension: string; same: boolean }>; interpretation: string };
    expect(comparison.identical).toBe(false);
    expect(comparison.dimensions.find((entry) => entry.dimension === "container")!.same).toBe(false);
    expect(comparison.interpretation).toContain("differ");

    const same = await runReverseRequest(makeContext(), {
      action: "compare",
      target: { inlineBase64: Buffer.from(elf).toString("base64"), name: "a.elf" },
      compareWith: { inlineBase64: Buffer.from(elf).toString("base64"), name: "b.elf" },
    });
    expect((same.data.comparison as { identical: boolean }).identical).toBe(true);
  });

  it("compares two stored analyses by id", async () => {
    const ctx = makeContext();
    const a = await runReverseRequest(ctx, { action: "analyze", target: { inlineBase64: Buffer.from(elf).toString("base64"), name: "a.elf" } });
    const b = await runReverseRequest(ctx, { action: "analyze", target: { inlineBase64: Buffer.from(unknownFixture()).toString("base64"), name: "b.bin" } });
    const response = await runReverseRequest(ctx, { action: "compare", compare: { analysisIds: [a.analysisId!, b.analysisId!] } });
    expect(response.ok).toBe(true);
    expect((response.data.comparison as { identical: boolean }).identical).toBe(false);
  });

  it("never executes a target, whatever the objective", async () => {
    for (const objective of ["behavior", "decompile", "functions"]) {
      const response = await runReverseRequest(makeContext(), {
        action: "analyze",
        target: { inlineBase64: Buffer.from(elf).toString("base64"), name: "demo.elf" },
        objective,
      });
      expect(response.ok, objective).toBe(true);
      expect(response.enginesUsed, objective).not.toContain("demo.analysis-service");
    }
  });

  it("refuses a URL target the SSRF guard blocks", async () => {
    const ctx = makeContext();
    ctx.fetchBytes = async () => {
      throw new Error("blocked by the SSRF guard");
    };
    const response = await runReverseRequest(ctx, { action: "triage", target: { url: "http://127.0.0.1:8787/secret", name: "x" } });
    expect(response.ok).toBe(false);
  });

  it("reads a Go binary through the metadata engine and labels the names as inferred", async () => {
    const response = await runReverseRequest(makeContext(), {
      action: "analyze",
      target: { inlineBase64: Buffer.from(goPclntabFixture()).toString("base64"), name: "demo.go" },
      objective: "symbols",
    });
    expect(response.ok).toBe(true);
    const formatSpecific = (response.data.triage as { formatSpecific: { go?: { candidates: string[] } } }).formatSpecific;
    expect(formatSpecific.go?.candidates).toContain("main.main");
    const goEvidence = (response.evidence as Array<{ source: string; label: string }>).filter((entry) => entry.source === "demo.go-metadata");
    expect(goEvidence.length).toBeGreaterThan(0);
    expect(goEvidence[0]!.label).toBe("inferred");
  });
});

/* -------------------------------------------------------------------- store */

describe("artifact store", () => {
  it("degrades to memory when R2 is not bound and still returns the artifact", async () => {
    const store = createReverseEngineeringStore(undefined, () => new Date("2026-10-01T00:00:00.000Z"));
    expect(store.available).toBe(false);
    const artifact = await store.put({ id: "a1", analysisId: "re_1", label: "report", contentType: "application/json", body: "{}" }, 60);
    expect(artifact.storageKey).toBeNull();
    expect(artifact.bytes).toBe(2);
    expect((await store.get("a1"))!.label).toBe("report");
    expect(await store.list("re_1")).toHaveLength(1);
    expect(await store.delete("a1")).toBe(true);
    expect(await store.get("a1")).toBeNull();
  });

  it("writes through to a bound bucket with an expiring TTL in metadata", async () => {
    const objects = new Map<string, { body: Uint8Array; customMetadata: Record<string, string> }>();
    const bucket = {
      put: async (key: string, value: ArrayBuffer | string, options?: { customMetadata?: Record<string, string> }) => {
        const body = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
        objects.set(key, { body, customMetadata: options?.customMetadata ?? {} });
      },
      get: async (key: string) => {
        const found = objects.get(key);
        return found ? { arrayBuffer: async () => found.body.buffer, customMetadata: found.customMetadata, size: found.body.byteLength } : null;
      },
      list: async (options?: { prefix?: string }) => ({
        objects: [...objects.entries()].filter(([key]) => !options?.prefix || key.startsWith(options.prefix)).map(([key, value]) => ({ key, customMetadata: value.customMetadata, size: value.body.byteLength })),
      }),
      delete: async (key: string) => {
        objects.delete(key);
      },
    };
    const store = createReverseEngineeringStore(bucket as never, () => new Date("2026-10-01T00:00:00.000Z"));
    expect(store.available).toBe(true);
    const artifact = await store.put({ id: "r1", analysisId: "re_1", label: "report", contentType: "application/json", body: '{"a":1}' }, 3_600);
    expect(artifact.storageKey).toBe("re-analysis/re_1/r1");
    expect(objects.get(artifact.storageKey!)!.customMetadata.expiresAt).toBe("2026-10-01T01:00:00.000Z");
    expect((await store.list("re_1")).map((entry) => entry.id)).toEqual(["r1"]);
    // An expired artifact is not served.
    const later = createReverseEngineeringStore(bucket as never, () => new Date("2026-10-02T00:00:00.000Z"));
    expect(await later.get("r1")).toBeNull();
  });
});

/* ------------------------------------------------------- MCP + UI integration */

describe("MCP and UI integration", () => {
  it("registers exactly the seven reverse-engineering tools", () => {
    expect([...REVERSE_TOOL_NAMES].sort()).toEqual([
      "reverse_analyze",
      "reverse_capabilities",
      "reverse_compare",
      "reverse_engineer",
      "reverse_evidence",
      "reverse_report",
      "reverse_triage",
    ]);
    for (const name of REVERSE_TOOL_NAMES) expect(DEMO_TOOL_NAMES as readonly string[]).toContain(name);
  });

  it("exposes them through tools/list with titles, descriptions and inputs", async () => {
    const response = await worker.fetch(
      new Request("https://demo.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      {} as never,
      CTX,
    );
    const text = await response.text();
    const payload = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter((line) => line.startsWith("data:")).at(-1)!.slice(5).trim());
    const tools = (payload.result?.tools ?? []) as Array<{ name: string; title?: string; description?: string; inputSchema?: { properties?: Record<string, unknown> }; annotations?: { readOnlyHint?: boolean } }>;
    expect(tools.length).toBe(TOOL_COUNT);
    for (const name of REVERSE_TOOL_NAMES) {
      const tool = tools.find((entry) => entry.name === name);
      expect(tool, `${name} missing from tools/list`).toBeDefined();
      expect(tool!.title).toBeTruthy();
      expect(tool!.description!.length).toBeGreaterThan(80);
      expect(tool!.annotations?.readOnlyHint).toBe(true);
      expect(Object.keys(tool!.inputSchema?.properties ?? {}).length).toBeGreaterThan(0);
    }
    const orchestrator = tools.find((entry) => entry.name === "reverse_engineer")!;
    expect(Object.keys(orchestrator.inputSchema!.properties!)).toContain("action");
    expect(Object.keys(orchestrator.inputSchema!.properties!)).toContain("authorization");
  });

  it("runs reverse_capabilities over the real MCP transport without any configuration", async () => {
    const response = await worker.fetch(
      new Request("https://demo.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "reverse_capabilities", arguments: { objective: "triage" } } }),
      }),
      {} as never,
      CTX,
    );
    const text = await response.text();
    const payload = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter((line) => line.startsWith("data:")).at(-1)!.slice(5).trim());
    const result = payload.result ?? {};
    expect(result.isError).toBeFalsy();
    const body = JSON.parse((result.content ?? []).map((entry: { text?: string }) => entry.text ?? "").join("\n"));
    expect(body.ok).toBe(true);
    expect(body.data.engines.length).toBeGreaterThanOrEqual(20);
    expect(body.data.externalTools.length).toBeGreaterThanOrEqual(20);
    expect(body.data.flags.reDynamicEnabled).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/RE_ANALYZER_KEY|analyzerKey|apiKey/i);
  });

  it("runs reverse_triage over the real MCP transport on a synthetic ELF", async () => {
    const response = await worker.fetch(
      new Request("https://demo.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "reverse_triage", arguments: { target: { inlineBase64: Buffer.from(elfFixture()).toString("base64"), name: "demo.elf" } } },
        }),
      }),
      {} as never,
      CTX,
    );
    const text = await response.text();
    const payload = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter((line) => line.startsWith("data:")).at(-1)!.slice(5).trim());
    const result = payload.result ?? {};
    expect(result.isError).toBeFalsy();
    const body = JSON.parse((result.content ?? []).map((entry: { text?: string }) => entry.text ?? "").join("\n"));
    expect(body.ok).toBe(true);
    expect(body.data.container.kind).toBe("elf");
    expect(body.data.triage.symbols.status).toBe("stripped");
    expect(body.data.triage.entropy.sections.map((section: { name: string }) => section.name)).toContain(".text");
  });

  it("surfaces the capability in the UI catalog and the capability categories", () => {
    const reverse = TOOL_CATALOG.filter((entry) => entry.group === "Reverse Engineering");
    expect(reverse.map((entry) => entry.name).sort()).toEqual([...REVERSE_TOOL_NAMES].sort());
    for (const entry of reverse) {
      expect(entry.availability).toBe("always");
      expect(entry.description!.length).toBeGreaterThan(40);
    }
    const category = CAPABILITY_CATEGORIES.find((entry) => entry.id === "reverse");
    expect(category).toBeDefined();
    expect(category!.groups).toEqual(["Reverse Engineering"]);
    expect(category!.description).toContain("never executed");
  });

  it("keeps Dev, Jev and Laya discoverable and does not collide with them", async () => {
    const { DEV_TOOL_NAMES } = await import("../src/mcp/dev-tools.js");
    const { JEV_TOOL_NAMES } = await import("../src/mcp/jev-tools.js");
    const { LAYA_TOOL_NAMES } = await import("../src/mcp/laya-tools.js");
    const reverse = new Set<string>(REVERSE_TOOL_NAMES);
    for (const name of [...DEV_TOOL_NAMES, ...JEV_TOOL_NAMES, ...LAYA_TOOL_NAMES]) {
      expect(reverse.has(name as string), `${name} collides with a reverse-engineering tool`).toBe(false);
      expect(DEMO_TOOL_NAMES as readonly string[]).toContain(name);
    }
    const { TOOL_GROUPS } = await import("../src/ui/tool-catalog.js");
    for (const group of ["Reverse Engineering", "JEV", "Laya"]) expect(TOOL_GROUPS).toContain(group);
  });

  it("exposes GET /capabilities/reverse with policy and no secrets", async () => {
    const response = await worker.fetch(new Request("https://demo.test/capabilities/reverse"), {} as never, CTX);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.reverseEngineering).toBe(true);
    expect(body.dynamicEnabled).toBe(false);
    expect(body.analyzerConfigured).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/RE_ANALYZER_KEY|analyzerKey/i);
    expect((body.safetyContract as string[]).join(" ")).toContain("never executed");
  });
});
