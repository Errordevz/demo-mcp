/**
 * A tolerant, dependency-free HTML/XML tokenizer + lightweight DOM.
 *
 * DEMO runs on Cloudflare Workers where `DOMParser` does not exist and pulling
 * in a full parser (jsdom) is a dev-only test dependency. Every capability that
 * needs to *read* markup — the webpage extractor, RSS/Atom feeds, Internet
 * Archive page retrieval, web diff, monitoring and research — shares this one
 * implementation, built to treat documents strictly as untrusted data:
 *
 *  - no script execution, no style cascade, no attribute interpretation beyond
 *    what callers read explicitly (href/src/content),
 *  - linear-time scanning with a bounded node count and input size,
 *  - forgiving about unclosed tags, raw `>` in text, missing quotes.
 */

export interface LiteNode {
  tag: string;
  attrs: Record<string, string>;
  children: LiteNode[];
  /** Text nodes directly under this element (in document order, mixed with elements). */
  parts: Array<{ kind: "text"; text: string } | { kind: "el"; node: LiteNode }>;
  parent?: LiteNode;
}

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

/** Elements whose entire content is raw data or non-prose; skipped without parsing. */
const SKIPPED_CONTENT = new Set(["script", "style", "noscript", "template", "svg", "math"]);

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", en: "–", em: "—",
  hellip: "…", middot: "·", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™", deg: "°",
  sup2: "²", sup3: "³", frac12: "½", euro: "€", pound: "£", yen: "¥", sect: "§", para: "¶", bull: "•",
};

export function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,29});/g, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeFromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? safeFromCodePoint(code) : match;
    }
    const key = entity.toLowerCase();
    return ENTITIES[key] ?? match;
  });
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function normalizeTag(tag: string): string {
  return tag.toLowerCase().replace(/[^a-z0-9:-]/g, "").slice(0, 40);
}

interface ParseLimits {
  maxNodes: number;
}

/**
 * Parse an HTML document (or fragment) into a lightweight tree. Never throws:
 * malformed markup degrades to plain text, which is exactly what extraction
 * needs from hostile input.
 */
export function parseHtml(input: string, limits: ParseLimits = { maxNodes: 40_000 }): LiteNode {
  const root: LiteNode = { tag: "#root", attrs: {}, children: [], parts: [] };
  const stack: LiteNode[] = [root];
  let nodeCount = 0;
  const source = input.slice(0, 4_000_000);
  let pos = 0;

  const current = () => stack[stack.length - 1] ?? root;

  const pushText = (text: string) => {
    if (!text) return;
    const parent = current();
    parent.parts.push({ kind: "text", text });
    if (parent.children.length < limits.maxNodes) {
      // text is cheap; only element children count toward structure size
    }
  };

  const addElement = (tag: string, attrs: Record<string, string>, selfClosing: boolean): LiteNode | null => {
    const parent = current();
    if (nodeCount >= limits.maxNodes) return null;
    nodeCount += 1;
    const node: LiteNode = { tag, attrs, children: [], parts: [], parent };
    parent.children.push(node);
    parent.parts.push({ kind: "el", node });
    if (!selfClosing) stack.push(node);
    return node;
  };

  while (pos < source.length) {
    const lt = source.indexOf("<", pos);
    if (lt === -1) {
      pushText(decodeEntities(source.slice(pos)));
      break;
    }
    if (lt > pos) pushText(decodeEntities(source.slice(pos, lt)));

    // Comments / doctype / CDATA: skip to their terminator.
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      pos = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<!", lt)) {
      const end = source.indexOf(">", lt);
      pos = end === -1 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith("<?", lt)) {
      const end = source.indexOf(">", lt);
      pos = end === -1 ? source.length : end + 1;
      continue;
    }

    const tagMatch = /^<\/?([a-zA-Z][a-zA-Z0-9:-]*)([^>]*)>/.exec(source.slice(lt, Math.min(source.length, lt + 4096)));
    if (!tagMatch) {
      // A raw "<" that is not a tag start: keep it as text.
      pushText("<");
      pos = lt + 1;
      continue;
    }
    const raw = tagMatch[0];
    const closing = raw.startsWith("</");
    const tag = normalizeTag(tagMatch[1]);

    if (tag === "br") {
      pushText("\n");
      pos = lt + raw.length;
      continue;
    }

    if (closing) {
      // Pop until the matching open tag (tolerating mismatches).
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      pos = lt + raw.length;
      continue;
    }

    const selfClosing = raw.endsWith("/>");
    const attrs = parseAttributes(tagMatch[2]);
    // Elements with raw content (script/style): consume until the matching close tag.
    if (SKIPPED_CONTENT.has(tag)) {
      const closeIndex = findRawContentEnd(source, tag, lt + raw.length);
      pos = closeIndex;
      continue;
    }
    addElement(tag, attrs, selfClosing || VOID_TAGS.has(tag));
    pos = lt + raw.length;
  }

  return root;
}

function findRawContentEnd(source: string, tag: string, from: number): number {
  const close = new RegExp(`</${tag}\\s*>`, "i");
  const rest = source.slice(from, from + 2_000_000);
  const match = close.exec(rest);
  return match ? from + match.index + match[0].length : source.length;
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let match: RegExpExecArray | null;
  let guard = 0;
  while ((match = pattern.exec(raw)) !== null && guard++ < 120) {
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (!(key in attrs)) attrs[key] = decodeEntities(value);
  }
  return attrs;
}

export function textOf(node: LiteNode | null | undefined): string {
  if (!node) return "";
  let out = "";
  for (const part of node.parts) {
    if (part.kind === "text") out += part.text;
    else out += textOf(part.node);
  }
  return out;
}

export function cleanText(value: string, max = 4_000): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Depth-first walk with a hard budget. */
export function walk(node: LiteNode, visit: (n: LiteNode, depth: number) => boolean | void, depth = 0, budget = { left: 40_000 }): void {
  if (budget.left-- <= 0 || depth > 60) return;
  if (visit(node, depth) === false) return;
  for (const child of node.children) walk(child, visit, depth + 1, budget);
}

export function findAll(root: LiteNode, tag: string, limit = 500): LiteNode[] {
  const out: LiteNode[] = [];
  walk(root, (n) => {
    if (n.tag === tag && out.length < limit) out.push(n);
  });
  return out;
}

export function findFirst(root: LiteNode, predicate: (n: LiteNode) => boolean, budget = { left: 40_000 }): LiteNode | null {
  let found: LiteNode | null = null;
  walk(root, (n) => {
    if (!found && predicate(n)) found = n;
  }, 0, budget);
  return found;
}

/** `<meta>` + `<link rel>` metadata collection shared by extraction and feeds. */
export function collectMeta(root: LiteNode): Record<string, string> {
  const meta: Record<string, string> = {};
  const seen = new Set<string>();
  const add = (key: string, value: string) => {
    if (!meta[key]) {
      meta[key] = value.slice(0, 2_000);
      seen.add(key);
    }
  };
  const head = findFirst(root, (n) => n.tag === "head") ?? root;
  walk(head, (n) => {
    if (seen.size >= 48) return false;
    if (n.tag === "meta") {
      const key = n.attrs.property || n.attrs.name || n.attrs.itemprop;
      if (key && n.attrs.content) add(`meta:${key.toLowerCase()}`, n.attrs.content);
    } else if (n.tag === "link") {
      const rel = (n.attrs.rel ?? "").toLowerCase();
      const href = n.attrs.href;
      if (href && ["canonical", "alternate", "next", "prev"].includes(rel)) add(`link:${rel}`, href);
      if (href && rel.includes("icon")) add("link:icon", href);
    } else if (n.tag === "title") {
      const t = cleanText(textOf(n), 400);
      if (t) add("title", t);
    }
  });
  return meta;
}

/** JSON-LD blocks (`<script type="application/ld+json">`) — data, not code. */
export function extractJsonLd(source: string, limit = 10): unknown[] {
  const out: unknown[] = [];
  const pattern = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]{0,200000}?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null && out.length < limit) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) if (out.length < limit && item && typeof item === "object") out.push(item);
    } catch {
      /* malformed JSON-LD is ignored, never fatal */
    }
  }
  return out;
}

/**
 * Flatten a tree to readable text with paragraph breaks, used everywhere a
 * "human-ish view" of a page is needed (feeds, diffs, research evidence).
 */
export function htmlToText(root: LiteNode, options: { maxChars?: number } = {}): string {
  const blocks = new Set(["p", "div", "section", "article", "li", "ul", "ol", "table", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "figure", "figcaption", "header", "footer", "aside", "main", "nav", "form", "details", "summary", "br", "hr", "dl", "dt", "dd", "address", "caption"]);
  const out: string[] = [];
  let emitted = 0;
  const maxChars = options.maxChars ?? 200_000;
  const visit = (n: LiteNode): void => {
    if (emitted > maxChars) return;
    if (n.tag === "#text") return;
    for (const part of n.parts) {
      if (emitted > maxChars) break;
      if (part.kind === "text") {
        out.push(part.text);
        emitted += part.text.length;
      } else {
        if (blocks.has(part.node.tag)) out.push("\n");
        visit(part.node);
        if (blocks.has(part.node.tag)) out.push("\n");
      }
    }
  };
  visit(root);
  return out
    .join("")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxChars);
}
