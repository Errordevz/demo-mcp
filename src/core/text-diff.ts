/**
 * Local text/document diff engine (DEMO 0.9 shared utility).
 *
 * Everything here runs inside the Worker: no external diff service, no uploads.
 * The module is the single diff implementation for `text_diff`, `web_diff`,
 * website monitoring change summaries and `git_repository` patches, so the
 * capabilities stay consistent and nothing duplicates the algorithm.
 *
 * Algorithm: trim common prefix/suffix, then Myers' O(ND) greedy LCS walk with
 * an edit budget; beyond the budget it degrades to a deterministic
 * "sections differ" summary instead of burning CPU. Output shapes are
 * structured first (coding agents), with a unified-diff renderer on top.
 */

import { BrowserError } from "./errors.js";
import { LIMITS, clamp } from "./limits.js";

export type DiffOpKind = "equal" | "insert" | "delete";

export interface DiffOp {
  op: DiffOpKind;
  /** 1-based line in side A (absent for inserts). */
  aLine?: number;
  /** 1-based line in side B (absent for deletes). */
  bLine?: number;
  text: string;
}

export interface LineDiff {
  ops: DiffOp[];
  added: number;
  removed: number;
  unchanged: number;
  /** 0..1 Jaccard-style similarity over equal lines vs total. */
  similarity: number;
  truncated: boolean;
}

export function splitLines(value: string): string[] {
  if (value === "") return [];
  return value.replace(/\r\n?/g, "\n").split("\n");
}

/**
 * Myers-style line diff with prefix/suffix trimming and an edit budget.
 * `maxEdits` bounds the greedy walk; exceeding it returns `null` so callers
 * can fall back to a coarser comparison.
 */
export function diffLines(aInput: string, bInput: string, options: { maxLines?: number; maxEdits?: number } = {}): LineDiff {
  const maxLines = clamp(options.maxLines ?? LIMITS.diffMaxLinesDefault, 50, LIMITS.diffMaxLinesCap);
  const a = splitLines(aInput);
  const b = splitLines(bInput);
  if (a.length > maxLines || b.length > maxLines) {
    throw new BrowserError("size_limit_exceeded", `Each side may have at most ${maxLines} lines (got ${a.length} and ${b.length}).`, {
      hint: "Compare smaller documents, or raise per-call max_lines (still bounded by the deployment limit).",
      retryable: false,
    });
  }
  const maxEdits = Math.max(16, Math.min(options.maxEdits ?? 2_000, maxLines * 4));
  const ops = myersDiff(a, b, maxEdits);
  if (!ops) {
    // Diverged beyond the edit budget: report honestly rather than lie.
    return {
      ops: [
        { op: "delete", aLine: 1, text: `[${a.length} lines — previous]` },
        { op: "insert", bLine: 1, text: `[${b.length} lines — current]` },
      ],
      added: b.length,
      removed: a.length,
      unchanged: 0,
      similarity: 0,
      truncated: true,
    };
  }
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const op of ops) {
    if (op.op === "insert") added++;
    else if (op.op === "delete") removed++;
    else unchanged++;
  }
  const total = Math.max(1, a.length, b.length);
  return { ops, added, removed, unchanged, similarity: Math.round((unchanged / total) * 1000) / 1000, truncated: false };
}

function myersDiff(a: string[], b: string[], maxEdits: number): DiffOp[] | null {
  // Trim the common prefix and suffix so the walk only sees the changed core.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const prefix: DiffOp[] = [];
  for (let i = 0; i < start; i++) prefix.push({ op: "equal", aLine: i + 1, bLine: i + 1, text: a[i] });
  const suffix: DiffOp[] = [];
  for (let k = 0; k < a.length - endA; k++) suffix.push({ op: "equal", aLine: endA + k + 1, bLine: endB + k + 1, text: a[endA + k] });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n === 0 && m === 0) return [...prefix, ...suffix];

  const maxD = Math.min(maxEdits, n + m);
  const offset = maxD + 2;
  const vSize = 2 * offset + 1;
  const v = new Int32Array(vSize);
  const trace: Int32Array[] = [];
  v[offset + 1] = 0;
  let solved = false;
  for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && midA[x] === midB[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        solved = true;
        break;
      }
    }
    if (solved) break;
  }
  if (!solved) return null;

  // Backtrack (classic Myers traceback) producing reversed steps, then flip.
  const reversed: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const snapshot = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && snapshot[offset + k - 1] < snapshot[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = snapshot[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      reversed.push({ op: "equal", aLine: start + x, bLine: start + y, text: midA[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) reversed.push({ op: "insert", bLine: start + prevY + 1, text: midB[prevY] });
      else reversed.push({ op: "delete", aLine: start + prevX + 1, text: midA[prevX] });
      x = prevX;
      y = prevY;
    }
  }
  reversed.reverse();
  return [...prefix, ...reversed, ...suffix];
}

export interface ChangedSection {
  a_start_line: number;
  a_end_line: number;
  b_start_line: number;
  b_end_line: number;
  removed: string[];
  added: string[];
}

/** Grouped changed sections (what humans scan; what monitors diff against). */
export function changedSections(diff: LineDiff): ChangedSection[] {
  const sections: ChangedSection[] = [];
  let current: ChangedSection | null = null;
  const flush = () => {
    if (current) sections.push(current);
    current = null;
  };
  for (const op of diff.ops) {
    if (op.op === "equal") {
      if (current && (current.removed.length || current.added.length)) flush();
      continue;
    }
    if (!current) {
      current = {
        a_start_line: op.aLine ?? 0,
        a_end_line: op.aLine ?? 0,
        b_start_line: op.bLine ?? 0,
        b_end_line: op.bLine ?? 0,
        removed: [],
        added: [],
      };
    }
    if (op.op === "delete") {
      current.removed.push(op.text);
      current.a_end_line = op.aLine ?? current.a_end_line;
    } else {
      current.added.push(op.text);
      current.b_end_line = op.bLine ?? current.b_end_line;
    }
  }
  flush();
  return sections.slice(0, 200);
}

/** unified-diff style rendering (no git context requirements; ~3 lines context). */
export function toUnifiedDiff(diff: LineDiff, fileLabelA = "a", fileLabelB = "b", contextLines = 3): string {
  const out: string[] = [`--- ${fileLabelA}`, `+++ ${fileLabelB}`];
  const ops = diff.ops;
  let i = 0;
  let budget = LIMITS.diffMaxOutputBytes;
  while (i < ops.length && budget > 0) {
    while (i < ops.length && ops[i].op === "equal") i++;
    if (i >= ops.length) break;
    const hunkStart = Math.max(0, i - contextLines);
    let j = i;
    let trailingEqual = 0;
    while (j < ops.length && (ops[j].op !== "equal" || trailingEqual < contextLines)) {
      if (ops[j].op === "equal") trailingEqual++;
      else trailingEqual = 0;
      j++;
    }
    const hunk = ops.slice(hunkStart, j);
    const firstA = hunk.find((op) => op.aLine !== undefined)?.aLine ?? 0;
    const firstB = hunk.find((op) => op.bLine !== undefined)?.bLine ?? 0;
    const countA = hunk.filter((op) => op.op !== "insert").length;
    const countB = hunk.filter((op) => op.op !== "delete").length;
    const header = `@@ -${firstA},${countA} +${firstB},${countB} @@`;
    budget -= header.length;
    out.push(header);
    for (const op of hunk) {
      const prefix = op.op === "insert" ? "+" : op.op === "delete" ? "-" : " ";
      const line = `${prefix}${op.text}`;
      budget -= line.length + 1;
      if (budget <= 0) {
        out.push("…[diff truncated by size limit]");
        return out.join("\n");
      }
      out.push(line);
    }
    i = j;
  }
  return out.join("\n");
}

/* ────────────────────────────── JSON diff ────────────────────────────────── */

export interface JsonDiffEntry {
  path: string;
  change: "added" | "removed" | "changed" | "type_changed";
  before?: unknown;
  after?: unknown;
}

function preview(value: unknown): unknown {
  if (typeof value === "string" && value.length > 240) return `${value.slice(0, 240)}…`;
  if (value !== null && typeof value === "object") {
    const text = JSON.stringify(value) ?? "";
    return text.length > 240 ? `[${Array.isArray(value) ? "array" : "object"} ${text.length} chars]` : value;
  }
  return value;
}

export function diffJson(a: unknown, b: unknown, maxEntries = 500): { entries: JsonDiffEntry[]; truncated: boolean } {
  const entries: JsonDiffEntry[] = [];
  const walkValue = (left: unknown, right: unknown, path: string): void => {
    if (entries.length >= maxEntries) return;
    if (left === right) return;
    const leftType = jsonType(left);
    const rightType = jsonType(right);
    if (leftType !== rightType) {
      entries.push({ path, change: "type_changed", before: preview(left), after: preview(right) });
      return;
    }
    if (leftType === "object") {
      const lo = left as Record<string, unknown>;
      const ro = right as Record<string, unknown>;
      for (const key of new Set([...Object.keys(lo), ...Object.keys(ro)])) {
        if (entries.length >= maxEntries) return;
        const inLeft = Object.prototype.hasOwnProperty.call(lo, key);
        const inRight = Object.prototype.hasOwnProperty.call(ro, key);
        if (inLeft && !inRight) entries.push({ path: joinPointer(path, key), change: "removed", before: preview(lo[key]) });
        else if (!inLeft && inRight) entries.push({ path: joinPointer(path, key), change: "added", after: preview(ro[key]) });
        else walkValue(lo[key], ro[key], joinPointer(path, key));
      }
      return;
    }
    if (leftType === "array") {
      const la = left as unknown[];
      const rb = right as unknown[];
      const shared = Math.min(la.length, rb.length);
      for (let i = 0; i < shared; i++) {
        if (entries.length >= maxEntries) return;
        walkValue(la[i], rb[i], `${path}/${i}`);
      }
      for (let i = shared; i < la.length; i++) entries.push({ path: `${path}/${i}`, change: "removed", before: preview(la[i]) });
      for (let i = shared; i < rb.length; i++) entries.push({ path: `${path}/${i}`, change: "added", after: preview(rb[i]) });
      return;
    }
    entries.push({ path, change: "changed", before: preview(left), after: preview(right) });
  };
  walkValue(a, b, "");
  return { entries: entries.slice(0, maxEntries), truncated: entries.length >= maxEntries };
}

function joinPointer(path: string, key: string): string {
  const escaped = key.replace(/~/g, "~0").replace(/\//g, "~1");
  return `${path}/${escaped}`;
}

export function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Normalize obvious dynamic noise before comparing webpages (timestamps,
 * session-ish numbers, whitespace) so a snapshot check reports *content*
 * change rather than "a clock ticks".
 */
export function normalizeForDiff(text: string, preset: "web-noise" | "whitespace" | "none" = "web-noise"): string {
  if (preset === "none") return text;
  let out = text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");
  if (preset === "whitespace") return out.trim();
  out = out
    .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?\.?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:uary)?\.?\s+\d{1,2},?\s+\d{4}[, ]+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?/g, "<date>")
    .replace(/\b\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?\b/g, "<date>")
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "<date>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:s|sec|secs|seconds|min|mins|minutes|hours?|days?|weeks?|months?|years?)\s+ago\b/gi, "<age>")
    .replace(/\b\d+(?:,\d{3})*(?:\.\d+)?\s*(views|reads|likes|shares|comments|downloads|subscribers|followers)\b/gi, "<count> $1")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<token>")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out;
}

/** Structured summary for tool results (humans + coding agents). */
export function summarizeDiff(diff: LineDiff) {
  return {
    added_lines: diff.added,
    removed_lines: diff.removed,
    unchanged_lines: diff.unchanged,
    similarity: diff.similarity,
    changed: diff.added + diff.removed,
    identical: diff.added === 0 && diff.removed === 0 && !diff.truncated,
    truncated: diff.truncated,
  };
}
