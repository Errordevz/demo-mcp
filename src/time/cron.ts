/**
 * Cron expression utilities (DEMO 0.9) — local, deterministic, no service.
 *
 * Supports standard 5-field cron (minute hour day-of-month month day-of-week)
 * and the common 6-field extension with a leading seconds field, plus the
 * @yearly/@annually/@monthly/@weekly/@daily/@midnight/@hourly macros. Fields
 * accept `* , - /` and month/weekday names. Day-of-month and day-of-week use
 * Vixie semantics (both restricted → either matching fires). Occurrence
 * computation is bounded to a 5-year horizon and returns [] with a message
 * when nothing matches (e.g. `0 0 30 2 *`).
 */

import { LIMITS, clamp } from "../core/limits.js";

export interface CronFieldSpec {
  field: string;
  raw: string;
  values: number[];
  min: number;
  max: number;
  description: string;
}

export interface CronExplanation {
  valid: boolean;
  expression: string;
  format: "5-field" | "6-field(seconds)" | "macro";
  macro: string | null;
  fields: CronFieldSpec[];
  human: string;
  warnings: string[];
  error: string | null;
}

export interface CronOccurrence {
  next: string[];
  from: string;
  horizonDays: number;
  message: string;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

export function explainCron(expression: string): CronExplanation {
  const warnings: string[] = [];
  const raw = String(expression ?? "").trim();
  if (!raw) return invalid(raw, "A cron expression is required.");
  let body = raw;
  let macro: string | null = null;
  if (raw.startsWith("@")) {
    macro = raw.toLowerCase().split(/\s+/)[0];
    const expansion = MACROS[macro];
    if (!expansion) return invalid(raw, `Unknown macro "${macro}". Supported: ${Object.keys(MACROS).join(", ")}.`);
    body = expansion;
    if (raw.split(/\s+/).length > 1) warnings.push("Text after the @macro was ignored.");
  }

  const parts = body.split(/\s+/).filter(Boolean);
  const hasSeconds = parts.length === 6;
  if (parts.length !== 5 && parts.length !== 6) {
    return invalid(raw, `Expected 5 fields (min hour dom mon dow) or 6 fields with leading seconds — got ${parts.length}.`);
  }

  const fields: CronFieldSpec[] = [];
  const labels: Array<{ name: string; min: number; max: number; description: string }> = hasSeconds
    ? [
        { name: "seconds", min: 0, max: 59, description: "seconds (0-59)" },
        { name: "minute", min: 0, max: 59, description: "minutes (0-59)" },
        { name: "hour", min: 0, max: 23, description: "hours (0-23)" },
        { name: "day-of-month", min: 1, max: 31, description: "day of month (1-31)" },
        { name: "month", min: 1, max: 12, description: "month (1-12 or JAN-DEC)" },
        { name: "day-of-week", min: 0, max: 7, description: "day of week (0-7, 0 and 7 = Sunday, or SUN-SAT)" },
      ]
    : [
        { name: "minute", min: 0, max: 59, description: "minutes (0-59)" },
        { name: "hour", min: 0, max: 23, description: "hours (0-23)" },
        { name: "day-of-month", min: 1, max: 31, description: "day of month (1-31)" },
        { name: "month", min: 1, max: 12, description: "month (1-12 or JAN-DEC)" },
        { name: "day-of-week", min: 0, max: 7, description: "day of week (0-7, 0 and 7 = Sunday, or SUN-SAT)" },
      ];

  for (let i = 0; i < parts.length; i++) {
    const label = labels[i];
    const spec = parseField(parts[i], label, warnings);
    if (!spec) return invalid(raw, `The ${label.name} field "${parts[i]}" is malformed. Use *, lists, ranges and steps (e.g. 1-5, 0/15, MON-FRI).`);
    fields.push(spec);
  }

  const names = fields.map((field) => field.field);
  const minuteSpec = fields.find((f) => f.field === "minute");
  const hourSpec = fields.find((f) => f.field === "hour");
  const domSpec = fields.find((f) => f.field === "day-of-month");
  const monthSpec = fields.find((f) => f.field === "month");
  const dowSpec = fields.find((f) => f.field === "day-of-week");
  const secondSpec = fields.find((f) => f.field === "seconds");

  const describeList = (spec: CronFieldSpec | undefined, unit: string, plural?: string): string => {
    if (!spec) return "";
    if (spec.raw === "*") return `every ${unit}`;
    if (/^\*\/\d+$/.test(spec.raw)) return `every ${spec.raw.slice(2)} ${plural ?? `${unit}s`}`;
    return `${unit} ${listText(spec.values)}`;
  };

  const monthText = describeList(monthSpec, "in month");
  const domText = describeList(domSpec, "on day");
  const dowText = describeList(dowSpec, "on weekday");
  const dayText =
    domSpec?.raw === "*" && dowSpec?.raw === "*"
      ? "every day"
      : domSpec?.raw === "*"
        ? dowText
        : dowSpec?.raw === "*"
          ? domText
          : `${domText} or ${dowText} (Vixie: either match fires)`;
  const human = [
    secondSpec && secondSpec.raw !== "0" && secondSpec.raw !== "*" ? describeList(secondSpec, "second") : null,
    describeList(minuteSpec, "at minute", "minutes"),
    describeList(hourSpec, "past hour", "hours"),
    dayText,
    monthSpec?.raw === "*" ? "" : monthText,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    valid: true,
    expression: raw,
    format: macro ? "macro" : hasSeconds ? "6-field(seconds)" : "5-field",
    macro,
    fields: fields.filter((field) => names.includes(field.field)),
    human: `Runs ${human}.`,
    warnings,
    error: null,
  };

  function invalid(expression: string, error: string): CronExplanation {
    return { valid: false, expression, format: "5-field", macro: null, fields: [], human: "", warnings, error };
  }
}

function listText(values: number[]): string {
  if (values.length > 12) return `${values.slice(0, 12).join(", ")}… (${values.length} values)`;
  return values.join(", ");
}

function parseField(raw: string, label: { name: string; min: number; max: number; description: string }, warnings: string[]): CronFieldSpec | null {
  const values = new Set<number>();
  const segments = raw.split(",");
  for (const segment of segments) {
    if (!segment) return null;
    const [rangePart, stepPart, ...extra] = segment.split("/");
    if (extra.length > 0) return null;
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) return null;
      step = Number(stepPart);
      if (step < 1 || step > label.max) return null;
    }
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = label.min;
      end = label.max;
    } else if (/^\d+$/.test(rangePart)) {
      start = normalizeValue(rangePart, label.name);
      end = stepPart !== undefined ? label.max : start;
    } else if (/^[A-Za-z]{3}-[A-Za-z]{3}$/.test(rangePart) || /^\d+-\d+$/.test(rangePart)) {
      const [from, to] = rangePart.split("-");
      start = normalizeValue(from, label.name);
      end = normalizeValue(to, label.name);
    } else if (/^[A-Za-z]{3}$/.test(rangePart)) {
      start = normalizeValue(rangePart, label.name);
      end = stepPart !== undefined ? label.max : start;
    } else {
      return null;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start < label.min || start > label.max || end < label.min || end > label.max) return null;
    if (start > end) {
      // Wrap-around ranges (FRI-MON) are accepted with a note.
      warnings.push(`${label.name} range "${segment}" wraps around; values from both ends are included.`);
      for (let value = start; value <= label.max; value += step) values.add(normalizeDow(value, label.name));
      for (let value = label.min; value <= end; value += step) values.add(normalizeDow(value, label.name));
      continue;
    }
    for (let value = start; value <= end; value += step) values.add(normalizeDow(value, label.name));
  }
  const sorted = [...values].sort((a, b) => a - b);
  return { field: label.name, raw, values: sorted, min: label.min, max: label.max, description: label.description };
}

function normalizeValue(token: string, fieldName: string): number {
  if (/^\d+$/.test(token)) return Number(token);
  const lower = token.toLowerCase();
  if (fieldName === "month") {
    const index = MONTH_NAMES.indexOf(lower);
    return index === -1 ? NaN : index + 1;
  }
  if (fieldName === "day-of-week") {
    const index = DAY_NAMES.indexOf(lower);
    return index === -1 ? NaN : index;
  }
  return NaN;
}

function normalizeDow(value: number, fieldName: string): number {
  // 7 == 0 == Sunday.
  return fieldName === "day-of-week" && value === 7 ? 0 : value;
}

/** Next execution times after `from` (bounded brute-force over days, fast). */
export function nextCronOccurrences(expression: string, options: { from?: Date; count?: number; horizonDays?: number } = {}): CronExplanation & { occurrences: CronOccurrence } {
  const explanation = explainCron(expression);
  const from = options.from ?? new Date();
  const count = clamp(options.count ?? 5, 1, LIMITS.cronMaxOccurrences);
  const horizonDays = clamp(options.horizonDays ?? 366, 1, LIMITS.cronSearchHorizonDays);
  const empty: CronOccurrence = { next: [], from: from.toISOString(), horizonDays, message: "" };
  if (!explanation.valid) return { ...explanation, occurrences: empty };

  const secondsField = explanation.fields.find((field) => field.field === "seconds");
  const minuteField = explanation.fields.find((field) => field.field === "minute")!;
  const hourField = explanation.fields.find((field) => field.field === "hour")!;
  const domField = explanation.fields.find((field) => field.field === "day-of-month")!;
  const monthField = explanation.fields.find((field) => field.field === "month")!;
  const dowField = explanation.fields.find((field) => field.field === "day-of-week")!;
  const seconds = secondsField ? secondsField.values : [0];

  const results: string[] = [];
  const cursor = new Date(from.getTime());
  cursor.setUTCMilliseconds(0);
  if (!secondsField) cursor.setUTCSeconds(0, 0);

  const deadline = from.getTime() + horizonDays * 86_400_000;
  // Walk days up to the horizon in UTC (Cloudflare Workers run in UTC, and a
  // deterministic clock is the only honest one for a schedule calculator).
  const dayCursor = new Date(cursor.getTime());
  dayCursor.setUTCHours(0, 0, 0, 0);
  while (dayCursor.getTime() <= deadline && results.length < count) {
    const month = dayCursor.getUTCMonth() + 1;
    const dayOfMonth = dayCursor.getUTCDate();
    const dayOfWeek = dayCursor.getUTCDay();
    const domMatch = domField.values.includes(dayOfMonth);
    const dowMatch = dowField.values.includes(dayOfWeek);
    // Vixie semantics: both restricted → OR; otherwise AND of the restricted one.
    const domRestricted = domField.raw !== "*";
    const dowRestricted = dowField.raw !== "*";
    const dayMatches = monthField.values.includes(month) && (domRestricted && dowRestricted ? domMatch || dowMatch : domMatch && dowMatch);
    if (dayMatches) {
      outer: for (const hour of hourField.values) {
        for (const minute of minuteField.values) {
          for (const second of seconds) {
            const candidate = new Date(dayCursor.getTime());
            candidate.setUTCHours(hour, minute, second, 0);
            if (candidate.getTime() <= from.getTime()) continue;
            if (candidate.getTime() > deadline) break outer;
            results.push(candidate.toISOString());
            if (results.length >= count) break outer;
          }
        }
      }
    }
    dayCursor.setUTCDate(dayCursor.getUTCDate() + 1);
  }

  return {
    ...explanation,
    occurrences: {
      next: results,
      from: from.toISOString(),
      horizonDays,
      message: results.length
        ? `${results.length} upcoming occurrence(s) within ${horizonDays} days.`
        : `No occurrence within ${horizonDays} days — check the day-of-month/month combination (e.g. 30 February never matches).`,
    },
  };
}
