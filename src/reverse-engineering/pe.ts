/**
 * PE/COFF parser (including .NET assemblies).
 *
 * Header, optional header, data directories, section table, exports, imports
 * and the CodeView debug entry (which usually leaks the original PDB path — a
 * strong `observed` toolchain signal). RVA→file-offset conversion is derived
 * from the section table, never assumed.
 */

import { ByteReader } from "./binary-reader.js";
import { shannonEntropyRange } from "./entropy.js";

export interface PeSection {
  name: string;
  virtualAddress: number;
  virtualSize: number;
  rawOffset: number;
  rawSize: number;
  characteristics: string[];
  entropy: number | null;
}

export interface PeExport {
  ordinal: number;
  rva: number;
  name: string | null;
}

export interface PeImport {
  dll: string;
  functions: string[];
}

export interface PeReport {
  ok: boolean;
  machine: string;
  bits: 32 | 64;
  subsystem: string;
  dllCharacteristics: string[];
  characteristics: string[];
  timestamp: string | null;
  linkerVersion: string;
  entryPoint: number;
  imageBase: number;
  sections: PeSection[];
  exports: PeExport[];
  exportName: string | null;
  imports: PeImport[];
  pdbPath: string | null;
  isDotNet: boolean;
  dotnetRuntime: string | null;
  dotnetMetadataStreams: string[];
  warnings: string[];
  truncated: boolean;
}

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

const SUBSYSTEMS: Record<number, string> = {
  0: "UNKNOWN",
  1: "NATIVE",
  2: "WINDOWS_GUI",
  3: "WINDOWS_CUI",
  5: "OS2_CUI",
  7: "POSIX_CUI",
  9: "WINDOWS_CE_GUI",
  10: "EFI_APPLICATION",
  11: "EFI_BOOT_SERVICE_DRIVER",
  12: "EFI_RUNTIME_DRIVER",
  13: "EFI_ROM",
  14: "XBOX",
  16: "WINDOWS_BOOT_APPLICATION",
};

const SECTION_CHARACTERISTICS: ReadonlyArray<readonly [number, string]> = [
  [0x00000020, "CODE"],
  [0x00000040, "INITIALIZED_DATA"],
  [0x00000080, "UNINITIALIZED_DATA"],
  [0x02000000, "DISCARDABLE"],
  [0x04000000, "NOT_CACHED"],
  [0x08000000, "NOT_PAGED"],
  [0x10000000, "SHARED"],
  [0x20000000, "EXECUTE"],
  [0x40000000, "READ"],
  [0x80000000, "WRITE"],
];

const DLL_CHARACTERISTICS: ReadonlyArray<readonly [number, string]> = [
  [0x0020, "HIGH_ENTROPY_VA"],
  [0x0040, "DYNAMIC_BASE (ASLR)"],
  [0x0080, "FORCE_INTEGRITY"],
  [0x0100, "NX_COMPAT"],
  [0x0200, "NO_ISOLATION"],
  [0x0400, "NO_SEH"],
  [0x0800, "NO_BIND"],
  [0x1000, "APPCONTAINER"],
  [0x2000, "WDM_DRIVER"],
  [0x4000, "GUARD_CF"],
  [0x8000, "TERMINAL_SERVER_AWARE"],
];

const MAX_SECTIONS = 256;
const MAX_EXPORTS = 4_096;
const MAX_IMPORT_DLLS = 256;
const MAX_IMPORT_FUNCTIONS = 2_048;

export function parsePe(reader: ByteReader): PeReport | null {
  const bytes = reader.bytes;
  if (bytes.byteLength < 64) return null;
  if (!(bytes[0] === 0x4d && bytes[1] === 0x5a)) return null;
  const peOffset = reader.u32(0x3c, true);
  if (peOffset === null || !reader.has(peOffset, 24)) return null;
  if (!(bytes[peOffset] === 0x50 && bytes[peOffset + 1] === 0x45 && bytes[peOffset + 2] === 0 && bytes[peOffset + 3] === 0)) return null;

  const warnings: string[] = [];
  const coff = peOffset + 4;
  const machine = reader.u16(coff, true) ?? 0;
  const numberOfSections = reader.u16(coff + 2, true) ?? 0;
  const timestamp = reader.u32(coff + 4, true) ?? 0;
  const sizeOfOptional = reader.u16(coff + 16, true) ?? 0;
  const characteristics = reader.u16(coff + 18, true) ?? 0;

  const optional = coff + 20;
  const magic = reader.u16(optional, true);
  if (magic !== 0x10b && magic !== 0x20b) return null;
  const bits: 32 | 64 = magic === 0x20b ? 64 : 32;
  const pe32Plus = bits === 64;

  const majorLinker = reader.u8(optional + 2) ?? 0;
  const minorLinker = reader.u8(optional + 3) ?? 0;
  const entryPoint = reader.u32(optional + 16, true) ?? 0;
  const imageBase = pe32Plus ? Number(reader.u64(optional + 24, true) ?? 0) : (reader.u32(optional + 28, true) ?? 0);
  const subsystem = reader.u16(optional + 68, true) ?? 0;
  const dllCharacteristics = reader.u16(optional + 70, true) ?? 0;
  const numberOfRva = reader.u32(optional + (pe32Plus ? 108 : 92), true) ?? 0;
  const dataDirOffset = optional + (pe32Plus ? 112 : 96);

  const directory = (index: number): { rva: number; size: number } | null => {
    const at = dataDirOffset + index * 8;
    if (!reader.has(at, 8)) return null;
    const value = reader.u32(at, true) ?? 0;
    const size = reader.u32(at + 4, true) ?? 0;
    return value === 0 ? null : { rva: value, size };
  };

  const report: PeReport = {
    ok: true,
    machine: PE_MACHINES[machine] ?? `0x${machine.toString(16)}`,
    bits,
    subsystem: SUBSYSTEMS[subsystem] ?? `0x${subsystem.toString(16)}`,
    dllCharacteristics: decodeFlags(dllCharacteristics, DLL_CHARACTERISTICS),
    characteristics: decodeCharacteristics(characteristics),
    timestamp: timestamp ? new Date(timestamp * 1000).toISOString() : null,
    linkerVersion: `${majorLinker}.${minorLinker}`,
    entryPoint,
    imageBase,
    sections: [],
    exports: [],
    exportName: null,
    imports: [],
    pdbPath: null,
    isDotNet: false,
    dotnetRuntime: null,
    dotnetMetadataStreams: [],
    warnings,
    truncated: false,
  };

  /* ------------------------------------------------------------- sections -- */
  const sectionTable = optional + sizeOfOptional;
  const count = Math.min(numberOfSections, MAX_SECTIONS);
  for (let i = 0; i < count; i += 1) {
    const at = sectionTable + i * 40;
    if (!reader.has(at, 40)) {
      report.truncated = true;
      warnings.push(`Section table truncated at index ${i} of ${numberOfSections}.`);
      break;
    }
    const rawName = reader.slice(at, 8) ?? new Uint8Array(8);
    const name = new TextDecoder("utf-8", { fatal: false }).decode(rawName).replace(/\0+$/, "");
    const virtualSize = reader.u32(at + 8, true) ?? 0;
    const virtualAddress = reader.u32(at + 12, true) ?? 0;
    const rawSize = reader.u32(at + 16, true) ?? 0;
    const rawOffset = reader.u32(at + 20, true) ?? 0;
    const sectionCharacteristics = reader.u32(at + 36, true) ?? 0;
    const entropy = rawSize > 0 && reader.has(rawOffset, rawSize) ? shannonEntropyRange(bytes, rawOffset, rawSize) : null;
    report.sections.push({
      name: name || `<section ${i}>`,
      virtualAddress,
      virtualSize,
      rawOffset,
      rawSize,
      characteristics: decodeFlags(sectionCharacteristics, SECTION_CHARACTERISTICS),
      entropy,
    });
  }

  const toOffset = (value: number): number | null => {
    for (const section of report.sections) {
      const span = Math.max(section.virtualSize, section.rawSize);
      if (span > 0 && value >= section.virtualAddress && value < section.virtualAddress + span) {
        const delta = value - section.virtualAddress;
        return delta < section.rawSize ? section.rawOffset + delta : null;
      }
    }
    return value < bytes.byteLength ? value : null;
  };

  /* -------------------------------------------------------------- exports -- */
  const exportDir = directory(0);
  if (exportDir) {
    const at = toOffset(exportDir.rva);
    if (at !== null && reader.has(at, 40)) {
      const nameRva = reader.u32(at + 12, true) ?? 0;
      const ordinalBase = reader.u32(at + 16, true) ?? 0;
      const numberOfFunctions = reader.u32(at + 20, true) ?? 0;
      const numberOfNames = reader.u32(at + 24, true) ?? 0;
      const addressOfFunctions = reader.u32(at + 28, true) ?? 0;
      const addressOfNames = reader.u32(at + 32, true) ?? 0;
      const nameAt = nameRva ? toOffset(nameRva) : null;
      report.exportName = nameAt === null ? null : reader.cString(nameAt, 256);
      const functionsAt = toOffset(addressOfFunctions);
      if (functionsAt !== null) {
        const total = Math.min(numberOfFunctions, MAX_EXPORTS);
        for (let i = 0; i < total; i += 1) {
          const fnRva = reader.u32(functionsAt + i * 4, true);
          if (fnRva === null || fnRva === 0) continue;
          report.exports.push({ ordinal: ordinalBase + i, rva: fnRva, name: null });
        }
      }
      const namesAt = toOffset(addressOfNames);
      if (namesAt !== null) {
        const total = Math.min(numberOfNames, MAX_EXPORTS);
        for (let i = 0; i < total; i += 1) {
          const namePtr = reader.u32(namesAt + i * 4, true);
          if (namePtr === null) continue;
          const nameOffset = toOffset(namePtr);
          const name = nameOffset === null ? null : reader.cString(nameOffset, 512);
          if (!name) continue;
          const ordinalIndex = reader.u16(namesAt + numberOfNames * 4 + i * 2, true) ?? i;
          const target = report.exports.find((entry) => entry.ordinal === ordinalBase + ordinalIndex);
          if (target) target.name = name;
        }
      }
    }
  }

  /* -------------------------------------------------------------- imports -- */
  const importDir = directory(1);
  if (importDir) {
    let at = toOffset(importDir.rva);
    for (let dll = 0; dll < MAX_IMPORT_DLLS && at !== null && reader.has(at, 20); dll += 1) {
      const originalFirstThunk = reader.u32(at, true) ?? 0;
      const nameRva = reader.u32(at + 12, true) ?? 0;
      const firstThunk = reader.u32(at + 16, true) ?? 0;
      if (originalFirstThunk === 0 && nameRva === 0 && firstThunk === 0) break;
      const nameAt = toOffset(nameRva);
      const dllName = nameAt === null ? `<dll ${dll}>` : (reader.cString(nameAt, 128) ?? `<dll ${dll}>`);
      const thunkAt = toOffset(originalFirstThunk || firstThunk);
      const functions: string[] = [];
      if (thunkAt !== null) {
        const step = pe32Plus ? 8 : 4;
        for (let i = 0; i < MAX_IMPORT_FUNCTIONS && reader.has(thunkAt + i * step, step); i += 1) {
          const value = pe32Plus ? Number(reader.u64(thunkAt + i * step, true) ?? 0) : (reader.u32(thunkAt + i * step, true) ?? 0);
          if (value === 0) break;
          const ordinalFlag = pe32Plus ? value >= 0x8000000000000000 : (value & 0x80000000) !== 0;
          if (ordinalFlag) {
            functions.push(`ordinal:${value & 0xffff}`);
            continue;
          }
          const hintAt = toOffset(value);
          functions.push(hintAt === null ? `rva:0x${value.toString(16)}` : (reader.cString(hintAt + 2, 256) ?? `rva:0x${value.toString(16)}`));
        }
      }
      report.imports.push({ dll: dllName, functions });
      at += 20;
    }
  }

  /* ---------------------------------------------------------------- debug -- */
  const debugDir = directory(6);
  if (debugDir) {
    const at = toOffset(debugDir.rva);
    const entries = Math.min(Math.floor(debugDir.size / 28), 16);
    for (let i = 0; i < entries && at !== null && reader.has(at + i * 28, 28); i += 1) {
      const entry = at + i * 28;
      const type = reader.u32(entry + 12, true) ?? 0;
      const sizeOfData = reader.u32(entry + 16, true) ?? 0;
      const rawPointer = reader.u32(entry + 24, true) ?? 0;
      if (type !== 2 || sizeOfData <= 0) continue;
      const head = reader.slice(rawPointer, Math.min(sizeOfData, 512));
      if (!head) continue;
      // CodeView: 'RSDS' + GUID(16) + age(4) + PDB path.
      if (head[0] === 0x52 && head[1] === 0x53 && head[2] === 0x44 && head[3] === 0x53) {
        let end = 24;
        while (end < head.byteLength && head[end] !== 0) end += 1;
        report.pdbPath = new TextDecoder("utf-8", { fatal: false }).decode(head.subarray(24, end));
      } else if (head[0] === 0x4e && head[1] === 0x42 && head[2] === 0x31 && head[3] === 0x30) {
        let end = 4;
        while (end < head.byteLength && head[end] !== 0) end += 1;
        report.pdbPath = new TextDecoder("utf-8", { fatal: false }).decode(head.subarray(4, end));
      }
    }
  }

  /* ---------------------------------------------------------------- .NET --- */
  const clr = directory(14);
  if (clr) {
    report.isDotNet = true;
    const at = toOffset(clr.rva);
    if (at !== null && reader.has(at, 72)) {
      const major = reader.u16(at + 4, true) ?? 0;
      const minor = reader.u16(at + 6, true) ?? 0;
      const metadataRva = reader.u32(at + 8, true) ?? 0;
      report.dotnetRuntime = `${major}.${minor}`;
      const metaAt = toOffset(metadataRva);
      if (metaAt !== null && reader.has(metaAt, 32)) {
        const versionLength = reader.u32(metaAt + 12, true) ?? 0;
        const streams = reader.u16(metaAt + 20, true) ?? 0;
        if (versionLength > 0 && versionLength < 256) {
          const version = reader.fixedString(metaAt + 16, versionLength);
          if (version) report.dotnetMetadataStreams.push(`version:${version.replace(/\0+$/, "")}`);
        }
        const streamTable = metaAt + 16 + versionLength;
        for (let i = 0; i < Math.min(streams, 16) && reader.has(streamTable + i * 8, 8); i += 1) {
          const streamOffset = reader.u32(streamTable + i * 8, true) ?? 0;
          const streamSize = reader.u32(streamTable + i * 8 + 4, true) ?? 0;
          const name = reader.cString(streamTable + streams * 8 + i * 8, 32);
          if (name) report.dotnetMetadataStreams.push(`${name}@0x${streamOffset.toString(16)}+${streamSize}`);
        }
      }
    }
  }

  if (numberOfRva > 16) warnings.push(`NumberOfRvaAndSizes=${numberOfRva} exceeds the 16 documented directories.`);

  return report;
}

function decodeFlags(value: number, table: ReadonlyArray<readonly [number, string]>): string[] {
  const out: string[] = [];
  for (const [mask, label] of table) {
    if ((value & mask) === mask) out.push(label);
  }
  return out;
}

function decodeCharacteristics(value: number): string[] {
  const out: string[] = [];
  if (value & 0x0001) out.push("RELOCS_STRIPPED");
  if (value & 0x0002) out.push("EXECUTABLE_IMAGE");
  if (value & 0x0020) out.push("LARGE_ADDRESS_AWARE");
  if (value & 0x0100) out.push("32BIT_MACHINE");
  if (value & 0x1000) out.push("SYSTEM");
  if (value & 0x2000) out.push("DLL");
  if (value & 0x4000) out.push("UP_SYSTEM_ONLY");
  return out;
}
