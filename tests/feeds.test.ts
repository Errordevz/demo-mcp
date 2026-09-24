/**
 * DEMO 0.9 — RSS/Atom feed parsing + retrieval. Malformed feeds degrade
 * gracefully; inline XML parsing works fully offline.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeDate, parseFeed, stripHtml } from "../src/feeds/parse.js";
import { fetchFeed } from "../src/feeds/client.js";
import { publicToolRateLimiter } from "../src/core/rate-limit.js";
import { installFetchRouter, htmlResult, type FetchRouter } from "./helpers/fetch-router.js";

const RSS2 = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Example Feed &amp; News</title>
    <link>https://feed.example.com/</link>
    <description>A &lt;tiny&gt; demo feed</description>
    <language>en</language>
    <lastBuildDate>Mon, 05 Jan 2024 12:00:00 GMT</lastBuildDate>
    <managingEditor>editor@example.com</managingEditor>
    <item>
      <title>First Post</title>
      <link>https://feed.example.com/posts/1</link>
      <guid isPermaLink="false">post-1</guid>
      <pubDate>Fri, 05 Jan 2024 09:30:00 GMT</pubDate>
      <author>alice@example.com (Alice)</author>
      <category>news</category>
      <category>demo</category>
      <description><![CDATA[<p>Hello <b>world</b> with a <a href="https://x.test">link</a>.</p>]]></description>
      <content:encoded><![CDATA[<p>Full content here.</p>]]></content:encoded>
      <enclosure url="https://feed.example.com/audio/1.mp3" type="audio/mpeg" length="12345"/>
    </item>
    <item>
      <title>Second Post</title>
      <link>https://feed.example.com/posts/2</link>
      <pubDate>Sat, 06 Jan 2024 10:00:00 GMT</pubDate>
      <description>Plain text description</description>
    </item>
    <item>
      <title>Third Post</title>
      <link>https://feed.example.com/posts/3</link>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Demo</title>
  <subtitle>Atom subtitle</subtitle>
  <link rel="self" href="https://atom.example.com/feed.xml"/>
  <link rel="alternate" href="https://atom.example.com/"/>
  <updated>2024-02-01T10:00:00Z</updated>
  <author><name>Bob Writer</name></author>
  <id>urn:demo:atom</id>
  <entry>
    <title>Atom Entry</title>
    <id>urn:demo:atom:1</id>
    <link rel="alternate" href="https://atom.example.com/entries/1"/>
    <published>2024-02-01T09:00:00Z</published>
    <updated>2024-02-01T09:30:00Z</updated>
    <author><name>Carol</name></author>
    <category term="science"/>
    <summary type="html">&lt;p&gt;Short summary&lt;/p&gt;</summary>
    <content type="html">&lt;p&gt;The &lt;b&gt;body&lt;/b&gt; text.&lt;/p&gt;</content>
  </entry>
</feed>`;

describe("feed parsing", () => {
  it("parses RSS 2.x: metadata, items, guid, dates, authors, categories, content, enclosures", () => {
    const feed = parseFeed(RSS2);
    expect(feed.format).toBe("rss2");
    expect(feed.title).toBe("Example Feed & News");
    expect(feed.description).toContain("demo feed");
    // escaped markup in descriptions is stripped, never rendered
    expect(feed.description).not.toContain("<tiny>");
    expect(feed.link).toBe("https://feed.example.com/");
    expect(feed.language).toBe("en");
    expect(normalizeDate("Mon, 05 Jan 2024 12:00:00 GMT")).toBe("2024-01-05T12:00:00.000Z");
    expect(feed.items.length).toBe(3);
    const first = feed.items[0];
    expect(first.title).toBe("First Post");
    expect(first.link).toBe("https://feed.example.com/posts/1");
    expect(first.guid).toBe("post-1");
    expect(first.guidIsPermalink).toBe(false);
    expect(first.published).toBe("2024-01-05T09:30:00.000Z");
    expect(first.authors.length).toBeGreaterThan(0);
    expect(first.categories).toEqual(["news", "demo"]);
    expect(first.description).toContain("Hello world");
    expect(first.content).toContain("Full content here");
    expect(first.enclosures[0]).toMatchObject({ url: "https://feed.example.com/audio/1.mp3", type: "audio/mpeg", length: 12345 });
  });

  it("parses Atom: entries, links, ids, published/updated, authors, categories", () => {
    const feed = parseFeed(ATOM);
    expect(feed.format).toBe("atom");
    expect(feed.title).toBe("Atom Demo");
    expect(feed.link).toBe("https://atom.example.com/");
    expect(feed.feedUrl).toBe("https://atom.example.com/feed.xml");
    expect(feed.author).toBe("Bob Writer");
    expect(feed.updated).toBe("2024-02-01T10:00:00.000Z");
    const entry = feed.items[0];
    expect(entry.title).toBe("Atom Entry");
    expect(entry.link).toBe("https://atom.example.com/entries/1");
    expect(entry.guid).toBe("urn:demo:atom:1");
    expect(entry.published).toBe("2024-02-01T09:00:00.000Z");
    expect(entry.updated).toBe("2024-02-01T09:30:00.000Z");
    expect(entry.authors).toEqual(["Carol"]);
    expect(entry.categories).toEqual(["science"]);
    expect(entry.summaryText).toContain("Short summary");
    expect(entry.content).toContain("The body text");
  });

  it("applies configurable entry limits and reports truncation", () => {
    const feed = parseFeed(RSS2, { limit: 1 });
    expect(feed.items.length).toBe(1);
    expect(feed.totalItems).toBe(3);
    expect(feed.truncated).toBe(true);
  });

  it("handles malformed feeds without throwing", () => {
    const broken = parseFeed("<rss><channel><title>Oops <item><title>Unclosed");
    expect(broken.title).toContain("Oops");
    expect(broken.warnings.length + 1).toBeGreaterThan(0);
    const notAFeed = parseFeed("this is not xml at all");
    expect(notAFeed.items).toEqual([]);
    expect(notAFeed.warnings.join(" ")).toMatch(/not a parseable feed|unclosed/i);
  });

  it("is XXE-safe: DOCTYPE entities are ignored, never expanded", () => {
    const xxe = `<?xml version="1.0"?>
<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<rss version="2.0"><channel><title>&xxe;</title><item><title>&xxe;</title></item></channel></rss>`;
    const feed = parseFeed(xxe);
    const text = JSON.stringify(feed);
    expect(text).not.toContain("root:");
    expect(feed.warnings).toContain("doctype-ignored");
  });

  it("strips HTML safely (scripts never become text)", () => {
    expect(stripHtml('<p>Hi <script>alert(1)</script><b>there</b></p>')).toBe("Hi there");
    expect(stripHtml("<p>A &amp; B</p>")).toBe("A & B");
  });
});

describe("feed retrieval", () => {
  let router: FetchRouter;
  beforeEach(() => {
    router = installFetchRouter();
    publicToolRateLimiter.reset();
  });
  afterEach(() => router.restore());

  it("fetches and parses a remote feed through the SSRF-guarded client", async () => {
    router.on("feed.example.com", () => ({ status: 200, headers: { "content-type": "application/rss+xml" }, body: RSS2 }));
    const result = await fetchFeed({ TOOL_RATE_LIMIT_PER_MINUTE: "60" }, "https://feed.example.com/rss.xml", { limit: 5 });
    expect(result.items.length).toBe(3);
    expect(result.finalUrl).toContain("feed.example.com");
  });

  it("discovers advertised feeds when the URL returns HTML", async () => {
    router.on("site.example.com", () =>
      htmlResult('<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"><title>Site</title></head><body>hi</body></html>'),
    );
    await expect(fetchFeed({}, "https://site.example.com/")).rejects.toMatchObject({ code: "unsupported" });
    try {
      await fetchFeed({}, "https://site.example.com/");
    } catch (error) {
      expect(String((error as Error).message)).toContain("https://site.example.com/feed.xml");
    }
  });

  it("rejects internal feed URLs before any request", async () => {
    await expect(fetchFeed({}, "http://127.0.0.1:8080/feed")).rejects.toMatchObject({ code: "blocked_url" });
    expect(router.requests.filter((request) => request.url.includes("127.0.0.1"))).toEqual([]);
  });

  it("parses inline XML without any network", async () => {
    const { default: worker } = await import("../index.js");
    const response = await worker.fetch(
      new Request("https://demo.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "feed_read", arguments: { xml: ATOM, limit: 5 } } }),
      }),
      {} as never,
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    );
    const text = await response.text();
    const payload = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter((line) => line.startsWith("data:")).at(-1)!.slice(5).trim());
    const body = JSON.parse((payload.result?.content ?? []).map((entry: { text?: string }) => entry.text ?? "").join("\n"));
    expect(body.ok).toBe(true);
    expect(body.items[0].title).toBe("Atom Entry");
    expect(router.requests.length).toBe(0);
  });
});
