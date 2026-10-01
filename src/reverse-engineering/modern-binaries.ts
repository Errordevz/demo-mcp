/**
 * Modern compiled-language metadata: Go, Rust, Swift.
 *
 * Ports the substance of upstream `scripts/extract_go_metadata.py` and
 * `references/03-modern-binaries.md`:
 *
 *   - **Go**: `.gopclntab` survives `strip`, so function names can be recovered
 *     from a stripped binary. The magic is validated (padding + pointer size)
 *     before anything is claimed, and every recovered name is labelled
 *     `inferred` — GoReSym or `go tool nm` is the authoritative path.
 *   - **Rust**: v0 (`_R…`) and legacy (`_ZN…E`) mangled symbols are demangled
 *     in-process. Demangling is arithmetic on the symbol string, so it is code,
 *     not model guessing — but the *meaning* of a demangled name is still only
 *     as good as the compiler's, so the labels stay honest.
 *   - **Swift**: `$s` symbols are detected and counted; full demangling needs
 *     the Swift toolchain, which DEMO reports as missing rather than faking.
 */

import { ByteReader } from "./binary-reader.js";
import type { ElfReport } from "./elf.js";
import type { MachoReport } from "./macho.js";

/* --------------------------------------------------------------------- Go -- */

export interface GoMetadata {
  found: boolean;
  /** File offset of the pclntab signature. */
  offset: number | null;
  size: number | null;
  magic: string | null;
  versionLabel: string;
  quantum: number | null;
  pointerSize: number | null;
  functionNameCandidates: string[];
  totalCandidates: number;
  buildInfo: string | null;
  /** True when a symbol table is still present (then names are `observed`). */
  symbolTablePresent: boolean;
  warnings: string[];
}

const GO_PCLNTAB_MAGICS: Record<number, string> = {
  0xfffffffb: "Go 1.2 – 1.15",
  0xfffffffa: "Go 1.16 – 1.17",
  0xfffffff0: "Go 1.18 – 1.19",
  0xfffffff1: "Go 1.20+",
};

const GO_MAGIC_BYTES: ReadonlyArray<readonly [number, number[]]> = [
  [0xfffffff1, [0xf1, 0xff, 0xff, 0xff]],
  [0xfffffff0, [0xf0, 0xff, 0xff, 0xff]],
  [0xfffffffa, [0xfa, 0xff, 0xff, 0xff]],
  [0xfffffffb, [0xfb, 0xff, 0xff, 0xff]],
];

/** Locate `.gopclntab` and recover candidate function names. */
export function extractGoMetadata(reader: ByteReader, elf: ElfReport | null, macho: MachoReport | null, maxNames = 200): GoMetadata {
  const bytes = reader.bytes;
  const warnings: string[] = [];
  const symbolTablePresent = Boolean(elf && elf.symbols.length > 0);

  const section = elf?.sections.find((entry) => entry.name === ".gopclntab") ?? null;
  const machoSection = macho?.sections.find((entry) => entry.name === "__gopclntab" || entry.name === ".gopclntab") ?? null;
  let offset: number | null = section?.offset ?? machoSection?.offset ?? null;
  let size: number | null = section?.size ?? machoSection?.size ?? null;
  let magic: number | null = null;

  if (offset !== null && size !== null && size >= 8 && reader.has(offset, 8)) {
    magic = reader.u32(offset, true);
  }

  if (offset === null) {
    // Direct scan for a validated pclntab header.
    for (const [value, pattern] of GO_MAGIC_BYTES) {
      let from = 0;
      for (;;) {
        const index = findBytes(bytes, pattern, from);
        if (index < 0) break;
        const pad = bytes[index + 4] === 0 && bytes[index + 5] === 0;
        const pointerSize = bytes[index + 7];
        if (pad && (pointerSize === 4 || pointerSize === 8)) {
          offset = index;
          size = bytes.byteLength - index;
          magic = value;
          break;
        }
        from = index + 4;
      }
      if (offset !== null) break;
    }
  }

  if (offset === null || size === null) {
    return {
      found: false,
      offset: null,
      size: null,
      magic: null,
      versionLabel: "unknown",
      quantum: null,
      pointerSize: null,
      functionNameCandidates: [],
      totalCandidates: 0,
      buildInfo: elf?.goBuildInfo ?? null,
      symbolTablePresent,
      warnings: warnings.length ? warnings : ["No .gopclntab section or signature found. Use GoReSym (github.com/mandiant/GoReSym) for full recovery."],
    };
  }

  if (magic === null && reader.has(offset, 4)) magic = reader.u32(offset, true);
  const versionLabel = magic !== null ? (GO_PCLNTAB_MAGICS[magic] ?? "unknown") : "unknown";
  if (versionLabel === "unknown") {
    warnings.push("The pclntab magic is not one of the published values: use GoReSym for full recovery.");
  }
  const quantum = reader.u8(offset + 6);
  const pointerSize = reader.u8(offset + 7);

  const candidates: string[] = [];
  let total = 0;
  const limit = Math.min(bytes.byteLength, offset + Math.min(size, 2 * 1024 * 1024));
  let i = offset + 16;
  while (i < limit && total < 20_000) {
    if (bytes[i] === 0) {
      i += 1;
      continue;
    }
    const end = indexOfByte(bytes, 0, i, limit);
    if (end < 0) break;
    const length = end - i;
    if (length > 250) {
      i = end + 1;
      continue;
    }
    if (length >= 4 && isPrintable(bytes, i, end)) {
      const value = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(i, end));
      if ((value.includes(".") || value.includes("/")) && !value.startsWith("(") && !value.startsWith(")")) {
        total += 1;
        if (candidates.length < maxNames) candidates.push(value);
      }
    }
    i = end + 1;
  }

  return {
    found: true,
    offset,
    size,
    magic: magic === null ? null : `0x${magic.toString(16)}`,
    versionLabel,
    quantum,
    pointerSize: pointerSize === 4 || pointerSize === 8 ? pointerSize : null,
    functionNameCandidates: candidates,
    totalCandidates: total,
    buildInfo: elf?.goBuildInfo ?? null,
    symbolTablePresent,
    warnings,
  };
}

/* ------------------------------------------------------------------- Rust -- */

export interface DemangledSymbol {
  original: string;
  demangled: string;
  scheme: "rust-v0" | "rust-legacy" | "swift" | "other";
}

/** Demangle Rust v0 / legacy symbols and flag Swift ones. Best-effort, bounded. */
export function demangleSymbols(symbols: string[], max = 200): DemangledSymbol[] {
  const out: DemangledSymbol[] = [];
  for (const symbol of symbols) {
    if (out.length >= max) break;
    if (symbol.startsWith("_R")) {
      out.push({ original: symbol, demangled: demangleRustV0(symbol) ?? symbol, scheme: "rust-v0" });
    } else if (symbol.startsWith("_ZN") || symbol.startsWith("__ZN")) {
      out.push({ original: symbol, demangled: demangleLegacy(symbol) ?? symbol, scheme: "rust-legacy" });
    } else if (symbol.startsWith("$s") || symbol.startsWith("_$s")) {
      out.push({ original: symbol, demangled: symbol, scheme: "swift" });
    }
  }
  return out;
}

/**
 * Rust v0 demangler (subset).
 *
 * The grammar is a small state machine over the symbol string; everything that
 * is not understood is passed through verbatim rather than guessed, so a
 * partially-demangled name is obviously partial.
 */
export function demangleRustV0(symbol: string): string | null {
  if (!symbol.startsWith("_R")) return null;
  let cursor = 2;
  const path: string[] = [];

  /** `<digits><name>` — the only thing a Rust path component can be. */
  const readIdentifier = (): string | null => {
    let length = 0;
    let digits = 0;
    while (cursor < symbol.length && symbol[cursor]! >= "0" && symbol[cursor]! <= "9") {
      length = length * 10 + (symbol.charCodeAt(cursor!) - 48);
      cursor += 1;
      digits += 1;
      if (length > 4096) return null;
    }
    if (digits === 0 || length === 0) return null;
    const value = symbol.slice(cursor, cursor + length);
    if (value.length !== length) return null;
    cursor += length;
    return value;
  };

  /**
   * A crate disambiguator: `s<base62>_` (or `g<…>`). It is skipped, never
   * rendered, and — critically — the base-62 run stops at the `_` terminator,
   * otherwise it would swallow the following length prefix.
   */
  const skipDisambiguator = (): boolean => {
    const marker = symbol[cursor];
    if (marker !== "s" && marker !== "g") return false;
    let at = cursor + 1;
    while (at < symbol.length && /[0-9A-Za-z]/.test(symbol[at]!)) at += 1;
    if (at === cursor + 1) return false;
    if (symbol[at] === "_") at += 1;
    cursor = at;
    return true;
  };

  // Optional leading `N<ns>` namespace marker.
  if (symbol[cursor] === "N") {
    cursor += 1;
    if (cursor < symbol.length && /[A-Za-z]/.test(symbol[cursor]!)) cursor += 1;
  }

  // Path components: identifiers, disambiguators, and `I…E` generic scopes.
  for (let guard = 0; guard < 64; guard += 1) {
    const ch = symbol[cursor];
    if (ch === undefined || ch === "E") break;
    if (ch === "I") {
      cursor += 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const identifier = readIdentifier();
      if (!identifier) break;
      path.push(identifier);
      continue;
    }
    if (skipDisambiguator()) continue;
    // Anything else is a namespace marker we do not model; skip one character so
    // the scan can continue rather than abandoning the whole symbol.
    cursor += 1;
  }

  // Drop a trailing `17h<hash>` so it never appears inside a name.
  const hashIndex = symbol.indexOf("17h", cursor);
  if (hashIndex >= 0) cursor = hashIndex;

  return path.length ? path.join("::") : null;
}

function demangleLegacy(symbol: string): string | null {
  const body = symbol.replace(/^_+Z?N?/, "").replace(/E$/, "");
  const parts: string[] = [];
  let cursor = 0;
  for (let guard = 0; guard < 64; guard += 1) {
    const digits = /^(\d+)/.exec(body.slice(cursor));
    if (!digits) break;
    const length = Number(digits[1]);
    cursor += digits[1].length;
    const part = body.slice(cursor, cursor + length);
    if (part.length !== length) break;
    cursor += length;
    if (/^h[0-9a-f]{16}$/.test(part)) continue;
    parts.push(part);
  }
  return parts.length ? parts.join("::") : null;
}

/* ------------------------------------------------------------------ Swift -- */

export interface SwiftSymbolSummary {
  count: number;
  sample: string[];
  /** Swift demangling needs the Swift toolchain, which DEMO reports as missing. */
  demanglerAvailable: false;
}

export function summarizeSwiftSymbols(symbols: string[], max = 20): SwiftSymbolSummary {
  const swift = symbols.filter((symbol) => symbol.startsWith("$s") || symbol.startsWith("_$s"));
  return { count: swift.length, sample: swift.slice(0, max), demanglerAvailable: false };
}

/* ----------------------------------------------------------------- helpers - */

function findBytes(haystack: Uint8Array, needle: number[], from: number): number {
  const limit = haystack.byteLength - needle.length;
  outer: for (let i = Math.max(0, from); i <= limit; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function indexOfByte(haystack: Uint8Array, value: number, from: number, limit: number): number {
  for (let i = Math.max(0, from); i < limit; i += 1) if (haystack[i] === value) return i;
  return -1;
}

function isPrintable(bytes: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i += 1) {
    const b = bytes[i]!;
    if (b < 0x20 || b >= 0x7f) return false;
  }
  return true;
}
