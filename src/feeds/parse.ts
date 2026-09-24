/**
 * RSS 2.x / Atom 1.0 / RDF feed parsing (DEMO 0.9 shared module).
 *
 * Feeds are untrusted input: this parser extracts, never executes — CDATA and
 * HTML inside descriptions is kept as text (later cleaned by `html-lite`), and
 * DOCTYPE/external entities are ignored by `xml-lite` (no XXE). Malformed feeds
 * degrade gracefully with `warnings` instead of throwing.
 */

import { cleanText, decodeEntities, parseHtml, textOf, walk } from "../core/html-lite.js";
import { LIMITS, clamp } from "../core/limits.js";
import { childrenNamed, firstNamed, nodeText, parseXml, pickLink, rawText, type XmlNode } from "../core/xml-lite.js";

export interface FeedItem {
  id: string | null;
  title: string | null;
  link: string | null;
  guid: string | null;
  guidIsPermalink: boolean | null;
  published: string | null;
  updated: string | null;
  authors: string[];
  categories: string[];
  description: string | null;
  content: string | null;
  summaryText: string;
  enclosures: Array<{ url: string; type: string | null; length: number | null }>;
}

export interface ParsedFeed {
  format: "rss2" | "atom" | "rdf" | "unknown";
  title: string | null;
  description: string | null;
  link: string | null;
  language: string | null;
  updated: string | null;
  generator: string | null;
  copyright: string | null;
  author: string | null;
  feedUrl: string | null;
  items: FeedItem[];
  totalItems: number;
  truncated: boolean;
  warnings: string[];
}

export interface ParseFeedOptions {
  limit?: number;
  /** Base URL for relative links. */
  baseUrl?: string | null;
}

/** Parse a feed document (RSS 2.x, Atom, RDF/RSS 1.0). Never throws on bad input. */
export function parseFeed(source: string, options: ParseFeedOptions = {}): ParsedFeed {
  const warnings: string[] = [];
  const limit = clamp(options.limit ?? LIMITS.feedMaxEntriesDefault, 1, LIMITS.feedMaxEntriesCap);
  const { root, warnings: parseWarnings } = parseXmlDoc(source);
  warnings.push(...parseWarnings);
  if (!root) {
    return emptyFeed("unknown", warnings.concat("The document is not a parseable feed (no root element)."), limit);
  }

  const feedNode: XmlNode = (root.localName === "rss" ? firstNamed(root, "channel") : root.localName.toLowerCase() === "rdf" ? root : root.localName === "feed" ? root : firstNamed(root, "channel")) ?? root;
  const kind = detectFormat(root, feedNode);
  const warningsOut = warnings;

  // Channel-level metadata: RSS <channel> children / Atom <feed> children.
  const channel = feedNode;
  const title = firstText(channel, "title");
  const description = firstText(channel, "description") ?? firstText(channel, "subtitle") ?? firstText(channel, "tagline");
  const link = resolveLink(pickFeedLink(channel, kind), options.baseUrl);
  const language = firstText(channel, "language");
  const updated = firstText(channel, "lastBuildDate") ?? firstText(channel, "pubDate") ?? firstText(channel, "updated");
  const generator = firstText(channel, "generator");
  const copyright = firstText(channel, "copyright") ?? firstText(channel, "rights");
  const authorNode = firstNamed(channel, "author");
  const author =
    firstText(channel, "managingEditor") ??
    (authorNode ? nodeText(firstNamed(authorNode, "name")) || nodeText(authorNode) : null) ??
    firstText(channel, "creator") ??
    firstText(channel, "rights");
  const feedUrl = resolveLink(pickLink(channel, "self"), options.baseUrl);

  const itemNodes = kind === "atom" ? childrenNamed(channel, "entry") : [...childrenNamed(channel, "item"), ...childrenNamed(root, "item")];
  const items: FeedItem[] = [];
  for (const node of itemNodes) {
    if (items.length >= limit) break;
    items.push(kind === "atom" ? atomItem(node, options.baseUrl) : rssItem(node, options.baseUrl));
  }

  return {
    format: kind,
    title: title ? cleanText(title, 400) : null,
    description: description ? cleanText(stripHtml(description), 2_000) : null,
    link,
    language,
    updated: normalizeDate(updated),
    generator: generator ? cleanText(generator, 200) : null,
    copyright: copyright ? cleanText(copyright, 400) : null,
    author: author ? cleanText(author, 200) : null,
    feedUrl,
    items,
    totalItems: itemNodes.length,
    truncated: itemNodes.length > limit,
    warnings: warningsOut.slice(0, 20),
  };
}

function parseXmlDoc(source: string) {
  return parseXml(source, { maxNodes: 20_000 });
}

function emptyFeed(format: ParsedFeed["format"], warnings: string[], _limit: number): ParsedFeed {
  return {
    format,
    title: null,
    description: null,
    link: null,
    language: null,
    updated: null,
    generator: null,
    copyright: null,
    author: null,
    feedUrl: null,
    items: [],
    totalItems: 0,
    truncated: false,
    warnings,
  };
}

function detectFormat(root: XmlNode, channel: XmlNode): ParsedFeed["format"] {
  const name = root.localName.toLowerCase();
  if (name === "rss") return "rss2";
  if (name === "feed") return "atom";
  if (name === "rdf") return "rdf";
  if (childrenNamed(channel, "entry").length > 0) return "atom";
  return "unknown";
}

function firstText(node: XmlNode | null, ...names: string[]): string | null {
  const found = firstNamed(node, ...names);
  const text = nodeText(found);
  return text || null;
}

function pickFeedLink(node: XmlNode | null, kind: ParsedFeed["format"]): string | null {
  if (!node) return null;
  if (kind === "atom") return pickLink(node, "alternate");
  const direct = firstNamed(node, "link");
  const text = nodeText(direct);
  return text || pickLink(node, "alternate");
}

function resolveLink(value: string | null, baseUrl: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!baseUrl) return trimmed;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return trimmed;
  }
}

function rssItem(node: XmlNode, baseUrl: string | null | undefined): FeedItem {
  const title = firstText(node, "title");
  const link = resolveLink(firstText(node, "link"), baseUrl);
  const guidNode = firstNamed(node, "guid");
  const guid = nodeText(guidNode) || null;
  const isPermalink = guidNode ? guidNode.attrs["ispermalink"] !== "false" : null;
  const descriptionHtml = firstText(node, "description");
  const content = firstNamed(node, "encoded") ? rawText(firstNamed(node, "encoded")) : null;
  const authors = collectAuthors(node, "author", "creator", "managingEditor");
  const categories = childrenNamed(node, "category").map((child) => nodeText(child)).filter(Boolean);
  const enclosures = childrenNamed(node, "enclosure")
    .map((child) => ({
      url: resolveLink(child.attrs.url ?? null, baseUrl) ?? "",
      type: child.attrs.type ?? null,
      length: Number.isFinite(Number(child.attrs.length)) ? Number(child.attrs.length) : null,
    }))
    .filter((entry) => entry.url);
  const summarySource = descriptionHtml ?? content ?? "";
  return {
    id: guid ?? link,
    title: title ? cleanText(title, 400) : null,
    link,
    guid,
    guidIsPermalink: isPermalink,
    published: normalizeDate(firstText(node, "pubDate") ?? firstText(node, "date")),
    updated: null,
    authors: authors.slice(0, 5),
    categories: categories.slice(0, 20),
    description: descriptionHtml ? cleanText(stripHtml(descriptionHtml), 4_000) : null,
    content: content ? cleanText(stripHtml(content), 20_000) : null,
    summaryText: cleanText(stripHtml(summarySource), 600),
    enclosures: enclosures.slice(0, 5),
  };
}

function atomItem(node: XmlNode, baseUrl: string | null | undefined): FeedItem {
  const title = firstText(node, "title");
  const link = resolveLink(pickLink(node, "alternate"), baseUrl);
  const id = firstText(node, "id");
  const summaryHtml = firstText(node, "summary");
  const contentNode = firstNamed(node, "content");
  const contentHtml = contentNode ? rawText(contentNode) : null;
  const authors = collectAuthors(node, "author", "contributor");
  const categories = childrenNamed(node, "category")
    .map((child) => child.attrs.term ?? nodeText(child))
    .filter(Boolean);
  const enclosures = childrenNamed(node, "link")
    .filter((child) => (child.attrs.rel ?? "alternate") === "enclosure")
    .map((child) => ({
      url: resolveLink(child.attrs.href ?? null, baseUrl) ?? "",
      type: child.attrs.type ?? null,
      length: Number.isFinite(Number(child.attrs.length)) ? Number(child.attrs.length) : null,
    }))
    .filter((entry) => entry.url);
  return {
    id: id ?? link,
    title: title ? cleanText(title, 400) : null,
    link,
    guid: id,
    guidIsPermalink: null,
    published: normalizeDate(firstText(node, "published") ?? firstText(node, "issued") ?? firstText(node, "created")),
    updated: normalizeDate(firstText(node, "updated") ?? firstText(node, "modified")),
    authors: authors.slice(0, 5),
    categories: categories.slice(0, 20),
    description: summaryHtml ? cleanText(stripHtml(summaryHtml), 4_000) : null,
    content: contentHtml ? cleanText(stripHtml(contentHtml), 20_000) : null,
    summaryText: cleanText(stripHtml(summaryHtml ?? contentHtml ?? ""), 600),
    enclosures: enclosures.slice(0, 5),
  };
}

function collectAuthors(node: XmlNode, ...names: string[]): string[] {
  const out: string[] = [];
  for (const authorNode of childrenNamed(node, ...names)) {
    const nameNode = firstNamed(authorNode, "name");
    const text = nodeText(nameNode) || nodeText(authorNode);
    if (text) out.push(cleanText(text, 200));
  }
  return out;
}

/** Strip HTML markup to readable text (safe: scripts/styles are skipped by parseHtml). */
export function stripHtml(html: string, maxChars = 20_000): string {
  if (!/[<&>]/.test(html)) return decodeEntities(html.slice(0, maxChars));
  const root = parseHtml(html, { maxNodes: 8_000 });
  return cleanText(textOf(root), maxChars);
}

/** RFC 822 / ISO-8601 / truncated date parsing → ISO string or null. */
export function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  // Common non-ISO shapes: "5 Jan 2024", "2024-01-05".
  const fallback = Date.parse(`${raw} UTC`);
  return Number.isFinite(fallback) ? new Date(fallback).toISOString() : null;
}
