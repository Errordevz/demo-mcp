/**
 * PDF intelligence (DEMO 0.9) — a bounded, dependency-free PDF reader.
 *
 * PDFs are untrusted binary input: nothing here executes script, launches
 * embedded files or resolves remote XObjects. The reader is a *scanner*:
 *
 *   1. lenient object graph scan (xref tables are advisory — damaged PDFs and
 *      incremental updates still parse),
 *   2. per-page content streams inflated with the platform's DecompressionStream
 *      (zlib/deflate) only — no codec execution, no JavaScript PDF engines,
 *   3. text extraction from the content operator stream (Tj/TJ/'/" with Td/TD/
 *      Tm/T* positioning) preserving page numbers and approximate line/word
 *      order, so results carry page-level references,
 *   4. image XObject detection (JPEG/DCT pages can be OCR'd through DEMO's
 *      existing Workers AI vision binding),
 *   5. Info-dictionary + XMP metadata, scanned-page detection and a whitespace/
 *      alignment table heuristic.
 *
 * Limitations are reported, never papered over: ToUnicode CMaps, CID fonts and
 * CCITT/JBIG2 raster data are out of scope, and OCR requires the AI binding.
 */

import { BrowserError } from "../core/errors.js";
import { LIMITS, clamp } from "../core/limits.js";

/* ────────────────────────────── object model ─────────────────────────────── */

export type PdfValue =
  | { kind: "null" }
  | { kind: "bool"; value: boolean }
  | { kind: "number"; value: number }
  | { kind: "string"; value: string; bytes: Uint8Array }
  | { kind: "name"; value: string }
  | { kind: "array"; items: PdfValue[] }
  | { kind: "dict"; entries: Map<string, PdfValue> }
  | { kind: "ref"; num: number; gen: number };

interface PdfObject {
  num: number;
  gen: number;
  value: PdfValue;
  stream: Uint8Array | null;
}

class PdfParser {
  readonly objects = new Map<number, PdfObject>();
  private text: string;
  private bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.text = latin1(bytes);
  }

  parse(): void {
    const pattern = /(\d+)\s+(\d+)\s+obj\b/g;
    let match: RegExpExecArray | null;
    let count = 0;
    while ((match = pattern.exec(this.text)) !== null && count < 20_000) {
      count++;
      const num = Number(match[1]);
      const gen = Number(match[2]);
      try {
        const { value, next } = this.parseValue(match.index + match[0].length);
        let stream: Uint8Array | null = null;
        let cursor = skipSpace(this.text, next);
        if (this.text.startsWith("stream", cursor)) {
          cursor += "stream".length;
          if (this.text[cursor] === "\r") cursor++;
          if (this.text[cursor] === "\n") cursor++;
          stream = this.readStream(cursor, value);
        }
        this.objects.set(num, { num, gen, value, stream });
      } catch {
        /* one broken object must not sink the document */
      }
    }
  }

  private readStream(start: number, value: PdfValue): Uint8Array | null {
    const length = value.kind === "dict" ? this.resolve(value.entries.get("Length") ?? { kind: "null" }) : null;
    if (length?.kind === "number" && length.value >= 0 && start + length.value <= this.bytes.length) {
      return this.bytes.subarray(start, start + length.value);
    }
    const end = this.text.indexOf("endstream", start);
    if (end === -1) return this.bytes.subarray(start, Math.min(start + 20_000_000, this.bytes.length));
    let trueEnd = end;
    // Trim the EOL that legitimately precedes `endstream`.
    if (this.text[trueEnd - 1] === "\n") trueEnd--;
    if (this.text[trueEnd - 1] === "\r") trueEnd--;
    return this.bytes.subarray(start, trueEnd);
  }

  resolve(value: PdfValue | undefined, depth = 0): PdfValue | null {
    if (!value || depth > 16) return null;
    if (value.kind === "ref") {
      const object = this.objects.get(value.num);
      return object ? this.resolve(object.value, depth + 1) : null;
    }
    return value;
  }

  resolveStream(value: PdfValue | undefined, depth = 0): { value: PdfValue; stream: Uint8Array | null } | null {
    if (!value || depth > 16) return null;
    if (value.kind === "ref") {
      const object = this.objects.get(value.num);
      if (!object) return null;
      if (object.value.kind === "ref") return this.resolveStream(object.value, depth + 1);
      return { value: object.value, stream: object.stream };
    }
    return { value, stream: null };
  }

  streamOf(num: number): Uint8Array | null {
    return this.objects.get(num)?.stream ?? null;
  }

  parseValue(index: number): { value: PdfValue; next: number } {
    let i = skipSpace(this.text, index);
    const char = this.text[i];
    if (char === undefined) return { value: { kind: "null" }, next: i };
    if (this.text.startsWith("<<", i)) return this.parseDict(i + 2);
    if (char === "[") return this.parseArray(i + 1);
    if (char === "(") return this.parseLiteralString(i);
    if (char === "<" && this.text[i + 1] !== "<") return this.parseHexString(i);
    if (char === "/") return this.parseName(i);
    if (char === "-" || char === "+" || char === "." || (char >= "0" && char <= "9")) return this.parseNumberOrRef(i);
    if (this.text.startsWith("true", i)) return { value: { kind: "bool", value: true }, next: i + 4 };
    if (this.text.startsWith("false", i)) return { value: { kind: "bool", value: false }, next: i + 5 };
    if (this.text.startsWith("null", i)) return { value: { kind: "null" }, next: i + 4 };
    return { value: { kind: "null" }, next: i + 1 };
  }

  private parseDict(index: number): { value: PdfValue; next: number } {
    const entries = new Map<string, PdfValue>();
    let i = index;
    let guard = 0;
    for (;;) {
      i = skipSpace(this.text, i);
      if (this.text.startsWith(">>", i)) return { value: { kind: "dict", entries }, next: i + 2 };
      if (this.text[i] !== "/" || guard++ > 500) return { value: { kind: "dict", entries }, next: i };
      const key = this.parseName(i);
      const parsed = this.parseValue(key.next);
      entries.set(key.value.kind === "name" ? key.value.value : "", parsed.value);
      i = parsed.next;
    }
  }

  private parseArray(index: number): { value: PdfValue; next: number } {
    const items: PdfValue[] = [];
    let i = index;
    let guard = 0;
    for (;;) {
      i = skipSpace(this.text, i);
      if (this.text[i] === "]") return { value: { kind: "array", items }, next: i + 1 };
      if (guard++ > 2_000) return { value: { kind: "array", items }, next: i };
      const parsed = this.parseValue(i);
      items.push(parsed.value);
      i = parsed.next;
    }
  }

  private parseName(index: number): { value: PdfValue; next: number } {
    let i = index + 1;
    let name = "";
    while (i < this.text.length && !/[\s()<>[\]{}/%]/.test(this.text[i]) && name.length < 128) {
      if (this.text[i] === "#" && /^[0-9A-Fa-f]{2}/.test(this.text.slice(i + 1, i + 3))) {
        name += String.fromCharCode(Number.parseInt(this.text.slice(i + 1, i + 3), 16));
        i += 3;
        continue;
      }
      name += this.text[i];
      i++;
    }
    return { value: { kind: "name", value: name }, next: i };
  }

  private parseLiteralString(index: number): { value: PdfValue; next: number } {
    let i = index + 1;
    let depth = 1;
    const codes: number[] = [];
    while (i < this.text.length && codes.length < 2_000_000) {
      const char = this.text[i];
      if (char === "\\") {
        const next = this.text[i + 1];
        if (next === "n") codes.push(10);
        else if (next === "r") codes.push(13);
        else if (next === "t") codes.push(9);
        else if (next === "b") codes.push(8);
        else if (next === "f") codes.push(12);
        else if (next === "(" || next === ")" || next === "\\") codes.push(next.charCodeAt(0));
        else if (next === "\r" && this.text[i + 2] === "\n") i += 2;
        else if (next >= "0" && next <= "7") {
          const octal = this.text.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)?.[0] ?? next;
          codes.push(Number.parseInt(octal, 8) & 0xff);
          i += octal.length - 1;
        } else if (next !== undefined) codes.push(next.charCodeAt(0));
        i += 2;
        continue;
      }
      if (char === "(") depth++;
      if (char === ")") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      codes.push(this.text.charCodeAt(i) & 0xff);
      i++;
    }
    const bytes = new Uint8Array(codes);
    return { value: { kind: "string", value: pdfStringToText(bytes), bytes }, next: i };
  }

  private parseHexString(index: number): { value: PdfValue; next: number } {
    const end = this.text.indexOf(">", index);
    const hex = this.text.slice(index + 1, end === -1 ? this.text.length : end).replace(/[^0-9A-Fa-f]/g, "");
    const codes: number[] = [];
    for (let i = 0; i + 1 < hex.length; i += 2) codes.push(Number.parseInt(hex.slice(i, i + 2), 16));
    if (hex.length % 2 === 1) codes.push(Number.parseInt(hex.slice(-1) + "0", 16));
    const bytes = new Uint8Array(codes);
    return { value: { kind: "string", value: pdfStringToText(bytes), bytes }, next: end === -1 ? this.text.length : end + 1 };
  }

  private parseNumberOrRef(index: number): { value: PdfValue; next: number } {
    const rest = this.text.slice(index, index + 64);
    const numberMatch = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(rest);
    if (!numberMatch) return { value: { kind: "null" }, next: index + 1 };
    const value = Number(numberMatch[0]);
    const afterNum = skipSpace(this.text, index + numberMatch[0].length);
    // `N G R` object reference (N already consumed): the tail is `G R`.
    const refMatch = /^(\d+)\s+R\b/.exec(this.text.slice(afterNum, afterNum + 32));
    if (refMatch && Number.isInteger(value)) {
      return { value: { kind: "ref", num: value, gen: Number(refMatch[1]) }, next: afterNum + refMatch[0].length };
    }
    return { value: { kind: "number", value }, next: index + numberMatch[0].length };
  }
}

function skipSpace(text: string, index: number): number {
  let i = index;
  while (i < text.length) {
    const char = text[i];
    if (char === "%" || char === "#") {
      // Comments run to EOL inside object bodies.
      if (char === "%") {
        const eol = text.indexOf("\n", i);
        i = eol === -1 ? text.length : eol + 1;
        continue;
      }
    }
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    break;
  }
  return i;
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
}

function pdfStringToText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // UTF-16BE
    let out = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(3));
  }
  // Heuristic UTF-16BE without BOM (many producers skip it).
  let zeros = 0;
  for (let i = 1; i < Math.min(bytes.length, 40); i += 2) if (bytes[i] === 0) zeros++;
  if (bytes.length >= 4 && zeros >= Math.min(8, Math.floor(bytes.length / 2)) * 0.6 && bytes.length % 2 === 0) {
    let out = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  }
  return latin1(bytes);
}

/* ───────────────────────────── content streams ───────────────────────────── */

interface TextChunk {
  x: number;
  y: number;
  text: string;
}

interface PageLine {
  y: number;
  chunks: TextChunk[];
  text: string;
}

async function inflateStream(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (bytes.byteLength === 0) return bytes;
  for (const format of ["deflate", "deflate-raw"] as const) {
    try {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const stream = new Blob([copy as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
      const out = new Uint8Array(await new Response(stream).arrayBuffer());
      return out;
    } catch {
      /* try the next format */
    }
  }
  return null;
}

/** Decode a page content stream's filters (FlateDecode → inflate; DCT = JPEG passthrough). */
async function decodeStream(parser: PdfParser, stream: Uint8Array, dict: PdfValue): Promise<{ bytes: Uint8Array; jpeg: boolean; undecodable: string | null }> {
  const filters: string[] = [];
  const filterValue = dict.kind === "dict" ? parser.resolve(dict.entries.get("Filter")) : null;
  if (filterValue?.kind === "name") filters.push(filterValue.value);
  else if (filterValue?.kind === "array") for (const item of filterValue.items) if (item.kind === "name") filters.push(item.value);
  let current = stream;
  let jpeg = false;
  for (const filter of filters) {
    if (filter === "FlateDecode" || filter === "Fl") {
      const inflated = await inflateStream(current);
      if (!inflated) return { bytes: current, jpeg, undecodable: "FlateDecode" };
      current = inflated;
    } else if (filter === "DCTDecode" || filter === "DCT") {
      jpeg = true;
    } else if (filter === "ASCIIHexDecode" || filter === "AHx") {
      current = hexDecode(current);
    } else if (filter === "ASCII85Decode" || filter === "A85") {
      return { bytes: current, jpeg, undecodable: filter };
    } else {
      return { bytes: current, jpeg, undecodable: filter };
    }
  }
  return { bytes: current, jpeg, undecodable: null };
}

function hexDecode(bytes: Uint8Array): Uint8Array {
  const text = latin1(bytes).replace(/[^0-9A-Fa-f]/g, "");
  const out = new Uint8Array(Math.floor(text.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Minimal content-stream interpreter producing positioned text chunks. */
function interpretContent(content: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  let tx = 0;
  let ty = 0;
  let leading = 0;
  let lineStartX = 0;
  let lineStartY = 0;
  let operandStack: Array<{ kind: string; value?: unknown }> = [];
  let arrayStack: Array<Array<unknown>> = [];
  let currentArray: Array<unknown> | null = null;
  let depth = 0;

  const push = (item: { kind: string; value?: unknown }) => {
    if (currentArray) currentArray.push(item);
    else operandStack.push(item);
  };

  let i = 0;
  const length = content.length;
  let guard = 0;
  while (i < length && guard++ < 500_000) {
    const char = content[i];
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    if (char === "%") {
      const eol = content.indexOf("\n", i);
      i = eol === -1 ? length : eol + 1;
      continue;
    }
    if (content.startsWith("<<", i)) {
      // Skip inline dictionaries (e.g. in marked content) as opaque values.
      let depthDict = 0;
      while (i < length) {
        if (content.startsWith("<<", i)) {
          depthDict++;
          i += 2;
        } else if (content.startsWith(">>", i)) {
          depthDict--;
          i += 2;
          if (depthDict <= 0) break;
        } else i++;
      }
      push({ kind: "dict" });
      continue;
    }
    if (char === "[") {
      arrayStack.push((currentArray = []));
      i++;
      continue;
    }
    if (char === "]" && currentArray) {
      const finished = arrayStack.pop() ?? [];
      currentArray = arrayStack.length ? arrayStack[arrayStack.length - 1] : null;
      push({ kind: "array", value: finished });
      i++;
      continue;
    }
    if (char === "(") {
      let start = i;
      let d = 1;
      i++;
      const codes: number[] = [];
      while (i < length && d > 0) {
        const c = content[i];
        if (c === "\\") {
          const next = content[i + 1] ?? "";
          if (next === "n") codes.push(10);
          else if (next === "r") codes.push(13);
          else if (next === "t") codes.push(9);
          else if (next === "(" || next === ")" || next === "\\") codes.push(next.charCodeAt(0));
          else if (next >= "0" && next <= "7") {
            const octal = content.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)?.[0] ?? next;
            codes.push(Number.parseInt(octal, 8) & 0xff);
            i += octal.length - 1;
          } else if (next !== undefined) codes.push(next.charCodeAt(0));
          i += 2;
          continue;
        }
        if (c === "(") d++;
        else if (c === ")") {
          d--;
          if (d === 0) {
            i++;
            break;
          }
        }
        codes.push(content.charCodeAt(i) & 0xff);
        i++;
      }
      void start;
      push({ kind: "string", value: pdfStringToText(new Uint8Array(codes)) });
      continue;
    }
    if (char === "<" && content[i + 1] !== "<") {
      const end = content.indexOf(">", i);
      const hex = content.slice(i + 1, end === -1 ? length : end).replace(/[^0-9A-Fa-f]/g, "");
      const codes: number[] = [];
      for (let k = 0; k + 1 < hex.length; k += 2) codes.push(Number.parseInt(hex.slice(k, k + 2), 16));
      if (hex.length % 2 === 1) codes.push(Number.parseInt(hex.slice(-1) + "0", 16));
      i = end === -1 ? length : end + 1;
      push({ kind: "string", value: pdfStringToText(new Uint8Array(codes)) });
      continue;
    }
    if (char === "/") {
      let name = "";
      i++;
      while (i < length && !/[\s()<>[\]{}/%]/.test(content[i]) && name.length < 128) {
        if (content[i] === "#" && /^[0-9A-Fa-f]{2}/.test(content.slice(i + 1, i + 3))) {
          name += String.fromCharCode(Number.parseInt(content.slice(i + 1, i + 3), 16));
          i += 3;
          continue;
        }
        name += content[i];
        i++;
      }
      push({ kind: "name", value: name });
      continue;
    }
    const numberMatch = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(content.slice(i, i + 32));
    if (numberMatch) {
      push({ kind: "number", value: Number(numberMatch[0]) });
      i += numberMatch[0].length;
      continue;
    }
    const opMatch = /^[A-Za-z'"*]{1,12}/.exec(content.slice(i, i + 16));
    if (opMatch) {
      const op = opMatch[0];
      i += op.length;
      handleOperator(op, operandStack, currentArray, {
        show: (text, x, y) => chunks.push({ x, y, text }),
        move: (x, y) => {
          tx = x;
          ty = y;
          lineStartX = x;
          lineStartY = y;
        },
        moveLine: (dx, dy) => {
          lineStartX += dx;
          lineStartY += dy;
          tx = lineStartX;
          ty = lineStartY;
        },
        setLeading: (value) => {
          leading = value;
        },
        nextLine: () => {
          lineStartY -= leading;
          tx = lineStartX;
          ty = lineStartY;
        },
        getState: () => ({ tx, ty }),
      });
      operandStack = [];
      currentArray = arrayStack.length ? arrayStack[arrayStack.length - 1] : null;
      depth++;
      if (depth > 100_000) break;
      continue;
    }
    i++;
  }
  return chunks;
}

interface ContentState {
  show(text: string, x: number, y: number): void;
  move(x: number, y: number): void;
  moveLine(dx: number, dy: number): void;
  setLeading(value: number): void;
  nextLine(): void;
  getState(): { tx: number; ty: number };
}

function handleOperator(op: string, operands: Array<{ kind: string; value?: unknown }>, _array: Array<unknown> | null, state: ContentState): void {
  const nums = operands.filter((entry) => entry.kind === "number").map((entry) => entry.value as number);
  const strings = operands.filter((entry) => entry.kind === "string").map((entry) => entry.value as string);
  switch (op) {
    case "Td":
      if (nums.length >= 2) state.moveLine(nums[0], nums[1]);
      break;
    case "TD":
      if (nums.length >= 2) {
        state.setLeading(-nums[1]);
        state.moveLine(nums[0], nums[1]);
      }
      break;
    case "Tm":
      if (nums.length >= 6) state.move(nums[4], nums[5]);
      break;
    case "TL":
      if (nums.length >= 1) state.setLeading(nums[0]);
      break;
    case "T*":
      state.nextLine();
      break;
    case "Tj":
      if (strings.length) {
        const { tx, ty } = state.getState();
        state.show(strings[0], tx, ty);
      }
      break;
    case "TJ": {
      const array = operands.find((entry) => entry.kind === "array")?.value as Array<{ kind: string; value?: unknown }> | undefined;
      if (array) {
        let text = "";
        for (const item of array) {
          if (item.kind === "string") text += item.value as string;
          else if (item.kind === "number" && (item.value as number) <= -180) text += " ";
        }
        const { tx, ty } = state.getState();
        state.show(text, tx, ty);
      }
      break;
    }
    case "'":
      state.nextLine();
      if (strings.length) {
        const { tx, ty } = state.getState();
        state.show(strings[0], tx, ty);
      }
      break;
    case '"': {
      state.nextLine();
      const string = strings[strings.length - 1];
      if (string !== undefined) {
        const { tx, ty } = state.getState();
        state.show(string, tx, ty);
      }
      break;
    }
    default:
      break;
  }
}

function chunksToLines(chunks: TextChunk[]): PageLine[] {
  const sorted = [...chunks].sort((a, b) => b.y - a.y);
  const lines: PageLine[] = [];
  for (const chunk of sorted) {
    const target = lines.find((line) => Math.abs(line.y - chunk.y) < 2.5);
    if (target) target.chunks.push(chunk);
    else lines.push({ y: chunk.y, chunks: [chunk], text: "" });
  }
  for (const line of lines) {
    line.chunks.sort((a, b) => a.x - b.x);
    let text = "";
    let previousEnd: number | null = null;
    for (const chunk of line.chunks) {
      if (previousEnd !== null && chunk.x - previousEnd > 24) text += "  ";
      else if (previousEnd !== null && chunk.x - previousEnd > 3) text += " ";
      text += chunk.text;
      previousEnd = chunk.x + chunk.text.length * 5;
    }
    line.text = text.replace(/\s+/g, " ").trim();
  }
  return lines.sort((a, b) => b.y - a.y);
}

/* ───────────────────────────── public API ────────────────────────────────── */

export interface PdfTable {
  page: number;
  caption: string | null;
  rows: string[][];
  columnCount: number;
}

export interface PdfPageReport {
  page: number;
  chars: number;
  text: string;
  imageCount: number;
  images: Array<{ width: number | null; height: number | null; filter: string | null; jpeg: boolean }>;
  scanned: boolean;
  tables: PdfTable[];
  lines: number;
}

export interface PdfMetadata {
  title: string | null;
  author: string | null;
  subject: string | null;
  keywords: string | null;
  creator: string | null;
  producer: string | null;
  creationDate: string | null;
  modDate: string | null;
  xmp: Record<string, string>;
  pageCountDeclared: number | null;
  pdfVersion: string | null;
}

export interface PdfDocument {
  pageCount: number;
  metadata: PdfMetadata;
  pages: PdfPageReport[];
  scanned: { detected: boolean; scannedPages: number[]; imagePages: number[]; heuristic: string };
  fullText: string;
  warnings: string[];
  limitations: string[];
  truncated: boolean;
}

export async function parsePdf(
  bytes: Uint8Array,
  options: { maxPages?: number; maxChars?: number; includePageText?: boolean } = {},
): Promise<PdfDocument> {
  const warnings: string[] = [];
  const limitations: string[] = [];
  const maxPages = clamp(options.maxPages ?? LIMITS.pdfMaxPagesCap, 1, LIMITS.pdfMaxPagesCap);
  const maxChars = clamp(options.maxChars ?? LIMITS.pdfMaxTextChars, 1_000, LIMITS.pdfMaxTextChars);

  const header = latin1(bytes.subarray(0, 1024));
  const headerMatch = /%PDF-(\d\.\d)/.exec(header);
  if (!headerMatch) {
    throw new BrowserError("unsupported", "This file does not carry a %PDF- header and is not a PDF.", {
      hint: "Check the URL/content-type — the bytes may be an HTML error page or another document type.",
      retryable: false,
    });
  }

  const parser = new PdfParser(bytes);
  parser.parse();
  if (parser.objects.size === 0) {
    throw new BrowserError("unsupported", "The PDF's object graph could not be scanned (no parseable objects).", { retryable: false });
  }

  // Page order: prefer the /Pages /Kids tree; fall back to object order.
  const pageRefs: Array<{ num: number; dict: PdfValue }> = [];
  const visited = new Set<number>();
  const walkKids = (value: PdfValue | undefined, depth: number): void => {
    const resolved = parser.resolve(value);
    if (!resolved || depth > 32 || pageRefs.length > maxPages) return;
    if (resolved.kind !== "dict") {
      if (resolved.kind === "array") for (const item of resolved.items) walkKids(item, depth + 1);
      return;
    }
    const type = parser.resolve(resolved.entries.get("Type"));
    const typeName = type?.kind === "name" ? type.value : null;
    const kids = resolved.entries.get("Kids");
    if (typeName === "Pages" || (kids && !resolved.entries.get("Contents"))) {
      const kidList = parser.resolve(kids);
      if (kidList?.kind === "array") for (const kid of kidList.items) {
        if (kid.kind === "ref" && visited.has(kid.num)) continue;
        if (kid.kind === "ref") visited.add(kid.num);
        walkKids(kid, depth + 1);
      }
      return;
    }
    if (typeName === "Page" || resolved.entries.has("Contents") || resolved.entries.has("Resources")) {
      const ref = [...parser.objects.values()].find((object) => object.value === resolved);
      if (ref) pageRefs.push({ num: ref.num, dict: resolved });
    }
  };
  for (const object of parser.objects.values()) {
    const type = object.value.kind === "dict" ? parser.resolve(object.value.entries.get("Type")) : null;
    if (type?.kind === "name" && type.value === "Pages") walkKids(object.value, 0);
    if (pageRefs.length >= maxPages) break;
  }
  if (pageRefs.length === 0) {
    for (const object of parser.objects.values()) {
      if (object.value.kind !== "dict") continue;
      const type = parser.resolve(object.value.entries.get("Type"));
      if (type?.kind === "name" && type.value === "Page") pageRefs.push({ num: object.num, dict: object.value });
      if (pageRefs.length >= maxPages) break;
    }
  }

  const metadata = extractMetadata(parser, headerMatch[1]);
  const pages: PdfPageReport[] = [];
  const scannedPages: number[] = [];
  const imagePages: number[] = [];
  let truncated = false;
  let totalChars = 0;

  for (let index = 0; index < Math.min(pageRefs.length, maxPages); index++) {
    const pageNumber = index + 1;
    const pageDict = pageRefs[index].dict;
    // Content streams.
    let contentBytes = new Uint8Array();
    const contentsValue = pageDict.kind === "dict" ? pageDict.entries.get("Contents") : undefined;
    const contentsResolved = parser.resolve(contentsValue);
    const streams: Uint8Array[] = [];
    const pushStream = async (value: PdfValue | undefined) => {
      const located = parser.resolveStream(value);
      if (!located?.stream) return;
      const decoded = await decodeStream(parser, located.stream, located.value);
      if (decoded.undecodable) {
        limitations.push(`page ${pageNumber}: stream filter ${decoded.undecodable} is not supported; that content is skipped.`);
        return;
      }
      streams.push(decoded.bytes);
    };
    if (contentsResolved?.kind === "array") {
      for (const item of contentsResolved.items) await pushStream(item);
    } else {
      await pushStream(contentsValue);
    }
    const totalLength = streams.reduce((sum, stream) => sum + stream.byteLength, 0);
    contentBytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const stream of streams) {
      contentBytes.set(stream, offset);
      offset += stream.byteLength;
    }

    const contentText = latin1(contentBytes).slice(0, 8_000_000);
    const chunks = interpretContent(contentText);
    const lines = chunksToLines(chunks);
    const text = lines.map((line) => line.text).filter(Boolean).join("\n");
    const pageImages = await pageImagesOf(parser, pageDict);
    const tables = detectTables(lines, pageNumber);
    const scanned = text.replace(/\s/g, "").length < LIMITS.pdfScannedPageTextThreshold && pageImages.length > 0;
    if (scanned) scannedPages.push(pageNumber);
    if (pageImages.length > 0) imagePages.push(pageNumber);

    if (totalChars + text.length > maxChars) truncated = true;
    totalChars += text.length;
    pages.push({
      page: pageNumber,
      chars: text.length,
      text: options.includePageText === false ? "" : text.slice(0, Math.max(0, maxChars - Math.max(0, totalChars - text.length))),
      imageCount: pageImages.length,
      images: pageImages,
      scanned,
      tables,
      lines: lines.length,
    });
  }

  const fullText = pages.map((page) => `[page ${page.page}]\n${page.text}`).join("\n\n");
  const scanned = {
    detected: scannedPages.length > 0 && scannedPages.length >= Math.max(1, Math.ceil(pages.length / 2)),
    scannedPages,
    imagePages,
    heuristic: "A page counts as scanned when it carries less than 40 non-space characters of extractable text and at least one embedded image.",
  };
  if (scannedPages.length > 0) {
    limitations.push("Scanned/image-only pages contain no embedded text; use pdf mode: ocr (requires the Workers AI binding) to read them.");
  }
  if (pageRefs.length > maxPages) {
    truncated = true;
    warnings.push(`Only the first ${maxPages} pages were processed.`);
  }

  return { pageCount: pageRefs.length, metadata, pages, scanned, fullText: fullText.slice(0, maxChars), warnings, limitations, truncated };
}

async function pageImagesOf(parser: PdfParser, pageDict: PdfValue): Promise<Array<{ width: number | null; height: number | null; filter: string | null; jpeg: boolean }>> {
  const out: Array<{ width: number | null; height: number | null; filter: string | null; jpeg: boolean }> = [];
  if (pageDict.kind !== "dict") return out;
  const resources = parser.resolve(pageDict.entries.get("Resources"));
  const xobjects = resources?.kind === "dict" ? parser.resolve(resources.entries.get("XObject")) : null;
  if (!xobjects || xobjects.kind !== "dict") return out;
  for (const [, reference] of xobjects.entries) {
    const located = parser.resolveStream(reference);
    if (!located || located.value.kind !== "dict") continue;
    const subtype = parser.resolve(located.value.entries.get("Subtype"));
    if (subtype?.kind !== "name" || subtype.value !== "Image") continue;
    const width = parser.resolve(located.value.entries.get("Width"));
    const height = parser.resolve(located.value.entries.get("Height"));
    const filterValue = parser.resolve(located.value.entries.get("Filter"));
    const filterName = filterValue?.kind === "name" ? filterValue.value : filterValue?.kind === "array" && filterValue.items[0]?.kind === "name" ? (filterValue.items[0] as { value: string }).value : null;
    out.push({
      width: width?.kind === "number" ? width.value : null,
      height: height?.kind === "number" ? height.value : null,
      filter: filterName,
      jpeg: filterName === "DCTDecode" || filterName === "DCT",
    });
    if (out.length >= 20) break;
  }
  return out;
}

/** Column-alignment table heuristic over positioned lines. */
function detectTables(lines: PageLine[], page: number): PdfTable[] {
  const tables: PdfTable[] = [];
  let run: PageLine[] = [];
  const flush = () => {
    if (run.length >= 3) {
      const rows = run.map((line) => line.chunks.map((chunk) => chunk.text.trim()).filter(Boolean));
      const columns = Math.max(...rows.map((row) => row.length));
      if (columns >= 3) {
        tables.push({ page, caption: null, rows: rows.map((row) => row.slice(0, 12)), columnCount: columns });
      }
    }
    run = [];
  };
  for (const line of lines) {
    if (line.chunks.length >= 3) run.push(line);
    else flush();
    if (tables.length >= 10) break;
  }
  flush();
  return tables;
}

function extractMetadata(parser: PdfParser, version: string): PdfMetadata {
  const xmp: Record<string, string> = {};
  // XMP packet scan over every stream (bounded).
  for (const object of parser.objects.values()) {
    if (!object.stream) continue;
    const text = latin1(object.stream.subarray(0, 400_000));
    const start = text.indexOf("<x:xmpmeta");
    if (start === -1) continue;
    const end = text.indexOf("</x:xmpmeta>", start);
    const packet = text.slice(start, end === -1 ? start + 200_000 : end);
    const grab = (tag: string, key: string) => {
      const match = new RegExp(`<${tag}[^>]*>([^<]{1,400})</${tag}>`).exec(packet);
      if (match) xmp[key] = match[1].trim().slice(0, 400);
    };
    grab("dc:title", "title");
    grab("dc:creator", "creator");
    grab("dc:description", "description");
    grab("pdf:Producer", "producer");
    grab("xmp:CreateDate", "createDate");
    grab("xmp:ModifyDate", "modifyDate");
    grab("pdf:Keywords", "keywords");
    break;
  }

  let info: PdfValue | null = null;
  // Info dictionary: the object carrying Title/Author/Producer/CreationDate.
  for (const object of parser.objects.values()) {
    if (object.value.kind !== "dict") continue;
    const entries = object.value.entries;
    if (entries.has("Producer") || entries.has("Title") || entries.has("Author") || entries.has("CreationDate")) {
      info = object.value;
      break;
    }
  }
  const stringValue = (dict: PdfValue | null, key: string): string | null => {
    if (!dict || dict.kind !== "dict") return null;
    const value = parser.resolve(dict.entries.get(key));
    if (value?.kind === "string") return value.value.slice(0, 400) || null;
    return null;
  };
  return {
    title: stringValue(info, "Title") ?? xmp.title ?? null,
    author: stringValue(info, "Author") ?? xmp.creator ?? null,
    subject: stringValue(info, "Subject") ?? xmp.description ?? null,
    keywords: stringValue(info, "Keywords") ?? xmp.keywords ?? null,
    creator: stringValue(info, "Creator") ?? null,
    producer: stringValue(info, "Producer") ?? xmp.producer ?? null,
    creationDate: stringValue(info, "CreationDate") ?? xmp.createDate ?? null,
    modDate: stringValue(info, "ModDate") ?? xmp.modifyDate ?? null,
    xmp,
    pageCountDeclared: null,
    pdfVersion: version,
  };
}

export interface PdfSearchMatch {
  page: number;
  line: number;
  match: string;
  context: string;
}

export function searchPdf(document: PdfDocument, query: string, options: { caseInsensitive?: boolean; regex?: boolean; limit?: number } = {}): { matches: PdfSearchMatch[]; truncated: boolean } {
  const limit = clamp(options.limit ?? LIMITS.pdfMaxSearchMatches, 1, LIMITS.pdfMaxSearchMatches);
  let matcher: RegExp;
  try {
    matcher = new RegExp(options.regex ? query.slice(0, 300) : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), options.caseInsensitive ? "i" : "");
  } catch (error) {
    throw new BrowserError("invalid_input", `The search pattern is not a valid regular expression: ${String(error instanceof Error ? error.message : error).slice(0, 140)}`, { retryable: false });
  }
  const matches: PdfSearchMatch[] = [];
  let truncated = false;
  for (const page of document.pages) {
    const lines = page.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const found = matcher.exec(lines[i]);
      if (!found) continue;
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
      matches.push({ page: page.page, line: i + 1, match: found[0], context: lines[i].slice(0, 300) });
    }
    if (truncated) break;
  }
  return { matches, truncated };
}

/* ─────────────────────────────── OCR (Workers AI) ────────────────────────── */

export interface OcrPageResult {
  page: number;
  status: "ok" | "unavailable" | "failed" | "no-embedded-image";
  text: string | null;
  provider: string | null;
  message: string;
}

/**
 * OCR scanned pages through DEMO's existing Workers AI vision binding.
 * JPEG (DCTDecode) page images are handed to the same model family the video
 * pipeline uses (VIDEO_VISION_MODEL); pages without an embedded JPEG report
 * `no-embedded-image` instead of inventing text.
 */
export async function ocrScannedPdf(
  env: Record<string, unknown> | undefined,
  bytes: Uint8Array,
  document: PdfDocument,
  options: { pages?: number[]; maxPages?: number } = {},
): Promise<{ pages: OcrPageResult[]; provider: string | null; model: string | null; message: string }> {
  const ai = (env?.AI ?? null) as { run?: (model: string, input: unknown) => Promise<unknown> } | null;
  const model = String(env?.VIDEO_VISION_MODEL ?? "@cf/llava-hf/llava-1.5-7b-hf");
  const maxPages = clamp(options.maxPages ?? LIMITS.pdfMaxOcrPages, 1, LIMITS.pdfMaxOcrPages);
  const wanted = (options.pages?.length ? options.pages : document.scanned.scannedPages).slice(0, maxPages);
  if (!ai || typeof ai.run !== "function") {
    return {
      pages: [],
      provider: null,
      model: null,
      message: "OCR is unavailable: this deployment has no Workers AI binding (AI). Configure the AI binding to enable scanned-page OCR; DEMO will not claim text it could not read.",
    };
  }

  const parser = new PdfParser(bytes);
  parser.parse();
  // Rebuild page refs in the same order as parsePdf (page N ↔ pageRefs[N-1]).
  const pageNumbers = document.pages.map((page) => page.page);
  const results: OcrPageResult[] = [];
  for (const pageNumber of wanted) {
    const index = pageNumbers.indexOf(pageNumber);
    if (index === -1) {
      results.push({ page: pageNumber, status: "failed", text: null, provider: null, message: "Page out of range." });
      continue;
    }
    const image = await firstJpegOfPage(parser, index);
    if (!image) {
      results.push({ page: pageNumber, status: "no-embedded-image", text: null, provider: null, message: "This page's image is not stored as JPEG (DCTDecode); DEMO does not rasterize other image filters without a decoder." });
      continue;
    }
    try {
      const copy = new Uint8Array(image.byteLength);
      copy.set(image);
      const raw = (await ai.run(model, {
        image: copy.buffer,
        prompt: "This is a scanned page from a document. Read all visible text and return it verbatim, preserving line breaks as plain text. Do not describe the page. If there is no readable text, return an empty string.",
      })) as { description?: string; result?: { description?: string }; text?: string } | string;
      const text = typeof raw === "string" ? raw : raw?.result?.description ?? raw?.description ?? raw?.text ?? "";
      results.push({ page: pageNumber, status: "ok", text: String(text).slice(0, 40_000) || null, provider: `cloudflare-ai:${model}`, message: "OCR output is model-generated from the page image; verify critical values against the original." });
    } catch (error) {
      results.push({ page: pageNumber, status: "failed", text: null, provider: `cloudflare-ai:${model}`, message: `The vision model rejected this page image (${String(error instanceof Error ? error.message : error).slice(0, 160)}).` });
    }
  }
  return { pages: results, provider: `cloudflare-ai:${model}`, model, message: "OCR is model-generated. Page references are preserved; compare against the PDF itself for critical text." };
}

async function firstJpegOfPage(parser: PdfParser, pageIndex: number): Promise<Uint8Array | null> {
  let seen = 0;
  for (const object of parser.objects.values()) {
    if (object.value.kind !== "dict") continue;
    const type = parser.resolve(object.value.entries.get("Type"));
    const subtype = parser.resolve(object.value.entries.get("Subtype"));
    const isPage = (type?.kind === "name" && type.value === "Page") || (object.value.entries.has("Contents") && subtype?.kind !== "name");
    if (!isPage) continue;
    seen++;
    if (seen !== pageIndex + 1) continue;
    const images = await pageImagesOf(parser, object.value);
    if (!images.some((image) => image.jpeg)) return null;
    // Locate the actual JPEG bytes.
    const resources = parser.resolve(object.value.entries.get("Resources"));
    const xobjects = resources?.kind === "dict" ? parser.resolve(resources.entries.get("XObject")) : null;
    if (!xobjects || xobjects.kind !== "dict") return null;
    for (const [, reference] of xobjects.entries) {
      const located = parser.resolveStream(reference);
      if (!located || located.value.kind !== "dict") continue;
      const subtypeValue = parser.resolve(located.value.entries.get("Subtype"));
      if (subtypeValue?.kind !== "name" || subtypeValue.value !== "Image") continue;
      const filterValue = parser.resolve(located.value.entries.get("Filter"));
      const filterName = filterValue?.kind === "name" ? filterValue.value : filterValue?.kind === "array" && filterValue.items[0]?.kind === "name" ? (filterValue.items[0] as { value: string }).value : null;
      if ((filterName === "DCTDecode" || filterName === "DCT") && located.stream) return located.stream;
    }
    return null;
  }
  return null;
}
