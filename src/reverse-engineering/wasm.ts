/**
 * WebAssembly module parser.
 *
 * Reads the module's own description of its ABI boundary: sections, imports
 * (host functions the module expects), exports (what it offers), memory and
 * table counts, and the `name` custom section when the author did not strip it.
 * Every length is a LEB128 that is validated against the bytes that actually
 * follow, so a corrupt module cannot drive an allocation.
 */

import { ByteReader } from "./binary-reader.js";
import { shannonEntropyRange } from "./entropy.js";

export interface WasmImport {
  module: string;
  field: string;
  kind: "func" | "table" | "memory" | "global";
  /** Type index for functions, limits for memory, etc. */
  detail: string;
}

export interface WasmExport {
  name: string;
  kind: "func" | "table" | "memory" | "global";
  index: number;
}

export interface WasmSection {
  id: number;
  name: string;
  size: number;
  offset: number;
  entropy: number | null;
}

export interface WasmReport {
  ok: boolean;
  version: number;
  sections: WasmSection[];
  imports: WasmImport[];
  exports: WasmExport[];
  functionCount: number;
  codeCount: number;
  memoryCount: number;
  tableCount: number;
  globalCount: number;
  dataCount: number;
  startFunction: number | null;
  /** Names recovered from the `name` custom section (usually stripped). */
  functionNames: Array<{ index: number; name: string }>;
  moduleName: string | null;
  wasiImports: string[];
  warnings: string[];
  truncated: boolean;
}

const SECTION_NAMES: Record<number, string> = {
  0: "custom",
  1: "type",
  2: "import",
  3: "function",
  4: "table",
  5: "memory",
  6: "global",
  7: "export",
  8: "start",
  9: "element",
  10: "code",
  11: "data",
  12: "dataCount",
  13: "tag",
};

const MAX_SECTIONS = 512;
const MAX_ENTRIES = 4_096;
const MAX_NAMES = 4_096;

export function parseWasm(reader: ByteReader): WasmReport | null {
  const bytes = reader.bytes;
  if (bytes.byteLength < 8) return null;
  if (!(bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d)) return null;
  const version = reader.u32(4, true) ?? 0;
  const warnings: string[] = [];
  const report: WasmReport = {
    ok: true,
    version,
    sections: [],
    imports: [],
    exports: [],
    functionCount: 0,
    codeCount: 0,
    memoryCount: 0,
    tableCount: 0,
    globalCount: 0,
    dataCount: 0,
    startFunction: null,
    functionNames: [],
    moduleName: null,
    wasiImports: [],
    warnings,
    truncated: false,
  };

  let cursor = 8;
  for (let index = 0; index < MAX_SECTIONS && cursor < bytes.byteLength; index += 1) {
    const idByte = bytes[cursor]!;
    cursor += 1;
    const size = readLeb(bytes, cursor);
    if (!size) {
      report.truncated = true;
      warnings.push(`Section ${index} (${SECTION_NAMES[idByte] ?? idByte}) has an unterminated size.`);
      break;
    }
    cursor = size.next;
    const declared = Number(size.value);
    const payloadStart = cursor;
    const payloadEnd = Math.min(bytes.byteLength, cursor + declared);
    if (payloadEnd !== cursor + declared) {
      report.truncated = true;
      warnings.push(`Section ${index} (${SECTION_NAMES[idByte] ?? idByte}) declares ${declared} bytes but only ${payloadEnd - cursor} remain.`);
    }
    report.sections.push({
      id: idByte,
      name: SECTION_NAMES[idByte] ?? `0x${idByte.toString(16)}`,
      size: declared,
      offset: payloadStart,
      entropy: payloadEnd > payloadStart ? shannonEntropyRange(bytes, payloadStart, payloadEnd - payloadStart) : null,
    });

    const payload = bytes.subarray(payloadStart, payloadEnd);
    if (idByte === 2) parseImports(payload, report);
    else if (idByte === 7) parseExports(payload, report);
    else if (idByte === 3) report.functionCount = countLebVector(payload);
    else if (idByte === 10) report.codeCount = countLebVector(payload);
    else if (idByte === 5) report.memoryCount = countLebVector(payload);
    else if (idByte === 4) report.tableCount = countLebVector(payload);
    else if (idByte === 6) report.globalCount = countLebVector(payload);
    else if (idByte === 11) report.dataCount = countLebVector(payload);
    else if (idByte === 12) report.dataCount = Number(readLebValue(payload, 0) ?? 0);
    else if (idByte === 8) report.startFunction = Number(readLebValue(payload, 0) ?? 0);
    else if (idByte === 0) parseNameSection(payload, report);

    cursor = payloadEnd;
  }

  report.wasiImports = report.imports.filter((entry) => entry.module.startsWith("wasi_")).map((entry) => `${entry.module}.${entry.field}`);
  if (report.functionCount > 0 && report.codeCount === 0) {
    warnings.push("Function section present but no code section: this is a metadata-only or truncated module.");
  }
  return report;
}

function parseImports(payload: Uint8Array, report: WasmReport): void {
  let cursor = 0;
  const count = Number(readLebValue(payload, cursor) ?? 0);
  cursor = advanceLeb(payload, cursor);
  for (let i = 0; i < Math.min(count, MAX_ENTRIES); i += 1) {
    const moduleName = readWasmName(payload, cursor);
    if (!moduleName) break;
    cursor = moduleName.next;
    const fieldName = readWasmName(payload, cursor);
    if (!fieldName) break;
    cursor = fieldName.next;
    const kind = payload[cursor] ?? 0;
    cursor += 1;
    let detail = "";
    if (kind === 0) {
      const typeIndex = readLebValue(payload, cursor);
      if (!typeIndex) break;
      detail = `type #${typeIndex.value}`;
      cursor = typeIndex.next;
    } else if (kind === 1) {
      const table = readTableType(payload, cursor);
      detail = table.detail;
      cursor = table.next;
    } else if (kind === 2) {
      const limits = readLimits(payload, cursor);
      detail = limits.detail;
      cursor = limits.next;
    } else {
      const valueType = payload[cursor] ?? 0;
      const mutable = payload[cursor + 1] === 1;
      detail = `value=0x${valueType.toString(16)}${mutable ? " mutable" : ""}`;
      cursor += 2;
    }
    report.imports.push({ module: moduleName.value, field: fieldName.value, kind: (["func", "table", "memory", "global"] as const)[kind] ?? "func", detail });
  }
}

function parseExports(payload: Uint8Array, report: WasmReport): void {
  let cursor = 0;
  const count = Number(readLebValue(payload, cursor) ?? 0);
  cursor = advanceLeb(payload, cursor);
  for (let i = 0; i < Math.min(count, MAX_ENTRIES); i += 1) {
    const name = readWasmName(payload, cursor);
    if (!name) break;
    cursor = name.next;
    const kind = payload[cursor] ?? 0;
    const index = readLebValue(payload, cursor + 1);
    if (!index) break;
    cursor = index.next;
    report.exports.push({ name: name.value, kind: (["func", "table", "memory", "global"] as const)[kind] ?? "func", index: Number(index.value) });
  }
}

function parseNameSection(payload: Uint8Array, report: WasmReport): void {
  // The payload starts with the section name ("name"), then subsections.
  const name = readWasmName(payload, 0);
  if (!name || name.value !== "name") return;
  let cursor = name.next;
  while (cursor < payload.byteLength) {
    const subId = payload[cursor]!;
    cursor += 1;
    const size = readLebValue(payload, cursor);
    if (!size) break;
    cursor = size.next;
    const declared = Number(size.value);
    const body = payload.subarray(cursor, cursor + declared);
    if (subId === 0) {
      const moduleName = readWasmName(body, 0);
      if (moduleName) report.moduleName = moduleName.value;
    } else if (subId === 1) {
      const count = Number(readLebValue(body, 0) ?? 0);
      let at = advanceLeb(body, 0);
      for (let i = 0; i < Math.min(count, MAX_NAMES) && at < body.byteLength; i += 1) {
        const index = readLebValue(body, at);
        if (!index) break;
        at = index.next;
        const fnName = readWasmName(body, at);
        if (!fnName) break;
        at = fnName.next;
        report.functionNames.push({ index: Number(index.value), name: fnName.value });
      }
    }
    cursor += Number(size.value);
  }
}

function readTableType(payload: Uint8Array, cursor: number): { detail: string; next: number } {
  const valueType = payload[cursor] ?? 0;
  const limits = readLimits(payload, cursor + 1);
  return { detail: `elem=0x${valueType.toString(16)} ${limits.detail}`, next: limits.next };
}

function readLimits(payload: Uint8Array, cursor: number): { detail: string; next: number } {
  const flags = payload[cursor] ?? 0;
  const min = readLebValue(payload, cursor + 1);
  if (!min) return { detail: "limits (malformed)", next: cursor + 1 };
  if (flags & 0x01) {
    const max = readLebValue(payload, min.next);
    return { detail: `min=${min.value}${max ? ` max=${max.value}` : ""}`, next: max ? max.next : min.next };
  }
  return { detail: `min=${min.value}`, next: min.next };
}

function readWasmName(payload: Uint8Array, cursor: number): { value: string; next: number } | null {
  const length = readLebValue(payload, cursor);
  if (!length) return null;
  const start = length.next;
  const end = Math.min(payload.byteLength, start + Number(length.value));
  if (end !== start + Number(length.value)) return null;
  return { value: new TextDecoder("utf-8", { fatal: false }).decode(payload.subarray(start, end)), next: end };
}

function countLebVector(payload: Uint8Array): number {
  return Number(readLebValue(payload, 0) ?? 0);
}

function readLebValue(bytes: Uint8Array, offset: number): { value: bigint; next: number } | null {
  return readLeb(bytes, offset);
}

function advanceLeb(bytes: Uint8Array, offset: number): number {
  const read = readLeb(bytes, offset);
  return read ? read.next : offset + 1;
}

/** Unsigned LEB128, clamped so a corrupt value cannot loop forever. */
function readLeb(bytes: Uint8Array, offset: number): { value: bigint; next: number } | null {
  let result = 0n;
  let shift = 0n;
  let cursor = offset;
  for (let i = 0; i < 10 && cursor < bytes.byteLength; i += 1, cursor += 1) {
    const byte = bytes[cursor]!;
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if ((byte & 0x80) === 0) return { value: result, next: cursor + 1 };
  }
  return null;
}
