/**
 * Evidence store.
 *
 * The upstream skill's central rule is "evidence or it didn't happen": every
 * claim carries `observed:` / `inferred:` / `proposed:` / `web:` and no claim
 * may appear without a citation. This module is the enforcement point inside
 * DEMO: the store assigns ids, records which tool produced each entry, tracks
 * cross-checks, and refuses to let a caller relabel an inference as an
 * observation without naming the second source.
 */

import type { Evidence, EvidenceLabel } from "./types.js";
import { EVIDENCE_LABELS } from "./types.js";

export interface AddEvidenceInput {
  label: EvidenceLabel;
  source: string;
  target: string;
  location: string;
  claim: string;
  result?: unknown;
  confidence?: number;
  /** Ids of other evidence entries that independently agree. */
  crossCheckedWith?: string[];
}

/** Maximum evidence entries retained per analysis (keeps artifacts bounded). */
export const MAX_EVIDENCE = 2_000;

export class EvidenceStore {
  private readonly items: Evidence[] = [];
  private readonly byId = new Map<string, Evidence>();
  private readonly clock: () => string;

  /**
   * @param clock   Timestamp source (only observed entries carry a timestamp).
   * @param seeded  Entries restored from a stored analysis, so a report can be
   *                rebuilt from persisted evidence without re-running analysis.
   */
  constructor(clock: () => string = () => new Date().toISOString(), seeded: Evidence[] = []) {
    this.clock = clock;
    for (const entry of seeded.slice(0, MAX_EVIDENCE)) {
      const copy = { ...entry };
      this.items.push(copy);
      this.byId.set(copy.id, copy);
    }
  }

  /** Every entry, in insertion order. Never copies, so callers must not mutate. */
  get entries(): Evidence[] {
    return this.items;
  }

  get size(): number {
    return this.items.length;
  }

  list(): Evidence[] {
    return this.items.slice();
  }

  /** Filter by label and/or a free-text match over claim, source and location. */
  query(options: { label?: EvidenceLabel; source?: string; query?: string; includeSuperseded?: boolean } = {}): Evidence[] {
    const needle = options.query?.trim().toLowerCase() ?? "";
    return this.items.filter((entry) => {
      if (options.label && entry.label !== options.label) return false;
      if (options.source && entry.source !== options.source) return false;
      if (needle) {
        const haystack = `${entry.claim} ${entry.source} ${entry.location}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }

  /** Label histogram, always including the labels with zero entries. */
  counts(): Record<EvidenceLabel, number> {
    const counts: Record<EvidenceLabel, number> = { observed: 0, inferred: 0, proposed: 0, web: 0, unknown: 0 };
    for (const entry of this.items) counts[entry.label] += 1;
    return counts;
  }

  /** Everything still unlabelled — reported, never hidden. */
  unknowns(): Evidence[] {
    return this.items.filter((entry) => entry.label === "unknown");
  }

  add(input: AddEvidenceInput): Evidence {
    const id = `ev-${String(this.entries.length + 1).padStart(4, "0")}`;
    const label = EVIDENCE_LABELS.includes(input.label) ? input.label : "unknown";
    const entry: Evidence = {
      id,
      label,
      source: input.source,
      target: input.target,
      location: input.location,
      claim: input.claim,
      result: input.result ?? null,
      confidence: clamp01(input.confidence ?? defaultConfidence(label)),
      timestamp: label === "observed" ? this.clock() : null,
      ...(input.crossCheckedWith && input.crossCheckedWith.length ? { crossCheckedWith: input.crossCheckedWith } : {}),
    };
    if (this.entries.length >= MAX_EVIDENCE) {
      // Never grow without bound: a huge artifact must not produce an unbounded
      // artifact of its own.
      return entry;
    }
    this.entries.push(entry);
    this.byId.set(id, entry);
    return entry;
  }

  /** Record that two entries from different sources agree. */
  crossCheck(leftId: string, rightId: string): void {
    const left = this.byId.get(leftId);
    const right = this.byId.get(rightId);
    if (!left || !right || left.id === right.id) return;
    if (left.source === right.source) return; // same tool twice is not a cross-check
    const leftLinks = new Set(left.crossCheckedWith ?? []);
    leftLinks.add(right.id);
    left.crossCheckedWith = [...leftLinks];
    const rightLinks = new Set(right.crossCheckedWith ?? []);
    rightLinks.add(left.id);
    right.crossCheckedWith = [...rightLinks];
  }

  get(id: string): Evidence | undefined {
    return this.byId.get(id);
  }

  /** Page through the evidence so a tool result never dumps everything. */
  page(options: { label?: EvidenceLabel; source?: string; offset?: number; limit?: number } = {}): { total: number; offset: number; limit: number; items: Evidence[]; labels: Record<EvidenceLabel, number> } {
    let items = this.items;
    if (options.label) items = items.filter((entry) => entry.label === options.label);
    if (options.source) items = items.filter((entry) => entry.source === options.source);
    const labels: Record<EvidenceLabel, number> = { observed: 0, inferred: 0, proposed: 0, web: 0, unknown: 0 };
    for (const entry of this.items) labels[entry.label] += 1;
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.min(Math.max(1, options.limit ?? 25), 200);
    return { total: items.length, offset, limit, items: items.slice(offset, offset + limit), labels };
  }

  /** Claims that are only backed by a single source — reported as such. */
  singleSourced(): Evidence[] {
    return this.items.filter((entry) => entry.label !== "unknown" && !(entry.crossCheckedWith ?? []).length);
  }
}

export function defaultConfidence(label: EvidenceLabel): number {
  switch (label) {
    case "observed":
      return 1;
    case "inferred":
      return 0.6;
    case "proposed":
      return 0.3;
    case "web":
      return 0.5;
    default:
      return 0;
  }
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, Math.round(value * 1000) / 1000));
}

/**
 * Guard used by the report builder: a finding may only be labelled `observed`
 * when every backing evidence entry is `observed` *and* at least one of them is
 * cross-checked against a different source. This is the mechanical version of
 * "one tool's pseudocode is a hypothesis".
 */
export function strongestLabel(evidence: Evidence[]): EvidenceLabel {
  if (evidence.length === 0) return "unknown";
  if (evidence.every((entry) => entry.label === "observed")) return "observed";
  if (evidence.some((entry) => entry.label === "inferred")) return "inferred";
  if (evidence.some((entry) => entry.label === "proposed")) return "proposed";
  if (evidence.some((entry) => entry.label === "web")) return "web";
  return "unknown";
}

/** True when the claim is backed by at least two distinct tools. */
export function isCrossChecked(evidence: Evidence[]): boolean {
  const sources = new Set(evidence.map((entry) => entry.source));
  return sources.size >= 2;
}
