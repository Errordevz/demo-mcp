/**
 * Struct layout validation — a direct port of upstream `scripts/validate_struct.py`.
 *
 * Recovered layouts are full of the same mistakes: overlapping offsets, a field
 * that starts before the previous one ends, a total size the fields do not fill.
 * Those are arithmetic errors, so they are checked by code, not by eye.
 */

import { parseCount } from "./binary-reader.js";

export interface StructFieldInput {
  name?: string;
  offset: unknown;
  size: unknown;
  type?: string;
  note?: string;
}

export interface StructField {
  name: string;
  offset: number;
  size: number;
  type: string | null;
}

export interface StructValidation {
  ok: boolean;
  fields: StructField[];
  errors: string[];
  padding: Array<{ before: string; at: number; bytes: number }>;
  trailingPadding: number | null;
  totalSize: number | null;
  endOffset: number;
}

export function validateStructLayout(input: { fields?: StructFieldInput[]; total_size?: unknown; align?: unknown }): StructValidation {
  const errors: string[] = [];
  const fields: StructField[] = [];
  const align = parseCount(input.align) ?? 1;

  (input.fields ?? []).forEach((field, index) => {
    const name = String(field.name ?? `field_${index}`).slice(0, 64);
    const offset = parseCount(field.offset);
    const size = parseCount(field.size);
    if (offset === null || size === null) {
      errors.push(`Missing or unparseable offset/size for "${name}".`);
      return;
    }
    if (offset < 0) errors.push(`Negative offset ${offset} for "${name}".`);
    if (size <= 0) errors.push(`Non-positive size ${size} for "${name}".`);
    fields.push({ name, offset, size, type: field.type ? String(field.type).slice(0, 32) : null });
  });

  const totalSize = parseCount(input.total_size);
  const sorted = [...fields].sort((a, b) => a.offset - b.offset);
  const padding: StructValidation["padding"] = [];
  let current = 0;

  for (const field of sorted) {
    if (field.offset < current) {
      errors.push(`Overlap at 0x${field.offset.toString(16)} for "${field.name}" (previous field ends at 0x${current.toString(16)}).`);
    } else if (field.offset > current) {
      padding.push({ before: field.name, at: current, bytes: field.offset - current });
    }
    current = field.offset + field.size;
  }

  let trailingPadding: number | null = null;
  if (totalSize !== null) {
    if (current > totalSize) errors.push(`Fields exceed the declared total size (0x${current.toString(16)} > 0x${totalSize.toString(16)}).`);
    else if (current < totalSize) trailingPadding = totalSize - current;
  }

  if (align > 1) {
    for (const field of sorted) {
      if (field.offset % align !== 0) {
        errors.push(`Field "${field.name}" at 0x${field.offset.toString(16)} is not aligned to ${align}.`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    fields: sorted,
    errors,
    padding,
    trailingPadding,
    totalSize,
    endOffset: current,
  };
}
