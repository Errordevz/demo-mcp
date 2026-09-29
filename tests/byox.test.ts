/**
 * Build Your Own X catalog: parser, incremental refresh, and the public routes.
 *
 * The upstream README is real-world messy (compound language lists, a `[video]`
 * marker, headings that appear in the table of contents as well as in the
 * tutorials section), so the parser is tested against a synthetic README that
 * reproduces those shapes rather than against a network fixture — no test here
 * touches the internet, and none asserts anything about tutorial *content*.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { diffByoxIndexes, findTutorial, parseByoxReadme, searchByox, BYOX_MIN_TUTORIALS } from "../src/byox/catalog.js";
import { clearByoxCacheForTests, loadByoxIndex, refreshByoxIndex } from "../src/byox/store.js";
import { handleByoxRoute } from "../src/byox/routes.js";
import { presentedAdminKey, adminKeyMatches, isAdminRequest } from "../src/core/admin.js";

/** Build a README with @p categories × 12 entries (above the sanity floor). */
function readme(options: { categories?: number; perCategory?: number; mutate?: (text: string) => string } = {}): string {
  const categories = options.categories ?? 5;
  const perCategory = options.perCategory ?? 12;
  let body = "# Build your own X\n\n## Table of Contents\n";
  for (let c = 0; c < categories; c += 1) body += `- [Build your own Thing ${c}](#build-your-own-thing-${c})\n`;
  body += "\n## Tutorials\n";
  for (let c = 0; c < categories; c += 1) {
    body += `\n#### Build your own \`Thing ${c}\`\n\n`;
    for (let t = 0; t < perCategory; t += 1) {
      const languages = t % 4 === 0 ? "C# / TypeScript" : t % 3 === 0 ? "Rust" : "Python";
      const marker = t % 7 === 0 ? " [video]" : "";
      body += `* [**${languages}**: _Write your own ${c}-${t} from scratch_](https://example.org/${c}/${t})${marker}\n`;
    }
    body += `* not an entry, just prose\n`;
  }
  return options.mutate ? options.mutate(body) : body;
}

class FakeBucket {
  objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  async put(key: string, value: Uint8Array | ArrayBuffer | string, options?: { customMetadata?: Record<string, string> }) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
    this.objects.set(key, { bytes, metadata: options?.customMetadata ?? {} });
  }
  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      customMetadata: object.metadata,
      httpMetadata: { contentType: "application/json" },
      text: async () => new TextDecoder().decode(object.bytes),
      json: async () => JSON.parse(new TextDecoder().decode(object.bytes)),
      arrayBuffer: async () => object.bytes.buffer.slice(object.bytes.byteOffset, object.bytes.byteOffset + object.bytes.byteLength),
    };
  }
  async head(key: string) {
    const object = this.objects.get(key);
    return object ? { size: object.bytes.byteLength, customMetadata: object.metadata } : null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

function fetchOnce(body: string, init?: { status?: number; etag?: string }) {
  return vi.fn(async () =>
    new Response(body, {
      status: init?.status ?? 200,
      headers: { "content-type": "text/plain; charset=utf-8", ...(init?.etag ? { etag: init.etag } : {}) },
    }),
  );
}

function env(bucket: FakeBucket, extra: Record<string, unknown> = {}) {
  return {
    SCREENSHOTS: bucket,
    DEMO_API_KEY: "a-very-long-admin-key-value",
    BYOX_REFRESH_MIN_INTERVAL_SECONDS: "60",
    SSRF_DNS_CHECK: "false",
    ...extra,
  } as never;
}

/** The guard is stubbed: these tests never resolve a hostname. */
const guard = async (url: string) => url;

beforeEach(() => clearByoxCacheForTests());

describe("BYOX parser", () => {
  it("parses categories, compound languages and the video marker", () => {
    const report = parseByoxReadme(readme(), { readmeUrl: "https://example.test/README.md", etag: null, lastModified: null, sha256: "a".repeat(64), fetchedAt: "2026-09-29T00:00:00.000Z" });
    expect(report.index.counts.categories).toBe(5);
    expect(report.index.counts.tutorials).toBe(60);
    expect(report.index.counts.languages).toBeGreaterThan(1);
    // `C# / TypeScript` is two languages, not one string.
    expect(report.index.tutorials[0]!.languages).toEqual(["C#", "TypeScript"]);
    // Every seventh entry is a video, the rest are articles.
    expect(report.index.tutorials.some((tutorial) => tutorial.format === "video")).toBe(true);
    expect(report.index.tutorials.filter((tutorial) => tutorial.format === "video")).toHaveLength(10);
    // Non-entry prose is skipped, never invented as an entry.
    expect(report.index.counts.tutorials).toBe(report.index.tutorials.length);
    expect(report.index.categories.map((category) => category.title)).toContain("Thing 3");
    // The table-of-contents anchors must not be parsed as tutorials.
    expect(report.index.tutorials.every((tutorial) => tutorial.url.startsWith("https://example.org/"))).toBe(true);
  });

  it("never invents entries for text it cannot understand", () => {
    const options = { readmeUrl: "https://example.test/README.md", etag: null, lastModified: null, sha256: "a".repeat(64), fetchedAt: "2026-09-29T00:00:00.000Z" };
    expect(parseByoxReadme("not a readme at all", options).index.counts.tutorials).toBe(0);
    // A malformed bullet after a real category is skipped, not guessed at, and the
    // store's sanity floor (not the parser) is what protects a good index.
    const partial = parseByoxReadme(`## Tutorials\n\n#### Build your own \`Thing\`\n\n* [**Rust**: _Real one_](https://example.org/real)\n* [**Rust**: broken\n`, options);
    expect(partial.index.counts.tutorials).toBe(1);
    expect(partial.skipped + partial.problems.length).toBeGreaterThan(0);
  });

  it("searches by keyword, language and category, and finds by id or url", () => {
    const report = parseByoxReadme(readme(), { readmeUrl: "https://example.test/README.md", etag: null, lastModified: null, sha256: "a".repeat(64), fetchedAt: "2026-09-29T00:00:00.000Z" });
    const index = report.index;
    const byKeyword = searchByox(index, { query: "write your own 2-3", limit: 5 });
    expect(byKeyword.total).toBeGreaterThan(0);
    const byLanguage = searchByox(index, { language: "Rust", limit: 5 });
    expect(byLanguage.hits.every((hit) => hit.tutorial.languages.includes("Rust"))).toBe(true);
    const byCategory = searchByox(index, { category: "thing-4", limit: 50 });
    expect(byCategory.hits.every((hit) => hit.tutorial.categoryId === "thing-4")).toBe(true);
    const single = index.tutorials[0]!;
    expect(findTutorial(index, single.id)?.url).toBe(single.url);
    expect(findTutorial(index, single.url)?.id).toBe(single.id);
    expect(findTutorial(index, "https://example.org/does-not-exist")).toBeNull();
  });

  it("diffs two indexes into added, removed and updated entries", () => {
    const options = { readmeUrl: "u", etag: null, lastModified: null, sha256: "a".repeat(64), fetchedAt: "t" };
    const base = parseByoxReadme(readme(), options).index;

    // A language change keeps the id (category + title slug + hash of the URL),
    // so it is reported as an update rather than churn.
    const relanguaged = parseByoxReadme(readme({ mutate: (text) => text.replace("**Python**: _Write your own 1-1 from scratch_", "**Go**: _Write your own 1-1 from scratch_") }), options).index;
    const updated = diffByoxIndexes(base, relanguaged);
    expect(updated.updated).toHaveLength(1);
    expect(updated.updated[0]!.changes).toEqual(["languages"]);
    expect(updated.added).toHaveLength(0);
    expect(updated.removed).toHaveLength(0);

    // A retitled entry gets a new id, so the same reference is remove + add.
    const retitled = parseByoxReadme(readme({ mutate: (text) => text.replace("_Write your own 0-0 from scratch_", "_Write your own 0-0 properly_") }), options).index;
    const churn = diffByoxIndexes(base, retitled);
    expect(churn.added).toHaveLength(1);
    expect(churn.removed).toHaveLength(1);
    expect(churn.toTutorials).toBe(churn.fromTutorials);
  });
});

describe("BYOX incremental refresh", () => {
  it("indexes on the first refresh and stores a source snapshot", async () => {
    const bucket = new FakeBucket();
    const result = await refreshByoxIndex(env(bucket), { force: true, now: Date.parse("2026-09-29T00:00:00.000Z"), fetchImpl: fetchOnce(readme()) as never, guard });
    expect(result.refreshed).toBe(true);
    expect(result.index?.counts.tutorials).toBe(60);
    expect(bucket.objects.has("byox/index.json")).toBe(true);
    expect(bucket.objects.has("byox/state.json")).toBe(true);
    expect(bucket.objects.has("byox/source.md")).toBe(true);
  });

  it("treats a 304 as unchanged and only bumps lastCheckedAt", async () => {
    const bucket = new FakeBucket();
    const first = await refreshByoxIndex(env(bucket), { force: true, now: Date.parse("2026-09-29T00:00:00.000Z"), fetchImpl: fetchOnce(readme(), { etag: "W/\"v1\"" }) as never, guard });
    expect(first.index?.source.etag).toBe("W/\"v1\"");
    clearByoxCacheForTests();
    const second = await refreshByoxIndex(env(bucket), {
      force: true,
      now: Date.parse("2026-09-29T01:00:00.000Z"),
      fetchImpl: vi.fn(async () => new Response(null, { status: 304 })) as never,
      guard,
    });
    expect(second.unchanged).toBe(true);
    expect(second.index?.counts.tutorials).toBe(60);
    expect(second.index?.generatedAt).toBe(first.index?.generatedAt);
    expect(second.index?.source.fetchedAt).toBe(first.index?.source.fetchedAt);
    expect(second.index?.source.lastCheckedAt).toBe("2026-09-29T01:00:00.000Z");
  });

  it("keeps the previous index instead of replacing it with a truncated or implausibly small README", async () => {
    const bucket = new FakeBucket();
    await refreshByoxIndex(env(bucket), { force: true, now: Date.parse("2026-09-29T00:00:00.000Z"), fetchImpl: fetchOnce(readme()) as never, guard });
    clearByoxCacheForTests();
    const tiny = await refreshByoxIndex(env(bucket), { force: true, now: Date.parse("2026-09-29T02:00:00.000Z"), fetchImpl: fetchOnce(readme({ categories: 1, perCategory: 2 })) as never, guard });
    expect(tiny.refreshed).toBe(false);
    expect(tiny.reason).toContain(`minimum ${BYOX_MIN_TUTORIALS}`);
    expect(tiny.index?.counts.tutorials).toBe(60);
    clearByoxCacheForTests();
    const load = await loadByoxIndex(env(bucket), { now: Date.parse("2026-09-29T02:00:01.000Z") });
    expect(load.index?.counts.tutorials).toBe(60);
    // The refusal is recorded on the state, so an operator sees why the catalog
    // did not move even though it is still fresh in time.
    expect(load.state?.lastError).toContain("Refusing to replace the catalog");
  });

  it("records a network failure without destroying the stored catalog", async () => {
    const bucket = new FakeBucket();
    await refreshByoxIndex(env(bucket), { force: true, now: Date.parse("2026-09-29T00:00:00.000Z"), fetchImpl: fetchOnce(readme()) as never, guard });
    clearByoxCacheForTests();
    const failed = await refreshByoxIndex(env(bucket), {
      force: true,
      now: Date.parse("2026-09-29T03:00:00.000Z"),
      fetchImpl: vi.fn(async () => {
        throw new Error("network is down");
      }) as never,
      guard,
    });
    expect(failed.refreshed).toBe(false);
    expect(failed.reason).toContain("network is down");
    expect(failed.index?.counts.tutorials).toBe(60);
    const state = JSON.parse(new TextDecoder().decode(bucket.objects.get("byox/state.json")!.bytes)) as { lastError: string | null };
    expect(state.lastError).toContain("network is down");
  });

  it("honours the minimum refresh interval unless forced", async () => {
    const bucket = new FakeBucket();
    const now = Date.parse("2026-09-29T00:00:00.000Z");
    await refreshByoxIndex(env(bucket), { force: true, now, fetchImpl: fetchOnce(readme()) as never, guard });
    clearByoxCacheForTests();
    const again = await refreshByoxIndex(env(bucket), { now: now + 5_000, fetchImpl: fetchOnce(readme()) as never, guard });
    expect(again.refreshed).toBe(false);
    expect(again.reason).toContain("minimum interval");
  });
});

describe("BYOX HTTP routes", () => {
  it("serves metadata search, categories and a single entry without an index", async () => {
    const bucket = new FakeBucket();
    const e = env(bucket);
    await refreshByoxIndex(e, { force: true, now: Date.parse("2026-09-29T00:00:00.000Z"), fetchImpl: fetchOnce(readme()) as never, guard });
    clearByoxCacheForTests();

    const search = await handleByoxRoute(new Request("https://demo.test/byox/search?q=from%20scratch&limit=3"), e);
    const body = (await search!.json()) as { ok: boolean; total: number; hits: Array<{ url: string; title: string }> };
    expect(search!.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.hits.length).toBeLessThanOrEqual(3);
    expect(body.hits[0]!.url).toMatch(/^https:\/\/example\.org\//);

    const categories = await handleByoxRoute(new Request("https://demo.test/byox/categories"), e);
    const catBody = (await categories!.json()) as { categories: unknown[]; languages: unknown[] };
    expect(catBody.categories).toHaveLength(5);
    expect(catBody.languages.length).toBeGreaterThan(0);

    const report = await handleByoxRoute(new Request("https://demo.test/byox"), e);
    const reportBody = (await report!.json()) as { ok: boolean; catalog: { indexed: boolean; catalog: { entries: number } } };
    expect(reportBody.ok).toBe(true);
    expect(reportBody.catalog.indexed).toBe(true);
    expect(reportBody.catalog.catalog.entries).toBe(60);

    const first = JSON.parse(new TextDecoder().decode(bucket.objects.get("byox/index.json")!.bytes)) as { tutorials: Array<{ id: string }> };
    const one = await handleByoxRoute(new Request(`https://demo.test/byox/tutorial/${first.tutorials[0]!.id}`), e);
    expect(((await one!.json()) as { tutorial: { id: string } }).tutorial.id).toBe(first.tutorials[0]!.id);
  });

  it("refuses to refresh without the administrator key and never accepts it in the query string", async () => {
    const bucket = new FakeBucket();
    const e = env(bucket);
    const anonymous = await handleByoxRoute(new Request("https://demo.test/byox/refresh", { method: "POST" }), e);
    expect(anonymous!.status).toBe(403);
    const inQuery = await handleByoxRoute(new Request("https://demo.test/byox/refresh?key=a-very-long-admin-key-value", { method: "POST" }), e);
    expect(inQuery!.status).toBe(403);
    const wrongHeader = await handleByoxRoute(new Request("https://demo.test/byox/refresh", { method: "POST", headers: { "x-demo-admin-key": "nope-nope-nope-nope" } }), e);
    expect(wrongHeader!.status).toBe(403);
    const serviceToken = await handleByoxRoute(new Request("https://demo.test/byox/refresh", { method: "POST", headers: { "cf-access-jwt-assertion": "a-very-long-admin-key-value" } }), e);
    expect(serviceToken!.status).toBe(403);
  });

  it("refreshes with the administrator key", async () => {
    const bucket = new FakeBucket();
    const e = env(bucket);
    // Seed the catalog first (the refresh route forces a real refresh).
    await refreshByoxIndex(e, { force: true, now: Date.parse("2026-09-29T00:00:00.000Z"), fetchImpl: fetchOnce(readme()) as never, guard });
    clearByoxCacheForTests();
    const response = await handleByoxRoute(
      new Request("https://demo.test/byox/refresh", { method: "POST", headers: { "x-demo-admin-key": "a-very-long-admin-key-value" } }),
      e,
    );
    const body = (await response!.json()) as { ok: boolean; refresh: { storage: string } };
    // No fetchImpl is injectable through the route: the guard rejects the
    // upstream URL in this environment, and the route reports that honestly
    // instead of claiming a refresh happened.
    expect(body.ok).toBe(true);
    expect(["r2", "unavailable"]).toContain(body.refresh.storage);
  });

  it("returns 404 for an unknown entry and 405 for a write to a read route", async () => {
    const bucket = new FakeBucket();
    const e = env(bucket);
    await refreshByoxIndex(e, { force: true, now: Date.parse("2026-09-29T00:00:00.000Z"), fetchImpl: fetchOnce(readme()) as never, guard });
    clearByoxCacheForTests();
    const missing = await handleByoxRoute(new Request("https://demo.test/byox/tutorial/ws_nope"), e);
    expect(missing!.status).toBe(404);
    const wrongMethod = await handleByoxRoute(new Request("https://demo.test/byox/search", { method: "POST" }), e);
    expect(wrongMethod!.status).toBe(405);
    expect(await handleByoxRoute(new Request("https://demo.test/other"), e)).toBeNull();
  });
});

describe("administrator gate", () => {
  it("reads the key from supported headers only", () => {
    expect(presentedAdminKey(new Request("https://demo.test/x", { headers: { "x-demo-admin-key": "abc" } }))).toBe("abc");
    expect(presentedAdminKey(new Request("https://demo.test/x", { headers: { authorization: "Bearer abc" } }))).toBe("abc");
    expect(presentedAdminKey(new Request("https://demo.test/x?key=abc"))).toBeNull();
    expect(presentedAdminKey(new Request("https://demo.test/x", { headers: { "cf-access-jwt-assertion": "abc" } }))).toBeNull();
  });

  it("compares digests and rejects an unconfigured or mismatched deployment", async () => {
    expect(await adminKeyMatches(env(new FakeBucket()), "a-very-long-admin-key-value")).toBe(true);
    expect(await adminKeyMatches(env(new FakeBucket()), "wrong-key")).toBe(false);
    const short = env(new FakeBucket(), { DEMO_API_KEY: "short" });
    expect(await isAdminRequest(new Request("https://demo.test/x", { headers: { "x-demo-admin-key": "short" } }), short)).toBe(false);
    expect(await isAdminRequest(new Request("https://demo.test/x"), env(new FakeBucket()))).toBe(false);
  });
});
