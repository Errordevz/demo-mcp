/**
 * Document intelligence tools: `pdf_document` (public PDF pipeline) and
 * `image_analyze` (generic vision on DEMO's existing Workers AI binding).
 * Both fetch through the SSRF-guarded client with content-type validation,
 * size limits and timeouts; PDFs and images are treated strictly as untrusted
 * data (nothing is executed).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { BrowserError } from "../core/errors.js";
import { createSsrfGuard, guardedFetchBytes } from "../core/guarded-fetch.js";
import { LIMITS, clamp } from "../core/limits.js";
import { publicToolRateLimiter } from "../core/rate-limit.js";
import { runTool, textResult } from "./results.js";
import { ocrScannedPdf, parsePdf, searchPdf } from "../documents/pdf.js";
import { analyzeImageWithAi, assertImageCount, compareImages, fetchPublicImage, PROMPTS, type ImageMetadata } from "../documents/image.js";

export const DOCUMENT_TOOL_NAMES = ["pdf_document", "image_analyze"] as const;

export interface DocumentToolContext {
  env: Record<string, unknown> & { PDF_MAX_MB?: string; IMAGE_MAX_MB?: string };
}

async function fetchPdfBytes(env: DocumentToolContext["env"], url: string, timeoutMs?: number): Promise<Uint8Array> {
  publicToolRateLimiter.charge(env, "pdf_document", url);
  const guard = createSsrfGuard(env);
  const maxMb = clamp(Number(env.PDF_MAX_MB ?? LIMITS.pdfMaxBytesDefault / (1024 * 1024)), 1, LIMITS.pdfMaxBytesCap / (1024 * 1024));
  const result = await guardedFetchBytes(url, {
    guard,
    timeoutMs: clamp(timeoutMs ?? LIMITS.publicFetchTimeoutMaxMs, 1_000, LIMITS.publicFetchTimeoutMaxMs),
    maxBytes: maxMb * 1024 * 1024,
    acceptContentTypes: ["application/pdf", "application/x-pdf", "text/html", "application/octet-stream"],
    headers: { accept: "application/pdf;q=0.9,*/*;q=0.1", "user-agent": "DEMO-MCP/1.0.0 (+pdf reader; public read-only)" },
  });
  // A PDF must carry the header; an HTML body here is a wall/wrong-URL page.
  const head = new TextDecoder("latin1").decode(result.bytes.subarray(0, 1024));
  if (!head.includes("%PDF-")) {
    throw new BrowserError("unsupported", `The URL did not return a PDF (${result.contentType ?? "no content-type"}${/html/i.test(result.contentType ?? "") ? "; it looks like an HTML page — a login wall or wrong URL" : ""}).`, {
      retryable: false,
    });
  }
  return result.bytes;
}

export function registerDocumentTools(mcp: McpServer, ctx: DocumentToolContext): void {
  mcp.registerTool(
    "pdf_document",
    {
      title: "PDF Document Intelligence",
      description:
        "Download and inspect a PUBLIC PDF: mode=info (metadata + page count + scanned detection), mode=text (page-by-page text with page numbers preserved), mode=pages (per-page structure: characters, lines, embedded images, tables), mode=search (find text with page/line references), mode=tables (extracted table candidates), mode=ocr (OCR scanned/image-only pages through DEMO's existing Workers AI vision binding — reports unavailable instead of inventing text when no AI binding exists). Scanned PDFs are detected explicitly. PDFs are untrusted input: nothing inside them is executed. Size/timeout limits and SSRF protection apply like every other fetch.",
      inputSchema: {
        mode: z.enum(["info", "text", "pages", "search", "tables", "ocr"]).default("info"),
        url: z.string().url().max(2_000).describe("Public http(s) URL of the PDF."),
        pages: z.array(z.number().int().min(1).max(LIMITS.pdfMaxPagesCap)).max(LIMITS.pdfMaxOcrPages).optional().describe("ocr mode: specific page numbers (default: all detected scanned pages, capped)."),
        max_pages: z.number().int().min(1).max(LIMITS.pdfMaxPagesCap).default(LIMITS.pdfMaxPagesCap),
        query: z.string().max(200).optional().describe("search mode: text or regex to find."),
        case_insensitive: z.boolean().optional(),
        regex: z.boolean().optional(),
        timeout_ms: z.number().int().min(1_000).max(LIMITS.publicFetchTimeoutMaxMs).optional(),
      },
      annotations: { title: "PDF Document Intelligence", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(async () => {
        const mode = (args.mode ?? "info") as "info" | "text" | "pages" | "search" | "tables" | "ocr";
        // Validate mode-specific inputs before any network work.
        if (mode === "search" && !args.query) throw new BrowserError("invalid_input", "search mode requires query.", { retryable: false });
        const bytes = await fetchPdfBytes(ctx.env, args.url, args.timeout_ms);
        const document = await parsePdf(bytes, { maxPages: args.max_pages, includePageText: true });
        switch (mode) {
          case "info":
            return textResult({
              ok: true,
              url: args.url,
              pageCount: document.pageCount,
              metadata: document.metadata,
              scanned: document.scanned,
              warnings: document.warnings,
              limitations: document.limitations,
              truncated: document.truncated,
            });
          case "text":
            return textResult({
              ok: true,
              url: args.url,
              pageCount: document.pageCount,
              truncated: document.truncated,
              text: document.fullText,
              pages: document.pages.map((page) => ({ page: page.page, chars: page.chars, text: page.text })),
              scanned: document.scanned,
              limitations: document.limitations,
            });
          case "pages":
            return textResult({
              ok: true,
              url: args.url,
              pageCount: document.pageCount,
              pages: document.pages.map((page) => ({ page: page.page, chars: page.chars, lines: page.lines, imageCount: page.imageCount, images: page.images, scanned: page.scanned, tableCount: page.tables.length })),
              scanned: document.scanned,
              truncated: document.truncated,
            });
          case "search": {
            if (!args.query) throw new BrowserError("invalid_input", "search mode requires query.");
            const result = searchPdf(document, args.query, { caseInsensitive: args.case_insensitive, regex: args.regex });
            return textResult({ ok: true, url: args.url, query: args.query, ...result });
          }
          case "tables": {
            const tables = document.pages.flatMap((page) => page.tables);
            return textResult({
              ok: true,
              url: args.url,
              tables,
              message: tables.length
                ? `${tables.length} table candidate(s) detected by column alignment (rows are reconstructed from positioned text; verify against the original).`
                : "No table structure was detected. The heuristic needs ≥3 aligned columns across ≥3 lines and will miss borderless or irregular layouts.",
            });
          }
          case "ocr": {
            const result = await ocrScannedPdf(ctx.env, bytes, document, { pages: args.pages, maxPages: LIMITS.pdfMaxOcrPages });
            return textResult({ ok: true, url: args.url, scanned: document.scanned, ...result });
          }
          default:
            throw new BrowserError("invalid_input", `Unknown pdf mode "${String(mode)}".`, { hint: "Valid modes: info, text, pages, search, tables, ocr" });
        }
      }),
  );

  mcp.registerTool(
    "image_analyze",
    {
      title: "Image Analysis",
      description:
        "Fetch a PUBLIC image and analyze it with DEMO's existing Workers AI vision binding (the same pipeline the video tools use — no second vision API). mode=info (format, dimensions, size, hash), mode=describe (factual description), mode=ocr (transcribe visible text), mode=analyze (structured visible-text/objects/scene JSON), mode=compare (2-4 images: per-image metadata+descriptions plus coarse similarity). When no AI binding is configured, info still works and AI-derived fields report unavailable — DEMO never invents descriptions or text. Size limits and SSRF protection apply.",
      inputSchema: {
        mode: z.enum(["info", "describe", "ocr", "analyze", "compare"]).default("info"),
        urls: z.array(z.string().url().max(2_000)).min(1).max(LIMITS.imageCompareMaxImages).describe("Public image URL(s); compare mode accepts 2-4."),
        timeout_ms: z.number().int().min(1_000).max(LIMITS.publicFetchTimeoutMaxMs).optional(),
      },
      annotations: { title: "Image Analysis", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      runTool(async () => {
        const mode = (args.mode ?? "info") as "info" | "describe" | "ocr" | "analyze" | "compare";
        const urls = args.urls as string[];
        assertImageCount(urls.length);
        if (mode === "compare" && urls.length < 2) throw new BrowserError("invalid_input", "compare mode needs at least two image URLs.");
        const images: Array<{ metadata: ImageMetadata; analysis?: ReturnType<typeof analyzeImageWithAi> extends Promise<infer R> ? R : never }> = [];
        const fetched = [];
        for (const url of urls) {
          fetched.push(await fetchPublicImage(ctx.env, url, { scope: "image_analyze", timeoutMs: args.timeout_ms }));
        }
        switch (mode) {
          case "info":
            return textResult({ ok: true, images: fetched.map((image) => image.metadata), message: "Binary metadata only; dimensions are read from the file headers (png/jpeg/gif/webp/bmp/avif)." });
          case "describe":
          case "ocr":
          case "analyze": {
            const prompt = mode === "describe" ? PROMPTS.describe : mode === "ocr" ? PROMPTS.ocr : PROMPTS.analyze;
            for (const image of fetched) {
              const analysis = await analyzeImageWithAi(ctx.env, image.bytes, prompt);
              images.push({ metadata: image.metadata, analysis });
            }
            return textResult({ ok: true, mode, results: images, message: "Model-generated analysis of each image; verify critical details against the image itself." });
          }
          case "compare": {
            const described: Array<{ metadata: ImageMetadata; analysis?: unknown }> = [];
            for (const image of fetched) {
              const analysis = await analyzeImageWithAi(ctx.env, image.bytes, PROMPTS.describe);
              described.push({ metadata: image.metadata, analysis });
            }
            const comparison = compareImages(fetched.map((image) => image.metadata));
            return textResult({ ok: true, mode, results: described, comparison, message: "Per-image descriptions plus coarse pairwise similarity. For pixel-level difference regions use screenshot_diff (browser-based)." });
          }
          default:
            throw new BrowserError("invalid_input", `Unknown image mode "${String(mode)}".`, { hint: "Valid modes: info, describe, ocr, analyze, compare" });
        }
      }),
  );
}
