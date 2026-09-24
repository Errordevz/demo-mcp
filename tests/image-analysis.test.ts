/**
 * DEMO 0.9 — image analysis on the existing Workers AI binding.
 * Retrieval/metadata work without AI; AI-derived fields report unavailable
 * rather than being invented.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeImageWithAi, compareImages, fetchPublicImage, PROMPTS, assertImageCount } from "../src/documents/image.js";
import { publicToolRateLimiter } from "../src/core/rate-limit.js";
import { installFetchRouter, type FetchRouter } from "./helpers/fetch-router.js";

const ENV = { TOOL_RATE_LIMIT_PER_MINUTE: "60" } as Record<string, unknown>;

/** 2×1 PNG: two pixels (red, blue). */
function tinyPng(): Uint8Array {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x6d, 0x56, 0x9e, 0x7a,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

describe("image retrieval + metadata", () => {
  let router: FetchRouter;
  beforeEach(() => {
    router = installFetchRouter();
    publicToolRateLimiter.reset();
  });
  afterEach(() => router.restore());

  it("fetches a public image and reports format/dimensions/hash", async () => {
    router.on("img.example.com", () => ({ status: 200, headers: { "content-type": "image/png" }, body: tinyPng() }));
    const image = await fetchPublicImage(ENV, "https://img.example.com/pic.png");
    expect(image.metadata.width).toBe(2);
    expect(image.metadata.height).toBe(1);
    expect(image.metadata.aspectRatio).toBe(2);
    expect(image.metadata.format).toMatch(/png/i);
    expect(image.metadata.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects non-image content and internal targets", async () => {
    router.on("img.example.com", () => ({ status: 200, headers: { "content-type": "text/html" }, body: "<html>login wall</html>" }));
    await expect(fetchPublicImage(ENV, "https://img.example.com/not-image")).rejects.toMatchObject({ code: "unsupported" });
    await expect(fetchPublicImage(ENV, "http://192.168.0.10/x.png")).rejects.toMatchObject({ code: "blocked_url" });
    expect(router.requests.filter((request) => request.url.includes("192.168"))).toEqual([]);
  });

  it("enforces the size limit", async () => {
    router.on("img.example.com", () => ({ status: 200, headers: { "content-type": "image/png", "content-length": "99999999" }, body: "x" }));
    await expect(fetchPublicImage(ENV, "https://img.example.com/huge.png")).rejects.toMatchObject({ code: "size_limit_exceeded" });
  });
});

describe("vision analysis", () => {
  it("reports unavailable without the AI binding (never invented)", async () => {
    const result = await analyzeImageWithAi({}, tinyPng(), PROMPTS.describe);
    expect(result.status).toBe("unavailable");
    expect(result.text).toBeNull();
    expect(result.message).toMatch(/no Workers AI binding/i);
  });

  it("describes/OCRs via the existing AI.run pipeline", async () => {
    const calls: Array<{ model: string; prompt: string }> = [];
    const env = {
      AI: {
        run: async (model: string, input: { prompt: string }) => {
          calls.push({ model, prompt: input.prompt });
          return { description: "A two pixel test image." };
        },
      },
    };
    const result = await analyzeImageWithAi(env, tinyPng(), PROMPTS.describe);
    expect(result.status).toBe("ok");
    expect(result.text).toBe("A two pixel test image.");
    expect(result.provider).toContain("cloudflare-ai:");
    expect(calls[0].prompt).toContain("Describe this image");
  });

  it("maps model failures to an honest failed status", async () => {
    const env = { AI: { run: async () => { throw new Error("boom"); } } };
    const result = await analyzeImageWithAi(env, tinyPng(), PROMPTS.ocr);
    expect(result.status).toBe("failed");
    expect(result.text).toBeNull();
    expect(result.message).toContain("boom");
  });
});

describe("multi-image comparison", () => {
  it("computes coarse pairwise similarity and flags identical bytes", async () => {
    const meta = (url: string, sha: string | null = null) => ({ url, finalUrl: url, contentType: "image/png", bytes: 100, format: "png", width: 100, height: 50, aspectRatio: 2, sha256: sha });
    const comparison = compareImages([meta("https://x/a.png"), meta("https://x/b.png"), meta("https://x/c.png", "aa".repeat(32))]);
    expect(comparison.pairs.length).toBe(3);
    const identical = comparison.pairs.find((pair) => pair.similarity.identicalBytes);
    // c is compared against a and b without shared sha — check a real identical pair instead.
    void identical;
    const same = compareImages([meta("https://x/a.png", "bb".repeat(32)), meta("https://x/a-copy.png", "bb".repeat(32))]);
    expect(same.pairs[0].similarity.identicalBytes).toBe(true);
    expect(same.pairs[0].similarity.similarity).toBe(1);
    expect(same.pairs[0].similarity.note).toMatch(/byte-identical/i);
  });

  it("caps comparison counts", () => {
    expect(() => assertImageCount(5)).toThrowError(/At most 4 images/);
  });
});

describe("image_analyze tool surface", () => {
  let router: FetchRouter;
  beforeEach(() => {
    router = installFetchRouter();
    publicToolRateLimiter.reset();
  });
  afterEach(() => router.restore());

  async function callTool(args: Record<string, unknown>) {
    const { default: worker } = await import("../index.js");
    const response = await worker.fetch(
      new Request("https://demo.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "image_analyze", arguments: args } }),
      }),
      ENV as never,
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    );
    const text = await response.text();
    const payload = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter((line) => line.startsWith("data:")).at(-1)!.slice(5).trim());
    const body = (payload.result?.content ?? []).map((entry: { text?: string }) => entry.text ?? "").join("\n");
    return { isError: Boolean(payload.result?.isError), parsed: JSON.parse(body) as Record<string, any> };
  }

  it("returns metadata without AI and unavailable analysis fields", async () => {
    router.on("img.example.com", () => ({ status: 200, headers: { "content-type": "image/png" }, body: tinyPng() }));
    const info = await callTool({ mode: "info", urls: ["https://img.example.com/pic.png"] });
    expect(info.isError).toBeFalsy();
    expect(info.parsed.images[0].width).toBe(2);
    const described = await callTool({ mode: "describe", urls: ["https://img.example.com/pic.png"] });
    expect(described.parsed.results[0].analysis.status).toBe("unavailable");
  });

  it("validates compare mode input", async () => {
    const result = await callTool({ mode: "compare", urls: ["https://img.example.com/pic.png"] });
    expect(result.isError).toBe(true);
    expect(result.parsed.error).toBe("invalid_input");
  });
});
