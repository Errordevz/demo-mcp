/**
 * DEMO 0.9 — structured web research. Discovery + sources are stubbed; the
 * provenance/conflict/inference contract is asserted directly.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareEvidence, planQuery, runResearch } from "../src/research/orchestrator.js";
import { publicToolRateLimiter } from "../src/core/rate-limit.js";
import { installFetchRouter, htmlResult, jsonResult, type FetchRouter } from "./helpers/fetch-router.js";

const ENV = { TOOL_RATE_LIMIT_PER_MINUTE: "60" } as Record<string, unknown>;

function ddgHtml(results: Array<{ url: string; title: string }>): string {
  const rows = results.map((result) => `<tr><td><a rel="nofollow" href="//lite.duckduckgo.com/l/?uddg=${encodeURIComponent(result.url)}">${result.title}</a></td><td class="result-snippet">snippet</td></tr>`).join("");
  return `<html><body><table>${rows}</table><a class="result-link" href="https://lite.duckduckgo.com/lite/?q=x&page=2">Next page</a></body></html>`;
}

describe("query planning + evidence comparison", () => {
  it("extracts core terms and cheap variants deterministically", () => {
    const plan = planQuery("What is the tallest building in Dubai?");
    expect(plan.coreTerms).toEqual(expect.arrayContaining(["tallest", "building", "dubai"]));
    expect(plan.variants.length).toBeGreaterThan(0);
    expect(plan.variants.length).toBeLessThanOrEqual(3);
  });

  it("groups near-duplicate statements as agreement and number conflicts as conflicts", () => {
    const evidence = [
      { text: "The observatory deck stands 555 meters above the ground level.", sourceIndex: 0, sourceUrl: "https://a.test/", retrievedAt: "2024-01-01T00:00:00Z", matchedTerms: ["observatory"] },
      { text: "The observatory deck stands 555 meters above the ground level, sources confirm.", sourceIndex: 1, sourceUrl: "https://b.test/", retrievedAt: "2024-01-02T00:00:00Z", matchedTerms: ["observatory"] },
      { text: "The observatory deck stands 828 meters above the ground level.", sourceIndex: 2, sourceUrl: "https://c.test/", retrievedAt: "2024-01-03T00:00:00Z", matchedTerms: ["observatory"] },
    ];
    const findings = compareEvidence(evidence);
    const corroborated = findings.facts.filter((fact) => fact.agreementCount >= 2);
    expect(corroborated.length).toBeGreaterThanOrEqual(1);
    expect(corroborated[0].sources.map((source) => source.url)).toEqual(expect.arrayContaining(["https://a.test/", "https://b.test/"]));
    expect(findings.conflicts.length).toBeGreaterThanOrEqual(1);
    expect(findings.conflicts[0].variants.map((variant) => variant.sourceUrl).length).toBe(2);
  });
});

describe("runResearch orchestration", () => {
  let router: FetchRouter;
  beforeEach(() => {
    router = installFetchRouter();
    publicToolRateLimiter.reset();
  });
  afterEach(() => router.restore());

  function routeSources() {
    router.on("lite.duckduckgo.com", () =>
      htmlResult(ddgHtml([
        { url: "https://alpha.test/tower", title: "Alpha Tower Facts" },
        { url: "https://beta.test/tower", title: "Beta Tower Facts" },
        { url: "https://gamma.test/tower", title: "Blocked Source" },
      ])),
    );
    router.on("alpha.test", () =>
      htmlResult("<html><head><title>Alpha Tower Facts</title></head><body><article><p>The tower reaches 555 meters and opened in 2010 after eight years of construction work.</p><p>Unrelated filler text without any matching keywords at all.</p></article></body></html>"),
    );
    router.on("beta.test", () =>
      htmlResult("<html><head><title>Beta Tower Facts</title></head><body><article><p>The tower reaches 555 meters and opened in 2010, according to the official record book.</p></article></body></html>"),
    );
  }

  it("discovers, retrieves, extracts and returns provenance-backed findings", async () => {
    routeSources();
    const result = await runResearch({ env: ENV, query: "tower height meters construction", maxSources: 3, timeoutMs: 20_000 });
    expect(result.sources.filter((source) => source.status === "retrieved").length).toBeGreaterThanOrEqual(2);
    expect(result.findings.facts.length).toBeGreaterThan(0);
    for (const fact of result.findings.facts) {
      for (const source of fact.sources) {
        expect(source.url).toMatch(/^https?:\/\//);
        expect(source.retrievedAt).toMatch(/^\d{4}-/);
      }
    }
    const corroborated = result.findings.facts.find((fact) => fact.agreementCount >= 2);
    expect(corroborated).toBeTruthy();
    expect(["low", "medium"]).toContain(result.confidence.level);
    expect(result.provenanceNote).toMatch(/never invent a citation/i);
    expect(result.limitations.join(" ")).toMatch(/no language model/i);
  });

  it("reports blocked sources with a human-handoff hint instead of bypassing", async () => {
    routeSources();
    router.on("gamma.test", () => ({ status: 403, headers: { "content-type": "text/html" }, body: "<html>captcha challenge</html>" }));
    const result = await runResearch({ env: ENV, query: "tower height meters construction", maxSources: 3, timeoutMs: 20_000 });
    const blocked = result.sources.find((source) => source.url.includes("gamma.test"));
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.humanHandoffHint).toMatch(/browser_captcha_handoff|browser_pause_for_human/);
  });

  it("falls back to the Wayback Machine for dead sources and records the timestamp", async () => {
    router.on("lite.duckduckgo.com", () => htmlResult(ddgHtml([{ url: "https://dead.test/tower", title: "Dead Source" }])));
    router.on("dead.test", () => ({ status: 404, headers: { "content-type": "text/html" }, body: "gone" }));
    router.on("archive.org", () => jsonResult({ archived_snapshots: { closest: { url: "https://web.archive.org/web/20230101000000/https://dead.test/tower", timestamp: "20230101000000", status: "200" } } }));
    router.on("web.archive.org", () => htmlResult("<html><body><article><p>The tower reaches 555 meters according to the archived page about construction.</p></article></body></html>"));
    const result = await runResearch({ env: ENV, query: "tower construction", maxSources: 2, timeoutMs: 20_000, includeArchiveFallback: true });
    const archived = result.sources.find((source) => source.status === "archived");
    expect(archived?.archivedTimestamp).toBe("20230101000000");
    expect(archived?.via).toBe("archive");
    expect(result.uncertainty.join(" ")).toMatch(/only available via its Wayback snapshot/);
  });

  it("respects domain allow/deny lists", async () => {
    routeSources();
    const restricted = await runResearch({ env: ENV, query: "tower height", maxSources: 3, allowedDomains: ["alpha.test"], timeoutMs: 20_000, includeArchiveFallback: false });
    expect(restricted.sources.every((source) => source.url.includes("alpha.test") || source.status === "skipped")).toBe(true);
    expect(restricted.sources.some((source) => source.status === "skipped" && source.error?.includes("domain policy"))).toBe(true);
  });

  it("is honest when nothing usable is found", async () => {
    router.on("lite.duckduckgo.com", () => htmlResult("<html><body><p>No results at all.</p></body></html>"));
    const result = await runResearch({ env: ENV, query: "zzz nothing zzz", maxSources: 2, timeoutMs: 15_000, includeArchiveFallback: false });
    expect(result.sources.filter((source) => source.status === "retrieved").length).toBe(0);
    expect(result.confidence.level).toBe("none");
    expect(result.message).toMatch(/found little usable evidence|no evidence/i);
  });

  it("blocks internal targets before any research fetch", async () => {
    await expect(runResearch({ env: ENV, query: "x y z", allowedDomains: ["127.0.0.1"], maxSources: 1, timeoutMs: 8_000, includeArchiveFallback: false })).resolves.toBeTruthy();
    expect(router.requests.filter((request) => request.url.includes("127.0.0.1"))).toEqual([]);
  });
});
