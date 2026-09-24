/**
 * DEMO 0.9 — webpage extraction, web diff and website monitoring.
 * Extraction runs offline on fixture HTML; diff/monitor use the stubbed fetch
 * and a fake R2 bucket (put/get/head/delete/list) with the real store code.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractPage, toMarkdown, toPlainText, toJsonView } from "../src/web/extract.js";
import { computeWebDiff, storePageSnapshot } from "../src/web/diff.js";
import { addMonitor, checkDueMonitors, checkMonitor, getMonitor, listMonitors, removeMonitor } from "../src/web/monitor.js";
import { WebSnapshotStore, sha256Hex, trimVersions } from "../src/web/storage.js";
import { normalizeForDiff } from "../src/core/text-diff.js";
import { publicToolRateLimiter } from "../src/core/rate-limit.js";
import { installFetchRouter, htmlResult, type FetchRouter } from "./helpers/fetch-router.js";

const ARTICLE_HTML = `<!doctype html>
<html lang="en"><head>
<title>Widget Review — Tech Blog</title>
<meta name="description" content="A thorough widget review.">
<meta property="article:published_time" content="2024-03-01T10:00:00Z">
<meta property="og:site_name" content="Tech Blog">
<link rel="canonical" href="https://blog.example.com/widget-review">
<script type="application/ld+json">{"@type":"Article","author":{"name":"Jane Doe"},"datePublished":"2024-03-01T10:00:00Z"}</script>
<script>var tracking = "should-never-appear";</script>
</head><body>
<nav><a href="/home">Home</a></nav>
<article>
  <h1>Widget Review</h1>
  <p>The widget is surprisingly durable and survived every drop test we ran.</p>
  <h2>Specifications</h2>
  <ul><li>Weight: 200g</li><li>Water resistant</li></ul>
  <table><tr><th>Model</th><th>Price</th></tr><tr><td>Widget S</td><td>$19</td></tr><tr><td>Widget X</td><td>$29</td></tr></table>
  <p>We recommend it for everyday use, with minor caveats about the color options.</p>
  <img src="/images/widget.jpg" alt="The widget on a table">
  <a href="https://other.example.org/source">Our source</a>
</article>
<footer>Cookie banner noise</footer>
</body></html>`;

describe("webpage extraction", () => {
  it("extracts article content, metadata, headings, lists, tables, links, images, JSON-LD", () => {
    const page = extractPage(ARTICLE_HTML, { url: "https://blog.example.com/widget-review" });
    expect(page.title).toBe("Widget Review — Tech Blog");
    expect(page.description).toBe("A thorough widget review.");
    expect(page.author).toBe("Jane Doe"); // from JSON-LD
    expect(page.publishedTime).toBe("2024-03-01T10:00:00Z");
    expect(page.siteName).toBe("Tech Blog");
    expect(page.canonicalUrl).toBe("https://blog.example.com/widget-review");
    expect(page.language).toBe("en");
    expect(page.headings.map((heading) => heading.text)).toEqual(expect.arrayContaining(["Widget Review", "Specifications"]));
    expect(page.paragraphs.join(" ")).toContain("surprisingly durable");
    expect(page.paragraphs.join(" ")).not.toContain("should-never-appear"); // scripts skipped
    expect(page.paragraphs.join(" ")).not.toContain("Cookie banner"); // footer noise skipped
    const list = page.contentBlocks.find((block) => block.type === "list");
    expect(list && list.type === "list" ? list.items : []).toEqual(expect.arrayContaining(["Weight: 200g", "Water resistant"]));
    const table = page.tables[0];
    expect(table.headers).toEqual(["Model", "Price"]);
    expect(table.rows).toEqual([["Widget S", "$19"], ["Widget X", "$29"]]);
    expect(page.links.map((link) => link.href)).toEqual(expect.arrayContaining(["https://other.example.org/source"]));
    expect(page.images[0]).toMatchObject({ src: "https://blog.example.com/images/widget.jpg", alt: "The widget on a table" });
    expect(page.jsonLd.length).toBeGreaterThan(0);
  });

  it("renders Markdown and clean text", () => {
    const page = extractPage(ARTICLE_HTML, { url: "https://blog.example.com/widget-review" });
    const markdown = toMarkdown(page);
    expect(markdown).toContain("# Widget Review — Tech Blog");
    expect(markdown).toContain("## Widget Review"); // content heading (level+1)
    expect(markdown).toContain("- Weight: 200g");
    expect(markdown).toContain("| Model | Price |");
    expect(markdown).toContain("![The widget on a table](https://blog.example.com/images/widget.jpg)");
    const text = toPlainText(page);
    expect(text).toContain("WIDGET REVIEW");
    const json = toJsonView(page);
    expect(JSON.parse(json.text).title).toContain("Widget Review");
  });

  it("survives hostile/malformed HTML", () => {
    const page = extractPage("<p>Broken <div>unclosed <span>mess", { url: "https://x.test/" });
    expect(page.paragraphs.join(" ")).toContain("Broken");
    const empty = extractPage("", {});
    expect(empty.title).toBeNull();
  });
});

describe("web diff", () => {
  let router: FetchRouter;
  beforeEach(() => {
    router = installFetchRouter();
    publicToolRateLimiter.reset();
  });
  afterEach(() => router.restore());

  it("detects added/removed/changed content and normalizes dynamic noise", async () => {
    const before = "Posted 2024-01-05 and 1,234 views\nStable headline\nOld paragraph line.";
    router.on("blog.example.com", () => htmlResult(`<html><head><title>T</title></head><body><article><p>Posted 2025-06-07 and 9,999 views</p><p>Stable headline</p><p>New paragraph line.</p></article></body></html>`));
    const result = await computeWebDiff({ env: { TOOL_RATE_LIMIT_PER_MINUTE: "60" }, url: "https://blog.example.com/post", previousText: before });
    expect(result.summary.identical).toBe(false);
    // Paired removals+additions land in `changed`; unpaired ones in added/removed.
    const afterText = [...result.added, ...result.changed.map((pair) => pair.after)].join(" ");
    const beforeText = [...result.removed, ...result.changed.map((pair) => pair.before)].join(" ");
    expect(afterText).toContain("New paragraph line");
    expect(beforeText).toContain("Old paragraph line");
    // The timestamp/counter change must NOT show as content change after normalization.
    expect(afterText).not.toContain("9,999 views");
    expect(result.changed.some((pair) => /1,234 views/.test(pair.before))).toBe(false);
    expect(result.unifiedDiff).toContain("@@");
  });

  it("stores baselines and diffs against stored snapshots", async () => {
    const bucket = new FakeBucket();
    const store = new WebSnapshotStore(bucket as never, 3600);
    const env = { WEB_SNAPSHOTS: bucket, TOOL_RATE_LIMIT_PER_MINUTE: "60" };
    router.on("blog.example.com", () => htmlResult("<html><body><article><p>Version one content.</p></article></body></html>"));
    const stored = await storePageSnapshot(env, { url: "https://blog.example.com/p", finalUrl: "https://blog.example.com/p", status: 200, page: extractPage("<article><p>Version one content.</p></article>", { url: "https://blog.example.com/p" }), source: "manual" });
    expect(stored.snapshotKey).toMatch(/^web-snap\//);
    expect(bucket.objects.get(stored.snapshotKey)?.metadata.expiresAt).toBeTruthy();

    router.on("blog.example.com", () => htmlResult("<html><body><article><p>Version two content changed.</p></article></body></html>"));
    const diff = await computeWebDiff({ env, url: "https://blog.example.com/p", snapshotKey: stored.snapshotKey });
    expect(diff.baseline.source).toBe("snapshot");
    expect(diff.summary.identical).toBe(false);
    const afterText = [...diff.added, ...diff.changed.map((pair) => pair.after)].join(" ");
    expect(afterText).toContain("Version two");
    void store;
  });

  it("expires stored snapshots with the artifact TTL semantics", async () => {
    const bucket = new FakeBucket();
    const store = new WebSnapshotStore(bucket as never, 3600);
    const saved = await store.storeSnapshot({ url: "https://x.test/", finalUrl: "https://x.test/", fetchedAt: new Date().toISOString(), status: 200, title: "t", text: "hello", normalization: "none", source: "manual" });
    // Age the object past its TTL.
    const object = bucket.objects.get(saved.key)!;
    object.metadata.expiresAt = new Date(Date.now() - 1000).toISOString();
    await expect(store.readSnapshot(saved.key)).rejects.toMatchObject({ code: "ARTIFACT_EXPIRED" });
  });
});

describe("website monitoring", () => {
  let router: FetchRouter;
  beforeEach(() => {
    router = installFetchRouter();
    publicToolRateLimiter.reset();
  });
  afterEach(() => router.restore());

  let bucket: FakeBucket;
  const env = () => ({ WEB_SNAPSHOTS: bucket, TOOL_RATE_LIMIT_PER_MINUTE: "60", SNAPSHOT_RETENTION_SECONDS: "86400" });
  beforeEach(() => {
    bucket = new FakeBucket();
  });

  it("registers a monitor, detects changes with a summary, respects intervals and removes", async () => {
    router.on("watch.example.com", () => htmlResult("<html><body><article><p>Original watched content.</p></article></body></html>"));
    const added = await addMonitor({ env: env(), url: "https://watch.example.com/page", intervalSeconds: 3600 });
    expect(added.monitor.id).toMatch(/^[a-f0-9]{48}$/);
    expect(added.changed).toBe(false);
    expect(added.monitor.baselineFingerprint).toBeTruthy();

    // Not due yet without force.
    const early = await checkMonitor({ env: env(), id: added.monitor.id });
    expect(early.checked).toBe(false);
    expect(early.message).toMatch(/Not due/);

    // Content changes; forced check reports the summary.
    router.on("watch.example.com", () => htmlResult("<html><body><article><p>Original watched content.</p><p>Breaking addition.</p></article></body></html>"));
    const checked = await checkMonitor({ env: env(), id: added.monitor.id, force: true });
    expect(checked.changed).toBe(true);
    expect(checked.changeSummary!.added).toBeGreaterThan(0);
    expect(checked.message).toMatch(/Content changed/);

    const listed = await listMonitors(env());
    expect(listed.monitors.length).toBe(1);
    const record = await getMonitor(env(), added.monitor.id);
    expect(record.versions.length).toBe(2);

    const removed = await removeMonitor(env(), added.monitor.id);
    expect(removed.removed).toBe(true);
    await expect(getMonitor(env(), added.monitor.id)).rejects.toMatchObject({ code: "page_not_found" });
  });

  it("reports no-change checks and trims history to max_versions", async () => {
    router.on("stable.example.com", () => htmlResult("<html><body><article><p>Never changes at all.</p></article></body></html>"));
    const added = await addMonitor({ env: env(), url: "https://stable.example.com/", maxVersions: 2, intervalSeconds: 300 });
    for (let i = 0; i < 3; i++) await checkMonitor({ env: env(), id: added.monitor.id, force: true });
    const record = await getMonitor(env(), added.monitor.id);
    expect(record.versions.length).toBe(2); // trimmed to maxVersions
    expect(record.versions.every((version) => version.changed === false)).toBe(true);
  });

  it("sweeps only due monitors and only when asked", async () => {
    router.on("due.example.com", () => htmlResult("<html><body><article><p>Due content v1.</p></article></body></html>"));
    const monitor = await addMonitor({ env: env(), url: "https://due.example.com/", intervalSeconds: 300 });
    const sweep = await checkDueMonitors(env(), { maxChecks: 5 });
    expect(sweep.checked).toBe(0); // only just checked → not due
    const forced = await checkDueMonitors(env(), { maxChecks: 5 });
    expect(forced.results.length).toBe(0);
    // Backdate the last check to make it due.
    const bucketObject = bucket.objects.get(`web-mon/${monitor.monitor.id}.json`)!;
    const document = JSON.parse(new TextDecoder().decode(bucketObject.bytes));
    document.lastCheckedAt = new Date(Date.now() - 3600_000).toISOString();
    bucketObject.bytes = new TextEncoder().encode(JSON.stringify(document));
    const swept = await checkDueMonitors(env(), { maxChecks: 5 });
    expect(swept.checked).toBe(1);
  });

  it("refuses internal monitor targets", async () => {
    await expect(addMonitor({ env: env(), url: "http://localhost:8080/" })).rejects.toMatchObject({ code: "blocked_url" });
  });
});

describe("normalization + fingerprinting", () => {
  it("fingerprint is stable and normalization strips noise", () => {
    expect(normalizeForDiff("x\n\n\n")).toBe(normalizeForDiff("x"));
  });
  it("sha256 of text is deterministic", async () => {
    expect(await sha256Hex("abc")).toBe(await sha256Hex("abc"));
  });
  it("trims versions oldest-first", () => {
    const versions = [1, 2, 3, 4].map((n) => ({ checkedAt: String(n), fingerprint: String(n), status: 200, changed: false }));
    expect(trimVersions(versions, 2).map((version) => version.fingerprint)).toEqual(["3", "4"]);
  });
});

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
  async list(options?: { prefix?: string; limit?: number }) {
    const objects = [...this.objects.entries()]
      .filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
      .slice(0, options?.limit ?? 100)
      .map(([key, object]) => ({ key, size: object.bytes.byteLength, lastModified: new Date(), customMetadata: object.metadata }));
    return { objects };
  }
}
