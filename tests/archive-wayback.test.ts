/**
 * DEMO 0.9 — Internet Archive / Wayback Machine capability.
 * All requests against stubbed public endpoints; no API key anywhere.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveItem, archiveSearchItems, waybackClosest, waybackRetrieve, waybackSnapshots } from "../src/archive/client.js";
import { publicToolRateLimiter } from "../src/core/rate-limit.js";
import { installFetchRouter, jsonResult, htmlResult, type FetchRouter } from "./helpers/fetch-router.js";

const ENV = { TOOL_RATE_LIMIT_PER_MINUTE: "60" } as Record<string, unknown>;
const ORIGINAL = "https://example.com/article";

describe("wayback availability / closest snapshot", () => {
  let router: FetchRouter;
  beforeEach(() => {
    router = installFetchRouter();
    publicToolRateLimiter.reset();
  });
  afterEach(() => router.restore());

  it("finds the closest snapshot and preserves original URL + timestamp", async () => {
    router.on("archive.org", ({ url }) => {
      expect(url.pathname).toBe("/wayback/available");
      return jsonResult({ archived_snapshots: { closest: { url: "https://web.archive.org/web/20240101120000/https://example.com/article", timestamp: "20240101120000", status: "200", mimetype: "text/html" } } });
    });
    const result = await waybackClosest(ENV, ORIGINAL, "2024-01-02");
    expect(result.available).toBe(true);
    expect(result.snapshot?.timestamp).toBe("20240101120000");
    expect(result.snapshot?.originalUrl).toBe(ORIGINAL);
    expect(result.snapshot?.archiveUrl).toContain("/web/20240101120000/");
    expect(result.message).toMatch(/as of|snapshot/i);
  });

  it("reports honestly when no snapshot exists", async () => {
    router.on("archive.org", () => jsonResult({ archived_snapshots: {} }));
    const result = await waybackClosest(ENV, ORIGINAL);
    expect(result.available).toBe(false);
    expect(result.snapshot).toBeNull();
    expect(result.message).toMatch(/no .*snapshot exists/i);
    expect(result.message).toMatch(/not an error/i);
  });

  it("blocks internal original URLs before contacting the archive", async () => {
    await expect(waybackClosest(ENV, "http://169.254.169.254/latest/meta-data/")).rejects.toMatchObject({ code: "blocked_url" });
    expect(router.requests.length).toBe(0);
  });

  it("maps upstream throttling to a stable rate_limited error", async () => {
    router.on("archive.org", () => ({ status: 429, headers: { "content-type": "text/plain" }, body: "slow down" }));
    await expect(waybackClosest(ENV, ORIGINAL)).rejects.toMatchObject({ code: "rate_limited", retryable: true });
  });
});

describe("wayback snapshot listing", () => {
  let router: FetchRouter;
  beforeEach(() => {
    router = installFetchRouter();
    publicToolRateLimiter.reset();
  });
  afterEach(() => router.restore());

  it("lists captures around a date with original URLs and timestamps", async () => {
    router.on("web.archive.org", ({ url }) => {
      expect(url.pathname).toBe("/cdx/search/cdx");
      expect(url.searchParams.get("matchType")).toBe("exact");
      return jsonResult([
        ["timestamp", "original", "statuscode", "mimetype", "digest", "length"],
        ["20240101120000", ORIGINAL, "200", "text/html", "ABC", "1234"],
        ["20240102130000", ORIGINAL, "200", "text/html", "DEF", "2345"],
      ]);
    });
    const listing = await waybackSnapshots(ENV, ORIGINAL, { from: "2024-01-01", to: "2024-01-03", limit: 10 });
    expect(listing.snapshots.length).toBe(2);
    expect(listing.snapshots[0].timestamp).toBe("20240101120000");
    expect(listing.snapshots[0].originalUrl).toBe(ORIGINAL);
    expect(listing.snapshots[0].archiveUrl).toContain("web.archive.org/web/20240101120000/");
  });

  it("says so plainly when the window is empty", async () => {
    router.on("web.archive.org", () => jsonResult([["timestamp", "original", "statuscode", "mimetype", "digest", "length"]]));
    const listing = await waybackSnapshots(ENV, ORIGINAL);
    expect(listing.snapshots).toEqual([]);
    expect(listing.message).toMatch(/no matching snapshots/i);
  });

  it("rejects malformed timestamps", async () => {
    await expect(waybackSnapshots(ENV, ORIGINAL, { from: "not-a-date" })).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("wayback retrieval", () => {
  let router: FetchRouter;
  beforeEach(() => {
    router = installFetchRouter();
    publicToolRateLimiter.reset();
  });
  afterEach(() => router.restore());

  it("retrieves an archived page and extracts its content with the capture timestamp", async () => {
    router.on("archive.org", () => jsonResult({ archived_snapshots: { closest: { url: "https://web.archive.org/web/20240101120000/https://example.com/article", timestamp: "20240101120000", status: "200" } } }));
    router.on("web.archive.org", ({ url }) => {
      expect(url.pathname).toContain("/web/20240101120000id_/");
      return htmlResult("<html><head><title>Archived Piece</title></head><body><article><h1>Archived Piece</h1><p>Historic content lives here.</p></article></body></html>");
    });
    const result = await waybackRetrieve(ENV, ORIGINAL);
    expect(result.timestamp).toBe("20240101120000");
    expect(result.originalUrl).toBe(ORIGINAL);
    expect(result.extracted?.title).toContain("Archived Piece");
    expect(result.text).toContain("Historic content lives here");
    expect(result.message).toMatch(/from 20240101120000/);
  });

  it("fails clearly when the URL has no snapshot at all", async () => {
    router.on("archive.org", () => jsonResult({ archived_snapshots: {} }));
    await expect(waybackRetrieve(ENV, ORIGINAL)).rejects.toMatchObject({ code: "page_not_found" });
  });
});

describe("archive.org item + search", () => {
  let router: FetchRouter;
  beforeEach(() => {
    router = installFetchRouter();
    publicToolRateLimiter.reset();
  });
  afterEach(() => router.restore());

  it("searches items without an API key", async () => {
    router.on("archive.org", ({ url }) => {
      expect(url.pathname).toBe("/advancedsearch.php");
      expect(url.searchParams.get("output")).toBe("json");
      return jsonResult({ response: { numFound: 1, docs: [{ identifier: "goodytwoshoes00newy", title: "Goody Two Shoes", mediatype: "texts", year: 1888 }] } });
    });
    const result = await archiveSearchItems(ENV, "goody two shoes", { limit: 5 });
    expect(result.total).toBe(1);
    expect(result.items[0].identifier).toBe("goodytwoshoes00newy");
    expect(result.items[0].itemUrl).toContain("archive.org/details/goodytwoshoes00newy");
  });

  it("returns item metadata + file layout and flags restricted items", async () => {
    router.on("archive.org", () =>
      jsonResult({
        metadata: { identifier: "restricted-item", title: "Lending Item", access_restricted_item: true, creator: "Someone", collection: ["inlibrary"] },
        files: [{ name: "restricted-item_djvu.txt", format: "DjVuTXT", length: "1234" }, { name: "page.jpg", format: "JPEG", length: "999" }],
        server: "ia800000.us.archive.org",
        dir: "/0/items/restricted-item",
      }),
    );
    const item = await archiveItem(ENV, "restricted-item");
    expect(item.restricted).toBe(true);
    expect(item.message).toMatch(/restricted/i);
    expect(item.message).toMatch(/instead of attempting to bypass/i);
    expect(item.files.length).toBe(2);
    expect(item.files[0].format).toBe("DjVuTXT");
  });

  it("reports missing items as unavailable, not as empty success", async () => {
    router.on("archive.org", () => jsonResult({ error: "Item not found" }));
    await expect(archiveItem(ENV, "does-not-exist-xyz")).rejects.toMatchObject({ code: "page_not_found" });
  });

  it("validates identifiers", async () => {
    await expect(archiveItem(ENV, "../../etc/passwd")).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("archive tools over MCP", () => {
  let router: FetchRouter;
  beforeEach(() => {
    router = installFetchRouter();
    publicToolRateLimiter.reset();
  });
  afterEach(() => router.restore());

  async function callTool(name: string, args: Record<string, unknown>) {
    const { default: worker } = await import("../index.js");
    const response = await worker.fetch(
      new Request("https://demo.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }),
      ENV as never,
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    );
    const text = await response.text();
    const payload = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter((line) => line.startsWith("data:")).at(-1)!.slice(5).trim());
    const body = (payload.result?.content ?? []).map((entry: { text?: string }) => entry.text ?? "").join("\n");
    return { isError: Boolean(payload.result?.isError), parsed: JSON.parse(body) as Record<string, any> };
  }

  it("exposes archive_search, archive_item and wayback with honest empty results", async () => {
    router.on("archive.org", () => jsonResult({ response: { numFound: 0, docs: [] } }));
    const search = await callTool("archive_search", { scope: "items", query: "nothing here" });
    expect(search.isError).toBeFalsy();
    expect(search.parsed.items).toEqual([]);
    expect(search.parsed.message).toMatch(/no archive.org items/i);

    router.on("archive.org", () => jsonResult({ archived_snapshots: {} }));
    const wayback = await callTool("wayback", { mode: "availability", url: "https://example.com/x" });
    expect(wayback.parsed.available).toBe(false);
    expect(wayback.parsed.snapshot).toBeNull();
  });
});
