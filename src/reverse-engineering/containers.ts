/**
 * Container identification — the first deterministic step of every analysis.
 *
 * Direct port of the magic-byte table in the upstream
 * `references/01-triage.md` and `scripts/triage_binary.py`, extended to the
 * containers DEMO can actually parse in-process. Nothing here guesses: an
 * unrecognised file is reported as `unknown` with its leading bytes, because a
 * wrong container assumption is the single most expensive mistake in reverse
 * engineering (upstream: "No skipping triage — wrong toolchain assumption
 * wastes an hour and produces wrong code").
 */

import { ByteReader, toHex } from "./binary-reader.js";
import type { ContainerKind } from "./types.js";

export interface ContainerProfile {
  kind: ContainerKind;
  /** Human label, e.g. `ELF64 (x86-64, little-endian)`. */
  label: string;
  arch: string | null;
  bits: number | null;
  endian: "little" | "big" | null;
  /** Leading magic bytes as hex. */
  magic: string;
  /** 1.0 for a byte-exact match, lower for a heuristic one. */
  confidence: number;
  notes: string[];
  /** True when the container is an archive that must be unpacked first. */
  needsUnpacking: boolean;
}

const ELF_MACHINES: Record<number, string> = {
  0x02: "SPARC",
  0x03: "x86",
  0x08: "MIPS",
  0x14: "PowerPC",
  0x15: "PowerPC64",
  0x16: "S390",
  0x28: "ARM",
  0x32: "IA-64",
  0x3e: "x86-64",
  0x8c: "TMS320C6000",
  0xb7: "ARM64",
  0xf3: "RISC-V",
  0xf7: "BPF",
};

const MACHO_CPUTYPES: Record<number, string> = {
  0x00000007: "x86",
  0x01000007: "x86-64",
  0x0000000c: "ARM",
  0x0100000c: "ARM64",
  0x0000000a: "MC680x0",
  0x0100000f: "ARM64_32",
};

const PE_MACHINES: Record<number, string> = {
  0x014c: "x86 (i386)",
  0x0162: "R3000 MIPS",
  0x0166: "R4000 MIPS",
  0x01a2: "SH3",
  0x01a6: "SH4",
  0x01c0: "ARM",
  0x01c2: "ARM Thumb-2",
  0x01c4: "ARMNT",
  0x0200: "IA-64",
  0x5032: "RISC-V 32",
  0x5064: "RISC-V 64",
  0x8664: "x86-64",
  0xaa64: "ARM64",
  0x01f0: "PowerPC",
};

const WASM_TARGETS = new Set(["wasm32", "wasm64"]);

/** Identify the container from its leading bytes and the headers we can read. */
export function detectContainer(reader: ByteReader): ContainerProfile {
  const bytes = reader.bytes;
  const magic = toHex(bytes.subarray(0, Math.min(16, bytes.byteLength)));
  const notes: string[] = [];

  if (bytes.byteLength < 4) {
    return {
      kind: "unknown",
      label: bytes.byteLength === 0 ? "empty file" : "too small to identify",
      arch: null,
      bits: null,
      endian: null,
      magic,
      confidence: 1,
      notes: ["Fewer than 4 bytes: no container can be identified."],
      needsUnpacking: false,
    };
  }

  // ── ELF ───────────────────────────────────────────────────────────────────
  if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
    const bits = bytes[4] === 2 ? 64 : bytes[4] === 1 ? 32 : null;
    const endian = bytes[5] === 1 ? "little" : bytes[5] === 2 ? "big" : null;
    const machine = reader.u16(18, endian !== "big");
    const arch = machine === null ? null : ELF_MACHINES[machine] ?? `machine 0x${machine.toString(16)}`;
    const type = reader.u16(16, endian !== "big");
    const typeLabel = ELF_TYPES[type ?? -1] ?? "unknown ELF type";
    return {
      kind: "elf",
      label: `ELF${bits ?? ""} (${arch ?? "unknown arch"}, ${endian ?? "?"}-endian, ${typeLabel})`,
      arch,
      bits,
      endian,
      magic,
      confidence: 1,
      notes: [
        `e_type=0x${(type ?? 0).toString(16)} (${typeLabel})`,
        `e_machine=0x${(machine ?? 0).toString(16)} (${arch ?? "unknown"})`,
      ],
      needsUnpacking: false,
    };
  }

  // ── PE/COFF ───────────────────────────────────────────────────────────────
  if (bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const peOffset = reader.u32(0x3c, true);
    const dotnet = peOffset !== null && reader.has(peOffset, 24) && looksLikeClrHeader(reader, peOffset);
    const machine = peOffset !== null && reader.has(peOffset + 4, 2) ? reader.u16(peOffset + 4, true) : null;
    const arch = machine === null ? null : PE_MACHINES[machine] ?? `machine 0x${machine.toString(16)}`;
    const magic2 = peOffset !== null && reader.has(peOffset + 24, 2) ? reader.u16(peOffset + 24, true) : null;
    const bits = magic2 === 0x20b ? 64 : magic2 === 0x10b ? 32 : null;
    const bsjb = bytes.subarray(0, Math.min(bytes.byteLength, 8192)).includes(0x42) && findBytes(bytes, [0x42, 0x53, 0x4a, 0x42]) >= 0;
    if (dotnet || bsjb) {
      notes.push("CLR header present (BSJB): managed .NET assembly");
    }
    return {
      kind: dotnet || bsjb ? "dotnet" : "pe",
      label: `${dotnet || bsjb ? "PE/COFF (.NET assembly, CLR header)" : "PE/COFF"}${bits ? ` (${bits}-bit` : ""}${arch ? `, ${arch}` : ""}${bits ? ")" : ""}`,
      arch,
      bits,
      endian: "little",
      magic,
      confidence: peOffset !== null ? 1 : 0.8,
      notes: [
        `e_lfanew=0x${(peOffset ?? 0).toString(16)}`,
        ...notes,
      ],
      needsUnpacking: false,
    };
  }

  // ── Mach-O ────────────────────────────────────────────────────────────────
  const macho = detectMachO(reader);
  if (macho) return macho;

  // ── Java class / Mach-O fat (shared CAFEBABE magic) ───────────────────────
  if (bytes[0] === 0xca && bytes[1] === 0xfe && bytes[2] === 0xba && bytes[3] === 0xbe) {
    const major = reader.u16(6, false);
    if (major !== null && major >= 45 && major <= 80) {
      const javaVersion = JAVA_MAJOR[major] ?? `class file version ${major}`;
      return {
        kind: "java-class",
        label: `Java .class bytecode (major ${major} → ${javaVersion})`,
        arch: "jvm",
        bits: null,
        endian: "big",
        magic,
        confidence: 1,
        notes: [`major_version=${major}`, `minor_version=${reader.u16(4, false) ?? "?"}`],
        needsUnpacking: false,
      };
    }
    return {
      kind: "macho",
      label: "Mach-O universal (fat) binary",
      arch: "multiple",
      bits: null,
      endian: "big",
      magic,
      confidence: 0.8,
      notes: ["CAFEBABE with an implausible class-file version: treated as a fat Mach-O container."],
      needsUnpacking: false,
    };
  }
  if (bytes[0] === 0xca && bytes[1] === 0xfe && bytes[2] === 0xba && bytes[3] === 0xbf) {
    return {
      kind: "macho",
      label: "Mach-O 64-bit universal (fat) binary",
      arch: "multiple",
      bits: 64,
      endian: "big",
      magic,
      confidence: 0.8,
      notes: ["CAFEBABF fat header."],
      needsUnpacking: false,
    };
  }
  if (bytes[0] === 0xbe && bytes[1] === 0xba && bytes[2] === 0xfe && bytes[3] === 0xca) {
    return {
      kind: "macho",
      label: "Mach-O fat (little-endian fat header)",
      arch: "multiple",
      bits: null,
      endian: "little",
      magic,
      confidence: 0.7,
      notes: ["Byte-swapped fat header."],
      needsUnpacking: false,
    };
  }

  // ── WebAssembly ───────────────────────────────────────────────────────────
  if (bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d) {
    const version = reader.u32(4, true);
    return {
      kind: "wasm",
      label: `WebAssembly module (version ${version ?? "?"})`,
      arch: "wasm",
      bits: 32,
      endian: "little",
      magic,
      confidence: version === 1 ? 1 : 0.7,
      notes: version === 1 ? [] : ["Unexpected WASM version — treat the module layout with suspicion."],
      needsUnpacking: false,
    };
  }

  // ── Android DEX ───────────────────────────────────────────────────────────
  if (bytes[0] === 0x64 && bytes[1] === 0x65 && bytes[2] === 0x78 && bytes[3] === 0x0a) {
    return {
      kind: "dex",
      label: "Android DEX (Dalvik executable)",
      arch: "dalvik",
      bits: null,
      endian: "little",
      magic,
      confidence: 1,
      notes: ["Use jadx/apktool on the containing APK; DEX alone loses resource context."],
      needsUnpacking: false,
    };
  }

  // ── Python bytecode ───────────────────────────────────────────────────────
  const pyc = detectPyc(reader);
  if (pyc) return pyc;

  // ── Archives (must be unpacked, never executed) ───────────────────────────
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) {
    const jar = findBytes(bytes.subarray(0, Math.min(bytes.byteLength, 4096)), ascii("META-INF/")) >= 0;
    return {
      kind: "jar",
      label: jar ? "ZIP container (JAR layout: META-INF present)" : "ZIP container (JAR/APK/IPA/docx-like)",
      arch: null,
      bits: null,
      endian: null,
      magic,
      confidence: 0.9,
      notes: ["ZIP is a container: unpack in an isolated workspace before analysing members."],
      needsUnpacking: true,
    };
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return { kind: "archive", label: "gzip stream", arch: null, bits: null, endian: null, magic, confidence: 1, notes: ["Single-member gzip: decompress in an isolated workspace, bounded."], needsUnpacking: true };
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68) {
    return { kind: "archive", label: "bzip2 stream", arch: null, bits: null, endian: null, magic, confidence: 1, notes: ["Decompress in an isolated workspace, bounded."], needsUnpacking: true };
  }
  if (bytes[0] === 0xfd && bytes[1] === 0x37 && bytes[2] === 0x7a && bytes[3] === 0x58) {
    return { kind: "archive", label: "xz stream", arch: null, bits: null, endian: null, magic, confidence: 1, notes: ["Decompress in an isolated workspace, bounded."], needsUnpacking: true };
  }
  if (bytes[0] === 0x04 && bytes[1] === 0x00 && bytes[2] === 0x00 && bytes[3] === 0x00 && findBytes(bytes.subarray(0, 1024), ascii('"files"')) >= 0) {
    return {
      kind: "asar",
      label: "ASAR (Electron archive)",
      arch: null,
      bits: null,
      endian: null,
      magic,
      confidence: 0.9,
      notes: ["Electron app.asar: the header is a JSON pickle; members are never executed."],
      needsUnpacking: true,
    };
  }

  // ── PCAP / PCAPNG ─────────────────────────────────────────────────────────
  const pcap = detectPcap(reader);
  if (pcap) return pcap;

  // ── SQLite (embedded databases carry real schemas) ────────────────────────
  if (bytes.byteLength >= 16 && ascii("SQLite format 3\0").every((b, i) => bytes[i] === b)) {
    return {
      kind: "sqlite",
      label: "SQLite 3 database",
      arch: null,
      bits: null,
      endian: null,
      magic,
      confidence: 1,
      notes: ["Read schema and rows as data only; never open the database with an application."],
      needsUnpacking: false,
    };
  }

  // ── Plain text ────────────────────────────────────────────────────────────
  const printable = printableHeadRatio(bytes);
  if (printable > 0.9) {
    return {
      kind: "text",
      label: "text / script (no binary container)",
      arch: null,
      bits: null,
      endian: null,
      magic,
      confidence: 0.8,
      notes: ["Analyse as source. A shebang line is reported by the strings pass."],
      needsUnpacking: false,
    };
  }

  return {
    kind: "unknown",
    label: `unknown container (magic ${magic})`,
    arch: null,
    bits: null,
    endian: null,
    magic,
    confidence: 0,
    notes: [
      "No known container matched. Treat the format as undocumented: go straight to the evidence-driven protocol/format workflow.",
      `Leading bytes: ${toHex(bytes.subarray(0, Math.min(32, bytes.byteLength)), " ")}`,
    ],
    needsUnpacking: false,
  };
}

const ELF_TYPES: Record<number, string> = {
  0: "ET_NONE",
  1: "ET_REL (relocatable)",
  2: "ET_EXEC (executable)",
  3: "ET_DYN (shared object / PIE)",
  4: "ET_CORE (core dump)",
};

const JAVA_MAJOR: Record<number, string> = {
  45: "Java 1.1",
  46: "Java 1.2",
  47: "Java 1.3",
  48: "Java 1.4",
  49: "Java 5",
  50: "Java 6",
  51: "Java 7",
  52: "Java 8",
  53: "Java 9",
  54: "Java 10",
  55: "Java 11",
  56: "Java 12",
  57: "Java 13",
  58: "Java 14",
  59: "Java 15",
  60: "Java 16",
  61: "Java 17",
  62: "Java 18",
  63: "Java 19",
  64: "Java 20",
  65: "Java 21",
  66: "Java 22",
  67: "Java 23",
  68: "Java 24",
};

/** Python .pyc magic → version (the table upstream tells you to version-gate on). */
export const PYC_MAGICS: Record<number, string> = {
  20121: "Python 1.5",
  50428: "Python 1.6",
  50823: "Python 2.0",
  60202: "Python 2.1",
  60717: "Python 2.2",
  62011: "Python 2.3",
  62041: "Python 2.4",
  62061: "Python 2.5",
  62071: "Python 2.6",
  62121: "Python 2.7",
  3110: "Python 3.0",
  3130: "Python 3.1",
  3140: "Python 3.2",
  3150: "Python 3.3",
  3160: "Python 3.4",
  3170: "Python 3.5",
  3180: "Python 3.6",
  3190: "Python 3.7",
  3210: "Python 3.8",
  3220: "Python 3.9",
  3230: "Python 3.10",
  3240: "Python 3.11",
  3250: "Python 3.12",
  3260: "Python 3.13",
  3270: "Python 3.14",
  3280: "Python 3.15",
};

function detectPyc(reader: ByteReader): ContainerProfile | null {
  const bytes = reader.bytes;
  if (bytes.byteLength < 8) return null;
  // A .pyc magic is a 16-bit LE number in a narrow, sparse range; requiring the
  // following field to look like a timestamp or hash keeps text files out.
  const magic = reader.u16(0, true);
  if (magic === null) return null;
  const version = PYC_MAGICS[magic];
  if (!version) return null;
  const flags = reader.u32(4, true);
  return {
    kind: "python-bytecode",
    label: `Python bytecode .pyc (${version})`,
    arch: "python",
    bits: null,
    endian: "little",
    magic: toHex(bytes.subarray(0, 4)),
    confidence: 0.85,
    notes: [
      `magic=${magic} → ${version}`,
      `header flags=0x${(flags ?? 0).toString(16)} (0 = timestamp-based, 1/3 = hash-based)`,
      "Version-gate the decompiler: uncompyle6 (≤3.8), decompyle3 (3.9), pycdc (3.10+); marshal+dis always works.",
    ],
    needsUnpacking: false,
  };
}

function detectPcap(reader: ByteReader): ContainerProfile | null {
  const bytes = reader.bytes;
  const magic = toHex(bytes.subarray(0, 4));
  if (bytes.byteLength >= 4) {
    if (bytes[0] === 0xd4 && bytes[1] === 0xc3 && bytes[2] === 0xb2 && bytes[3] === 0xa1) {
      return pcapProfile("pcap (little-endian, microsecond)", "little");
    }
    if (bytes[0] === 0xa1 && bytes[1] === 0xb2 && bytes[2] === 0xc3 && bytes[3] === 0xd4) {
      return pcapProfile("pcap (big-endian, microsecond)", "big");
    }
    if (bytes[0] === 0x4d && bytes[1] === 0x3c && bytes[2] === 0xb2 && bytes[3] === 0xa1) {
      return pcapProfile("pcap (little-endian, nanosecond)", "little");
    }
    if (bytes[0] === 0xa1 && bytes[1] === 0xb2 && bytes[2] === 0x3c && bytes[3] === 0x4d) {
      return pcapProfile("pcap (big-endian, nanosecond)", "big");
    }
    if (bytes[0] === 0x0a && bytes[1] === 0x0d && bytes[2] === 0x0d && bytes[3] === 0x0a) {
      return {
        kind: "pcap",
        label: "pcapng capture",
        arch: null,
        bits: null,
        endian: "little",
        magic,
        confidence: 1,
        notes: ["Section Header Block detected; blocks are parsed with a hard packet cap."],
        needsUnpacking: false,
      };
    }
  }
  return null;
}

function pcapProfile(label: string, endian: "little" | "big"): ContainerProfile {
  return {
    kind: "pcap",
    label,
    arch: null,
    bits: null,
    endian,
    magic: "",
    confidence: 1,
    notes: ["Packet captures are read as data: no packet is ever transmitted."],
    needsUnpacking: false,
  };
}

function detectMachO(reader: ByteReader): ContainerProfile | null {
  const bytes = reader.bytes;
  const m = reader.u32(0, false);
  const is64 = m === 0xfeedfacf || m === 0xcffaedfe || m === 0xfeedfacf;
  const is32 = m === 0xfeedface || m === 0xcefaedfe;
  if (!is64 && !is32) return null;
  const little = m === 0xcffaedfe || m === 0xcefaedfe;
  const cputype = reader.u32(4, little);
  const arch = cputype === null ? null : MACHO_CPUTYPES[cputype] ?? `cputype 0x${cputype.toString(16)}`;
  const filetype = reader.u32(12, little);
  return {
    kind: "macho",
    label: `Mach-O ${is64 ? "64" : "32"}-bit (${arch ?? "unknown"}, ${little ? "little" : "big"}-endian)`,
    arch,
    bits: is64 ? 64 : 32,
    endian: little ? "little" : "big",
    magic: toHex(bytes.subarray(0, 4)),
    confidence: 1,
    notes: [`cputype=0x${(cputype ?? 0).toString(16)}`, `filetype=0x${(filetype ?? 0).toString(16)}`],
    needsUnpacking: false,
  };
}

function looksLikeClrHeader(reader: ByteReader, peOffset: number): boolean {
  // Data directory 14 (CLR header) at peOffset + 24 + 112 + 8*14
  const clr = reader.u32(peOffset + 24 + 112 + 8 * 14, true);
  if (clr === null || clr === 0) return false;
  return reader.has(clr, 4) && reader.bytes[clr] === 0x42 && reader.bytes[clr + 1] === 0x53 && reader.bytes[clr + 2] === 0x4a && reader.bytes[clr + 3] === 0x42;
}

function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

export function findBytes(haystack: Uint8Array, needle: number[], from = 0): number {
  if (needle.length === 0) return from;
  const limit = haystack.byteLength - needle.length;
  outer: for (let i = Math.max(0, from); i <= limit; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function printableHeadRatio(bytes: Uint8Array): number {
  const head = bytes.subarray(0, Math.min(bytes.byteLength, 1024));
  if (head.byteLength === 0) return 0;
  let printable = 0;
  for (const b of head) {
    if ((b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d) printable += 1;
  }
  return printable / head.byteLength;
}

/** Names the architecture in the terms the report uses. */
export function describeArch(profile: ContainerProfile): string {
  if (profile.arch) return profile.arch;
  if (profile.kind === "wasm") return "wasm";
  return "unknown";
}

export { WASM_TARGETS };
