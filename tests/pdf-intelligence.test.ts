/**
 * DEMO 0.9 — PDF intelligence. The PDFs here are hand-built byte-for-byte
 * (uncompressed + zlib-compressed streams + a JPEG/DCT page image), so text
 * extraction, page references, metadata, scanned detection, tables and the OCR
 * pipeline are all verified against known ground truth.
 */

import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ocrScannedPdf, parsePdf, searchPdf } from "../src/documents/pdf.js";
import { publicToolRateLimiter } from "../src/core/rate-limit.js";
import { installFetchRouter, type FetchRouter } from "./helpers/fetch-router.js";

function latin1Bytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Minimal two-page PDF: page 1 has positioned text + a fake table; page 2 flate. */
function buildTextPdf(): Uint8Array {
  const content1 = [
    "BT",
    "/F1 12 Tf",
    "72 720 Td",
    "(Quarterly Report) Tj",
    "0 -20 Td",
    "(Revenue grew strongly this year.) Tj",
    "0 -20 Td",
    "(Region) Tj",
    "120 0 Td",
    "(Sales) Tj",
    "120 0 Td",
    "(Growth) Tj",
    "0 -20 Td",
    "-120 0 Td",
    "(North) Tj",
    "120 0 Td",
    "(1200) Tj",
    "120 0 Td",
    "(14) Tj",
    "0 -20 Td",
    "-120 0 Td",
    "(South) Tj",
    "120 0 Td",
    "(900) Tj",
    "120 0 Td",
    "(9) Tj",
    "ET",
  ].join("\n");
  const content2 = ["BT", "/F1 12 Tf", "72 720 Td", "(Second page mentions 42 units.) Tj", "ET"].join("\n");

  const objects: Array<Uint8Array | string> = [];
  const add = (body: string | Uint8Array, index: number) => {
    objects[index - 1] = body;
  };
  add("<< /Type /Catalog /Pages 2 0 R >>", 1);
  add("<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>", 2);
  add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>", 3);
  add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>", 4);
  add(`<< /Length ${content1.length} >>\nstream\n${content1}\nendstream`, 5);
  add(`<< /Length ${content2.length} >>\nstream\n${content2}\nendstream`, 6);
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", 7);
  add("<< /Title (Demo Report) /Author (Ada Lovelace) /Producer (DEMO Test Suite) /CreationDate (D:20240105120000Z) >>", 8);

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    const body = objects[i];
    pdf += `${i + 1} 0 obj\n`;
    pdf += typeof body === "string" ? body : "";
    pdf += `\nendobj\n`;
  }
  pdf += `trailer\n<< /Root 1 0 R /Info 8 0 R >>\nstartxref\n0\n%%EOF\n`;
  void offsets;
  return latin1Bytes(pdf);
}

/** One-page scanned-style PDF: a DCT (JPEG-ish) image XObject and no text. */
function buildScannedPdf(): Uint8Array {
  // A minimal JPEG-ish byte sequence: SOI + APP0-ish filler + EOI. The parser
  // only needs DCT stream bytes to hand to the vision model stub.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
  const objects: Array<string | Uint8Array> = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  for (let i = 0; i < objects.length; i++) {
    pdf += `${i + 1} 0 obj\n${typeof objects[i] === "string" ? objects[i] : ""}\nendobj\n`;
  }
  const imageDict = `5 0 obj\n<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.byteLength} >>\nstream\n`;
  const head = latin1Bytes(pdf + imageDict);
  return concat([head, jpeg, latin1Bytes("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n")]);
}

/** One page with a FlateDecode content stream (exercises the inflater). */
function buildFlatePdf(): Uint8Array {
  const content = "BT /F1 12 Tf 72 720 Td (Compressed stream text) Tj ET";
  const compressed = new Uint8Array(deflateSync(Buffer.from(content, "latin1")));
  let pdf = "%PDF-1.4\n";
  pdf += "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n";
  pdf += "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n";
  pdf += "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>\nendobj\n";
  const dict = `4 0 obj\n<< /Length ${compressed.byteLength} /Filter /FlateDecode >>\nstream\n`;
  return concat([latin1Bytes(pdf + dict), compressed, latin1Bytes("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n")]);
}

describe("PDF parsing", () => {
  it("extracts text with page numbers, metadata and tables", async () => {
    const document = await parsePdf(buildTextPdf());
    expect(document.pageCount).toBe(2);
    expect(document.metadata.title).toBe("Demo Report");
    expect(document.metadata.author).toBe("Ada Lovelace");
    expect(document.metadata.producer).toBe("DEMO Test Suite");
    expect(document.pages[0].text).toContain("Quarterly Report");
    expect(document.pages[0].text).toContain("Revenue grew strongly");
    expect(document.pages[1].text).toContain("Second page mentions 42 units");
    // Page-level references preserved in the full text.
    expect(document.fullText).toContain("[page 1]");
    expect(document.fullText).toContain("[page 2]");
    // Table heuristic over the aligned Region/Sales/Growth rows.
    const table = document.pages[0].tables[0];
    expect(table).toBeTruthy();
    expect(table.rows.flat()).toEqual(expect.arrayContaining(["Region", "Sales", "Growth", "North", "South"]));
    expect(document.scanned.detected).toBe(false);
  });

  it("reads FlateDecode content streams via the platform inflater", async () => {
    const document = await parsePdf(buildFlatePdf());
    expect(document.pages[0].text).toContain("Compressed stream text");
  });

  it("detects scanned/image-only pages with an explicit heuristic", async () => {
    const document = await parsePdf(buildScannedPdf());
    expect(document.pageCount).toBe(1);
    expect(document.scanned.detected).toBe(true);
    expect(document.scanned.scannedPages).toEqual([1]);
    expect(document.pages[0].images[0]).toMatchObject({ jpeg: true, width: 8, height: 8 });
    expect(document.limitations.join(" ")).toMatch(/scanned|ocr/i);
  });

  it("searches within the PDF with page/line references", async () => {
    const document = await parsePdf(buildTextPdf());
    const result = searchPdf(document, "Revenue grew", { caseInsensitive: true });
    expect(result.matches.length).toBe(1);
    expect(result.matches[0].page).toBe(1);
    expect(result.matches[0].context).toContain("Revenue grew");
    const missing = searchPdf(document, "does not exist anywhere");
    expect(missing.matches).toEqual([]);
  });

  it("rejects non-PDF input with a stable error", async () => {
    await expect(parsePdf(latin1Bytes("<html><body>not a pdf</body></html>"))).rejects.toMatchObject({ code: "unsupported" });
  });
});

describe("PDF OCR via existing Workers AI", () => {
  it("reports unavailable (never invented text) without the AI binding", async () => {
    const document = await parsePdf(buildScannedPdf());
    const result = await ocrScannedPdf({}, buildScannedPdf(), document);
    expect(result.pages).toEqual([]);
    expect(result.provider).toBeNull();
    expect(result.message).toMatch(/OCR is unavailable/i);
    expect(result.message).toMatch(/will not claim text/i);
  });

  it("OCR-extracts JPEG page images through the vision binding with page references", async () => {
    const calls: unknown[] = [];
    const env = {
      AI: {
        run: async (model: string, input: unknown) => {
          calls.push({ model, input });
          return { description: "Scanned Page Text Line" };
        },
      },
    };
    const bytes = buildScannedPdf();
    const document = await parsePdf(bytes);
    const result = await ocrScannedPdf(env, bytes, document);
    expect(result.pages[0]).toMatchObject({ page: 1, status: "ok", text: "Scanned Page Text Line" });
    expect(result.provider).toContain("cloudflare-ai:");
    expect(calls.length).toBe(1);
    expect(result.pages[0].message).toMatch(/model-generated/i);
  });

  it("reports model failures honestly", async () => {
    const env = { AI: { run: async () => { throw new Error("model exploded"); } } };
    const bytes = buildScannedPdf();
    const document = await parsePdf(bytes);
    const result = await ocrScannedPdf(env, bytes, document);
    expect(result.pages[0].status).toBe("failed");
    expect(result.pages[0].text).toBeNull();
    expect(result.pages[0].message).toContain("model exploded");
  });
});

describe("pdf_document tool surface", () => {
  let router: FetchRouter;
  beforeEach(() => {
    router = installFetchRouter();
    publicToolRateLimiter.reset();
  });
  afterEach(() => router.restore());

  async function callTool(args: Record<string, unknown>, env: Record<string, unknown> = {}) {
    const { default: worker } = await import("../index.js");
    const response = await worker.fetch(
      new Request("https://demo.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pdf_document", arguments: args } }),
      }),
      { TOOL_RATE_LIMIT_PER_MINUTE: "60", ...env } as never,
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    );
    const text = await response.text();
    const payload = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").filter((line) => line.startsWith("data:")).at(-1)!.slice(5).trim());
    const body = (payload.result?.content ?? []).map((entry: { text?: string }) => entry.text ?? "").join("\n");
    return { isError: Boolean(payload.result?.isError), parsed: JSON.parse(body) as Record<string, any> };
  }

  it("downloads a public PDF and returns text with page references", async () => {
    router.on("docs.example.com", () => ({ status: 200, headers: { "content-type": "application/pdf" }, body: buildTextPdf() }));
    const result = await callTool({ mode: "text", url: "https://docs.example.com/report.pdf" });
    expect(result.isError).toBeFalsy();
    expect(result.parsed.pages[0].text).toContain("Quarterly Report");
  });

  it("rejects HTML walls and internal URLs with structured errors", async () => {
    router.on("docs.example.com", () => ({ status: 200, headers: { "content-type": "text/html" }, body: "<html>login</html>" }));
    const wall = await callTool({ mode: "info", url: "https://docs.example.com/report.pdf" });
    expect(wall.isError).toBe(true);
    expect(wall.parsed.error).toBe("unsupported");
    expect(wall.parsed.message).toMatch(/HTML page|wrong URL/i);

    const internal = await callTool({ mode: "info", url: "http://10.1.2.3/report.pdf" });
    expect(internal.isError).toBe(true);
    expect(["blocked_url", "invalid_input"]).toContain(internal.parsed.error);
  });

  it("enforces the size limit", async () => {
    router.on("big.example.com", () => ({ status: 200, headers: { "content-type": "application/pdf", "content-length": "999999999" }, body: "%PDF-1.4" }));
    const result = await callTool({ mode: "info", url: "https://big.example.com/huge.pdf" });
    expect(result.isError).toBe(true);
    expect(result.parsed.error).toBe("size_limit_exceeded");
  });
});
