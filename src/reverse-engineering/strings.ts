/**
 * String extraction.
 *
 * Upstream `triage_binary.py` shells out to `strings`. DEMO's Worker runtime
 * has no shell, so the same job is done in-process with the same defaults
 * (`-n 6`, plus a UTF-16LE pass, because Windows and Java artifacts hide half
 * their interesting text in wide strings). Output is always bounded: the
 * caller gets counts plus the first N matches, never the whole table.
 */

import type { ByteReader } from "./binary-reader.js";

export interface ExtractedString {
  offset: number;
  length: number;
  encoding: "ascii" | "utf16le";
  value: string;
}

export interface StringScan {
  total: number;
  returned: ExtractedString[];
  truncated: boolean;
  /** Distinct strings that look security-relevant, grouped by theme. */
  notable: NotableString[];
}

export interface NotableString {
  theme: string;
  value: string;
  offset: number;
}

const MIN_LENGTH = 6;

const NOTABLE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["url", /\bhttps?:\/\/[^\s"'<>]{4,}/i],
  ["email", /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{2,255}\.[A-Za-z]{2,24}\b/],
  ["filesystem-path", /(?:\/[A-Za-z0-9._-]{2,}){2,}\/?|\b[A-Za-z]:\\[^\s"'<>]{2,}/],
  ["registry-key", /\bHK(?:LM|CU|CR|U|CC)\\[^\s"'<>]{3,}/i],
  ["network-endpoint", /\b(?:[A-Za-z0-9-]+\.)+(?:com|net|org|io|dev|local|internal|lan)\b/],
  ["ip-literal", /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
  ["runtime-marker", /\b(?:go1\.\d+|rustc|GCC|clang|MSVC|dotnet|CoreCLR|CPython|PyInstaller|Nuitka|Electron|node\.js|V8)\b/i],
  ["packer-marker", /\b(?:UPX!|VMProtect|Themida|ASPack|PECompact|MPRESS|Obsidium|Enigma)\b/i],
  ["crypto-marker", /\b(?:AES|RC4|ChaCha|RSA|SHA-?256|HMAC|EVP_|BCrypt|CryptDeriveKey|SecTrustEvaluate|SSL_CTX_set_verify)\b/i],
  ["anti-analysis", /\b(?:IsDebuggerPresent|CheckRemoteDebuggerPresent|NtQueryInformationProcess|ptrace|anti-?debug|anti-?vm|sandbox|VMware|VirtualBox)\b/i],
  ["ipc-marker", /\b(?:\\\\\.\\pipe\\|mach_msg|dbus|COM1|LPC|ZeroMQ|ZMTP)\b/i],
  ["error-format", /\b(?:error|failed|fatal|panic|assert|denied|refused|invalid)[^\n]{0,80}/i],
];

/** Extract ASCII and UTF-16LE strings with a hard bound on how many are returned. */
export function extractStrings(reader: ByteReader, options: { max?: number; minLength?: number } = {}): StringScan {
  const max = options.max ?? 400;
  const minLength = options.minLength ?? MIN_LENGTH;
  const bytes = reader.bytes;
  const found: ExtractedString[] = [];
  let total = 0;
  let truncated = false;

  const push = (offset: number, length: number, encoding: "ascii" | "utf16le", value: string) => {
    total += 1;
    if (found.length < max) found.push({ offset, length, encoding, value });
    else truncated = true;
  };

  let runStart = -1;
  for (let i = 0; i <= bytes.byteLength; i += 1) {
    const b = i < bytes.byteLength ? bytes[i]! : 0;
    const printable = b >= 0x20 && b < 0x7f;
    if (printable) {
      if (runStart < 0) runStart = i;
      continue;
    }
    if (runStart >= 0) {
      const length = i - runStart;
      if (length >= minLength) push(runStart, length, "ascii", new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(runStart, i)));
      runStart = -1;
    }
  }

  // UTF-16LE pass: every second byte must be 0 for a candidate to count.
  let wideStart = -1;
  for (let i = 0; i + 1 < bytes.byteLength; i += 2) {
    const low = bytes[i]!;
    const high = bytes[i + 1]!;
    const ok = low >= 0x20 && low < 0x7f && high === 0;
    if (ok) {
      if (wideStart < 0) wideStart = i;
      continue;
    }
    if (wideStart >= 0) {
      const length = (i - wideStart) / 2;
      if (length >= minLength) {
        let text = "";
        for (let j = wideStart; j < i; j += 2) text += String.fromCharCode(bytes[j]!);
        push(wideStart, length, "utf16le", text);
      }
      wideStart = -1;
    }
  }

  const notable: NotableString[] = [];
  const seenThemes = new Set<string>();
  for (const entry of found) {
    for (const [theme, pattern] of NOTABLE_PATTERNS) {
      if (seenThemes.has(theme)) continue;
      if (pattern.test(entry.value)) {
        notable.push({ theme, value: entry.value.slice(0, 200), offset: entry.offset });
        seenThemes.add(theme);
      }
    }
  }

  return { total, returned: found, truncated, notable };
}

/** Count only — cheap enough to run on every analysis without a second pass. */
export function countStrings(reader: ByteReader, minLength = MIN_LENGTH): number {
  const bytes = reader.bytes;
  let count = 0;
  let run = 0;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    const b = bytes[i]!;
    if (b >= 0x20 && b < 0x7f) run += 1;
    else {
      if (run >= minLength) count += 1;
      run = 0;
    }
  }
  if (run >= minLength) count += 1;
  return count;
}
