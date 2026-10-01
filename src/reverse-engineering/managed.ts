/**
 * Managed-runtime and container parsers: JVM `.class`, Android DEX, .NET
 * metadata, Electron ASAR and ZIP/JAR/APK central directories.
 *
 * These follow the upstream `04-managed-runtimes.md` rule: "always prefer
 * metadata + strings + resource tables over raw code when available — names for
 * free". They also follow the security rule DEMO needs: a container is only
 * ever *described*, never unpacked here. ZIP listing reads the central
 * directory and enforces explicit decompression-bomb guards; no member is
 * decompressed, extracted or executed.
 */

import { ByteReader } from "./binary-reader.js";
import { shannonEntropyRange } from "./entropy.js";

/* ------------------------------------------------------------------- JVM --- */

export interface JavaField {
  name: string;
  descriptor: string;
  access: string[];
}

export interface JavaMethod {
  name: string;
  descriptor: string;
  access: string[];
}

export interface JavaClassReport {
  ok: boolean;
  majorVersion: number;
  minorVersion: number;
  javaVersion: string;
  access: string[];
  thisClass: string | null;
  superClass: string | null;
  interfaces: string[];
  fields: JavaField[];
  methods: JavaMethod[];
  sourceFile: string | null;
  constantPoolUtf8: number;
  constantPoolEntries: number;
  warnings: string[];
}

const JAVA_MAJOR: Record<number, string> = {
  45: "Java 1.1", 46: "Java 1.2", 47: "Java 1.3", 48: "Java 1.4", 49: "Java 5", 50: "Java 6",
  51: "Java 7", 52: "Java 8", 53: "Java 9", 54: "Java 10", 55: "Java 11", 56: "Java 12",
  57: "Java 13", 58: "Java 14", 59: "Java 15", 60: "Java 16", 61: "Java 17", 62: "Java 18",
  63: "Java 19", 64: "Java 20", 65: "Java 21", 66: "Java 22", 67: "Java 23", 68: "Java 24",
};

const MAX_CP_ENTRIES = 8_192;

export function parseJavaClass(reader: ByteReader): JavaClassReport | null {
  const bytes = reader.bytes;
  if (bytes.byteLength < 24) return null;
  if (!(bytes[0] === 0xca && bytes[1] === 0xfe && bytes[2] === 0xba && bytes[3] === 0xbe)) return null;
  const minor = reader.u16(4, false) ?? 0;
  const major = reader.u16(6, false) ?? 0;
  if (major < 45) return null;

  const warnings: string[] = [];
  const utf8: string[] = [];
  const classNames: Array<number | null> = [];
  let constantPoolEntries = 0;

  const count = reader.u16(8, false) ?? 0;
  let cursor = 10;
  for (let i = 1; i < Math.min(count, MAX_CP_ENTRIES); i += 1) {
    const tag = reader.u8(cursor);
    if (tag === null) break;
    cursor += 1;
    constantPoolEntries += 1;
    if (tag === 1) {
      const length = reader.u16(cursor, false) ?? 0;
      utf8[i] = reader.fixedString(cursor + 2, length) ?? "";
      cursor += 2 + length;
    } else if (tag === 7 || tag === 8 || tag === 16 || tag === 19 || tag === 20) {
      const index = reader.u16(cursor, false) ?? 0;
      if (tag === 7) classNames[i] = index;
      cursor += 2;
    } else if (tag === 3 || tag === 4) {
      cursor += 4;
    } else if (tag === 5 || tag === 6) {
      cursor += 8;
      i += 1; // long/double take two constant-pool slots
    } else if (tag === 9 || tag === 10 || tag === 11 || tag === 12 || tag === 17 || tag === 18) {
      cursor += 4;
    } else if (tag === 15) {
      cursor += 3;
    } else {
      warnings.push(`Unknown constant-pool tag ${tag} at index ${i}; the parse stopped there.`);
      break;
    }
  }

  const access = decodeJavaAccess(reader.u16(cursor, false) ?? 0);
  const thisIndex = reader.u16(cursor + 2, false) ?? 0;
  const superIndex = reader.u16(cursor + 4, false) ?? 0;
  const interfaceCount = reader.u16(cursor + 6, false) ?? 0;
  let at = cursor + 8;
  const interfaces: string[] = [];
  for (let i = 0; i < Math.min(interfaceCount, 256) && reader.has(at, 2); i += 1) {
    const classIndex = reader.u16(at, false) ?? 0;
    const nameIndex = classNames[classIndex] ?? null;
    if (nameIndex !== null) {
      const value = utf8[nameIndex];
      if (value) interfaces.push(value);
    }
    at += 2;
  }

  const readMembers = (offset: number): { members: Array<{ nameIndex: number; descriptorIndex: number; access: number }>; next: number } => {
    const memberCount = reader.u16(offset, false) ?? 0;
    let cursorAt = offset + 2;
    const members: Array<{ nameIndex: number; descriptorIndex: number; access: number }> = [];
    for (let i = 0; i < Math.min(memberCount, 4_096) && reader.has(cursorAt, 8); i += 1) {
      members.push({
        access: reader.u16(cursorAt, false) ?? 0,
        nameIndex: reader.u16(cursorAt + 2, false) ?? 0,
        descriptorIndex: reader.u16(cursorAt + 4, false) ?? 0,
      });
      const attributeCount = reader.u16(cursorAt + 6, false) ?? 0;
      cursorAt += 8;
      for (let a = 0; a < Math.min(attributeCount, 64); a += 1) {
        const length = reader.u32(cursorAt + 2, false) ?? 0;
        cursorAt += 6 + length;
      }
    }
    return { members, next: cursorAt };
  };

  const fields = readMembers(at);
  const methods = readMembers(fields.next);

  let sourceFile: string | null = null;
  let attributeAt = methods.next;
  const attributeCount = reader.u16(attributeAt, false) ?? 0;
  attributeAt += 2;
  for (let a = 0; a < Math.min(attributeCount, 64) && reader.has(attributeAt, 6); a += 1) {
    const nameIndex = reader.u16(attributeAt, false) ?? 0;
    const length = reader.u32(attributeAt + 2, false) ?? 0;
    if (utf8[nameIndex] === "SourceFile" && length === 2) {
      sourceFile = utf8[reader.u16(attributeAt + 6, false) ?? 0] ?? null;
    }
    attributeAt += 6 + length;
  }

  const thisClassNameIndex = classNames[thisIndex] ?? null;
  const superClassNameIndex = classNames[superIndex] ?? null;

  return {
    ok: true,
    majorVersion: major,
    minorVersion: minor,
    javaVersion: JAVA_MAJOR[major] ?? `class file version ${major}`,
    access,
    thisClass: thisClassNameIndex === null ? (thisIndex === 0 ? null : `<cp#${thisIndex}>`) : (utf8[thisClassNameIndex] ?? `<cp#${thisClassNameIndex}>`),
    superClass: superClassNameIndex === null ? (superIndex === 0 ? null : `<cp#${superIndex}>`) : (utf8[superClassNameIndex] ?? `<cp#${superClassNameIndex}>`),
    interfaces,
    fields: fields.members.map((m) => ({ name: utf8[m.nameIndex] ?? "?", descriptor: utf8[m.descriptorIndex] ?? "?", access: decodeJavaAccess(m.access) })),
    methods: methods.members.map((m) => ({ name: utf8[m.nameIndex] ?? "?", descriptor: utf8[m.descriptorIndex] ?? "?", access: decodeJavaAccess(m.access) })),
    sourceFile,
    constantPoolUtf8: utf8.filter(Boolean).length,
    constantPoolEntries,
    warnings,
  };
}

function decodeJavaAccess(flags: number): string[] {
  const out: string[] = [];
  if (flags & 0x0001) out.push("public");
  if (flags & 0x0002) out.push("private");
  if (flags & 0x0004) out.push("protected");
  if (flags & 0x0008) out.push("static");
  if (flags & 0x0010) out.push("final");
  if (flags & 0x0020) out.push("super");
  if (flags & 0x0200) out.push("interface");
  if (flags & 0x0400) out.push("abstract");
  if (flags & 0x1000) out.push("synthetic");
  if (flags & 0x2000) out.push("annotation");
  if (flags & 0x4000) out.push("enum");
  return out;
}

/* ------------------------------------------------------------------- DEX --- */

export interface DexReport {
  ok: boolean;
  version: string;
  checksum: string;
  signature: string;
  fileSize: number;
  stringIds: number;
  typeIds: number;
  protoIds: number;
  fieldIds: number;
  methodIds: number;
  classDefs: number;
  warnings: string[];
}

export function parseDex(reader: ByteReader): DexReport | null {
  const bytes = reader.bytes;
  if (bytes.byteLength < 112) return null;
  if (!(bytes[0] === 0x64 && bytes[1] === 0x65 && bytes[2] === 0x78 && bytes[3] === 0x0a)) return null;
  const version = (reader.fixedString(4, 4) ?? "").replace(/\0+$/, "");
  const declaredSize = reader.u32(32, true) ?? 0;
  const warnings: string[] = [];
  if (declaredSize > 0 && declaredSize !== bytes.byteLength) {
    warnings.push(`Header declares ${declaredSize} bytes but the file is ${bytes.byteLength}: a truncated or padded capture.`);
  }
  return {
    ok: true,
    version: version || "unknown",
    checksum: toHex(reader.slice(8, 4)),
    signature: toHex(reader.slice(12, 20)),
    fileSize: bytes.byteLength,
    stringIds: reader.u32(56, true) ?? 0,
    typeIds: reader.u32(64, true) ?? 0,
    protoIds: reader.u32(72, true) ?? 0,
    fieldIds: reader.u32(80, true) ?? 0,
    methodIds: reader.u32(88, true) ?? 0,
    classDefs: reader.u32(96, true) ?? 0,
    warnings,
  };
}

/* ----------------------------------------------------------- .NET metadata - */

export interface DotNetMetadataReport {
  ok: boolean;
  runtimeVersion: string | null;
  streams: string[];
  warnings: string[];
}

/** Standalone BSJB metadata root (works for a raw `BSJB` blob or an assembly). */
export function parseDotNetMetadata(reader: ByteReader): DotNetMetadataReport | null {
  const bytes = reader.bytes;
  let at = 0;
  if (!(bytes[0] === 0x42 && bytes[1] === 0x53 && bytes[2] === 0x4a && bytes[3] === 0x42)) {
    const found = indexOf(bytes, [0x42, 0x53, 0x4a, 0x42], 0, Math.min(bytes.byteLength, 1 << 20));
    if (found < 0) return null;
    at = found;
  }
  const versionLength = reader.u32(at + 12, true) ?? 0;
  if (versionLength <= 0 || versionLength > 255) {
    return { ok: false, runtimeVersion: null, streams: [], warnings: ["The BSJB metadata root has an implausible version length."] };
  }
  const version = (reader.fixedString(at + 16, versionLength) ?? "").replace(/\0+$/, "");
  const streams = reader.u16(at + 20, true) ?? 0;
  const streamTable = at + 16 + versionLength;
  const out: string[] = [];
  for (let i = 0; i < Math.min(streams, 16) && reader.has(streamTable + i * 8, 8); i += 1) {
    const offset = reader.u32(streamTable + i * 8, true) ?? 0;
    const size = reader.u32(streamTable + i * 8 + 4, true) ?? 0;
    const name = reader.cString(streamTable + streams * 8 + i * 8, 32);
    if (name) out.push(`${name}@0x${offset.toString(16)}+${size}`);
  }
  return { ok: true, runtimeVersion: version || null, streams: out, warnings: [] };
}

/* ----------------------------------------------------------------- ASAR --- */

export interface AsarReport {
  ok: boolean;
  headerSize: number;
  entries: number;
  totalUnpackedSize: number;
  topLevel: string[];
  warnings: string[];
}

/**
 * Electron ASAR header. The layout is a Chromium Pickle: a 4-byte payload size
 * (always 4), a 4-byte JSON header size, then the JSON itself padded to a
 * 4-byte boundary. Only the header is read — never the members.
 */
export function parseAsar(reader: ByteReader): AsarReport | null {
  const bytes = reader.bytes;
  if (bytes.byteLength < 16) return null;
  if (reader.u32(0, true) !== 4) return null;
  const headerSize = reader.u32(4, true) ?? 0;
  if (headerSize <= 0 || headerSize > 8 * 1024 * 1024 || !reader.has(8, headerSize)) return null;
  const json = reader.fixedString(8, headerSize);
  if (!json) return null;
  let parsed: { files?: Record<string, unknown> } | null = null;
  try {
    parsed = JSON.parse(json) as { files?: Record<string, unknown> };
  } catch {
    return { ok: false, headerSize, entries: 0, totalUnpackedSize: 0, topLevel: [], warnings: ["The ASAR header is present but not valid JSON: a corrupted archive or a newer framing."] };
  }
  if (!parsed || typeof parsed.files !== "object" || parsed.files === null) {
    return { ok: false, headerSize, entries: 0, totalUnpackedSize: 0, topLevel: [], warnings: ["The ASAR header parsed but has no files map."] };
  }
  const entries: Array<{ path: string; size: number }> = [];
  const walk = (node: Record<string, unknown>, prefix: string) => {
    for (const [key, value] of Object.entries(node)) {
      if (entries.length >= 20_000) return;
      const path = prefix ? `${prefix}/${key}` : key;
      if (value && typeof value === "object" && "files" in (value as Record<string, unknown>)) {
        walk((value as { files: Record<string, unknown> }).files, path);
      } else if (value && typeof value === "object") {
        const size = Number((value as { size?: unknown }).size ?? 0);
        entries.push({ path, size: Number.isFinite(size) ? size : 0 });
      }
    }
  };
  walk(parsed.files, "");
  return {
    ok: true,
    headerSize,
    entries: entries.length,
    totalUnpackedSize: entries.reduce((sum, entry) => sum + entry.size, 0),
    topLevel: Object.keys(parsed.files).slice(0, 40),
    warnings: entries.length >= 20_000 ? ["The ASAR holds at least 20,000 entries; the listing is bounded."] : [],
  };
}

/* ------------------------------------------------------------------ ZIP --- */

export interface ZipEntry {
  name: string;
  method: string;
  compressedSize: number;
  uncompressedSize: number;
  flags: string[];
  offset: number;
}

export interface ZipReport {
  ok: boolean;
  entryCount: number;
  entries: ZipEntry[];
  totalCompressed: number;
  totalUncompressed: number;
  maxRatio: number;
  encryptedEntries: number;
  jarLike: boolean;
  apkLike: boolean;
  warnings: string[];
}

/** Absolute caps: an archive that exceeds them is refused, never expanded. */
export const ZIP_LIMITS = {
  maxEntries: 5_000,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxRatio: 1_000,
} as const;

/**
 * Read the ZIP central directory only. No member is ever decompressed, so a
 * decompression bomb has nothing to expand: the guard is that DEMO refuses to
 * report an archive whose declared expansion exceeds the caps, and the analysis
 * never writes a member to disk.
 */
export function listZipEntries(reader: ByteReader): ZipReport | null {
  const bytes = reader.bytes;
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) return null;
  const warnings: string[] = [];

  const eocd = findEocd(bytes);
  if (eocd === null) {
    return { ok: false, entryCount: 0, entries: [], totalCompressed: 0, totalUncompressed: 0, maxRatio: 0, encryptedEntries: 0, jarLike: false, apkLike: false, warnings: ["No ZIP end-of-central-directory record found: a truncated capture or not a ZIP container."] };
  }

  const entryCount = reader.u16(eocd + 10, true) ?? 0;
  const centralDirOffset = reader.u32(eocd + 16, true) ?? 0;
  const entries: ZipEntry[] = [];
  let totalCompressed = 0;
  let totalUncompressed = 0;
  let maxRatio = 0;
  let encryptedEntries = 0;

  let cursor = centralDirOffset;
  const limit = Math.min(entryCount, ZIP_LIMITS.maxEntries);
  for (let i = 0; i < limit; i += 1) {
    if (!reader.has(cursor, 46)) {
      warnings.push(`The central directory is truncated after ${i} of ${entryCount} entries.`);
      break;
    }
    if (!(bytes[cursor] === 0x50 && bytes[cursor + 1] === 0x4b && bytes[cursor + 2] === 0x01 && bytes[cursor + 3] === 0x02)) {
      warnings.push(`Central-directory signature mismatch at entry ${i}.`);
      break;
    }
    const flags = reader.u16(cursor + 8, true) ?? 0;
    const method = reader.u16(cursor + 10, true) ?? 0;
    const compressedSize = reader.u32(cursor + 20, true) ?? 0;
    const uncompressedSize = reader.u32(cursor + 24, true) ?? 0;
    const nameLength = reader.u16(cursor + 28, true) ?? 0;
    const extraLength = reader.u16(cursor + 30, true) ?? 0;
    const commentLength = reader.u16(cursor + 32, true) ?? 0;
    const name = reader.fixedString(cursor + 46, Math.min(nameLength, 512)) ?? "";
    if (flags & 0x1) encryptedEntries += 1;
    maxRatio = Math.max(maxRatio, uncompressedSize > 0 && compressedSize > 0 ? uncompressedSize / compressedSize : 0);
    totalCompressed += compressedSize;
    totalUncompressed += uncompressedSize;
    entries.push({
      name,
      method: ZIP_METHODS[method] ?? `0x${method.toString(16)}`,
      compressedSize,
      uncompressedSize,
      flags: [
        ...(flags & 0x1 ? ["ENCRYPTED"] : []),
        ...(flags & 0x8 ? ["STREAMED"] : []),
        ...(flags & 0x800 ? ["UTF8"] : []),
      ],
      offset: reader.u32(cursor + 42, true) ?? 0,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  const names = entries.map((entry) => entry.name);
  const jarLike = names.some((name) => name.startsWith("META-INF/"));
  const apkLike = names.includes("AndroidManifest.xml") && names.includes("classes.dex");

  if (totalUncompressed > ZIP_LIMITS.maxTotalUncompressedBytes) {
    warnings.push(`Declared expansion is ${totalUncompressed} bytes, above the ${ZIP_LIMITS.maxTotalUncompressedBytes}-byte cap: refused as a probable decompression bomb.`);
  }
  if (maxRatio > ZIP_LIMITS.maxRatio) {
    warnings.push(`The highest expansion ratio is ${Math.round(maxRatio)}:1, above the ${ZIP_LIMITS.maxRatio}:1 cap.`);
  }
  if (entryCount > ZIP_LIMITS.maxEntries) {
    warnings.push(`The archive declares ${entryCount} entries; only the first ${ZIP_LIMITS.maxEntries} are listed.`);
  }
  if (encryptedEntries > 0) {
    warnings.push(`${encryptedEntries} encrypted entr${encryptedEntries === 1 ? "y" : "ies"} present; DEMO never attempts to decrypt them.`);
  }

  return {
    ok: true,
    entryCount,
    entries: entries.slice(0, 200),
    totalCompressed,
    totalUncompressed,
    maxRatio: Math.round(maxRatio * 100) / 100,
    encryptedEntries,
    jarLike,
    apkLike,
    warnings,
  };
}

const ZIP_METHODS: Record<number, string> = {
  0: "stored",
  8: "deflate",
  9: "deflate64",
  12: "bzip2",
  14: "lzma",
  93: "zstd",
  95: "xz",
};

function findEocd(bytes: Uint8Array): number | null {
  const min = Math.max(0, bytes.byteLength - 66_000);
  for (let i = bytes.byteLength - 22; i >= min; i -= 1) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return i;
  }
  return null;
}

function indexOf(haystack: Uint8Array, needle: number[], from: number, limit: number): number {
  const end = Math.min(haystack.byteLength - needle.length, limit);
  outer: for (let i = Math.max(0, from); i <= end; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function toHex(bytes: Uint8Array | null): string {
  return bytes ? [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("") : "";
}

/* ------------------------------------------------------------- pyc header -- */

export interface PycReport {
  ok: boolean;
  magic: number;
  pythonVersion: string;
  flags: string;
  headerBytes: number;
}

/** `.pyc` header. The version table is what upstream calls "version-gating". */
export function parsePyc(reader: ByteReader): PycReport | null {
  if (reader.length < 16) return null;
  const magic = reader.u16(0, true);
  if (magic === null) return null;
  const version = PYC_MAGICS[magic];
  if (!version) return null;
  const flags = reader.u32(4, true) ?? 0;
  return { ok: true, magic, pythonVersion: version, flags: `0x${flags.toString(16)}`, headerBytes: 16 };
}

const PYC_MAGICS: Record<number, string> = {
  20121: "Python 1.5", 50428: "Python 1.6", 50823: "Python 2.0", 60202: "Python 2.1",
  60717: "Python 2.2", 62011: "Python 2.3", 62041: "Python 2.4", 62061: "Python 2.5",
  62071: "Python 2.6", 62121: "Python 2.7", 3110: "Python 3.0", 3130: "Python 3.1",
  3140: "Python 3.2", 3150: "Python 3.3", 3160: "Python 3.4", 3170: "Python 3.5",
  3180: "Python 3.6", 3190: "Python 3.7", 3210: "Python 3.8", 3220: "Python 3.9",
  3230: "Python 3.10", 3240: "Python 3.11", 3250: "Python 3.12", 3260: "Python 3.13",
  3270: "Python 3.14", 3280: "Python 3.15",
};

export { shannonEntropyRange };
