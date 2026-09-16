/**
 * Dynamic frame planning for `inspect_video`.
 *
 * The plan is duration-aware and intent-aware:
 *
 *  - short clips get dense coverage (so a 6-second surprise is not missed);
 *  - longer videos get intelligent sampling with a strict cap;
 *  - the first and last meaningful frames are always included;
 *  - "what happens at the end?" biases extra frames into the final quarter;
 *  - duplicate/near-duplicate timestamps are collapsed.
 *
 * Pure functions only: fully unit-testable without a browser or network.
 */

import { LIMITS, clamp } from "../core/limits.js";
import type { IntentFocus } from "./intent.js";

/** Frame budget per duration bucket (spec: <10s → 5–10, 10–60s → 8–16, longer → capped). */
export function planFrameCount(durationSeconds: number | null): number {
  if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return 8;
  if (durationSeconds < 10) return clamp(Math.round(Math.max(5, durationSeconds * 0.8)), 5, 8);
  if (durationSeconds <= 60) return clamp(Math.round(durationSeconds / 5), 8, 12);
  return clamp(Math.round(durationSeconds / 30), 8, LIMITS.videoFramesMaxCount);
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

function evenSpread(start: number, end: number, count: number): number[] {
  if (count <= 1) return [round3((start + end) / 2)];
  const step = (end - start) / (count - 1);
  return Array.from({ length: count }, (_unused, i) => round3(start + step * i));
}

/** Sort, drop near-duplicate timestamps (<100 ms apart), and cap the count. */
function dedupeSorted(values: number[], max: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const output: number[] = [];
  for (const value of sorted) {
    if (output.length && value - output[output.length - 1] < 0.1) continue;
    output.push(round3(value));
    if (output.length >= max) break;
  }
  return output;
}

/**
 * Timestamps covering the whole video, always including a first meaningful
 * frame (just after 0s, which is often black) and a final meaningful frame
 * (just before the true end). Focus "ending"/"beginning" packs roughly half of
 * the budget densely into the relevant quarter while keeping wide coverage.
 */
export function planFrameTimestamps(durationSeconds: number, count: number, focus: IntentFocus = "general"): number[] {
  const duration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
  const total = clamp(count, 1, LIMITS.videoFramesMaxCount);
  if (duration <= 0) return [0];
  const first = Math.min(0.25, duration * 0.02);
  const last = Math.max(first + 0.05, duration - Math.max(0.05, duration * 0.02));
  if (total === 1) return [round3((first + last) / 2)];
  if (focus === "ending" && total >= 4) {
    const wide = evenSpread(first, last, Math.ceil(total / 2));
    const dense = evenSpread(Math.max(first, duration * 0.75), last, Math.floor(total / 2));
    return dedupeSorted([...wide, ...dense], total);
  }
  if (focus === "beginning" && total >= 4) {
    const wide = evenSpread(first, last, Math.ceil(total / 2));
    const dense = evenSpread(first, Math.min(last, duration * 0.25), Math.floor(total / 2));
    return dedupeSorted([...dense, ...wide], total);
  }
  return dedupeSorted(evenSpread(first, last, total), total);
}
