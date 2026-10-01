/**
 * Evidence-driven protocol and IPC analysis.
 *
 * Ports upstream `references/05-protocols-ipc.md` §1 as deterministic code:
 *
 *   1. align the captured messages by position,
 *   2. classify every column (constant / small cardinality / monotonic /
 *      length-prefix / checksum),
 *   3. verify every checksum hypothesis by *recomputing* it,
 *   4. reconstruct the state machine from observed transitions,
 *   5. emit a specification where each field carries the evidence that produced
 *      it.
 *
 * Two hard rules, inherited from upstream and enforced by the types:
 *   - a field is never invented: an unclassifiable column is reported as
 *     `unknown`, with its observed values;
 *   - a checksum is never claimed without the recomputation succeeding.
 */

import { adler32, crc16, crc32, crc32c, sum16, xor8 } from "./entropy.js";

export interface MessageSample {
  /** Optional label, e.g. a direction or a captured opcode. */
  label?: string;
  bytes: Uint8Array;
}

export type FieldRole = "magic" | "constant" | "enum" | "counter" | "length" | "checksum" | "payload" | "unknown";

export interface ColumnAnalysis {
  offset: number;
  /** Observed distinct values (bounded). */
  distinct: number;
  constant: boolean;
  constantValue: string | null;
  /** Values seen, hex, bounded. */
  samples: string[];
  monotonicIncreasing: boolean;
  smallCardinality: boolean;
  matchesMessageLength: { endian: "little" | "big"; width: 2 | 4 } | null;
  matchesRemainingLength: { endian: "little" | "big"; width: 2 | 4 } | null;
}

export interface LengthPrefixCandidate {
  offset: number;
  width: 2 | 4;
  endian: "little" | "big";
  /** Which length the field matched: the whole message or the bytes after it. */
  matches: "message" | "remaining" | "both";
  /** How many of the sampled messages it matched. */
  hits: number;
  total: number;
}

export interface ChecksumCandidate {
  offset: number;
  width: 1 | 2 | 4;
  algorithm: string;
  /** The byte range the checksum covers. */
  covers: string;
  hits: number;
  total: number;
}

export interface FramingAnalysis {
  messageCount: number;
  minLength: number;
  maxLength: number;
  alignedColumns: ColumnAnalysis[];
  lengthPrefixes: LengthPrefixCandidate[];
  checksums: ChecksumCandidate[];
  /** A framing hypothesis, or an explicit statement that there is not one. */
  framing: {
    style: "length-prefixed" | "magic+length" | "delimiter" | "fixed-size" | "unknown";
    detail: string;
    confidence: number;
  };
}

export interface ProtocolField {
  name: string;
  offset: number | null;
  width: number | null;
  type: string;
  endianness: "little" | "big" | "none" | "unknown";
  role: FieldRole;
  /** Evidence ids / tool sources backing this field. */
  evidence: string[];
  confidence: number;
  /** What is still unknown about this field. */
  unknowns: string[];
}

export interface ProtocolMessage {
  name: string;
  direction: string | null;
  opcode: number | null;
  fields: ProtocolField[];
  notes: string[];
}

export interface StateTransition {
  from: string;
  on: string;
  to: string;
  observations: number;
}

export interface ProtocolSpecification {
  schema: 1;
  framing: FramingAnalysis["framing"] & { lengthPrefixes: LengthPrefixCandidate[]; checksums: ChecksumCandidate[] };
  messages: ProtocolMessage[];
  stateMachine: {
    states: string[];
    transitions: StateTransition[];
    /** States or transitions that were inferred but never observed. */
    unobserved: string[];
  };
  fields: ProtocolField[];
  unknowns: string[];
}

const MAX_MESSAGES = 64;
const MAX_COLUMNS = 64;
const MAX_SAMPLES = 6;

/** Align messages column-wise and classify every column. */
export function analyzeFraming(samples: MessageSample[]): FramingAnalysis {
  const messages = samples.slice(0, MAX_MESSAGES);
  const lengths = messages.map((sample) => sample.bytes.byteLength);
  const minLength = lengths.length ? Math.min(...lengths) : 0;
  const maxLength = lengths.length ? Math.max(...lengths) : 0;

  const alignedColumns: ColumnAnalysis[] = [];
  const columnCount = Math.min(Math.max(maxLength, 0), MAX_COLUMNS);
  for (let offset = 0; offset < columnCount; offset += 1) {
    const values: number[] = [];
    for (const message of messages) {
      if (offset < message.bytes.byteLength) values.push(message.bytes[offset]!);
    }
    if (values.length === 0) continue;
    const distinctValues = [...new Set(values)];
    const constant = distinctValues.length === 1;
    let monotonicIncreasing = true;
    for (let i = 1; i < values.length; i += 1) {
      if (values[i]! <= values[i - 1]!) {
        monotonicIncreasing = false;
        break;
      }
    }
    alignedColumns.push({
      offset,
      distinct: distinctValues.length,
      constant,
      constantValue: constant ? `0x${distinctValues[0]!.toString(16).padStart(2, "0")}` : null,
      samples: distinctValues.slice(0, MAX_SAMPLES).map((value) => `0x${value.toString(16).padStart(2, "0")}`),
      monotonicIncreasing: values.length > 2 && monotonicIncreasing,
      smallCardinality: distinctValues.length > 1 && distinctValues.length <= 8,
      matchesMessageLength: null,
      matchesRemainingLength: null,
    });
  }

  const lengthPrefixes = findLengthPrefixes(messages, columnCount);
  const checksums = findChecksums(messages, columnCount);

  let style: FramingAnalysis["framing"]["style"] = "unknown";
  let detail = "No consistent framing could be derived from the supplied messages.";
  let confidence = 0.2;
  const prefix = lengthPrefixes.find((candidate) => candidate.hits === candidate.total && candidate.total >= 2);
  const magicColumn = alignedColumns.find((column) => column.constant && column.offset === 0);
  if (prefix) {
    style = magicColumn ? "magic+length" : "length-prefixed";
    detail = `A ${prefix.width * 8}-bit ${prefix.endian}-endian length field at offset ${prefix.offset} matches the ${prefix.matches === "remaining" ? "remaining" : "total"} message length in ${prefix.hits}/${prefix.total} messages.`;
    confidence = Math.min(0.95, 0.5 + 0.45 * (prefix.hits / Math.max(1, prefix.total)));
  } else if (lengths.length > 1 && minLength === maxLength && minLength > 0) {
    style = "fixed-size";
    detail = `All ${messages.length} messages are exactly ${minLength} bytes: a fixed-size frame.`;
    confidence = 0.6;
  } else if (magicColumn) {
    style = "magic+length";
    detail = `Offset 0 is constant (${magicColumn.constantValue}) across all messages, but no length field was verified.`;
    confidence = 0.4;
  }

  return { messageCount: messages.length, minLength, maxLength, alignedColumns, lengthPrefixes, checksums, framing: { style, detail, confidence: Math.round(confidence * 100) / 100 } };
}

function findLengthPrefixes(messages: MessageSample[], columnCount: number): LengthPrefixCandidate[] {
  const out: LengthPrefixCandidate[] = [];
  if (messages.length < 2) return out;
  for (const width of [2, 4] as const) {
    for (const endian of ["little", "big"] as const) {
      for (let offset = 0; offset + width <= Math.min(columnCount, 32); offset += 1) {
        let messageHits = 0;
        let remainingHits = 0;
        for (const message of messages) {
          const value = readInt(message.bytes, offset, width, endian);
          if (value === null) continue;
          if (value === message.bytes.byteLength) messageHits += 1;
          if (value === message.bytes.byteLength - offset - width) remainingHits += 1;
        }
        if (messageHits === 0 && remainingHits === 0) continue;
        const hits = Math.max(messageHits, remainingHits);
        out.push({
          offset,
          width,
          endian,
          matches: messageHits > 0 && remainingHits > 0 ? "both" : messageHits > 0 ? "message" : "remaining",
          hits,
          total: messages.length,
        });
      }
    }
  }
  return out.sort((a, b) => b.hits - a.hits || a.offset - b.offset).slice(0, 8);
}

function findChecksums(messages: MessageSample[], columnCount: number): ChecksumCandidate[] {
  const out: ChecksumCandidate[] = [];
  if (messages.length < 3) return out;
  const algorithms: Array<{ name: string; fn: (bytes: Uint8Array) => number; width: 1 | 2 | 4 }> = [
    { name: "crc32", fn: crc32, width: 4 },
    { name: "crc32c", fn: crc32c, width: 4 },
    { name: "adler32", fn: adler32, width: 4 },
    { name: "sum16", fn: sum16, width: 2 },
    { name: "crc16-ccitt", fn: crc16, width: 2 },
    { name: "xor8", fn: xor8, width: 1 },
  ];
  const ranges: Array<{ label: string; from: (message: Uint8Array, offset: number, width: number) => [number, number] | null }> = [
    { label: "everything before the field", from: (_message, offset) => [0, offset] },
    { label: "everything after the field", from: (message, offset, width) => [offset + width, message.byteLength] },
    { label: "everything except the field", from: (message, offset, width) => [0, offset] },
  ];

  for (const { name, fn, width } of algorithms) {
    for (let offset = 0; offset + width <= Math.min(columnCount, 32); offset += 1) {
      for (const range of ranges) {
        let hits = 0;
        let considered = 0;
        for (const message of messages) {
          const bounds = range.from(message.bytes, offset, width);
          if (!bounds || bounds[1] <= bounds[0]) continue;
          considered += 1;
          const expected = fn(message.bytes.subarray(bounds[0], bounds[1]));
          const actual = readInt(message.bytes, offset, width, "little") ?? readInt(message.bytes, offset, width, "big");
          if (actual !== null && (actual === expected || actual === byteSwap(expected, width))) hits += 1;
        }
        if (hits >= 2 && considered >= 3 && hits === considered) {
          out.push({ offset, width, algorithm: name, covers: range.label, hits, total: considered });
        }
      }
    }
  }
  return out.sort((a, b) => b.hits - a.hits || a.offset - b.offset).slice(0, 8);
}

function readInt(bytes: Uint8Array, offset: number, width: 2 | 4 | 1, endian: "little" | "big"): number | null {
  if (offset + width > bytes.byteLength) return null;
  let value = 0;
  if (endian === "little") {
    for (let i = width - 1; i >= 0; i -= 1) value = value * 256 + bytes[offset + i]!;
  } else {
    for (let i = 0; i < width; i += 1) value = value * 256 + bytes[offset + i]!;
  }
  return value;
}

function byteSwap(value: number, width: 1 | 2 | 4): number {
  if (width === 1) return value;
  if (width === 2) return ((value & 0xff) << 8) | (value >>> 8);
  return (((value & 0xff) << 24) | ((value & 0xff00) << 8) | ((value >>> 8) & 0xff00) | ((value >>> 24) & 0xff)) >>> 0;
}

/**
 * Reconstruct a state machine from observed message sequences.
 * Every transition carries its observation count; anything not observed is
 * reported as unobserved rather than assumed.
 */
export function buildStateMachine(sessions: string[][], startState = "INITIAL"): ProtocolSpecification["stateMachine"] {
  const transitions: StateTransition[] = [];
  const states = new Set<string>([startState]);
  const seen = new Set<string>();

  for (const session of sessions) {
    let current = startState;
    for (const message of session) {
      const to = `after:${message}`;
      const key = `${current}|${message}`;
      const existing = transitions.find((entry) => entry.from === current && entry.on === message);
      if (existing) existing.observations += 1;
      else {
        transitions.push({ from: current, on: message, to, observations: 1 });
        seen.add(key);
      }
      states.add(current);
      states.add(to);
      current = to;
    }
  }

  const unobserved: string[] = [];
  for (const state of states) {
    for (const transition of transitions) {
      if (transition.from !== state) continue;
    }
  }
  // States that appear only as a destination and never emit anything are
  // reported, because an agent must not invent the messages they would send.
  for (const state of states) {
    if (!transitions.some((transition) => transition.from === state)) unobserved.push(`${state} emits nothing observed`);
  }

  return { states: [...states].sort(), transitions: transitions.sort((a, b) => b.observations - a.observations), unobserved };
}

/** Build the full specification from framing analysis plus caller knowledge. */
export function produceProtocolSpecification(
  samples: MessageSample[],
  options: {
    /** Opcodes observed by the caller (e.g. from a binary's handler table). */
    opcodes?: Array<{ name: string; code: number; direction?: string }>;
    /** Observed message-label sequences, one per session. */
    sessions?: string[][];
    /** Names the caller recovered from the target; each is `proposed`. */
    proposedMessageNames?: string[];
  } = {},
): ProtocolSpecification {
  const framing = analyzeFraming(samples);
  const unknowns: string[] = [];

  const fields: ProtocolField[] = [];
  const push = (field: ProtocolField) => fields.push(field);

  for (const column of framing.alignedColumns.slice(0, 24)) {
    const prefix = framing.lengthPrefixes.find((candidate) => candidate.offset === column.offset);
    const checksum = framing.checksums.find((candidate) => candidate.offset === column.offset);
    if (checksum) {
      push({
        name: `checksum_0x${column.offset.toString(16)}`,
        offset: column.offset,
        width: checksum.width,
        type: checksum.width === 1 ? "u8" : checksum.width === 2 ? "u16" : "u32",
        endianness: "unknown",
        role: "checksum",
        evidence: [`${checksum.algorithm} over ${checksum.covers} matches in ${checksum.hits}/${checksum.total} messages`],
        confidence: 0.9,
        unknowns: ["Byte order is unverified when the algorithm is order-agnostic."],
      });
      continue;
    }
    if (prefix) {
      push({
        name: `length_0x${column.offset.toString(16)}`,
        offset: column.offset,
        width: prefix.width,
        type: prefix.width === 2 ? "u16" : "u32",
        endianness: prefix.endian,
        role: "length",
        evidence: [`value equals the ${prefix.matches === "remaining" ? "remaining" : "total"} message length in ${prefix.hits}/${prefix.total} messages`],
        confidence: 0.85,
        unknowns: [],
      });
      continue;
    }
    if (column.constant && column.offset === 0) {
      push({ name: "magic", offset: column.offset, width: 1, type: "u8", endianness: "none", role: "magic", evidence: [`constant ${column.constantValue} across ${framing.messageCount} messages`], confidence: 0.95, unknowns: [] });
      continue;
    }
    if (column.monotonicIncreasing) {
      push({ name: `counter_0x${column.offset.toString(16)}`, offset: column.offset, width: 1, type: "u8", endianness: "none", role: "counter", evidence: [`strictly increasing across ${framing.messageCount} messages`], confidence: 0.7, unknowns: ["Width is inferred from a single column; a wider counter has not been excluded."] });
      continue;
    }
    if (column.smallCardinality) {
      push({ name: `enum_0x${column.offset.toString(16)}`, offset: column.offset, width: 1, type: "u8", endianness: "none", role: "enum", evidence: [`${column.distinct} distinct values: ${column.samples.join(", ")}`], confidence: 0.6, unknowns: ["The meaning of each value is unknown without a handler table."] });
      continue;
    }
    if (column.constant) {
      push({ name: `constant_0x${column.offset.toString(16)}`, offset: column.offset, width: 1, type: "u8", endianness: "none", role: "constant", evidence: [`constant ${column.constantValue}`], confidence: 0.9, unknowns: [] });
      continue;
    }
    push({ name: `unknown_0x${column.offset.toString(16)}`, offset: column.offset, width: 1, type: "u8", endianness: "none", role: "unknown", evidence: [`${column.distinct} distinct values: ${column.samples.join(", ")}`], confidence: 0.2, unknowns: ["Not classified. Do not assign a meaning without further evidence."] });
  }

  const messages: ProtocolMessage[] = (options.opcodes ?? []).map((opcode) => ({
    name: opcode.name,
    direction: opcode.direction ?? null,
    opcode: opcode.code,
    fields: fields.filter((field) => field.role !== "payload"),
    notes: [`Opcode 0x${opcode.code.toString(16)} supplied by the caller; field layout is shared with the other messages and is not message-specific.`],
  }));

  if (framing.framing.style === "unknown") {
    unknowns.push("No framing could be derived: supply more captured messages, or a length-prefix hypothesis to test.");
  }
  if (framing.checksums.length === 0) {
    unknowns.push("No checksum algorithm matched. Either there is none, or it covers a range this analysis did not try.");
  }
  for (const field of fields) {
    if (field.role === "unknown") unknowns.push(`Field at offset ${field.offset} is unclassified.`);
  }

  return {
    schema: 1,
    framing: { ...framing.framing, lengthPrefixes: framing.lengthPrefixes, checksums: framing.checksums },
    messages,
    stateMachine: options.sessions?.length ? buildStateMachine(options.sessions) : { states: [], transitions: [], unobserved: ["No observed message sequences were supplied, so no state machine could be reconstructed."] },
    fields,
    unknowns,
  };
}
