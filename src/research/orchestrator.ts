/**
 * Structured web research (DEMO 0.9) — an orchestration layer, not a new brain.
 *
 * It combines capabilities DEMO already has: guarded HTTP fetch, the shared
 * webpage extractor, the Internet Archive client (for archived fallbacks and
 * catalog sources), and the shared text-diff/normalization utilities. DEMO has
 * no LLM inside it, so "interpret the question" is deterministic keyword
 * planning and the returned evidence is what a connected AI should reason over:
 *
 *   discover → retrieve → extract → compare → findings with provenance
 *
 * Non-negotiables:
 *   - every externally sourced statement keeps its source URL + retrieved_at,
 *   - `findings.facts` only contains sentences actually present in sources
 *     (quoted, truncated); `findings.inference` is explicitly labelled as
 *     cross-source synthesis the agent should verify,
 *   - conflicts are reported as conflicts with both variants, never resolved
 *     by guessing; `confidence` is a heuristic and says so,
 *   - a source that needs CAPTCHA/auth/human interaction is *reported* with a
 *     human-handoff hint (browser_pause_for_human / browser_captcha_handoff),
 *     never bypassed.
 */

import { LIMITS, clamp } from "../core/limits.js";
import { createSsrfGuard, guardedFetchBytes } from "../core/guarded-fetch.js";
import { findAll, parseHtml, textOf, decodeEntities } from "../core/html-lite.js";
import { publicToolRateLimiter } from "../core/rate-limit.js";
import { toPlainText, type ExtractedPage } from "../web/extract.js";
import { fetchPublicPage } from "../web/fetch-page.js";
import { archiveSearchItems, waybackRetrieve } from "../archive/client.js";

export interface ResearchOptions {
  env: Record<string, unknown> | undefined;
  query: string;
  depth?: "quick" | "standard" | "deep";
  maxSources?: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  timeoutMs?: number;
  includeArchiveFallback?: boolean;
}

export interface SourceRecord {
  url: string;
  finalUrl: string;
  title: string | null;
  retrievedAt: string;
  status: "retrieved" | "blocked" | "archived" | "failed" | "skipped";
  via: "web" | "archive" | "catalog";
  archivedTimestamp: string | null;
  bytes: number | null;
  words: number | null;
  error: string | null;
  humanHandoffHint: string | null;
}

export interface EvidenceSentence {
  text: string;
  sourceIndex: number;
  sourceUrl: string;
  retrievedAt: string;
  /** Which query terms matched — provenance for *why* this sentence was picked. */
  matchedTerms: string[];
}

export interface ResearchResult {
  query: string;
  plan: {
    coreTerms: string[];
    variants: string[];
    depth: string;
    maxSources: number;
    domainPolicy: { allowed: string[] | null; blocked: string[] };
  };
  sources: SourceRecord[];
  discovery: { provider: string; candidates: number; considered: number; message: string };
  findings: {
    facts: Array<{ statement: string; sources: Array<{ url: string; retrievedAt: string; snippet: string }>; agreementCount: number }>;
    conflicts: Array<{ topic: string; variants: Array<{ statement: string; sourceUrl: string }> }>;
    inference: Array<{ statement: string; basis: string[] }>;
  };
  confidence: { level: "none" | "low" | "medium" | "high"; basis: string; note: string };
  uncertainty: string[];
  limitations: string[];
  provenanceNote: string;
  message: string;
}

const STOPWORDS = new Set(
  "a an and are as at be but by for from has have how in is it its of on or that the this to was what when where which who why will with about does did can could should would me my our your their there here than then so if into over under more most least find out tell explain show describe".split(" "),
);

/** Deterministic query planning: core terms + cheap variants. */
export function planQuery(query: string): { coreTerms: string[]; variants: string[] } {
  const words = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const core = [...new Set(words.filter((word) => word.length > 2 && !STOPWORDS.has(word)))].slice(0, 8);
  const terms = core.length ? core : words.slice(0, 4);
  const variants = [query.trim().slice(0, 300)];
  if (terms.length > 2) variants.push(terms.slice(0, 3).join(" "));
  if (terms.length > 0) variants.push(terms.join(" "));
  return { coreTerms: terms, variants: [...new Set(variants)].slice(0, 3) };
}

/** Discovery provider: DuckDuckGo's public lite endpoint (no API key). */
export async function discoverSources(env: Record<string, unknown> | undefined, query: string, limit: number): Promise<{ candidates: Array<{ url: string; title: string; snippet: string }>; provider: string; message: string }> {
  const guard = createSsrfGuard(env);
  const result = await guardedFetchBytes(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query.slice(0, 300))}`, {
    guard,
    timeoutMs: 12_000,
    maxBytes: 1_500_000,
    acceptContentTypes: ["text/html", "text/plain"],
    headers: { accept: "text/html", "user-agent": "DEMO-MCP/1.1.0 (+research; public read-only)" },
  });
  const html = new TextDecoder("utf-8", { fatal: false }).decode(result.bytes);
  const root = parseHtml(html, { maxNodes: 12_000 });
  const candidates: Array<{ url: string; title: string; snippet: string }> = [];
  for (const anchor of findAll(root, "a", 200)) {
    const href = anchor.attrs.href ?? "";
    let target = href;
    // DDG lite wraps results in /l/?uddg=<encoded>.
    const uddg = /[?&]uddg=([^&]+)/.exec(href);
    if (uddg) {
      try {
        target = decodeURIComponent(uddg[1]);
      } catch {
        continue;
      }
    }
    if (!/^https?:\/\//i.test(target)) continue;
    const title = decodeEntities(textOf(anchor)).trim().slice(0, 200);
    if (!title || title.toLowerCase() === "next page") continue;
    candidates.push({ url: target.slice(0, 2_000), title, snippet: "" });
    if (candidates.length >= limit * 3) break;
  }
  return {
    candidates,
    provider: "duckduckgo-lite",
    message: candidates.length ? `${candidates.length} candidate source(s) discovered.` : "The discovery provider returned no usable results (it may rate-limit anonymous traffic). Try archive fallback or a narrower query.",
  };
}

function domainAllowed(url: string, allowed: string[] | null, blocked: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return false;
  }
  if (blocked.some((domain) => host === domain || host.endsWith(`.${domain}`))) return false;
  if (!allowed || allowed.length === 0) return true;
  return allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

const SENTENCE_SPLIT = /(?:\n{2,}|(?<=[.!?])\s+(?=[A-Z"'(]))/;

export function extractEvidence(page: ExtractedPage, terms: string[], perSource: number): EvidenceSentence[] {
  const text = toPlainText(page);
  const sentences = text.split(SENTENCE_SPLIT).map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 40 && sentence.length < 500);
  const loweredTerms = terms.map((term) => term.toLowerCase());
  const scored: Array<{ sentence: string; score: number; matched: string[] }> = [];
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    const matched = loweredTerms.filter((term) => lower.includes(term));
    if (!matched.length) continue;
    // Prefer sentences with several distinct terms and numbers/dates (verifiable).
    const specificity = /\d/.test(sentence) ? 1.5 : 1;
    scored.push({ sentence, score: matched.length * specificity, matched: terms.filter((term) => lower.includes(term.toLowerCase())) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, perSource).map((entry) => ({
    text: entry.sentence.slice(0, 500),
    sourceIndex: -1,
    sourceUrl: "",
    retrievedAt: "",
    matchedTerms: entry.matched,
  }));
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((word) => (word.length > 3 || /\d/.test(word)) && word.length > 1 && !STOPWORDS.has(word)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Overlap coefficient: shared / min — robust when one sentence elaborates. */
function overlapScore(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / Math.min(a.size, b.size);
}

function statementNumbers(text: string): string[] {
  // Thousands separators and decimals stay glued to the number; trailing
  // punctuation (like "2010,") must NOT — or two identical numbers read as
  // different and every sentence becomes a fake conflict.
  return text.match(/\d+(?:,\d{3})*(?:\.\d+)?%?/g) ?? [];
}

function hasNegation(text: string): boolean {
  return /\b(not|no|never|denies|disputes|false|incorrect|cannot|won't|doesn't)\b/i.test(text);
}

/** Same topic with differing numbers or opposite negation → a conflict, not agreement. */
function diverges(a: string, b: string): boolean {
  const numbersA = statementNumbers(a);
  const numbersB = statementNumbers(b);
  const numbersDiffer = numbersA.length > 0 && numbersB.length > 0 && numbersA.join() !== numbersB.join();
  return numbersDiffer || hasNegation(a) !== hasNegation(b);
}

/** Cross-source comparison: near-duplicate statements = agreement; same topic with differing numbers/negation = conflict. */
export function compareEvidence(evidence: EvidenceSentence[]): ResearchResult["findings"] {
  const facts: ResearchResult["findings"]["facts"] = [];
  const conflicts: ResearchResult["findings"]["conflicts"] = [];
  const used = new Set<number>();

  for (let i = 0; i < evidence.length; i++) {
    if (used.has(i)) continue;
    const group = [evidence[i]];
    const tokensA = tokenize(evidence[i].text);
    for (let j = i + 1; j < evidence.length; j++) {
      if (used.has(j)) continue;
      const other = evidence[j];
      const similarity = overlapScore(tokensA, tokenize(other.text));
      if (similarity < 0.6 && jaccard(tokensA, tokenize(other.text)) < 0.5) continue;
      // Divergent numbers/negation in otherwise-overlapping statements is a
      // CONFLICT — two sources making incompatible claims about one topic.
      if (diverges(evidence[i].text, other.text)) {
        if (other.sourceUrl !== evidence[i].sourceUrl) {
          conflicts.push({
            topic: [...tokensA].filter((token) => !/\d/.test(token)).slice(0, 6).join(" "),
            variants: [
              { statement: evidence[i].text, sourceUrl: evidence[i].sourceUrl },
              { statement: other.text, sourceUrl: other.sourceUrl },
            ],
          });
          used.add(j);
        }
        continue;
      }
      group.push(other);
      used.add(j);
    }
    used.add(i);
    const sourceUrls = [...new Set(group.map((entry) => entry.sourceUrl))];
    facts.push({
      statement: evidence[i].text,
      sources: group.slice(0, 6).map((entry) => ({ url: entry.sourceUrl, retrievedAt: entry.retrievedAt, snippet: entry.text })),
      agreementCount: sourceUrls.length,
    });
  }

  // Inference: topics with single-source support (flagged as unverified).
  const inference: ResearchResult["findings"]["inference"] = facts
    .filter((fact) => fact.agreementCount === 1)
    .slice(0, 5)
    .map((fact) => ({
      statement: `Single-source claim (needs corroboration): ${fact.statement.slice(0, 200)}`,
      basis: fact.sources.map((source) => source.url),
    }));

  return { facts: facts.slice(0, 30), conflicts: conflicts.slice(0, 15), inference };
}

export async function runResearch(options: ResearchOptions): Promise<ResearchResult> {
  const depth = options.depth ?? "standard";
  const maxSources = clamp(options.maxSources ?? (depth === "quick" ? 3 : depth === "deep" ? 8 : 5), 1, LIMITS.researchMaxSourcesCap);
  const timeoutMs = clamp(options.timeoutMs ?? LIMITS.researchTimeoutDefaultMs, 5_000, LIMITS.researchTimeoutMaxMs);
  const plan = planQuery(options.query);
  publicToolRateLimiter.charge(options.env, "web_research", options.query);
  const blocked = (options.blockedDomains ?? []).map((domain) => domain.toLowerCase());
  const allowed = options.allowedDomains?.length ? options.allowedDomains.map((domain) => domain.toLowerCase()) : null;

  // 1-2. Discover.
  let candidates: Array<{ url: string; title: string; snippet: string }> = [];
  let discoveryMessage = "";
  try {
    const discovered = await discoverSources(options.env, plan.variants[0], maxSources);
    candidates = discovered.candidates;
    discoveryMessage = discovered.message;
  } catch (error) {
    discoveryMessage = `Primary discovery failed (${String(error instanceof Error ? error.message : error).slice(0, 140)}).`;
  }
  if (options.includeArchiveFallback && candidates.length < maxSources) {
    try {
      const catalog = await archiveSearchItems(options.env, plan.variants[0], { limit: Math.min(5, maxSources) });
      for (const item of catalog.items) {
        candidates.push({ url: item.itemUrl, title: item.title ?? item.identifier, snippet: (item.description ?? "").slice(0, 200) });
      }
      discoveryMessage += ` Archive catalog added ${catalog.items.length} candidate(s).`;
    } catch {
      /* fallback is best-effort */
    }
  }

  // 3-4. Retrieve + extract.
  const sources: SourceRecord[] = [];
  const evidence: EvidenceSentence[] = [];
  const uncertainties: string[] = [];
  const limitations: string[] = [];
  const deadline = Date.now() + timeoutMs;
  let considered = 0;

  for (const candidate of candidates) {
    if (sources.filter((source) => source.status === "retrieved" || source.status === "archived").length >= maxSources) break;
    if (Date.now() > deadline) {
      uncertainties.push("The research time budget expired before all candidate sources were retrieved.");
      break;
    }
    considered++;
    if (!domainAllowed(candidate.url, allowed, blocked)) {
      sources.push({
        url: candidate.url,
        finalUrl: candidate.url,
        title: candidate.title,
        retrievedAt: new Date().toISOString(),
        status: "skipped",
        via: "web",
        archivedTimestamp: null,
        bytes: null,
        words: null,
        error: "outside the requested domain policy",
        humanHandoffHint: null,
      });
      continue;
    }
    try {
      const fetched = await fetchPublicPage(candidate.url, {
        env: options.env,
        scope: "web_research",
        timeoutMs: Math.min(12_000, Math.max(3_000, deadline - Date.now() || 3_000)),
        maxChars: LIMITS.researchMaxBytesPerSource,
      });
      const sentences = extractEvidence(fetched.page, plan.coreTerms, LIMITS.researchEvidencePerSource);
      const record: SourceRecord = {
        url: candidate.url,
        finalUrl: fetched.finalUrl,
        title: fetched.page.title ?? candidate.title,
        retrievedAt: new Date().toISOString(),
        status: "retrieved",
        via: "web",
        archivedTimestamp: null,
        bytes: fetched.bytes,
        words: fetched.page.wordCount,
        error: null,
        humanHandoffHint: null,
      };
      sources.push(record);
      for (const sentence of sentences) {
        evidence.push({ ...sentence, sourceIndex: sources.length - 1, sourceUrl: fetched.finalUrl, retrievedAt: record.retrievedAt });
      }
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, 200);
      const needsHuman = /challenge|captcha|login|403|401|forbidden|consent/i.test(message);
      let archivedTimestamp: string | null = null;
      let status: SourceRecord["status"] = "failed";
      let finalUrl = candidate.url;
      if (options.includeArchiveFallback !== false && /page_not_found|navigation_failed|timeout|404|blocked_url/i.test(message)) {
        // Try the Wayback Machine before declaring the source unavailable.
        try {
          const archived = await waybackRetrieve(options.env, candidate.url, { extract: "text" });
          archivedTimestamp = archived.timestamp;
          status = "archived";
          finalUrl = archived.archiveUrl;
          const sentences = archived.extracted ? extractEvidence(archived.extracted, plan.coreTerms, LIMITS.researchEvidencePerSource) : [];
          sources.push({
            url: candidate.url,
            finalUrl,
            title: archived.extracted?.title ?? candidate.title,
            retrievedAt: new Date().toISOString(),
            status,
            via: "archive",
            archivedTimestamp,
            bytes: archived.bytes,
            words: archived.extracted?.wordCount ?? null,
            error: null,
            humanHandoffHint: null,
          });
          for (const sentence of sentences) {
            evidence.push({ ...sentence, sourceIndex: sources.length - 1, sourceUrl: finalUrl, retrievedAt: new Date().toISOString() });
          }
          uncertainties.push(`${candidate.url} was only available via its Wayback snapshot from ${archivedTimestamp}; live content may differ.`);
          continue;
        } catch {
          /* fall through to the failure record */
        }
      }
      sources.push({
        url: candidate.url,
        finalUrl,
        title: candidate.title,
        retrievedAt: new Date().toISOString(),
        status: needsHuman ? "blocked" : status,
        via: "web",
        archivedTimestamp,
        bytes: null,
        words: null,
        error: message,
        humanHandoffHint: needsHuman
          ? "This source requires a human (CAPTCHA/login/consent). Use the existing human-handoff flow — browser_captcha_handoff or browser_pause_for_human — instead of attempting to bypass the protection."
          : null,
      });
    }
  }

  // 5-9. Compare + provenance-backed findings.
  const findings = compareEvidence(evidence);
  const retrieved = sources.filter((source) => source.status === "retrieved" || source.status === "archived");
  const corroborated = findings.facts.filter((fact) => fact.agreementCount >= 2).length;
  const level: ResearchResult["confidence"]["level"] =
    retrieved.length === 0 || findings.facts.length === 0 ? "none" : findings.conflicts.length > 0 ? "low" : corroborated >= 3 ? "medium" : corroborated >= 1 ? "low" : "low";
  if (findings.conflicts.length) uncertainties.push(`${findings.conflicts.length} conflicting claim group(s) were found — report both sides, do not pick one silently.`);
  if (retrieved.length < 2) uncertainties.push("Fewer than two sources were retrieved; treat everything as unconfirmed.");
  limitations.push(
    "DEMO performs deterministic retrieval and comparison; it has no language model of its own. The connected AI must answer from these findings and cite the source URLs.",
    "Sentences are quoted from sources; they may themselves be wrong. Provenance is preserved so verification is possible.",
    "Discovery used a public search endpoint and may miss sources.",
  );

  return {
    query: options.query,
    plan: { coreTerms: plan.coreTerms, variants: plan.variants, depth, maxSources, domainPolicy: { allowed, blocked } },
    sources,
    discovery: { provider: "duckduckgo-lite (+ optional archive catalog)", candidates: candidates.length, considered, message: discoveryMessage },
    findings,
    confidence: {
      level,
      basis: `${retrieved.length} source(s) retrieved, ${findings.facts.length} evidence-backed statement(s), ${corroborated} corroborated across sources, ${findings.conflicts.length} conflict group(s).`,
      note: "This level is a heuristic of corroboration depth, not a probability of truth. When sources disagree, uncertainty is the honest answer.",
    },
    uncertainty: uncertainties.slice(0, 20),
    limitations,
    provenanceNote: "Every statement in findings.facts carries the source URL and retrieval timestamp. Never answer from memory when these findings exist — cite them. Never invent a citation.",
    message:
      findings.facts.length === 0
        ? "No evidence sentences matched the query terms in the retrieved sources. Report that the research found little usable evidence rather than improvising."
        : `Research complete: ${retrieved.length} source(s) read, ${findings.facts.length} evidence-backed statement(s).`,
  };
}
