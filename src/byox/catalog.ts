/**
 * Build Your Own X — catalog model.
 *
 * `https://github.com/codecrafters-io/build-your-own-x` is a curated catalog:
 * a single README whose `#### Build your own \`Category\`` headings group
 * bullets of the shape
 *
 *   * [**C++**: _Introduction to Ray Tracing …_](https://example.org/lesson)
 *   * [**C# / TypeScript / JavaScript**: _Learning to write a 3D engine_](…)
 *   * [**C#**: _How To Unity ARCore_](…) [video]
 *
 * Everything here is pure and synchronous: DEMO stores *references* (title,
 * languages, category, original URL, host, format) and never copies tutorial
 * text. The parser is deliberately tolerant — the upstream README is edited by
 * many people — but it refuses to fabricate: a line it cannot understand is
 * skipped, not guessed at, and `parseReport()` reports what was skipped so an
 * operator can see a format change instead of silently losing entries.
 */

export interface ByoxTutorial {
  /** Stable across refreshes: category + title slug + a hash of the URL. */
  id: string;
  title: string;
  categoryId: string;
  category: string;
  /** Languages the catalog itself names, in the order the README lists them. */
  languages: string[];
  url: string;
  host: string;
  /** `video` when the entry is marked `[video]` or hosted on a video platform. */
  format: "article" | "video";
}

export interface ByoxCategory {
  id: string;
  title: string;
  count: number;
  languages: Array<{ name: string; count: number }>;
}

export interface ByoxSourceState {
  repo: string;
  readmeUrl: string;
  /** Strong validator from the origin, replayed as `If-None-Match`. */
  etag: string | null;
  lastModified: string | null;
  /** SHA-256 of the README bytes that produced this index. */
  sha256: string;
  bytes: number;
  /** When the text last changed (`generatedAt`) vs when it was last checked. */
  fetchedAt: string;
  lastCheckedAt: string;
  /** Commits/refreshes seen since the index was first built. */
  refreshCount: number;
}

export interface ByoxIndex {
  version: 1;
  generatedAt: string;
  source: ByoxSourceState;
  categories: ByoxCategory[];
  tutorials: ByoxTutorial[];
  counts: { categories: number; tutorials: number; languages: number; skipped: number };
}

export interface ByoxParseReport {
  index: ByoxIndex;
  skipped: number;
  /** Lines that looked like an entry but failed the parser — never silently lost. */
  problems: string[];
}

/** Tutorials below this count mean the response was almost certainly not the real README. */
export const BYOX_MIN_TUTORIALS = 50;

const HEADING = /^#{2,5}\s+build your own\s+`?([^`\n]+?)`?\s*$/i;
const BULLET = /^\s{0,3}[*+-]\s+\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)\s*(.*)$/;
const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv)$/i;

/** A few spellings the catalog uses interchangeably; everything else is kept verbatim. */
const LANGUAGE_ALIASES: Record<string, string> = {
  js: "JavaScript",
  ts: "TypeScript",
  node: "Node.js",
  nodejs: "Node.js",
  golang: "Go",
  "c#": "C#",
  "c++": "C++",
  "f#": "F#",
  "objective-c": "Objective-C",
  "visual basic": "Visual Basic",
  wasm: "WebAssembly",
  pc: "Pseudocode",
};

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** FNV-1a, 32-bit, hex — stable, synchronous, dependency-free. */
export function tinyHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Split a language label like `C# / TypeScript / JavaScript` or `Java or Kotlin`. */
export function splitLanguages(label: string): string[] {
  const parts = label
    .replace(/\s+or\s+/gi, "/")
    .split(/[\/,;]/)
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const normalized = LANGUAGE_ALIASES[part.toLowerCase()] ?? part;
    if (normalized.length > 24 || !/[A-Za-z]/.test(normalized)) continue;
    if (seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    out.push(normalized);
  }
  return out;
}

/** Strip the README's markdown emphasis from a title. */
export function cleanTitle(raw: string): string {
  return raw
    .replace(/\s*\[video\]\s*$/i, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

interface ParsedLine {
  languages: string[];
  title: string;
  video: boolean;
}

/** `**C++**: _Title_` → languages + title; `_Title_` → title only. */
function parseLinkText(raw: string, trailing: string): ParsedLine {
  const video = /\[video\]/i.test(trailing) || /\[video\]/i.test(raw);
  const bold = /^\*\*(.+?)\*\*\s*:\s*(.*)$/.exec(raw.trim());
  const languages = bold ? splitLanguages(bold[1] ?? "") : [];
  const rest = bold ? (bold[2] ?? "") : raw;
  return { languages, title: cleanTitle(rest), video };
}

/**
 * Parse the upstream README.
 *
 * Only bullets that follow a `Build your own \`X\`` heading inside the tutorials
 * section are considered, and only absolute `http(s)` links: the table of
 * contents (anchor links) and the banner image are ignored by construction
 * rather than by a fragile block-list.
 */
export function parseByoxReadme(markdown: string, options: { repo?: string; readmeUrl?: string; etag?: string | null; lastModified?: string | null; sha256?: string; fetchedAt?: string } = {}): ByoxParseReport {
  const lines = markdown.split(/\r?\n/);
  const tutorials: ByoxTutorial[] = [];
  const problems: string[] = [];
  let skipped = 0;
  let inTutorials = false;
  let category: string | null = null;
  const seen = new Set<string>();

  for (const line of lines) {
    if (/^#{1,3}\s+tutorials\s*$/i.test(line)) {
      inTutorials = true;
      category = null;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      // The intro heading (`## Build your own <insert-technology-here>`) is not a category.
      const title = cleanTitle(heading[1] ?? "");
      if (/insert-technology-here/i.test(title) || !inTutorials) {
        category = null;
        continue;
      }
      category = title;
      continue;
    }
    if (/^#{1,5}\s+/.test(line)) {
      // A different heading ends the current category (e.g. the next top section).
      if (/^#{1,2}\s+/.test(line)) {
        category = null;
        inTutorials = /^#{1,3}\s+tutorials\s*$/i.test(line);
      }
      continue;
    }
    const bullet = BULLET.exec(line);
    if (!bullet) {
      if (inTutorials && /^\s{0,3}[*+-]\s+/.test(line)) skipped += 1;
      continue;
    }
    if (!inTutorials || !category) {
      skipped += 1;
      continue;
    }
    const parsed = parseLinkText(bullet[1] ?? "", bullet[3] ?? "");
    const url = (bullet[2] ?? "").trim();
    if (!parsed.title) {
      problems.push(`no title: ${line.trim().slice(0, 160)}`);
      continue;
    }
    let host: string;
    try {
      host = new URL(url).host.toLowerCase();
    } catch {
      problems.push(`unparseable URL: ${line.trim().slice(0, 160)}`);
      continue;
    }
    if (host.endsWith("github.com") && /\/codecrafters-io\/build-your-own-x/i.test(url)) {
      problems.push(`self-link ignored: ${line.trim().slice(0, 160)}`);
      continue;
    }
    const categoryId = slug(category);
    const id = `${categoryId}:${slug(parsed.title)}-${tinyHash(url)}`;
    if (seen.has(id)) {
      problems.push(`duplicate entry ignored: ${parsed.title.slice(0, 120)}`);
      continue;
    }
    seen.add(id);
    tutorials.push({
      id,
      title: parsed.title,
      categoryId,
      category,
      languages: parsed.languages,
      url,
      host,
      format: parsed.video || VIDEO_HOSTS.test(host) ? "video" : "article",
    });
  }

  tutorials.sort((a, b) => (a.category === b.category ? a.title.localeCompare(b.title) : a.category.localeCompare(b.category)));
  const { categories, languages } = summarize(tutorials);
  const now = options.fetchedAt ?? new Date().toISOString();
  const index: ByoxIndex = {
    version: 1,
    generatedAt: now,
    source: {
      repo: options.repo ?? "codecrafters-io/build-your-own-x",
      readmeUrl: options.readmeUrl ?? "https://raw.githubusercontent.com/codecrafters-io/build-your-own-x/master/README.md",
      etag: options.etag ?? null,
      lastModified: options.lastModified ?? null,
      sha256: options.sha256 ?? tinyHash(markdown),
      bytes: markdown.length,
      fetchedAt: now,
      lastCheckedAt: now,
      refreshCount: 1,
    },
    categories,
    tutorials,
    counts: { categories: categories.length, tutorials: tutorials.length, languages: languages.length, skipped },
  };
  return { index, skipped, problems };
}

function summarize(tutorials: ByoxTutorial[]): { categories: ByoxCategory[]; languages: Array<{ name: string; count: number }> } {
  const byCategory = new Map<string, ByoxCategory>();
  const languageCounts = new Map<string, number>();
  for (const tutorial of tutorials) {
    let category = byCategory.get(tutorial.categoryId);
    if (!category) {
      category = { id: tutorial.categoryId, title: tutorial.category, count: 0, languages: [] };
      byCategory.set(tutorial.categoryId, category);
    }
    category.count += 1;
    for (const language of tutorial.languages) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
  }
  const categories = [...byCategory.values()]
    .map((category) => {
      const counts = new Map<string, number>();
      for (const tutorial of tutorials) {
        if (tutorial.categoryId !== category.id) continue;
        for (const language of tutorial.languages) counts.set(language, (counts.get(language) ?? 0) + 1);
      }
      return {
        ...category,
        languages: [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => (b.count === a.count ? a.name.localeCompare(b.name) : b.count - a.count)),
      };
    })
    .sort((a, b) => (b.count === a.count ? a.title.localeCompare(b.title) : b.count - a.count));
  const languages = [...languageCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => (b.count === a.count ? a.name.localeCompare(b.name) : b.count - a.count));
  return { categories, languages };
}

export interface ByoxSearchOptions {
  query?: string;
  category?: string;
  language?: string;
  format?: "article" | "video";
  limit?: number;
  offset?: number;
}

export interface ByoxSearchHit {
  tutorial: ByoxTutorial;
  score: number;
}

/**
 * Keyword search with category/language filters.
 *
 * Every query token must match somewhere (title, category, language, host) so a
 * multi-word query cannot silently degrade into a single-word one; scoring then
 * ranks title and language matches above host matches. Filters accept either a
 * slug (`3d-renderer`) or the display name (`3D Renderer`).
 */
export function searchByox(index: ByoxIndex, options: ByoxSearchOptions = {}): { total: number; hits: ByoxSearchHit[] } {
  const tokens = (options.query ?? "")
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((token) => token.length > 1);
  const phrase = (options.query ?? "").trim().toLowerCase();
  const category = options.category ? slug(options.category) : null;
  const language = options.language?.trim().toLowerCase() ?? null;
  const hits: ByoxSearchHit[] = [];

  for (const tutorial of index.tutorials) {
    if (options.format && tutorial.format !== options.format) continue;
    if (category && tutorial.categoryId !== category) continue;
    if (language && !tutorial.languages.some((entry) => entry.toLowerCase() === language)) continue;
    const title = tutorial.title.toLowerCase();
    const categoryText = tutorial.category.toLowerCase();
    const languages = tutorial.languages.map((entry) => entry.toLowerCase());
    const haystack = `${title} ${categoryText} ${languages.join(" ")} ${tutorial.host}`;
    if (tokens.length && !tokens.every((token) => haystack.includes(token))) continue;
    let score = 0;
    for (const token of tokens) {
      if (title.includes(token)) score += 3;
      if (languages.some((entry) => entry.includes(token))) score += 2;
      if (categoryText.includes(token)) score += 2;
      if (tutorial.host.includes(token)) score += 1;
    }
    if (phrase && tokens.length > 1 && title.includes(phrase)) score += 6;
    if (!tokens.length) score = tutorial.languages.length ? 2 : 1;
    hits.push({ tutorial, score });
  }
  hits.sort((a, b) => (b.score === a.score ? a.tutorial.title.localeCompare(b.tutorial.title) : b.score - a.score));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const limit = Math.min(50, Math.max(1, Math.floor(options.limit ?? 10)));
  return { total: hits.length, hits: hits.slice(offset, offset + limit) };
}

export function findTutorial(index: ByoxIndex, idOrUrl: string): ByoxTutorial | null {
  const needle = idOrUrl.trim();
  if (!needle) return null;
  const lowered = needle.toLowerCase();
  return (
    index.tutorials.find((tutorial) => tutorial.id === needle) ??
    index.tutorials.find((tutorial) => tutorial.url.toLowerCase() === lowered) ??
    index.tutorials.find((tutorial) => tutorial.title.toLowerCase() === lowered) ??
    null
  );
}

export interface ByoxIndexDiff {
  added: string[];
  removed: string[];
  updated: Array<{ id: string; changes: string[] }>;
  fromTutorials: number;
  toTutorials: number;
}

/** What changed between two refreshes — the basis of the change report. */
export function diffByoxIndexes(previous: ByoxIndex | null, next: ByoxIndex): ByoxIndexDiff {
  if (!previous) {
    return { added: next.tutorials.map((tutorial) => tutorial.id), removed: [], updated: [], fromTutorials: 0, toTutorials: next.tutorials.length };
  }
  const before = new Map(previous.tutorials.map((tutorial) => [tutorial.id, tutorial]));
  const after = new Map(next.tutorials.map((tutorial) => [tutorial.id, tutorial]));
  const added: string[] = [];
  const removed: string[] = [];
  const updated: Array<{ id: string; changes: string[] }> = [];
  for (const [id, tutorial] of after) {
    const old = before.get(id);
    if (!old) {
      added.push(id);
      continue;
    }
    const changes: string[] = [];
    if (old.title !== tutorial.title) changes.push("title");
    if (old.url !== tutorial.url) changes.push("url");
    if (old.category !== tutorial.category) changes.push("category");
    if (old.languages.join("|") !== tutorial.languages.join("|")) changes.push("languages");
    if (old.format !== tutorial.format) changes.push("format");
    if (changes.length) updated.push({ id, changes });
  }
  for (const id of before.keys()) if (!after.has(id)) removed.push(id);
  return { added, removed, updated, fromTutorials: previous.tutorials.length, toTutorials: next.tutorials.length };
}

/* ------------------------------------------------------------- learning plans */

export interface LearningPlanStep {
  order: number;
  title: string;
  why: string;
  prerequisites: string[];
  tutorials: Array<{ id: string; title: string; url: string; host: string; languages: string[] }>;
  exercises: string[];
}

export interface LearningPlan {
  goal: string;
  level: string;
  languages: string[];
  weeks: number;
  generatedAt: string;
  catalog: { tutorials: number; categories: number; refreshedAt: string };
  steps: LearningPlanStep[];
  notes: string[];
}

/** Categories that are prerequisites for other categories in the catalog. */
const PREREQUISITES: Record<string, string[]> = {
  "programming-language": ["command-line-tool", "shell"],
  shell: ["command-line-tool"],
  "network-stack": ["command-line-tool"],
  "web-server": ["network-stack"],
  "web-browser": ["network-stack", "programming-language"],
  "search-engine": ["database", "network-stack"],
  docker: ["operating-system"],
  "operating-system": ["command-line-tool"],
  blockchain: ["database", "network-stack"],
  git: ["command-line-tool"],
  emulator: ["processor", "programming-language"],
  "neural-network": ["programming-language"],
  "physics-engine": ["3d-renderer"],
  game: ["3d-renderer", "physics-engine"],
  "front-end-framework": ["programming-language", "template-engine"],
  database: ["command-line-tool"],
};

const FOUNDATION_LANGUAGES = ["Python", "JavaScript", "TypeScript", "Go", "Ruby", "Java", "C#", "Rust", "C++", "C"];

function pickTutorials(index: ByoxIndex, categoryId: string, languages: string[], count: number): ByoxTutorial[] {
  const category = index.tutorials.filter((tutorial) => tutorial.categoryId === categoryId);
  const preferred = category.filter((tutorial) => tutorial.languages.some((entry) => languages.some((language) => language.toLowerCase() === entry.toLowerCase())));
  const pool = preferred.length ? preferred : category;
  // Prefer non-video, then shorter titles (usually the focused single-topic guides).
  return [...pool]
    .sort((a, b) => (a.format === b.format ? a.title.length - b.title.length : a.format === "article" ? -1 : 1))
    .slice(0, count);
}

/**
 * A deterministic roadmap: prerequisite order comes from `PREREQUISITES` and the
 * catalog itself, tutorial references are the catalog's original links, and the
 * exercises are generated from the category title. Nothing here claims DEMO can
 * read the linked tutorials — they are external sources.
 */
export function buildLearningPlan(
  index: ByoxIndex,
  input: { goal: string; level?: string; languages?: string[]; weeks?: number; maxSteps?: number },
): LearningPlan {
  const goal = cleanTitle(input.goal ?? "").slice(0, 200) || "software engineering from scratch";
  const level = (input.level ?? "intermediate").trim().toLowerCase();
  const wanted = (input.languages ?? []).map((language) => (LANGUAGE_ALIASES[language.trim().toLowerCase()] ?? language.trim())).filter(Boolean);
  const languages = wanted.length ? wanted : FOUNDATION_LANGUAGES.filter((language) => index.categories.some((category) => category.languages.some((entry) => entry.name === language))).slice(0, 2);
  const weeks = Math.min(52, Math.max(1, Math.floor(input.weeks ?? 12)));
  const maxSteps = Math.min(10, Math.max(2, Math.floor(input.maxSteps ?? 6)));

  const { hits } = searchByox(index, { query: goal, limit: 24 });
  const matchedCategories: string[] = [];
  for (const hit of hits) if (!matchedCategories.includes(hit.tutorial.categoryId)) matchedCategories.push(hit.tutorial.categoryId);
  if (!matchedCategories.length) {
    for (const category of index.categories.slice(0, 3)) matchedCategories.push(category.id);
  }
  const core = matchedCategories.slice(0, Math.max(1, maxSteps - 2));

  const prerequisiteIds: string[] = [];
  for (const categoryId of core) {
    for (const prerequisite of PREREQUISITES[categoryId] ?? []) {
      if (!core.includes(prerequisite) && !prerequisiteIds.includes(prerequisite) && index.categories.some((category) => category.id === prerequisite)) {
        prerequisiteIds.push(prerequisite);
      }
    }
  }

  const steps: LearningPlanStep[] = [];
  const pushPlanStep = (title: string, why: string, prerequisites: string[], categoryIds: string[], exercises: string[]) => {
    const tutorials = categoryIds
      .flatMap((categoryId) => pickTutorials(index, categoryId, languages, Math.max(1, Math.ceil(3 / Math.max(1, categoryIds.length)))))
      .slice(0, 4)
      .map((tutorial) => ({ id: tutorial.id, title: tutorial.title, url: tutorial.url, host: tutorial.host, languages: tutorial.languages }));
    steps.push({ order: steps.length + 1, title, why, prerequisites, tutorials, exercises });
  };

  pushPlanStep(
    `Set the foundations${languages.length ? ` in ${languages.join(" / ")}` : ""}`,
    "Every later project assumes fluency in one language, its test runner and its packaging.",
    [],
    ["command-line-tool"],
    [
      languages.length
        ? `Write and run a hello-world plus a unit test in ${languages.join(" and ")} with the language's idiomatic tooling (no framework shortcuts).`
        : "Pick one language from the catalog, then write and run a hello-world plus a unit test with its idiomatic tooling.",
      "Practise reading a reference implementation: clone one tutorial repository, run its tests, and write down the three ideas it teaches.",
    ],
  );
  for (const prerequisite of prerequisiteIds.slice(0, 2)) {
    const category = index.categories.find((entry) => entry.id === prerequisite);
    if (!category) continue;
    pushPlanStep(
      `Prerequisite: ${category.title}`,
      `The catalog lists ${category.count} ${category.title} tutorials, and ${core.map((id) => index.categories.find((entry) => entry.id === id)?.title ?? id).join(", ")} builds directly on it.`,
      [],
      [category.id],
      [
        `Work through one ${category.title} tutorial end to end; do not copy code — implement from the explanation and only consult the source when stuck.`,
        `Add at least two tests that would fail if your ${category.title} implementation regressed.`,
      ],
    );
  }
  for (const categoryId of core) {
    const category = index.categories.find((entry) => entry.id === categoryId);
    if (!category) continue;
    const share = Math.max(1, Math.round(weeks / (core.length + 1)));
    pushPlanStep(
      `Build: ${category.title}`,
      `Matches the goal "${goal}". The catalog holds ${category.count} tutorials across ${category.languages.length} language${category.languages.length === 1 ? "" : "s"} for this category.`,
      prerequisiteIds.length ? ["Foundations", ...prerequisiteIds.map((id) => index.categories.find((entry) => entry.id === id)?.title ?? id)] : ["Foundations"],
      [category.id],
      [
        `Implement a minimal ${category.title.toLowerCase()} from scratch, following one listed tutorial as the reference (about ${share} week${share === 1 ? "" : "s"}).`,
        `Write tests for the parts the tutorial leaves implicit, then diff your design decisions against the tutorial's and record the trade-offs.`,
        `Package the result so another collaborator can run it: README, one command to test, one command to run.`,
      ],
    );
  }
  pushPlanStep(
    "Integrate and verify",
    "Finishing with an integration step proves the pieces work together, which is what a portfolio (or a collaborator review) checks.",
    ["Foundations", ...core.map((id) => index.categories.find((entry) => entry.id === id)?.title ?? id)],
    core.slice(0, 1),
    [
      "Make the components you built work together behind one entry point, with an end-to-end test.",
      "Ask a second collaborator to review the diff: record who reviewed which file and what changed.",
      "Publish the result (public repository or a written report) with the exact commit you verified.",
    ],
  );

  return {
    goal,
    level,
    languages,
    weeks,
    generatedAt: new Date().toISOString(),
    catalog: { tutorials: index.counts.tutorials, categories: index.counts.categories, refreshedAt: index.source.lastCheckedAt },
    steps: steps.slice(0, maxSteps + 2),
    notes: [
      "Tutorial links point at their original authors; DEMO stores references only and never re-hosts tutorial content.",
      "Progress depends on actually writing code and tests — a plan with no commits is not progress.",
      "Respect each source's licence and access rules; DEMO does not bypass paywalls, CAPTCHAs or logins.",
    ],
  };
}
