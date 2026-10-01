/**
 * Clean-room reimplementation workflow.
 *
 * Ports upstream `references/07-cleanroom.md`:
 *
 *   1. collect observations,
 *   2. freeze the behavioural specification,
 *   3. identify inputs, outputs and state transitions,
 *   4. create golden test cases,
 *   5. compare the reimplementation's behaviour against them,
 *   6. report the mismatches.
 *
 * The one-way wall is enforced structurally: a clean-room specification contains
 * only evidence-referenced behaviour, never decompiled code, and the comparison
 * step consumes *captured outputs* — DEMO never executes the reimplementation
 * and never executes the original target. There is no code path here that runs
 * user-supplied code.
 */

export interface CleanRoomObservation {
  id: string;
  /** What was observed, in one sentence. */
  statement: string;
  /** Which tool/source produced it. */
  source: string;
  /** Where in the target it was observed. */
  location: string;
  label: "observed" | "inferred" | "proposed" | "web" | "unknown";
}

export interface CleanRoomSpecification {
  schema: 1;
  target: string;
  frozenAt: string;
  purpose: string;
  inputs: CleanRoomObservation[];
  outputs: CleanRoomObservation[];
  stateTransitions: CleanRoomObservation[];
  invariants: CleanRoomObservation[];
  /** Fields/structures the specification still cannot describe. */
  unknowns: string[];
  /** The wall: what this document deliberately does NOT contain. */
  excluded: string[];
}

export interface GoldenCase {
  id: string;
  description: string;
  input: string;
  expectedOutput: string | null;
  /** Evidence id that produced this case, or null when caller-supplied. */
  fromEvidence?: string | null;
  inputEncoding: "hex" | "base64" | "utf8";
  expectedEncoding: "hex" | "base64" | "utf8";
}

export interface ComparisonCase {
  id: string;
  /** The reimplementation's actual output, captured by the caller. */
  actualOutput: string;
  encoding?: "hex" | "base64" | "utf8";
}

export interface ComparisonResult {
  id: string;
  matched: boolean;
  expected: string | null;
  actual: string;
  /** Why it did not match, in bytes. */
  firstDifference: number | null;
  detail: string;
}

export interface CleanRoomComparison {
  schema: 1;
  total: number;
  matched: number;
  mismatched: number;
  unmatchedExpected: number;
  results: ComparisonResult[];
  verdict: "behaviour-equivalent-on-captured-cases" | "differences-found" | "insufficient-cases";
  notes: string[];
}

/** Freeze a behavioural specification from collected observations. */
export function freezeSpecification(input: {
  target: string;
  purpose: string;
  observations: CleanRoomObservation[];
  now?: string;
}): CleanRoomSpecification {
  const byKind = (label: CleanRoomObservation["label"]) => input.observations.filter((entry) => entry.label === label);
  const unknowns = input.observations.filter((entry) => entry.label === "unknown" || entry.label === "proposed").map((entry) => `${entry.id}: ${entry.statement}`);
  return {
    schema: 1,
    target: input.target,
    frozenAt: input.now ?? new Date().toISOString(),
    purpose: input.purpose,
    inputs: input.observations.filter((entry) => /input|request|reads|accepts|argument/i.test(entry.statement)),
    outputs: input.observations.filter((entry) => /output|response|writes|emits|returns|produces/i.test(entry.statement)),
    stateTransitions: input.observations.filter((entry) => /state|transition|handshake|session|phase/i.test(entry.statement)),
    invariants: input.observations.filter((entry) => /always|never|must|invariant|constant/i.test(entry.statement)),
    unknowns: unknowns.length ? unknowns : ["No unknown observations were recorded; verify that the observation set is complete before treating this as final."],
    excluded: [
      "Decompiled or disassembled source from the original target.",
      "Original identifiers, comments, assets, icons or branding.",
      "Any verbatim code from the original implementation.",
    ],
  };
}

/** Derive golden test cases from captured evidence. */
export function deriveGoldenCases(input: {
  /** Captured messages, one per case, already bounded. */
  captures?: Array<{ bytes: Uint8Array; description: string; evidenceId?: string }>;
  /** Caller-supplied cases, e.g. from a recorded trace. */
  supplied?: GoldenCase[];
  maxCases?: number;
}): GoldenCase[] {
  const max = input.maxCases ?? 32;
  const out: GoldenCase[] = [];
  for (const capture of input.captures ?? []) {
    if (out.length >= max) break;
    out.push({
      id: `golden-${String(out.length + 1).padStart(3, "0")}`,
      description: capture.description,
      input: toHex(capture.bytes),
      expectedOutput: null,
      fromEvidence: capture.evidenceId ?? null,
      inputEncoding: "hex",
      expectedEncoding: "hex",
    });
  }
  for (const supplied of input.supplied ?? []) {
    if (out.length >= max) break;
    out.push({ ...supplied, id: supplied.id || `golden-${String(out.length + 1).padStart(3, "0")}` });
  }
  return out;
}

/**
 * Compare a reimplementation's captured outputs against the golden cases.
 * The reimplementation is never executed: the caller runs it and reports what
 * it produced, and DEMO reports the differences byte-exactly.
 */
export function compareAgainstGolden(golden: GoldenCase[], actual: ComparisonCase[]): CleanRoomComparison {
  const results: ComparisonResult[] = [];
  const byId = new Map(golden.map((entry) => [entry.id, entry]));
  const used = new Set<string>();

  for (const entry of actual) {
    const expected = byId.get(entry.id);
    used.add(entry.id);
    if (!expected) {
      results.push({ id: entry.id, matched: false, expected: null, actual: entry.actualOutput, firstDifference: null, detail: "No golden case with this id exists." });
      continue;
    }
    if (!expected.expectedOutput) {
      results.push({ id: entry.id, matched: false, expected: null, actual: entry.actualOutput, firstDifference: null, detail: "The golden case has no recorded expected output, so equivalence cannot be asserted." });
      continue;
    }
    const expectedBytes = decode(expected.expectedOutput, expected.expectedEncoding);
    const actualBytes = decode(entry.actualOutput, entry.encoding ?? expected.expectedEncoding);
    const difference = firstDifference(expectedBytes, actualBytes);
    results.push({
      id: entry.id,
      matched: difference === null,
      expected: expected.expectedOutput,
      actual: entry.actualOutput,
      firstDifference: difference,
      detail:
        difference === null
          ? "Byte-for-byte identical on this case."
          : `First difference at byte ${difference}: expected 0x${expectedBytes[difference]?.toString(16).padStart(2, "0") ?? "?"}, got 0x${actualBytes[difference]?.toString(16).padStart(2, "0") ?? "?"} (expected ${expectedBytes.byteLength} bytes, got ${actualBytes.byteLength}).`,
    });
  }

  const matched = results.filter((entry) => entry.matched).length;
  const mismatched = results.length - matched;
  const unmatchedExpected = golden.filter((entry) => !used.has(entry.id) && entry.expectedOutput).length;

  return {
    schema: 1,
    total: results.length,
    matched,
    mismatched,
    unmatchedExpected,
    results,
    verdict: results.length === 0 ? "insufficient-cases" : mismatched === 0 && unmatchedExpected === 0 ? "behaviour-equivalent-on-captured-cases" : "differences-found",
    notes: [
      "Equivalence here is limited to the captured cases: it is evidence, not a proof of general equivalence.",
      unmatchedExpected > 0 ? `${unmatchedExpected} golden case(s) were never exercised by the reimplementation.` : "Every golden case was exercised.",
      "DEMO never executed the reimplementation or the original target to produce this comparison.",
    ],
  };
}

function firstDifference(a: Uint8Array, b: Uint8Array): number | null {
  const length = Math.max(a.byteLength, b.byteLength);
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return null;
}

function decode(value: string, encoding: "hex" | "base64" | "utf8"): Uint8Array {
  if (encoding === "utf8") return new TextEncoder().encode(value);
  if (encoding === "base64") {
    const binary = atob(value.trim());
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  const clean = value.replace(/[^0-9a-fA-F]/g, "");
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.byteLength; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes.subarray(0, 4096)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
