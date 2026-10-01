/**
 * ELF parser.
 *
 * Reads the parts of an ELF that carry evidence: header, program headers,
 * section headers, the symbol tables, the dynamic section and the notes. Every
 * count is clamped, every offset is bounds-checked, and a truncated file yields
 * a partial parse plus a warning instead of an exception.
 *
 * This replaces `readelf -h/-S/--dyn-syms` for the Worker-side deterministic
 * pass. When an external analysis service with real binutils is configured the
 * results are cross-checked against it (see `engine.ts`).
 */

import { ByteReader } from "./binary-reader.js";
import { shannonEntropyRange } from "./entropy.js";

export interface ElfSection {
  index: number;
  name: string;
  type: string;
  flags: string[];
  addr: number;
  offset: number;
  size: number;
  align: number;
  entropy: number | null;
}

export interface ElfSymbol {
  name: string;
  value: number;
  size: number;
  type: string;
  bind: string;
  shndx: string;
}

export interface ElfDynamic {
  needed: string[];
  soname: string | null;
  rpath: string | null;
  runpath: string | null;
  flags: string[];
  entries: number;
}

export interface ElfProgramHeader {
  type: string;
  flags: string;
  offset: number;
  vaddr: number;
  filesz: number;
  memsz: number;
}

export interface ElfReport {
  ok: boolean;
  bits: 32 | 64;
  endian: "little" | "big";
  type: string;
  machine: string;
  entry: number;
  osAbi: string;
  flags: string;
  sections: ElfSection[];
  symbols: ElfSymbol[];
  dynamicSymbols: ElfSymbol[];
  dynamic: ElfDynamic;
  programHeaders: ElfProgramHeader[];
  buildId: string | null;
  comment: string | null;
  goBuildInfo: string | null;
  warnings: string[];
  truncated: boolean;
}

const SECTION_TYPES: Record<number, string> = {
  0: "NULL",
  1: "PROGBITS",
  2: "SYMTAB",
  3: "STRTAB",
  4: "RELA",
  5: "HASH",
  6: "DYNAMIC",
  7: "NOTE",
  8: "NOBITS",
  9: "REL",
  10: "SHLIB",
  11: "DYNSYM",
  14: "INIT_ARRAY",
  15: "FINI_ARRAY",
  16: "PREINIT_ARRAY",
  17: "GROUP",
  18: "SYMTAB_SHNDX",
  19: "RELR",
  0x6ffffff5: "GNU_ATTRIBUTES",
  0x6ffffff6: "GNU_HASH",
  0x6ffffff7: "GNU_LIBLIST",
  0x6ffffffd: "GNU_VERDEF",
  0x6ffffffe: "GNU_VERNEED",
  0x6fffffff: "GNU_VERSYM",
};

const SYMBOL_TYPES = ["NOTYPE", "OBJECT", "FUNC", "SECTION", "FILE", "COMMON", "TLS", "NUM", "IFUNC"];
const SYMBOL_BINDS = ["LOCAL", "GLOBAL", "WEAK", "GNU_UNIQUE"];

const PH_TYPES: Record<number, string> = {
  0: "NULL",
  1: "LOAD",
  2: "DYNAMIC",
  3: "INTERP",
  4: "NOTE",
  5: "SHLIB",
  6: "PHDR",
  7: "TLS",
  0x6474e550: "GNU_EH_FRAME",
  0x6474e551: "GNU_STACK",
  0x6474e552: "GNU_RELRO",
  0x6474e553: "GNU_PROPERTY",
  0x6474e554: "GNU_SFRAME",
};

const ELF_TYPES: Record<number, string> = {
  0: "ET_NONE",
  1: "ET_REL",
  2: "ET_EXEC",
  3: "ET_DYN",
  4: "ET_CORE",
};

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
  0xb7: "AArch64",
  0xf3: "RISC-V",
  0xf7: "eBPF",
};

const OS_ABI: Record<number, string> = {
  0: "SYSV",
  1: "HP-UX",
  2: "NetBSD",
  3: "Linux (GNU)",
  6: "Solaris",
  9: "FreeBSD",
  12: "OpenBSD",
  255: "Standalone",
};

/** Hard caps: a hostile header must never be able to request a huge allocation. */
const MAX_SECTIONS = 4_096;
const MAX_SYMBOLS = 20_000;
const MAX_PHDRS = 256;
const MAX_DYN = 4_096;
const MAX_STRTAB = 1 << 20;

interface RawSectionHeader {
  index: number;
  nameIndex: number;
  type: number;
  flags: number;
  addr: number;
  offset: number;
  size: number;
  link: number;
  info: number;
  align: number;
  entsize: number;
}

export function parseElf(reader: ByteReader): ElfReport | null {
  const bytes = reader.bytes;
  if (bytes.byteLength < 20) return null;
  if (!(bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46)) return null;
  const bits: 32 | 64 | null = bytes[4] === 2 ? 64 : bytes[4] === 1 ? 32 : null;
  const endian: "little" | "big" | null = bytes[5] === 1 ? "little" : bytes[5] === 2 ? "big" : null;
  if (bits === null || endian === null) return null;
  const little = endian === "little";
  const warnings: string[] = [];

  const type = reader.u16(16, little) ?? 0;
  const machine = reader.u16(18, little) ?? 0;
  const entry = (bits === 64 ? (reader.u64(24, little) as number | null) : reader.u32(24, little)) ?? 0;
  const phoff = (bits === 64 ? (reader.u64(32, little) as number | null) : reader.u32(28, little)) ?? 0;
  const shoff = (bits === 64 ? (reader.u64(40, little) as number | null) : reader.u32(32, little)) ?? 0;
  const flags = reader.u32(bits === 64 ? 48 : 36, little) ?? 0;
  const ehsize = reader.u16(bits === 64 ? 52 : 40, little) ?? 0;
  const phentsize = reader.u16(bits === 64 ? 54 : 42, little) ?? 0;
  const phnum = reader.u16(bits === 64 ? 56 : 44, little) ?? 0;
  const shentsize = reader.u16(bits === 64 ? 58 : 46, little) ?? 0;
  const shnum = reader.u16(bits === 64 ? 60 : 48, little) ?? 0;
  const shstrndx = reader.u16(bits === 64 ? 62 : 50, little) ?? 0;

  const report: ElfReport = {
    ok: true,
    bits,
    endian,
    type: ELF_TYPES[type] ?? `0x${type.toString(16)}`,
    machine: ELF_MACHINES[machine] ?? `0x${machine.toString(16)}`,
    entry,
    osAbi: OS_ABI[bytes[7] ?? 0] ?? `0x${bytes[7] ?? 0}`,
    flags: `0x${flags.toString(16)}`,
    sections: [],
    symbols: [],
    dynamicSymbols: [],
    dynamic: { needed: [], soname: null, rpath: null, runpath: null, flags: [], entries: 0 },
    programHeaders: [],
    buildId: null,
    comment: null,
    goBuildInfo: null,
    warnings,
    truncated: false,
  };

  /* ------------------------------------------------------------- sections -- */
  const headers: RawSectionHeader[] = [];
  if (shoff !== 0 && shnum !== 0 && shentsize !== 0) {
    const count = Math.min(shnum, MAX_SECTIONS);
    for (let i = 0; i < count; i += 1) {
      const at = shoff + i * shentsize;
      if (!reader.has(at, shentsize)) {
        report.truncated = true;
        warnings.push(`Section header table truncated at index ${i} of ${shnum}.`);
        break;
      }
      if (bits === 64) {
        headers.push({
          index: i,
          nameIndex: reader.u32(at, little) ?? 0,
          type: reader.u32(at + 4, little) ?? 0,
          flags: Number(reader.u64(at + 8, little) ?? 0),
          addr: Number(reader.u64(at + 16, little) ?? 0),
          offset: Number(reader.u64(at + 24, little) ?? 0),
          size: Number(reader.u64(at + 32, little) ?? 0),
          link: reader.u32(at + 40, little) ?? 0,
          info: reader.u32(at + 44, little) ?? 0,
          align: Number(reader.u64(at + 48, little) ?? 0),
          entsize: Number(reader.u64(at + 56, little) ?? 0),
        });
      } else {
        headers.push({
          index: i,
          nameIndex: reader.u32(at, little) ?? 0,
          type: reader.u32(at + 4, little) ?? 0,
          flags: reader.u32(at + 8, little) ?? 0,
          addr: reader.u32(at + 12, little) ?? 0,
          offset: reader.u32(at + 16, little) ?? 0,
          size: reader.u32(at + 20, little) ?? 0,
          link: reader.u32(at + 24, little) ?? 0,
          info: reader.u32(at + 28, little) ?? 0,
          align: reader.u32(at + 32, little) ?? 0,
          entsize: reader.u32(at + 36, little) ?? 0,
        });
      }
    }
  } else if (shoff !== 0) {
    warnings.push("Section header table is declared but empty (stripped section headers).");
  }

  const shstr = headers[shstrndx];
  // `sh_name` is a *byte offset* into .shstrtab, not an index into a list, so
  // the section names are read as C-strings from the raw table rather than from
  // a positionally-split array (which is what symbol/dynamic tables need).
  const sectionNameTable = shstr ? reader.slice(shstr.offset, Math.min(shstr.size, MAX_STRTAB)) : null;
  const nameOf = (header: RawSectionHeader): string =>
    sectionNameTable ? cStringAt(sectionNameTable, header.nameIndex) : "";

  const stringTables = new Map<number, string[]>();

  for (const header of headers) {
    const name = nameOf(header);
    const entropy =
      header.type !== 8 && header.size > 0 && reader.has(header.offset, header.size)
        ? shannonEntropyRange(bytes, header.offset, header.size)
        : null;
    report.sections.push({
      index: header.index,
      name: name || `<unnamed ${header.index}>`,
      type: SECTION_TYPES[header.type] ?? `0x${header.type.toString(16)}`,
      flags: decodeSectionFlags(header.flags),
      addr: header.addr,
      offset: header.offset,
      size: header.size,
      align: header.align,
      entropy,
    });
    if (name === ".comment") report.comment = readFirstString(reader, header.offset, header.size);
    if (name === ".note.gnu.build-id") report.buildId = readBuildId(reader, header.offset, header.size);
    if (name === ".go.buildinfo") report.goBuildInfo = describeGoBuildInfo(reader, header.offset, header.size);
    if ((header.type === 3 || header.type === 11) && !stringTables.has(header.index)) {
      stringTables.set(header.index, readStringTable(reader, header.offset, header.size, MAX_STRTAB));
    }
  }

  /* ------------------------------------------------------------- symbols --- */
  for (const header of headers) {
    if (header.type !== 2 && header.type !== 11) continue;
    const strings = stringTables.get(header.link);
    if (!strings) continue;
    const entsize = header.entsize || (bits === 64 ? 24 : 16);
    const count = Math.min(Math.floor(header.size / entsize), MAX_SYMBOLS);
    const symbols: ElfSymbol[] = [];
    for (let i = 0; i < count; i += 1) {
      const symbol = readSymbol(reader, bits, little, header.offset + i * entsize, strings);
      if (symbol && symbol.name) symbols.push(symbol);
    }
    if (nameOf(header) === ".dynsym") report.dynamicSymbols = symbols;
    else report.symbols = symbols;
  }

  /* ------------------------------------------------------------- dynamic --- */
  const dynamicHeader = headers.find((header) => header.type === 6);
  if (dynamicHeader) {
    const strings = stringTables.get(dynamicHeader.link) ?? [];
    const entsize = bits === 64 ? 16 : 8;
    const count = Math.min(Math.floor(dynamicHeader.size / entsize), MAX_DYN);
    for (let i = 0; i < count; i += 1) {
      const at = dynamicHeader.offset + i * entsize;
      const tag = (bits === 64 ? (reader.u64(at, little) as number | null) : reader.u32(at, little)) ?? 0;
      const value = (bits === 64 ? (reader.u64(at + 8, little) as number | null) : reader.u32(at + 4, little)) ?? 0;
      if (tag === 0) break;
      report.dynamic.entries += 1;
      const resolved = tag === 1 || tag === 14 || tag === 15 || tag === 29 ? strings[value] ?? `offset ${value}` : null;
      if (tag === 1) report.dynamic.needed.push(resolved!);
      else if (tag === 14) report.dynamic.soname = resolved;
      else if (tag === 15) report.dynamic.rpath = resolved;
      else if (tag === 29) report.dynamic.runpath = resolved;
      else if (tag === 30 || tag === 0x6ffffffb) report.dynamic.flags.push(`${tag === 30 ? "DT_FLAGS" : "DT_FLAGS_1"}=0x${value.toString(16)}`);
    }
  }

  /* ------------------------------------------------------- program headers -- */
  const phSize = phentsize || (bits === 64 ? 56 : 32);
  const phCount = Math.min(phnum, MAX_PHDRS);
  for (let i = 0; i < phCount; i += 1) {
    const at = phoff + i * phSize;
    if (!reader.has(at, phSize)) {
      report.truncated = true;
      warnings.push(`Program header table truncated at index ${i} of ${phnum}.`);
      break;
    }
    const pType = reader.u32(at, little) ?? 0;
    const offset = bits === 64 ? (reader.u32(at + 8, little) ?? 0) : (reader.u32(at + 4, little) ?? 0);
    const vaddr = bits === 64 ? (Number(reader.u64(at + 16, little) ?? 0)) : (reader.u32(at + 8, little) ?? 0);
    const filesz = bits === 64 ? (Number(reader.u64(at + 32, little) ?? 0)) : (reader.u32(at + 16, little) ?? 0);
    const memsz = bits === 64 ? (Number(reader.u64(at + 40, little) ?? 0)) : (reader.u32(at + 20, little) ?? 0);
    const phFlags = bits === 64 ? (reader.u32(at + 4, little) ?? 0) : (reader.u32(at + 24, little) ?? 0);
    report.programHeaders.push({ type: PH_TYPES[pType] ?? `0x${pType.toString(16)}`, flags: decodePhFlags(phFlags), offset, vaddr, filesz, memsz });
  }

  if (ehsize && ehsize !== (bits === 64 ? 64 : 52)) {
    warnings.push(`Unexpected e_ehsize ${ehsize} for ELF${bits}.`);
  }

  return report;
}

/** NUL-terminated string at a byte offset inside a table, or "". */
function cStringAt(table: Uint8Array, offset: number): string {
  if (offset < 0 || offset >= table.byteLength) return "";
  let end = offset;
  while (end < table.byteLength && table[end] !== 0) end += 1;
  return new TextDecoder("utf-8", { fatal: false }).decode(table.subarray(offset, end));
}

function readStringTable(reader: ByteReader, offset: number, size: number, cap: number): string[] {
  const usable = Math.min(size, cap);
  if (usable <= 0 || !reader.has(offset, usable)) return [];
  const table = reader.bytes.subarray(offset, offset + usable);
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

function readFirstString(reader: ByteReader, offset: number, size: number): string | null {
  if (!reader.has(offset, Math.min(size, 256))) return null;
  const end = reader.bytes.indexOf(0, offset);
  if (end < 0 || end > offset + size) return null;
  return new TextDecoder("utf-8", { fatal: false }).decode(reader.bytes.subarray(offset, end));
}

function readBuildId(reader: ByteReader, offset: number, size: number): string | null {
  if (!reader.has(offset, Math.min(size, 64))) return null;
  const nameSize = reader.u32(offset, true) ?? 0;
  const descSize = reader.u32(offset + 4, true) ?? 0;
  if (descSize <= 0 || descSize > 64) return null;
  const descAt = offset + 12 + ((nameSize + 3) & ~3);
  const desc = reader.slice(descAt, descSize);
  return desc ? [...desc].map((b) => b.toString(16).padStart(2, "0")).join("") : null;
}

function describeGoBuildInfo(reader: ByteReader, offset: number, size: number): string {
  const magic = reader.slice(offset, Math.min(size, 32));
  if (!magic) return "present";
  if (magic[0] === 0xff && magic[1] === 0x00 && magic[2] === 0x47 && magic[3] === 0x6f) {
    return "Go 1.18+ buildinfo (\\xff Go buildinf:)";
  }
  if (magic[0] === 0xff && magic[1] === 0x47 && magic[2] === 0x6f) {
    return "Go 1.16/1.17 buildinfo";
  }
  return "present (unrecognised layout)";
}

function readSymbol(reader: ByteReader, bits: 32 | 64, little: boolean, at: number, strings: string[]): ElfSymbol | null {
  if (bits === 64) {
    if (!reader.has(at, 24)) return null;
    const nameIndex = reader.u32(at, little) ?? 0;
    const info = reader.u8(at + 4) ?? 0;
    const shndx = reader.u16(at + 6, little) ?? 0;
    return {
      name: strings[nameIndex] ?? "",
      value: Number(reader.u64(at + 8, little) ?? 0),
      size: Number(reader.u64(at + 16, little) ?? 0),
      type: SYMBOL_TYPES[info & 0xf] ?? "UNKNOWN",
      bind: SYMBOL_BINDS[info >> 4] ?? "UNKNOWN",
      shndx: shndx === 0 ? "UNDEF" : String(shndx),
    };
  }
  if (!reader.has(at, 16)) return null;
  const nameIndex = reader.u32(at, little) ?? 0;
  const info = reader.u8(at + 12) ?? 0;
  const shndx = reader.u16(at + 14, little) ?? 0;
  return {
    name: strings[nameIndex] ?? "",
    value: reader.u32(at + 4, little) ?? 0,
    size: reader.u32(at + 8, little) ?? 0,
    type: SYMBOL_TYPES[info & 0xf] ?? "UNKNOWN",
    bind: SYMBOL_BINDS[info >> 4] ?? "UNKNOWN",
    shndx: shndx === 0 ? "UNDEF" : String(shndx),
  };
}

function decodeSectionFlags(flags: number): string[] {
  const out: string[] = [];
  if (flags & 0x1) out.push("WRITE");
  if (flags & 0x2) out.push("ALLOC");
  if (flags & 0x4) out.push("EXECINSTR");
  if (flags & 0x10) out.push("MERGE");
  if (flags & 0x20) out.push("STRINGS");
  if (flags & 0x40) out.push("INFO_LINK");
  if (flags & 0x80) out.push("LINK_ORDER");
  if (flags & 0x200) out.push("GROUP");
  if (flags & 0x400) out.push("TLS");
  if (flags & 0x800) out.push("COMPRESSED");
  return out;
}

function decodePhFlags(flags: number): string {
  const out: string[] = [];
  if (flags & 1) out.push("X");
  if (flags & 2) out.push("W");
  if (flags & 4) out.push("R");
  return out.join("") || "-";
}
