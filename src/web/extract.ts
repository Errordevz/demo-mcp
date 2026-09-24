/**
 * Clean webpage extraction (DEMO 0.9) — one implementation, many callers.
 *
 * Used by `web_extract` (public API), `web_diff`/`web_monitor` (normalized
 * snapshots), the Internet Archive snapshot reader, research source reading and
 * feed content cleanup. It deliberately runs on *fetched HTML* through
 * `html-lite` — no second browser, no DOM library, no script execution. When
 * JS-rendered content is needed, DEMO's existing browser tools already do that;
 * this module's job is safe, deterministic extraction of the markup itself.
 */

import { cleanText, collectMeta, decodeEntities, extractJsonLd, findAll, parseHtml, textOf, walk, type LiteNode } from "../core/html-lite.js";
import { LIMITS, clamp } from "../core/limits.js";

export interface ExtractHeading {
  level: number;
  text: string;
  anchor: string | null;
}

export interface ExtractLink {
  text: string;
  href: string;
  external: boolean;
}

export interface ExtractImage {
  src: string;
  alt: string;
  title?: string;
}

export interface ExtractTable {
  caption: string | null;
  headers: string[];
  rows: string[][];
}

export type ContentBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; language: string | null; text: string }
  | { type: "quote"; text: string }
  | { type: "table"; caption: string | null; headers: string[]; rows: string[][] }
  | { type: "image"; src: string; alt: string }
  | { type: "rule" };

export interface ExtractedPage {
  url: string | null;
  finalUrl: string | null;
  title: string | null;
  description: string | null;
  author: string | null;
  publishedTime: string | null;
  modifiedTime: string | null;
  siteName: string | null;
  language: string | null;
  canonicalUrl: string | null;
  headings: ExtractHeading[];
  paragraphs: string[];
  links: ExtractLink[];
  images: ExtractImage[];
  tables: ExtractTable[];
  contentBlocks: ContentBlock[];
  metadata: Record<string, string>;
  jsonLd: unknown[];
  wordCount: number;
  truncated: boolean;
  warnings: string[];
}

const NOISE_CLASS =
  /\b(nav|menu|navbar|nav-|footer|header-?bar|sidebar|side-?bar|comment|disqus|promo|advert|ads|ad-|banner|cookie|social|share|related|newsletter|subscribe|masthead|breadcrumb|pagination|modal|popup|overlay|skip-?link|paywall)\b/i;
const NOISE_ID = NOISE_CLASS;
const CONTENT_HINT = /\b(article|post|entry|content|main|body|story|prose|document)\b/i;

function looksNoise(node: LiteNode): boolean {
  const cls = `${node.attrs.class ?? ""} ${node.attrs.id ?? ""}`;
  return NOISE_CLASS.test(cls);
}

function absolutize(href: string | null | undefined, base: string | null): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("javascript:") || trimmed.startsWith("data:") || trimmed.startsWith("#")) return null;
  if (base) {
    try {
      return new URL(trimmed, base).toString();
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

/**
 * Extract structured content from an HTML document. `options.mainSelector` is
 * intentionally not a CSS engine — it supports "article", "main" and
 * "[role=main]" style single-token hints to keep the parser tiny.
 */
export function extractPage(html: string, options: { url?: string | null; maxChars?: number; includeAllLinks?: boolean } = {}): ExtractedPage {
  const warnings: string[] = [];
  const base = options.url ?? null;
  const maxChars = clamp(options.maxChars ?? LIMITS.webpageExtractMaxChars, 5_000, LIMITS.webpageExtractMaxChars);
  const root = parseHtml(html);
  const meta = collectMeta(root);
  const title = meta["title"] ?? meta["meta:og:title"] ?? meta["meta:twitter:title"] ?? null;

  // Choose the main content container: <article> / <main> / role=main / the
  // densest scored <div>, falling back to <body>.
  const body = findFirstByTag(root, "body") ?? root;
  let main: LiteNode | null =
    findFirstByTag(body, "article") ??
    findFirstByTag(body, "main") ??
    findDescendant(body, (n) => n.attrs.role === "main", 12) ??
    null;
  if (!main) {
    main = scoreContentContainer(body);
    if (main !== body) warnings.push("container-heuristic");
  }

  const headings: ExtractHeading[] = [];
  const paragraphs: string[] = [];
  const links: ExtractLink[] = [];
  const images: ExtractImage[] = [];
  const tables: ExtractTable[] = [];
  const blocks: ContentBlock[] = [];
  let charBudget = maxChars;
  let truncated = false;

  const consume = (cost: number): boolean => {
    charBudget -= cost;
    if (charBudget <= 0) {
      truncated = true;
      return false;
    }
    return true;
  };

  const emitLinkNodes = (node: LiteNode) => {
    for (const anchor of findAll(node, "a", LIMITS.maxLinks)) {
      const href = absolutize(anchor.attrs.href, base);
      if (!href) continue;
      const text = cleanText(textOf(anchor), 240);
      if (!text && !options.includeAllLinks) continue;
      let external = false;
      if (base) {
        try {
          external = new URL(href).host !== new URL(base).host;
        } catch {
          external = false;
        }
      }
      links.push({ text: text || href.slice(0, 240), href, external });
      if (links.length >= LIMITS.maxLinks) break;
    }
  };

  const tableOf = (node: LiteNode): ExtractTable => {
    const captionNode = node.children.find((c) => c.tag === "caption");
    const headerCells: string[] = [];
    const rows: string[][] = [];
    const thead = node.children.find((c) => c.tag === "thead");
    if (thead) {
      for (const row of thead.children.filter((c) => c.tag === "tr")) {
        for (const cell of row.children.filter((c) => c.tag === "th" || c.tag === "td")) headerCells.push(cleanText(textOf(cell), 120));
      }
    }
    const bodies = node.children.filter((c) => c.tag === "tbody" || c.tag === "tr");
    const rowNodes: LiteNode[] = [];
    for (const child of bodies) {
      if (child.tag === "tr") rowNodes.push(child);
      else rowNodes.push(...child.children.filter((c) => c.tag === "tr"));
    }
    for (const row of rowNodes.slice(0, 100)) {
      const cellNodes = row.children.filter((c) => c.tag === "td" || c.tag === "th");
      const cells = cellNodes.map((c) => cleanText(textOf(c), 240));
      if (cells.length) rows.push(cells);
    }
    // A leading all-<th> row (without <thead>) is the header row.
    if (headerCells.length === 0 && rows.length > 0) {
      const firstRow = rowNodes[0];
      const firstIsHeader = firstRow && firstRow.children.filter((c) => c.tag === "td" || c.tag === "th").length > 0 && firstRow.children.filter((c) => c.tag === "td" || c.tag === "th").every((c) => c.tag === "th");
      if (firstIsHeader) {
        headerCells.push(...rows.shift()!);
      }
    }
    return { caption: captionNode ? cleanText(textOf(captionNode), 240) : null, headers: headerCells, rows: rows.slice(0, 100) };
  };

  const visit = (node: LiteNode): void => {
    if (truncated) return;
    for (const part of node.parts) {
      if (truncated) return;
      if (part.kind === "text") continue;
      const child = part.node;
      if (["nav", "footer", "aside", "form"].includes(child.tag) || looksNoise(child)) continue;
      if (/^h[1-6]$/.test(child.tag)) {
        const text = cleanText(textOf(child), 300);
        if (text && consume(text.length)) {
          const level = Number(child.tag.slice(1));
          headings.push({ level, text, anchor: child.attrs.id ?? null });
          blocks.push({ type: "heading", level, text });
        }
        continue;
      }
      if (child.tag === "p") {
        const text = cleanText(textOf(child), 4_000);
        if (text && text.length > 1 && consume(text.length)) {
          paragraphs.push(text);
          blocks.push({ type: "paragraph", text });
        }
        continue;
      }
      if (child.tag === "ul" || child.tag === "ol") {
        const items = findAll(child, "li", 80)
          .map((li) => cleanText(textOf(li), 600))
          .filter(Boolean);
        if (items.length && consume(items.join(" ").length)) blocks.push({ type: "list", ordered: child.tag === "ol", items });
        continue;
      }
      if (child.tag === "pre") {
        const codeNode = child.children.find((c) => c.tag === "code");
        const languageMatch = /language-([\w-]+)|lang-([\w-]+)/.exec((codeNode ?? child).attrs.class ?? "");
        const language = languageMatch ? languageMatch[1] ?? languageMatch[2] : null;
        const text = (codeNode ? textOf(codeNode) : textOf(child)).replace(/\s+$/, "").slice(0, 4_000);
        if (text && consume(text.length)) blocks.push({ type: "code", language, text });
        continue;
      }
      if (child.tag === "blockquote") {
        const text = cleanText(textOf(child), 3_000);
        if (text && consume(text.length)) blocks.push({ type: "quote", text });
        continue;
      }
      if (child.tag === "table") {
        const table = tableOf(child);
        if ((table.headers.length || table.rows.length) && consume(200)) {
          tables.push(table);
          blocks.push({ type: "table", caption: table.caption, headers: table.headers, rows: table.rows });
        }
        continue;
      }
      if (child.tag === "img") {
        const src = absolutize(child.attrs.src ?? child.attrs["data-src"], base);
        if (src && src.length < 2_000) {
          const image: ExtractImage = { src, alt: cleanText(child.attrs.alt ?? "", 240), ...(child.attrs.title ? { title: cleanText(child.attrs.title, 160) } : {}) };
          images.push(image);
          blocks.push({ type: "image", src, alt: image.alt });
        }
        continue;
      }
      if (child.tag === "hr") {
        blocks.push({ type: "rule" });
        continue;
      }
      visit(child);
    }
  };

  if (main) visit(main);
  if (main) emitLinkNodes(main);
  if (links.length === 0 && options.includeAllLinks) emitLinkNodes(body);

  const jsonLd = extractJsonLd(html, LIMITS.maxJsonLdBlocks);
  const jsonLdMeta = flattenJsonLd(jsonLd);

  const description =
    meta["meta:og:description"] ?? meta["meta:description"] ?? meta["meta:twitter:description"] ?? paragraphs[0]?.slice(0, 500) ?? null;
  const author = meta["meta:author"] ?? meta["meta:article:author"] ?? jsonLdMeta.author ?? null;
  const publishedTime = meta["meta:article:published_time"] ?? meta["meta:datepublished"] ?? jsonLdMeta.datePublished ?? null;
  const modifiedTime = meta["meta:article:modified_time"] ?? jsonLdMeta.dateModified ?? null;
  const siteName = meta["meta:og:site_name"] ?? null;
  const canonicalUrl = absolutize(meta["link:canonical"] ?? null, base);
  const languageMatch = /lang="([^"]+)"/i.exec(html.slice(0, 4_000));
  const language = languageMatch ? cleanText(decodeEntities(languageMatch[1]), 20) : meta["meta:content-language"] ?? null;
  const wordCount = paragraphs.reduce((sum, p) => sum + p.split(/\s+/).filter(Boolean).length, 0) + headings.length;

  return {
    url: base,
    finalUrl: base,
    title: title ? cleanText(title, 400) : null,
    description: description ? cleanText(description, 1_000) : null,
    author,
    publishedTime,
    modifiedTime,
    siteName,
    language,
    canonicalUrl,
    headings: headings.slice(0, 100),
    paragraphs: paragraphs.slice(0, 4_000),
    links: links.slice(0, LIMITS.maxLinks),
    images: images.slice(0, LIMITS.maxImageCandidates * 5),
    tables: tables.slice(0, 40),
    contentBlocks: blocks.slice(0, 4_000),
    metadata: sanitizeMeta(meta),
    jsonLd,
    wordCount,
    truncated,
    warnings,
  };
}

/** Drop tracking-shaped meta keys and cap sizes; values are untrusted strings. */
function sanitizeMeta(meta: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (/track|pixel|analytics|ga-|utm_/i.test(key)) continue;
    out[key] = value.slice(0, 500);
    if (Object.keys(out).length >= 40) break;
  }
  return out;
}

function findFirstByTag(root: LiteNode, tag: string): LiteNode | null {
  let found: LiteNode | null = null;
  walk(
    root,
    (n) => {
      if (!found && n.tag === tag) found = n;
      return found ? false : undefined;
    },
    0,
    { left: 20_000 },
  );
  return found;
}

function findDescendant(root: LiteNode, predicate: (n: LiteNode) => boolean, depth: number): LiteNode | null {
  let found: LiteNode | null = null;
  const visit = (node: LiteNode, at: number): void => {
    if (found || at > depth) return;
    for (const child of node.children) {
      if (predicate(child)) {
        found = child;
        return;
      }
      visit(child, at + 1);
    }
  };
  visit(root, 0);
  return found;
}

/**
 * Readability-style density scoring over container elements: count the
 * characters of real paragraphs inside each candidate, penalise link density,
 * and pick the best window. Bounded so a hostile page cannot make this slow.
 */
function scoreContentContainer(body: LiteNode): LiteNode {
  let best: LiteNode = body;
  let bestScore = -1;
  const candidates: LiteNode[] = [];
  walk(
    body,
    (n) => {
      if ((n.tag === "div" || n.tag === "section" || n.tag === "article") && !looksNoise(n)) candidates.push(n);
    },
    0,
    { left: 6_000 },
  );
  for (const node of candidates.slice(0, 600)) {
    let textLen = 0;
    let linkLen = 0;
    let paragraphCount = 0;
    walk(
      node,
      (n) => {
        if (n.tag === "p") {
          paragraphCount++;
          const len = textOf(n).length;
          textLen += len;
          if (linkLen > 0 && textLen > 30_000) return false;
        } else if (n.tag === "a") {
          linkLen += textOf(n).length;
        }
      },
      0,
      { left: 4_000 },
    );
    if (paragraphCount < 2) continue;
    const linkDensity = textLen > 0 ? linkLen / textLen : 1;
    const score = textLen * (1 - Math.min(1, linkDensity * 1.5)) * (CONTENT_HINT.test(`${node.attrs.class ?? ""} ${node.attrs.id ?? ""}`) ? 1.5 : 1);
    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  }
  return best;
}

/* ────────────────────────────── formatters ───────────────────────────────── */

export function toMarkdown(page: ExtractedPage): string {
  const out: string[] = [];
  if (page.title) out.push(`# ${page.title}`, "");
  const byline = [page.author ? `Author: ${page.author}` : null, page.publishedTime ? `Published: ${page.publishedTime}` : null, page.url ? `Source: ${page.url}` : null].filter(Boolean);
  if (byline.length) out.push(`> ${byline.join(" · ")}`, "");
  for (const block of page.contentBlocks) {
    switch (block.type) {
      case "heading":
        out.push(`${"#".repeat(Math.min(6, block.level + 1))} ${block.text}`, "");
        break;
      case "paragraph":
        out.push(block.text, "");
        break;
      case "list":
        out.push(...block.items.map((item, i) => (block.ordered ? `${i + 1}. ${item}` : `- ${item}`)), "");
        break;
      case "code":
        out.push("```" + (block.language ?? ""), block.text, "```", "");
        break;
      case "quote":
        out.push(...block.text.split("\n").map((line) => `> ${line}`), "");
        break;
      case "table": {
        if (block.headers.length) {
          out.push(`| ${block.headers.join(" | ")} |`, `| ${block.headers.map(() => "---").join(" | ")} |`);
        }
        for (const row of block.rows) out.push(`| ${row.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`);
        out.push("");
        break;
      }
      case "image":
        out.push(`![${block.alt}](${block.src})`, "");
        break;
      case "rule":
        out.push("---", "");
        break;
    }
  }
  if (page.truncated) out.push("…[content truncated by the extraction size limit]");
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function toPlainText(page: ExtractedPage): string {
  const out: string[] = [];
  if (page.title) out.push(page.title, "");
  for (const block of page.contentBlocks) {
    if (block.type === "heading") out.push(block.text.toUpperCase(), "");
    else if (block.type === "paragraph" || block.type === "quote") out.push(block.text, "");
    else if (block.type === "list") out.push(...block.items.map((i) => `  - ${i}`), "");
    else if (block.type === "code") out.push(block.text, "");
    else if (block.type === "table") {
      if (block.headers.length) out.push(block.headers.join("\t"));
      for (const row of block.rows) out.push(row.join("\t"));
      out.push("");
    } else if (block.type === "image") out.push(`[image: ${block.alt || block.src}]`);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** JSON view: exactly the structured extraction, sized down for transport. */
export function toJsonView(page: ExtractedPage, maxChars = LIMITS.maxTextChars): { text: string; truncated: boolean } {
  const text = JSON.stringify(page, null, 2);
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: JSON.stringify({ ...page, paragraphs: page.paragraphs.slice(0, 80), contentBlocks: page.contentBlocks.slice(0, 120), links: page.links.slice(0, 60), note: "Truncated to the result size budget; fetch with a smaller max_chars or use format=markdown." }, null, 2), truncated: true };
}

/** Pull author/date fields out of the common schema.org types. */
function flattenJsonLd(blocks: unknown[]): { author: string | null; datePublished: string | null; dateModified: string | null } {
  let author: string | null = null;
  let datePublished: string | null = null;
  let dateModified: string | null = null;
  const visitValue = (value: unknown, depth = 0): void => {
    if (!value || depth > 4) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) visitValue(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (!author) {
      const person = obj.author ?? obj.creator;
      if (typeof person === "string") author = cleanText(person, 200);
      else if (person && typeof person === "object") {
        const name = (person as Record<string, unknown>).name ?? (person as Record<string, unknown>).displayName;
        if (typeof name === "string") author = cleanText(name, 200);
      }
    }
    if (!datePublished && typeof obj.datePublished === "string") datePublished = obj.datePublished.slice(0, 64);
    if (!dateModified && typeof obj.dateModified === "string") dateModified = obj.dateModified.slice(0, 64);
    for (const key of Object.keys(obj)) {
      if (author && datePublished && dateModified) break;
      visitValue(obj[key], depth + 1);
    }
  };
  for (const block of blocks) visitValue(block);
  return { author, datePublished, dateModified };
}
