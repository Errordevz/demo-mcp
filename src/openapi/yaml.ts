/**
 * Minimal YAML subset parser for OpenAPI documents (DEMO 0.9).
 *
 * OpenAPI lives mostly in YAML 1.2; Workers have no YAML parser and this repo
 * is dependency-light on purpose. This parser covers what OpenAPI documents
 * actually use — block mappings/sequences with indentation, inline `{}`/`[]`
 * flow collections, quoted and plain scalars, literal/folded block scalars
 * (`|`, `>`), comments, `---` document markers, `null/true/false/numbers`, and
 * the extremely common `<<: *anchor` merge via `&anchor` / `*alias` pairs.
 * What it does NOT do (and reports as `warnings`) is full YAML: multi-line
 * flow collections, `%directives`, and exotic scalar tags. Malformed input
 * degrades to partial structures with warnings rather than exceptions, because
 * the inspector must work on messy public documents.
 */

export interface YamlParseResult {
  value: unknown;
  warnings: string[];
}

interface Line {
  indent: number;
  content: string;
  number: number;
  rawIndex: number;
}

export function parseYamlLite(source: string): YamlParseResult {
  const warnings: string[] = [];
  const anchors = new Map<string, unknown>();
  // Strip a BOM, take the first document of a multi-doc stream.
  let text = source.replace(/^\uFEFF/, "");
  const docSplit = /^---[ \t]*$/m.exec(text);
  if (docSplit) {
    const after = text.slice(docSplit.index + docSplit[0].length);
    const nextDoc = /^---[ \t]*$/m.exec(after);
    text = nextDoc ? text.slice(docSplit.index + docSplit[0].length, docSplit.index + docSplit[0].length + nextDoc.index) : text.slice(docSplit.index + docSplit[0].length);
  }
  const lines: Line[] = [];
  const rawLines = text.split(/\r?\n/);
  rawLines.forEach((raw, index) => {
    const withoutComment = stripComment(raw);
    if (!withoutComment.trim()) return;
    if (/^\.\.\.[ \t]*$/.test(withoutComment.trim())) return;
    if (/^%/.test(withoutComment.trim())) {
      warnings.push(`directive ignored (line ${index + 1})`);
      return;
    }
    const indent = raw.length - raw.trimStart().length;
    lines.push({ indent, content: withoutComment.trimStart().replace(/\s+$/, ""), number: index + 1, rawIndex: index });
  });

  let cursor = 0;

  const parseBlock = (indent: number): unknown => {
    if (cursor >= lines.length) return null;
    const line = lines[cursor];
    if (line.indent < indent) return null;
    if (line.content.startsWith("- ") || line.content === "-") return parseSequence(line.indent);
    return parseMapping(line.indent);
  };

  const parseSequence = (indent: number): unknown[] => {
    const items: unknown[] = [];
    while (cursor < lines.length && lines[cursor].indent === indent && (lines[cursor].content === "-" || lines[cursor].content.startsWith("- "))) {
      const line = lines[cursor];
      const rest = line.content === "-" ? "" : line.content.slice(2).trimStart();
      cursor++;
      if (!rest) {
        items.push(parseBlock(indent + 1));
      } else if (/^[?#]/.test(rest)) {
        items.push(null);
      } else if (/^- /.test(rest)) {
        // Compact nested sequence on one line ("- - x") — rare; treat as scalar.
        items.push(parseScalarOrInline(rest, line.number, anchors, warnings));
      } else if (/^[A-Za-z0-9_"'[{][^:]*:(\s|$)/.test(rest) && !isInlineScalarOnly(rest)) {
        // Mapping entry that starts on the dash line ("- key: value").
        cursor--;
        lines[cursor] = { indent: indent + 2, content: rest, number: line.number, rawIndex: line.rawIndex };
        items.push(parseMapping(indent + 2));
      } else {
        items.push(parseScalarOrInline(rest, line.number, anchors, warnings));
      }
    }
    return items;
  };

  const parseMapping = (indent: number): Record<string, unknown> => {
    const map: Record<string, unknown> = {};
    while (cursor < lines.length && lines[cursor].indent === indent) {
      const line = lines[cursor];
      if (line.content === "-" || line.content.startsWith("- ")) break;
      const keyMatch = /^(?:([A-Za-z0-9_.$/<>-]+)|"([^"]*)"|'([^']*)')\s*:(\s+|$)/.exec(line.content);
      if (!keyMatch) {
        warnings.push(`unrecognised mapping line ${line.number}: ${line.content.slice(0, 60)}`);
        cursor++;
        continue;
      }
      const key = keyMatch[1] ?? keyMatch[2] ?? keyMatch[3] ?? "";
      const rest = line.content.slice(keyMatch[0].length).trimStart();
      cursor++;
      if (!rest || /^&[A-Za-z0-9_-]+$/.test(rest)) {
        // Value is a nested block (optionally anchored with `&name` alone on the line).
        const nested = cursor < lines.length && lines[cursor].indent > indent ? parseBlock(lines[cursor].indent) : null;
        if (rest.startsWith("&")) anchors.set(rest.slice(1), nested);
        map[key] = nested;
      } else if (rest === "|" || rest === "|-" || rest === "|+" || rest === ">" || rest === ">-" || rest === ">+") {
        map[key] = parseBlockScalar(rest, indent, rawLines, line.rawIndex + 1);
        // Block-scalar content also appears in `lines`; consume it.
        while (cursor < lines.length && lines[cursor].indent > indent) cursor++;
      } else {
        map[key] = parseScalarOrInline(rest, line.number, anchors, warnings, key);
      }
    }
    return map;
  };

  const value = lines.length ? parseBlock(lines[0].indent) : null;
  // Merge keys (`<<: *anchor`) applied lazily after parse: common OpenAPI pattern.
  const merged = applyMergeKeys(value, warnings);
  return { value: merged, warnings: warnings.slice(0, 20) };
}

function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === "'" && !inDouble) inSingle = !inSingle;
    else if (char === '"' && !inSingle) inDouble = !inDouble;
    else if (char === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function isInlineScalarOnly(rest: string): boolean {
  return rest.startsWith("{") || rest.startsWith("[") || rest.startsWith('"') || rest.startsWith("'");
}

function parseBlockScalar(header: string, parentIndent: number, rawLines: string[], startRawIndex: number): string {
  const folded = header.startsWith(">");
  const chomp = header.includes("-") ? "strip" : header.includes("+") ? "keep" : "clip";
  const collected: string[] = [];
  let index = startRawIndex;
  // Content: every following raw line indented deeper than the key (blank lines
  // allowed inside), stopping at the first non-blank line at/below the key indent.
  while (index < rawLines.length && collected.length < 5_000) {
    const raw = rawLines[index];
    const indent = raw.length - raw.trimStart().length;
    if (raw.trim() && indent <= parentIndent) break;
    collected.push(raw);
    index++;
  }
  const bodyIndent = collected.reduce((min, line) => (line.trim() ? Math.min(min, line.length - line.trimStart().length) : min), Number.POSITIVE_INFINITY);
  const stripped = collected.map((line) => (line.trim() ? line.slice(Number.isFinite(bodyIndent) ? bodyIndent : 0) : ""));
  let text = folded
    ? stripped.map((line) => line.trim()).join(" ").replace(/\s+/g, " ")
    : stripped.join("\n");
  if (chomp === "strip") text = text.replace(/\n+$/, "");
  else if (chomp === "clip") text = text.replace(/\n*$/, "\n");
  return text;
}

function parseScalarOrInline(raw: string, lineNumber: number, anchors: Map<string, unknown>, warnings: string[], key?: string): unknown {
  let text = raw;
  let anchor: string | null = null;
  // Anchor / alias / merge decorations.
  const anchorMatch = /^&([A-Za-z0-9_-]+)(?:\s+|$)/.exec(text);
  if (anchorMatch) {
    anchor = anchorMatch[1];
    text = text.slice(anchorMatch[0].length).trimStart();
    // "&name" alone on the line means the value is the nested block below;
    // callers handle the empty-rest case, so return the anchor marker.
    if (!text) {
      const holder: { __anchorOnly?: string } = { __anchorOnly: anchor };
      return holder;
    }
  }
  const aliasMatch = /^\*([A-Za-z0-9_-]+)$/.exec(text.trim());
  if (aliasMatch) {
    const resolved = anchors.get(aliasMatch[1]);
    if (resolved === undefined) warnings.push(`alias *${aliasMatch[1]} unresolved (line ${lineNumber})`);
    return resolved ?? null;
  }
  const tagMatch = /^!![A-Za-z0-9]+\s+/.exec(text);
  if (tagMatch) text = text.slice(tagMatch[0].length);
  if (key === "<<") {
    // Merge key: value is a map or alias; application happens in applyMergeKeys.
    const value = parseScalarOrInline(text, lineNumber, anchors, warnings);
    return { __merge: value };
  }
  let value: unknown;
  if (text.startsWith("{") || text.startsWith("[")) {
    value = parseFlow(text, warnings, lineNumber);
  } else {
    value = parseScalar(text);
  }
  if (anchor) anchors.set(anchor, value);
  return value;
}

function parseScalar(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "~" || /^null$/i.test(trimmed)) return null;
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) || (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)) {
    const inner = trimmed.slice(1, -1);
    return trimmed.startsWith('"') ? inner.replace(/\\(["\\/])/, "$1").replace(/\\n/g, "\n").replace(/\\t/g, "\t") : inner.replace(/''/g, "'");
  }
  if (/^[+-]?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/** One-line flow collections `{a: 1, b: [2, 3]}` — the only flow form OpenAPI commonly uses. */
function parseFlow(text: string, warnings: string[], lineNumber: number): unknown {
  try {
    return parseFlowValue(text.trim()).value;
  } catch {
    warnings.push(`flow value not parsed (line ${lineNumber}): ${text.slice(0, 60)}`);
    return text;
  }
}

function parseFlowValue(text: string, index = 0): { value: unknown; next: number } {
  const skipWs = (i: number) => {
    while (i < text.length && /\s/.test(text[i])) i++;
    return i;
  };
  let i = skipWs(index);
  const char = text[i];
  if (char === "{") {
    const map: Record<string, unknown> = {};
    i = skipWs(i + 1);
    while (i < text.length && text[i] !== "}") {
      const keyResult = parseFlowValue(text, i);
      const key = String(keyResult.value ?? "");
      i = skipWs(keyResult.next);
      if (text[i] === ":") i = skipWs(i + 1);
      const valueResult = parseFlowValue(text, i);
      map[key] = valueResult.value;
      i = skipWs(valueResult.next);
      if (text[i] === ",") i = skipWs(i + 1);
    }
    return { value: map, next: i + 1 };
  }
  if (char === "[") {
    const items: unknown[] = [];
    i = skipWs(i + 1);
    while (i < text.length && text[i] !== "]") {
      const result = parseFlowValue(text, i);
      items.push(result.value);
      i = skipWs(result.next);
      if (text[i] === ",") i = skipWs(i + 1);
    }
    return { value: items, next: i + 1 };
  }
  if (char === '"' || char === "'") {
    let out = "";
    i++;
    while (i < text.length && text[i] !== char) {
      if (char === '"' && text[i] === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      out += text[i];
      i++;
    }
    return { value: out, next: i + 1 };
  }
  let end = i;
  while (end < text.length && !",]}:".includes(text[end])) end++;
  return { value: parseScalar(text.slice(i, end)), next: end };
}

function applyMergeKeys(value: unknown, warnings: string[], depth = 0): unknown {
  if (depth > 20 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => applyMergeKeys(item, warnings, depth + 1));
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === "<<") {
      const mergeValue = (entry as { __merge?: unknown })?.__merge ?? entry;
      const sources = Array.isArray(mergeValue) ? mergeValue : [mergeValue];
      for (const source of sources) {
        if (source && typeof source === "object" && !Array.isArray(source)) {
          Object.assign(out, applyMergeKeys(source, warnings, depth + 1));
        } else if (source !== undefined && source !== null) {
          warnings.push("merge key `<<` did not resolve to a mapping");
        }
      }
      continue;
    }
    out[key] = applyMergeKeys(entry, warnings, depth + 1);
  }
  return out;
}
