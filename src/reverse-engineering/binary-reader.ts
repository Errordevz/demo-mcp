/**
 * Bounded binary reader.
 *
 * Every deterministic parser in this capability goes through this class, and
 * every read is bounds-checked against the *actual* byte length. That is what
 * makes it safe to parse an untrusted artifact inside a Worker: a header that
 * claims a 4 GB section table simply yields `null` instead of a crash or an
 * allocation, and a truncated file produces a partial parse plus a warning
 * rather than a thrown exception.
 */

export class ByteReader {
  readonly bytes: Uint8Array;
  private readonly view: DataView;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  /** True when `[offset, offset + size)` lies inside the buffer. */
  has(offset: number, size: number): boolean {
    return Number.isFinite(offset) && offset >= 0 && size >= 0 && offset + size <= this.length;
  }

  u8(offset: number): number | null {
    if (!this.has(offset, 1)) return null;
    return this.view.getUint8(offset);
  }

  i8(offset: number): number | null {
    if (!this.has(offset, 1)) return null;
    return this.view.getInt8(offset);
  }

  u16(offset: number, little: boolean): number | null {
    if (!this.has(offset, 2)) return null;
    return this.view.getUint16(offset, little);
  }

  i16(offset: number, little: boolean): number | null {
    if (!this.has(offset, 2)) return null;
    return this.view.getInt16(offset, little);
  }

  u32(offset: number, little: boolean): number | null {
    if (!this.has(offset, 4)) return null;
    return this.view.getUint32(offset, little);
  }

  i32(offset: number, little: boolean): number | null {
    if (!this.has(offset, 4)) return null;
    return this.view.getInt32(offset, little);
  }

  u64(offset: number, little: boolean): number | null {
    if (!this.has(offset, 8)) return null;
    const value = this.view.getBigUint64(offset, little);
    // Above 2^53 a JS number is no longer exact; report it as a string so the
    // report never silently rounds an address.
    return Number(value > 9007199254740991n ? value.toString() : value);
  }

  /** Raw bytes (copied) or null when out of range. */
  slice(offset: number, size: number): Uint8Array | null {
    if (!this.has(offset, size)) return null;
    return this.bytes.slice(offset, offset + size);
  }

  /** NUL-terminated ASCII/UTF-8 string starting at `offset`. */
  cString(offset: number, max = 512): string | null {
    if (offset < 0 || offset >= this.length) return null;
    let end = offset;
    const limit = Math.min(this.length, offset + max);
    while (end < limit && this.bytes[end] !== 0) end += 1;
    if (end >= limit && this.bytes[end] !== 0) return null;
    return new TextDecoder("utf-8", { fatal: false }).decode(this.bytes.subarray(offset, end));
  }

  /** Fixed-length ASCII/UTF-8 string. */
  fixedString(offset: number, size: number): string | null {
    const raw = this.slice(offset, size);
    if (!raw) return null;
    return new TextDecoder("utf-8", { fatal: false }).decode(raw);
  }

  hex(offset: number, size: number): string | null {
    const raw = this.slice(offset, size);
    if (!raw) return null;
    return [...raw].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  }
}

/** Lowercase hex of a byte range. */
export function toHex(bytes: Uint8Array, separator = ""): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(separator);
}

/** Parse a decimal or `0x`-prefixed integer the way the upstream validate_struct.py does. */
export function parseCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const parsed = /^0[xX][0-9a-fA-F]+$/.test(text) ? Number.parseInt(text.slice(2), 16) : Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
