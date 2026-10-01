/**
 * Entropy, checksums and byte statistics — computed by code, never estimated.
 *
 * This is a direct port of the philosophy (and the arithmetic) of
 * `PyModel/reverse-engineering-skill/scripts/calculate_entropy.py` and
 * `scripts/triage_binary.py`: Shannon entropy is measured, section boundaries
 * come from the parsed container, and the >7.0 bits/byte threshold is applied
 * by the code so a model can never "round" it into a conclusion.
 */

import type { ByteReader } from "./binary-reader.js";

export interface EntropyBlock {
  offset: number;
  size: number;
  entropy: number;
}

/** Shannon entropy in bits per byte over the whole buffer. */
export function shannonEntropy(bytes: Uint8Array): number {
  return shannonEntropyRange(bytes, 0, bytes.byteLength);
}

export function shannonEntropyRange(bytes: Uint8Array, offset: number, size: number): number {
  if (size <= 0) return 0;
  const counts = new Float64Array(256);
  const end = Math.min(bytes.byteLength, offset + size);
  let total = 0;
  for (let i = Math.max(0, offset); i < end; i += 1) {
    counts[bytes[i]!] += 1;
    total += 1;
  }
  if (total === 0) return 0;
  let entropy = 0;
  for (let i = 0; i < 256; i += 1) {
    const count = counts[i]!;
    if (count > 0) {
      const p = count / total;
      entropy -= p * Math.log2(p);
    }
  }
  return Math.round(entropy * 1000) / 1000;
}

/** Block entropy over fixed-size windows (the unknown-format fallback path). */
export function blockEntropy(bytes: Uint8Array, blockSize = 4096, maxBlocks = 256): EntropyBlock[] {
  const out: EntropyBlock[] = [];
  for (let offset = 0, index = 0; offset < bytes.byteLength && index < maxBlocks; offset += blockSize, index += 1) {
    const size = Math.min(blockSize, bytes.byteLength - offset);
    out.push({ offset, size, entropy: shannonEntropyRange(bytes, offset, size) });
  }
  return out;
}

/** Classification used by the triage report. Thresholds are the upstream ones. */
export function classifyEntropy(entropy: number): "empty" | "low" | "normal" | "high" | "packed-or-encrypted" {
  if (entropy <= 0) return "empty";
  if (entropy < 1.5) return "low";
  if (entropy < 6.5) return "normal";
  if (entropy <= 7.0) return "high";
  return "packed-or-encrypted";
}

export const ENTROPY_PACKED_THRESHOLD = 7.0;

/* ------------------------------------------------------------------ CRC/etc */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3, the zlib/gzip polynomial). */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.byteLength; i += 1) crc = (CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

/** CRC-32C (Castagnoli). */
export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    crc ^= bytes[i]!;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** CRC-16/CCITT-FALSE. */
export function crc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    crc ^= bytes[i]! << 8;
    for (let k = 0; k < 8; k += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc & 0xffff;
}

/** Adler-32 (zlib). */
export function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Simple XOR fold of the whole range (a very common "checksum" in homebrew protocols). */
export function xor8(bytes: Uint8Array): number {
  let value = 0;
  for (let i = 0; i < bytes.byteLength; i += 1) value ^= bytes[i]!;
  return value & 0xff;
}

/** 16-bit one's-complement sum (IP checksum family). */
/** Internet checksum (RFC 1071) as a 16-bit one's-complement sum. */
export function sum16(bytes: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i + 1 < bytes.byteLength; i += 2) sum += (bytes[i]! << 8) | bytes[i + 1]!;
  if (bytes.byteLength % 2 === 1) sum += bytes[bytes.byteLength - 1]! << 8;
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return (~sum) & 0xffff;
}

/* ------------------------------------------------------- byte statistics ---- */

export interface ByteStats {
  size: number;
  distinctBytes: number;
  printableRatio: number;
  nullRatio: number;
  highRatio: number;
}

/** Statistics used for string-encryption and packing heuristics. */
export function byteStats(bytes: Uint8Array): ByteStats {
  const counts = new Uint32Array(256);
  for (let i = 0; i < bytes.byteLength; i += 1) counts[bytes[i]!] += 1;
  let printable = 0;
  let nulls = 0;
  let high = 0;
  for (let i = 0; i < 256; i += 1) {
    if (i === 0) nulls = counts[i]!;
    else if (i >= 0x80) high += counts[i]!;
    if (i >= 0x20 && i < 0x7f) printable += counts[i]!;
  }
  const size = bytes.byteLength || 1;
  let distinct = 0;
  for (let i = 0; i < 256; i += 1) if (counts[i]! > 0) distinct += 1;
  return {
    size: bytes.byteLength,
    distinctBytes: distinct,
    printableRatio: Math.round((printable / size) * 1000) / 1000,
    nullRatio: Math.round((nulls / size) * 1000) / 1000,
    highRatio: Math.round((high / size) * 1000) / 1000,
  };
}

/** Fraction of bytes that decode as printable ASCII — the XOR-key score. */
export function printableRatio(bytes: Uint8Array): number {
  if (bytes.byteLength === 0) return 0;
  let printable = 0;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    const b = bytes[i]!;
    if ((b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d) printable += 1;
  }
  return printable / bytes.byteLength;
}

/**
 * Characters that survive in real text: letters, digits, space and the
 * punctuation that actually appears in identifiers, paths and sentences. XOR-ing
 * one ASCII string with another ASCII byte frequently yields *printable* output,
 * so printability alone is far too weak a signal — this set is what separates a
 * real decode from a coincidentally-printable one.
 */
function isTextual(value: number): boolean {
  return (
    (value >= 0x30 && value <= 0x39) || // 0-9
    (value >= 0x41 && value <= 0x5a) || // A-Z
    (value >= 0x61 && value <= 0x7a) || // a-z
    value === 0x20 ||
    value === 0x09 ||
    value === 0x0a ||
    value === 0x0d ||
    value === 0x2e || // .
    value === 0x2c || // ,
    value === 0x3a || // :
    value === 0x3b || // ;
    value === 0x2d || // -
    value === 0x5f || // _
    value === 0x2f || // /
    value === 0x5c || // \
    value === 0x28 || // (
    value === 0x29 || // )
    value === 0x27 // '
  );
}

/**
 * Brute-force single-byte XOR keys over a bounded window and score each by how
 * text-like the decode is. Deterministic: the answer is the argmax (lowest key
 * wins a tie), and the score is reported so a model can judge whether it is
 * convincing. A score below ~0.8 means the hypothesis is weak, not proven.
 */
export function bestXorKey(bytes: Uint8Array, maxWindow = 4096): { key: number; score: number; preview: string } {
  const window = bytes.subarray(0, Math.min(bytes.byteLength, maxWindow));
  let best = { key: 0, score: -1, preview: "" };
  for (let key = 1; key < 256; key += 1) {
    const decoded = new Uint8Array(Math.min(window.byteLength, 96));
    let printable = 0;
    let textual = 0;
    for (let i = 0; i < window.byteLength; i += 1) {
      const value = window[i]! ^ key;
      if ((value >= 0x20 && value < 0x7f) || value === 0x09 || value === 0x0a || value === 0x0d) printable += 1;
      if (isTextual(value)) textual += 1;
      if (i < decoded.byteLength) decoded[i] = value;
    }
    if (window.byteLength === 0) return { key: 0, score: 0, preview: "" };
    const score = (printable / window.byteLength) * 0.35 + (textual / window.byteLength) * 0.65;
    if (score > best.score) best = { key, score: Math.round(score * 1000) / 1000, preview: new TextDecoder("utf-8", { fatal: false }).decode(decoded) };
  }
  return best;
}

/** Hexdump helper (bounded) used by every targeted-inspection tool. */
export function hexdump(reader: ByteReader, offset: number, size: number): string[] {
  const lines: string[] = [];
  const end = Math.min(reader.length, offset + size);
  for (let start = Math.max(0, offset); start < end; start += 16) {
    const row = reader.bytes.subarray(start, Math.min(start + 16, end));
    const hex = [...row].map((b) => b.toString(16).padStart(2, "0")).join(" ").padEnd(47, " ");
    const ascii = [...row].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${start.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  return lines;
}
