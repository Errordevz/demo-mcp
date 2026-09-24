/**
 * DEMO 0.9 — screenshot comparison. Region merging is pure logic; the tool
 * degrades to honest metadata comparison when no browser binding exists (the
 * test env has none) and never fabricates pixel results.
 */

import { describe, expect, it } from "vitest";
import { mergeChangedRegions, metadataSimilarity, requireDistinct, diffThreshold } from "../src/browser/compare.js";

describe("changed-region merging", () => {
  it("merges connected changed cells into bounding regions", () => {
    const grid = [
      [false, false, false, false],
      [false, true, true, false],
      [false, true, false, false],
      [false, false, false, true],
    ];
    const regions = mergeChangedRegions(grid, 10, 20);
    expect(regions.length).toBe(2);
    const big = regions[0];
    expect(big).toMatchObject({ x: 10, y: 20, width: 20, height: 40 });
    const small = regions[1];
    expect(small).toMatchObject({ x: 30, y: 60, width: 10, height: 20 });
  });

  it("returns no regions for identical grids and respects min size", () => {
    expect(mergeChangedRegions([[false, false], [false, false]], 5, 5)).toEqual([]);
    expect(mergeChangedRegions([[true, false], [false, false]], 5, 5, 2)).toEqual([]);
  });

  it("caps the number of reported regions", () => {
    const grid = Array.from({ length: 10 }, () => Array.from({ length: 30 }, (_, index) => index % 2 === 0));
    const regions = mergeChangedRegions(grid, 1, 1);
    expect(regions.length).toBeLessThanOrEqual(25);
  });
});

describe("metadata similarity", () => {
  it("is 1 only for identical hashes and scales otherwise", () => {
    expect(metadataSimilarity({ width: 1, height: 1, bytes: 10, sha: "aa" }, { width: 1, height: 1, bytes: 10, sha: "aa" })).toBe(1);
    const different = metadataSimilarity({ width: 100, height: 100, bytes: 1000, sha: null }, { width: 100, height: 100, bytes: 1000, sha: null });
    expect(different).toBeGreaterThan(0.9);
    const different2 = metadataSimilarity({ width: 10, height: 10, bytes: 10, sha: null }, { width: 1000, height: 1000, bytes: 100000, sha: null });
    expect(different2).toBeLessThan(0.5);
  });
});

describe("screenshot_diff tool without browser binding", () => {
  async function callTool(args: Record<string, unknown>) {
    const { default: worker } = await import("../index.js");
    const response = await worker.fetch(
      new Request("https://demo.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "screenshot_diff", arguments: args } }),
      }),
      {
        SCREENSHOTS: {
          async get(key: string) {
            if (key !== "screenshots/AAAAAAAAAAAAAAAAAAAA") return null;
            const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xde, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
            return { arrayBuffer: async () => bytes.buffer, customMetadata: {} };
          },
        },
      } as never,
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    );
    const text = await response.text();
    const payload = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter((line) => line.startsWith("data:")).at(-1)!.slice(5).trim());
    const body = (payload.result?.content ?? []).map((entry: { text?: string }) => entry.text ?? "").join("\n");
    return { isError: Boolean(payload.result?.isError), parsed: JSON.parse(body) as Record<string, any> };
  }

  it("reports metadata-only comparison honestly when the browser is unavailable", async () => {
    const result = await callTool({ a: "AAAAAAAAAAAAAAAAAAAA", b: "BBBBBBBBBBBBBBBBBBBB" });
    // B does not exist in the fake bucket.
    expect(result.isError).toBe(true);
    expect(result.parsed.error).toBe("page_not_found");
  });

  it("rejects identical inputs before any work", async () => {
    const result = await callTool({ a: "AAAAAAAAAAAAAAAAAAAA", b: "AAAAAAAAAAAAAAAAAAAA" });
    expect(result.isError).toBe(true);
    expect(result.parsed.error).toBe("invalid_input");
  });

  it("validates reference shapes", async () => {
    const result = await callTool({ a: "!!bad!!", b: "BBBBBBBBBBBBBBBBBBBB" });
    expect(result.isError).toBe(true);
    expect(result.parsed.error).toBe("invalid_input");
  });
});

describe("guards and thresholds", () => {
  it("requireDistinct throws on identical inputs", () => {
    expect(() => requireDistinct("a", "a")).toThrowError(/two different/);
  });
  it("threshold is clamped", () => {
    expect(diffThreshold(undefined)).toBe(16);
    expect(diffThreshold(0)).toBe(1);
    expect(diffThreshold(999)).toBe(128);
  });
});
