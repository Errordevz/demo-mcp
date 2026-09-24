/**
 * Tolerant, dependency-free XML reader for RSS/Atom feeds (and Internet
 * Archive metadata payloads).
 *
 * Feeds in the wild are messy: unquoted attributes, CDATA everywhere, HTML
 * inside descriptions, undeclared entities, BOMs, mixed namespaces. This
 * parser does not validate XML — it *extracts* from it, treats the document as
 * untrusted data and never resolves external entities (XXO/XXE: DOCTYPE
 * content is skipped entirely). It shares philosophy (and the entity table
 * concept) with `html-lite`, staying small enough to embed in a Worker.
 */

import { decodeEntities } from "./html-lite.js";

export interface XmlNode {
  /** Tag without namespace prefix; `localName` kept separately for safety. */
  name: string;
  localName: string;
  ns: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

export interface XmlParseResult {
  root: XmlNode | null;
  warnings: string[];
}

export function parseXml(input: string, options: { maxNodes?: number } = {}): XmlParseResult {
  const warnings: string[] = [];
  const maxNodes = options.maxNodes ?? 20_000;
  let source = input.replace(/^\uFEFF/, "");
  if (source.length > 4_000_000) {
    source = source.slice(0, 4_000_000);
    warnings.push("input-truncated");
  }
  // Skip any DOCTYPE wholesale: external entities must never be fetched or expanded.
  const doctype = /<!DOCTYPE[\s\S]*?>/i.exec(source);
  if (doctype) {
    warnings.push("doctype-ignored");
    const end = source.indexOf("[", doctype.index);
    const close = source.indexOf(">", doctype.index);
    if (end !== -1 && end < close) {
      const bracketEnd = source.indexOf("]", end);
      const finalEnd = source.indexOf(">", bracketEnd === -1 ? doctype.index : bracketEnd);
      source = source.slice(0, doctype.index) + source.slice(finalEnd + 1);
    } else {
      source = source.slice(0, doctype.index) + source.slice(close + 1);
    }
  }

  const root: XmlNode = { name: "#document", localName: "#document", ns: "", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let nodes = 0;
  let pos = 0;

  while (pos < source.length && nodes < maxNodes) {
    const lt = source.indexOf("<", pos);
    if (lt === -1) {
      appendText(source.slice(pos));
      break;
    }
    if (lt > pos) appendText(decodeEntities(source.slice(pos, lt)));

    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      pos = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9);
      const raw = source.slice(lt + 9, end === -1 ? source.length : end);
      appendText(raw);
      pos = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<?", lt)) {
      const end = source.indexOf("?>", lt);
      pos = end === -1 ? source.length : end + 2;
      continue;
    }

    const match = /^<\/?([A-Za-z_:][-A-Za-z0-9_:.]*)([^>]*?)(\/?)>/.exec(source.slice(lt, Math.min(source.length, lt + 8_192)));
    if (!match) {
      appendText("<");
      pos = lt + 1;
      continue;
    }
    const raw = match[0];
    const closing = raw.startsWith("</");
    const rawName = match[1];
    const { name, localName, ns } = splitName(rawName);

    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
      }
      pos = lt + raw.length;
      continue;
    }
    const selfClosing = match[3] === "/";
    nodes++;
    const node: XmlNode = { name, localName, ns, attrs: parseAttrs(match[2]), children: [], text: "" };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    pos = lt + raw.length;
  }

  if (stack.length > 1) warnings.push("unclosed-elements");

  function appendText(value: string) {
    if (!value) return;
    const current = stack[stack.length - 1];
    current.text += value;
  }

  // First element child is the document root.
  return { root: root.children[0] ?? null, warnings };
}

function splitName(raw: string): { name: string; localName: string; ns: string } {
  const idx = raw.lastIndexOf(":");
  if (idx === -1) return { name: raw.toLowerCase(), localName: raw, ns: "" };
  return { name: raw.toLowerCase(), localName: raw.slice(idx + 1), ns: raw.slice(0, idx) };
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let match: RegExpExecArray | null;
  let guard = 0;
  while ((match = pattern.exec(raw)) !== null && guard++ < 64) {
    const key = match[1].toLowerCase();
    if (!(key in attrs)) attrs[key] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

/** Direct children by tag (local name, ignoring namespace prefixes). */
export function childrenNamed(node: XmlNode | null | undefined, ...names: string[]): XmlNode[] {
  if (!node) return [];
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  return node.children.filter((child) => wanted.has(child.localName.toLowerCase()));
}

export function firstNamed(node: XmlNode | null | undefined, ...names: string[]): XmlNode | null {
  const list = childrenNamed(node, ...names);
  return list[0] ?? null;
}

export function nodeText(node: XmlNode | null | undefined): string {
  if (!node) return "";
  let text = node.text;
  for (const child of node.children) text += nodeText(child);
  return text.trim();
}

/** Text with inline markup preserved (used to keep `content:encoded` HTML for later extraction). */
export function rawText(node: XmlNode | null | undefined): string {
  if (!node) return "";
  let out = node.text;
  for (const child of node.children) out += `<${child.name}>${rawText(child)}</${child.name}>`;
  return out.trim();
}

export function attr(node: XmlNode | null | undefined, key: string): string | null {
  if (!node) return null;
  const value = node.attrs[key.toLowerCase()];
  return value === undefined ? null : value;
}

/**
 * Flatten an `<atom:link rel="alternate" href=.../>`-style list or repeated
 * link elements to the best URL for a feed entry.
 */
export function pickLink(node: XmlNode | null | undefined, rel: string): string | null {
  if (!node) return null;
  const links = childrenNamed(node, "link");
  for (const link of links) {
    const linkRel = (attr(link, "rel") ?? "alternate").toLowerCase();
    if (linkRel === rel) {
      const href = attr(link, "href");
      if (href) return href;
    }
  }
  if (rel === "alternate") {
    for (const link of links) {
      const href = attr(link, "href");
      if (href) return href;
    }
    const text = nodeText(node);
    if (/^https?:\/\//i.test(text)) return text;
  }
  return null;
}
