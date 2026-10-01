/**
 * Mach-O parser.
 *
 * Header, load commands, segments/sections, dylib dependencies, UUID, entry
 * point and the symbol table — plus universal ("fat") container enumeration.
 * Section offsets are read from the file, so entropy is computed from the
 * bytes that are actually on disk.
 */

import { ByteReader } from "./binary-reader.js";
import { shannonEntropyRange } from "./entropy.js";

export interface MachoSection {
  segment: string;
  name: string;
  addr: number;
  size: number;
  offset: number;
  flags: string[];
  entropy: number | null;
}

export interface MachoSymbol {
  name: string;
  value: number;
  type: string;
}

export interface MachoReport {
  ok: boolean;
  bits: 32 | 64;
  endian: "little" | "big";
  cputype: string;
  filetype: string;
  flags: string[];
  entry: number | null;
  uuid: string | null;
  sections: MachoSection[];
  dylibs: string[];
  codeSignature: { offset: number; size: number } | null;
  symbols: MachoSymbol[];
  warnings: string[];
  truncated: boolean;
}

const MH_FILETYPES: Record<number, string> = {
  1: "MH_OBJECT",
  2: "MH_EXECUTE",
  3: "MH_FVMLIB",
  4: "MH_CORE",
  5: "MH_PRELOAD",
  6: "MH_DYLIB",
  7: "MH_DYLINKER",
  8: "MH_BUNDLE",
  9: "MH_DYLIB_STUB",
  10: "MH_DSYM",
  11: "MH_BUNDLE_EXECUTE",
  12: "MH_KEXT_BUNDLE",
};

const CPU_TYPES: Record<number, string> = {
  7: "x86",
  0x01000007: "x86-64",
  12: "ARM",
  0x0100000c: "ARM64",
  0x0100000f: "ARM64_32",
  6: "MC680x0",
  10: "MC98000",
  11: "HPPA",
  0x01000010: "PowerPC64",
};

const LOAD_COMMANDS: Record<number, string> = {
  0x1: "LC_SEGMENT",
  0x2: "LC_SYMTAB",
  0xb: "LC_ID_DYLIB",
  0xc: "LC_LOAD_DYLIB",
  0x19: "LC_SEGMENT_64",
  0x1b: "LC_UUID",
  0x1c: "LC_RPATH",
  0x1d: "LC_CODE_SIGNATURE",
  0x80000028: "LC_MAIN",
};

const MAX_COMMANDS = 512;
const MAX_SECTIONS = 512;
const MAX_SYMBOLS = 20_000;

export function parseMachO(reader: ByteReader): MachoReport | null {
  const bytes = reader.bytes;
  if (bytes.byteLength < 28) return null;
  const rawMagic = reader.u32(0, false);
  const magics = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe]);
  if (rawMagic === null || !magics.has(rawMagic)) return null;
  const little = rawMagic === 0xcefaedfe || rawMagic === 0xcffaedfe;
  const bits: 32 | 64 = rawMagic === 0xfeedfacf || rawMagic === 0xcffaedfe ? 64 : 32;

  const warnings: string[] = [];
  const cputypeValue = reader.u32(4, little) ?? 0;
  const filetypeValue = reader.u32(12, little) ?? 0;
  const report: MachoReport = {
    ok: true,
    bits,
    endian: little ? "little" : "big",
    cputype: CPU_TYPES[cputypeValue] ?? `0x${cputypeValue.toString(16)}`,
    filetype: MH_FILETYPES[filetypeValue] ?? `0x${filetypeValue.toString(16)}`,
    flags: decodeMachFlags(reader.u32(16, little) ?? 0),
    entry: null,
    uuid: null,
    sections: [],
    dylibs: [],
    codeSignature: null,
    symbols: [],
    warnings,
    truncated: false,
  };

  const commandCount = reader.u32(16, little) ?? 0;
  const headerSize = bits === 64 ? 32 : 28;
  let cursor = headerSize;
  let symoff = 0;
  let nsyms = 0;
  let stroff = 0;
  let strsize = 0;

  for (let i = 0; i < Math.min(commandCount, MAX_COMMANDS) && reader.has(cursor, 8); i += 1) {
    const cmd = reader.u32(cursor, little) ?? 0;
    const cmdsize = reader.u32(cursor + 4, little) ?? 0;
    if (cmdsize < 8 || !reader.has(cursor, cmdsize)) {
      report.truncated = true;
      warnings.push(`Load command ${i} (${LOAD_COMMANDS[cmd] ?? `0x${cmd.toString(16)}`}) has an implausible size ${cmdsize}.`);
      break;
    }

    if (cmd === 0x1 || cmd === 0x19) {
      const seg64 = cmd === 0x19;
      const segmentName = reader.fixedString(cursor + 8, 16)?.replace(/\0+$/, "") ?? "";
      const nsects = seg64 ? (reader.u32(cursor + 64, little) ?? 0) : (reader.u32(cursor + 48, little) ?? 0);
      const sectionSize = seg64 ? 80 : 68;
      const sectionsAt = seg64 ? cursor + 72 : cursor + 56;
      for (let s = 0; s < Math.min(nsects, MAX_SECTIONS) && reader.has(sectionsAt + s * sectionSize, sectionSize); s += 1) {
        const at = sectionsAt + s * sectionSize;
        const addr = seg64 ? Number(reader.u64(at + 32, little) ?? 0) : (reader.u32(at + 32, little) ?? 0);
        const size = seg64 ? Number(reader.u64(at + 40, little) ?? 0) : (reader.u32(at + 36, little) ?? 0);
        const offset = reader.u32(seg64 ? at + 48 : at + 40, little) ?? 0;
        const sflags = reader.u32(seg64 ? at + 64 : at + 56, little) ?? 0;
        report.sections.push({
          segment: segmentName,
          name: reader.fixedString(at, 16)?.replace(/\0+$/, "") ?? "",
          addr,
          size,
          offset,
          flags: decodeSectionFlags(sflags),
          entropy: size > 0 && offset > 0 && reader.has(offset, size) ? shannonEntropyRange(bytes, offset, size) : null,
        });
      }
    } else if (cmd === 0x1b) {
      const uuid = reader.slice(cursor + 8, 16);
      report.uuid = uuid ? [...uuid].map((b) => b.toString(16).padStart(2, "0")).join("") : null;
    } else if (cmd === 0xc || cmd === 0xb || cmd === 0xf || cmd === 0x1f) {
      const nameOffset = reader.u32(cursor + 8, little) ?? 0;
      const name = reader.cString(cursor + nameOffset, 256);
      if (name) report.dylibs.push(name);
    } else if (cmd === 0x2) {
      symoff = reader.u32(cursor + 8, little) ?? 0;
      nsyms = reader.u32(cursor + 12, little) ?? 0;
      stroff = reader.u32(cursor + 16, little) ?? 0;
      strsize = reader.u32(cursor + 20, little) ?? 0;
    } else if (cmd === 0x1d) {
      report.codeSignature = { offset: reader.u32(cursor + 8, little) ?? 0, size: reader.u32(cursor + 12, little) ?? 0 };
    } else if (cmd === 0x80000028) {
      report.entry = Number(reader.u64(cursor + 8, little) ?? 0);
    }

    cursor += cmdsize;
  }

  if (symoff > 0 && nsyms > 0 && stroff > 0 && strsize > 0) {
    const strings = readStringTable(reader, stroff, Math.min(strsize, 1 << 20));
    const entsize = bits === 64 ? 16 : 12;
    const total = Math.min(nsyms, MAX_SYMBOLS);
    for (let i = 0; i < total && reader.has(symoff + i * entsize, entsize); i += 1) {
      const at = symoff + i * entsize;
      const strx = reader.u32(at, little) ?? 0;
      const type = reader.u8(at + 4) ?? 0;
      const value = bits === 64 ? Number(reader.u64(at + 8, little) ?? 0) : (reader.u32(at + 8, little) ?? 0);
      const name = strings[strx] ?? "";
      if (name) report.symbols.push({ name, value, type: decodeNlistType(type) });
    }
  }

  return report;
}

/** Enumerate the architectures of a universal (fat) Mach-O container. */
export function parseFatHeader(reader: ByteReader): Array<{ cputype: string; offset: number; size: number }> {
  const out: Array<{ cputype: string; offset: number; size: number }> = [];
  const magic = reader.u32(0, false);
  if (magic !== 0xcafebabe && magic !== 0xbebafeca) return out;
  const big = magic === 0xcafebabe;
  const nfat = reader.u32(4, big) ?? 0;
  for (let i = 0; i < Math.min(nfat, 16); i += 1) {
    const at = 8 + i * 20;
    if (!reader.has(at, 20)) break;
    const cputype = reader.u32(at, big) ?? 0;
    out.push({
      cputype: CPU_TYPES[cputype] ?? `0x${cputype.toString(16)}`,
      offset: reader.u32(at + 8, big) ?? 0,
      size: reader.u32(at + 12, big) ?? 0,
    });
  }
  return out;
}

function readStringTable(reader: ByteReader, offset: number, size: number): string[] {
  if (size <= 0 || !reader.has(offset, size)) return [];
  const table = reader.bytes.subarray(offset, offset + size);
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i <= table.byteLength; i += 1) {
    if (i === table.byteLength || table[i] === 0) {
      out.push(i > start ? new TextDecoder("utf-8", { fatal: false }).decode(table.subarray(start, i)) : "");
      start = i + 1;
    }
  }
  return out;
}

function decodeMachFlags(flags: number): string[] {
  const out: string[] = [];
  if (flags & 0x1) out.push("NOUNDEFS");
  if (flags & 0x4) out.push("DYLDLINK");
  if (flags & 0x8) out.push("BINDATLOAD");
  if (flags & 0x80) out.push("TWOLEVEL");
  if (flags & 0x100) out.push("ALLOW_STACK_EXECUTION");
  if (flags & 0x20000) out.push("PIE");
  if (flags & 0x800000) out.push("ROOT_SAFE");
  return out;
}

function decodeSectionFlags(flags: number): string[] {
  const out: string[] = [];
  if (flags & 0x00000200) out.push("PURE_INSTRUCTIONS");
  if (flags & 0x00008000) out.push("DEBUG");
  if (flags & 0x10000000) out.push("EXT_RELOC");
  if (flags & 0x20000000) out.push("LOC_RELOC");
  if ((flags & 0xff) === 15) out.push("S_ZEROFILL");
  if ((flags & 0xff) === 1) out.push("S_CSTRING_LITERALS");
  return out;
}

function decodeNlistType(type: number): string {
  if (type & 0x0e) return "external";
  if (type & 0x01) return "undefined";
  return "local";
}
