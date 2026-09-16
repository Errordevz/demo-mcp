/**
 * Container + image signature coverage.
 *
 * Every byte shape DEMO claims to recognise gets a fixture here: AVI, FLV,
 * OGG (video and audio), WebM/Matroska, WebP, GIF, BMP and AVIF — through
 * `detectMediaSignature()`, `imageDimensions()`, `webmDurationFromBytes()`,
 * and the resolve/fetch/download paths that must report them honestly.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectMediaSignature,
  durationFromSample,
  imageDimensions,
  mp4DurationFromBytes,
  notAVideoMessage,
  webmDurationFromBytes,
} from "../src/video/probe.js";
import { VideoProcessor } from "../src/video/processor.js";
import { resolvePublicVideo } from "../src/video/http.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, out.byteLength);
  out.set(ascii(type), 4);
  out.set(payload, 8);
  return out;
}

/** RIFF container: `RIFF` + size + form (`AVI `, `WEBP`, `WAVE`). */
function riff(form: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.byteLength);
  out.set(ascii("RIFF"), 0);
  new DataView(out.buffer).setUint32(4, 4 + payload.byteLength, true);
  out.set(ascii(form), 8);
  out.set(payload, 12);
  return out;
}

describe("video container signatures", () => {
  it("detects AVI (RIFF/AVI)", () => {
    const bytes = riff("AVI ", concat(ascii("LIST"), new Uint8Array(64)));
    const signature = detectMediaSignature(bytes, "video/x-msvideo");
    expect(signature.detectedAs).toBe("avi");
    expect(signature.kind).toBe("video");
    expect(signature.isVideo).toBe(true);
    expect(signature.signatureIsVideo).toBe(true);
  });

  it("detects FLV", () => {
    const bytes = concat(ascii("FLV"), new Uint8Array([0x01, 0x05, 0x00, 0x00, 0x00, 0x09]), new Uint8Array(64));
    const signature = detectMediaSignature(bytes, "video/x-flv");
    expect(signature.detectedAs).toBe("flv");
    expect(signature.isVideo).toBe(true);
  });

  it("detects Ogg video vs Ogg audio from the codec header", () => {
    const video = concat(ascii("OggS"), new Uint8Array(28), ascii("theora"), new Uint8Array(64));
    expect(detectMediaSignature(video, "video/ogg").kind).toBe("video");
    expect(detectMediaSignature(video).container).toBe("ogg video");

    const audio = concat(ascii("OggS"), new Uint8Array(28), ascii("vorbis"), new Uint8Array(64));
    const signature = detectMediaSignature(audio, "audio/ogg");
    expect(signature.kind).toBe("audio");
    expect(signature.isVideo).toBe(false);

    const opus = concat(ascii("OggS"), new Uint8Array(28), ascii("OpusHead"), new Uint8Array(64));
    expect(detectMediaSignature(opus).kind).toBe("audio");
  });

  it("detects WebM vs Matroska from the EBML doctype", () => {
    const ebml = (doctype: string): Uint8Array => concat(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), ascii(doctype), new Uint8Array(64));
    expect(detectMediaSignature(ebml("webm")).detectedAs).toBe("webm");
    expect(detectMediaSignature(ebml("matroska")).detectedAs).toBe("matroska");
    expect(detectMediaSignature(ebml("webm")).isVideo).toBe(true);
  });

  it("never trusts a lying video content type over image bytes", () => {
    const gif = concat(ascii("GIF89a"), new Uint8Array(64));
    const signature = detectMediaSignature(gif, "video/mp4");
    expect(signature.detectedAs).toBe("gif");
    expect(signature.isImage).toBe(true);
    expect(signature.isVideo).toBe(false);
  });
});

describe("still-image signatures (thumbnails, never video)", () => {
  it("detects WebP (RIFF/WEBP)", () => {
    const bytes = riff("WEBP", concat(ascii("VP8 "), new Uint8Array(64)));
    const signature = detectMediaSignature(bytes, "image/webp");
    expect(signature.detectedAs).toBe("webp");
    expect(signature.isImage).toBe(true);
    expect(signature.isVideo).toBe(false);
    expect(notAVideoMessage(signature)).toMatch(/WEBP image/);
  });

  it("detects GIF87a and GIF89a", () => {
    expect(detectMediaSignature(concat(ascii("GIF87a"), new Uint8Array(32))).detectedAs).toBe("gif");
    expect(detectMediaSignature(concat(ascii("GIF89a"), new Uint8Array(32))).detectedAs).toBe("gif");
  });

  it("detects BMP", () => {
    const bytes = concat(ascii("BM"), new Uint8Array(64));
    const signature = detectMediaSignature(bytes, "image/bmp");
    expect(signature.detectedAs).toBe("bmp");
    expect(signature.isImage).toBe(true);
    expect(notAVideoMessage(signature)).toMatch(/BMP image/);
  });

  it("detects AVIF stills as images, not mp4 video", () => {
    const ftyp = box("ftyp", concat(ascii("avif"), new Uint8Array([0, 0, 0, 0]), ascii("mif1")));
    const signature = detectMediaSignature(concat(ftyp, new Uint8Array(64)), "image/avif");
    expect(signature.detectedAs).toBe("avif");
    expect(signature.kind).toBe("image");
    expect(signature.isVideo).toBe(false);
    expect(signature.brand).toBe("avif");

    // Even with a lying video content type, AVIF bytes are a still image.
    const lying = detectMediaSignature(concat(ftyp, new Uint8Array(64)), "video/mp4");
    expect(lying.detectedAs).toBe("avif");
    expect(lying.isVideo).toBe(false);
  });

  it("still classifies real ISO-BMFF video as video", () => {
    const ftyp = box("ftyp", concat(ascii("isom"), new Uint8Array([0, 0, 0, 0]), ascii("mp42")));
    expect(detectMediaSignature(concat(ftyp, new Uint8Array(64))).detectedAs).toBe("mp4");
  });
});

describe("imageDimensions()", () => {
  it("reads PNG dimensions from IHDR", () => {
    const bytes = new Uint8Array(32);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    bytes.set(ascii("IHDR"), 12);
    new DataView(bytes.buffer).setUint32(16, 320);
    new DataView(bytes.buffer).setUint32(20, 180);
    expect(imageDimensions(bytes)).toEqual({ width: 320, height: 180 });
  });

  it("reads GIF dimensions from the logical screen descriptor", () => {
    const bytes = concat(ascii("GIF89a"), new Uint8Array([0x40, 0x01, 0xf0, 0x00, 0x00, 0x00, 0x00]), new Uint8Array(16));
    expect(imageDimensions(bytes)).toEqual({ width: 320, height: 240 });
  });

  it("reads WebP dimensions for VP8, VP8L and VP8X chunks", () => {
    // VP8 (lossy): width/height u16 LE at chunk+10/+12 (14-bit).
    const vp8 = new Uint8Array(30);
    vp8.set(ascii("RIFF"), 0);
    vp8.set(ascii("WEBP"), 8);
    vp8.set(ascii("VP8 "), 12);
    new DataView(vp8.buffer).setUint16(26, 320, true);
    new DataView(vp8.buffer).setUint16(28, 180, true);
    expect(imageDimensions(vp8)).toEqual({ width: 320, height: 180 });

    // VP8L (lossless): packed 28-bit field at chunk+9.
    const vp8l = new Uint8Array(32);
    vp8l.set(ascii("RIFF"), 0);
    vp8l.set(ascii("WEBP"), 8);
    vp8l.set(ascii("VP8L"), 12);
    const packed = (319 | ((179 & 0x3fff) << 14)) >>> 0;
    new DataView(vp8l.buffer).setUint32(21, packed, true);
    expect(imageDimensions(vp8l)).toEqual({ width: 320, height: 180 });

    // VP8X (extended): 24-bit width-1/height-1 at chunk+12/+15.
    const vp8x = new Uint8Array(32);
    vp8x.set(ascii("RIFF"), 0);
    vp8x.set(ascii("WEBP"), 8);
    vp8x.set(ascii("VP8X"), 12);
    vp8x.set([319 & 0xff, (319 >> 8) & 0xff, 0], 24);
    vp8x.set([179 & 0xff, (179 >> 8) & 0xff, 0], 27);
    expect(imageDimensions(vp8x)).toEqual({ width: 320, height: 180 });
  });

  it("reads BMP dimensions from the DIB header", () => {
    const bytes = new Uint8Array(64);
    bytes.set(ascii("BM"), 0);
    new DataView(bytes.buffer).setUint32(14, 40, true); // DIB header size
    new DataView(bytes.buffer).setInt32(18, 320, true);
    new DataView(bytes.buffer).setInt32(22, 240, true);
    expect(imageDimensions(bytes)).toEqual({ width: 320, height: 240 });

    // Top-down BMPs store a negative height; the pixel size is the same.
    new DataView(bytes.buffer).setInt32(22, -240, true);
    expect(imageDimensions(bytes)).toEqual({ width: 320, height: 240 });
  });

  it("reads AVIF dimensions from the ispe box", () => {
    const ispePayload = new Uint8Array(12);
    new DataView(ispePayload.buffer).setUint32(4, 320);
    new DataView(ispePayload.buffer).setUint32(8, 240);
    const ipco = box("ipco", box("ispe", ispePayload));
    const iprp = box("iprp", ipco);
    // meta is a FullBox: version/flags word before its child boxes.
    const meta = box("meta", concat(new Uint8Array(4), iprp));
    const ftyp = box("ftyp", concat(ascii("avif"), new Uint8Array(4), ascii("mif1")));
    expect(imageDimensions(concat(ftyp, meta, new Uint8Array(32)))).toEqual({ width: 320, height: 240 });
  });

  it("returns null for truncated or implausible headers", () => {
    expect(imageDimensions(new Uint8Array(4))).toBeNull();
    const badBmp = new Uint8Array(64);
    badBmp.set(ascii("BM"), 0);
    expect(imageDimensions(badBmp)).toBeNull(); // zero width/height
  });
});

describe("webmDurationFromBytes()", () => {
  // EBML: TimecodeScale (0x2AD7B1, uinteger) + Duration (0x4489, float in
  // timecode ticks). Data lengths use real vint encoding (0x84 = 4 bytes,
  // 0x88 = 8 bytes), as muxers write them.
  function webmBytes(timecodeScale: number, ticks: number, float64: boolean): Uint8Array {
    const head = concat(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), ascii("webm"), new Uint8Array(8));
    const scaleBytes = new Uint8Array(4 + 4);
    scaleBytes.set([0x2a, 0xd7, 0xb1, 0x84], 0);
    new DataView(scaleBytes.buffer).setUint32(4, timecodeScale);
    const durationBytes = new Uint8Array(3 + (float64 ? 8 : 4));
    durationBytes.set([0x44, 0x89, float64 ? 0x88 : 0x84], 0);
    if (float64) new DataView(durationBytes.buffer).setFloat64(3, ticks);
    else new DataView(durationBytes.buffer).setFloat32(3, ticks);
    return concat(head, scaleBytes, durationBytes, new Uint8Array(32));
  }

  it("scales the EBML Duration by TimecodeScale", () => {
    // 12500 ticks at 1ms per tick = 12.5s.
    expect(webmDurationFromBytes(webmBytes(1_000_000, 12500, false))).toBeCloseTo(12.5, 3);
    expect(webmDurationFromBytes(webmBytes(1_000_000, 12500, true))).toBeCloseTo(12.5, 6);
    // 250 ticks at 50ms per tick = 12.5s.
    expect(webmDurationFromBytes(webmBytes(50_000_000, 250, true))).toBeCloseTo(12.5, 6);
  });

  it("returns null when the sample carries no Duration element", () => {
    const head = concat(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), ascii("webm"), new Uint8Array(64));
    expect(webmDurationFromBytes(head)).toBeNull();
    expect(webmDurationFromBytes(new Uint8Array(8))).toBeNull();
  });

  it("is reached through durationFromSample for WebM/Matroska", () => {
    const bytes = webmBytes(1_000_000, 7250, true);
    expect(durationFromSample(bytes)).toBeCloseTo(7.25, 6);
    // ISO-BMFF still resolves through the mvhd path, not the EBML scan.
    expect(mp4DurationFromBytes(bytes)).toBeNull();
  });
});

describe("path-level honesty for non-MP4 media", () => {
  const PAGE_URL = "https://example.com/post";
  const MEDIA_URL = "https://cdn.example.com/media";

  function stubPageAndMedia(media: Uint8Array, contentType: string, pageDuration: number | null): void {
    const page = `<!doctype html><html><head><title>Post</title>
<meta property="og:video" content="${MEDIA_URL}">
${pageDuration === null ? "" : `<meta name="video:duration" content="${pageDuration}">`}
</head><body></body></html>`;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: { method?: string }) => {
        const url = String(input);
        const method = String(init?.method ?? "GET").toUpperCase();
        if (url === PAGE_URL) {
          if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
          return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
        }
        if (url === MEDIA_URL) {
          if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-type": contentType, "content-length": String(media.byteLength) } });
          const body = new Uint8Array(media);
          return new Response(body as unknown as BodyInit, { status: 200, headers: { "content-type": contentType, "content-length": String(body.byteLength) } });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  }

  function createBucket() {
    const objects = new Map<string, { bytes: Uint8Array; httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> }>();
    return {
      objects,
      async put(key: string, value: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array> | string, options?: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> }) {
        let bytes: Uint8Array;
        if (typeof value === "string") bytes = new TextEncoder().encode(value);
        else if (value instanceof Uint8Array) bytes = value;
        else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
        else {
          const reader = (value as ReadableStream<Uint8Array>).getReader();
          const chunks: Uint8Array[] = [];
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            chunks.push(next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value));
          }
          const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
          bytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
        }
        objects.set(key, { bytes, httpMetadata: options?.httpMetadata, customMetadata: options?.customMetadata });
      },
      async head(key: string) {
        const object = objects.get(key);
        return object ? { size: object.bytes.byteLength, httpMetadata: object.httpMetadata, customMetadata: object.customMetadata } : null;
      },
      async get(key: string) {
        const object = objects.get(key);
        if (!object) return null;
        return {
          body: null,
          size: object.bytes.byteLength,
          httpMetadata: object.httpMetadata,
          customMetadata: object.customMetadata,
          async arrayBuffer() {
            return object.bytes.buffer.slice(object.bytes.byteOffset, object.bytes.byteOffset + object.bytes.byteLength);
          },
        };
      },
      async delete(key: string) {
        objects.delete(key);
      },
    };
  }

  it("resolve() reports a GIF behind an og:video tag as an unverified image candidate", async () => {
    const gif = concat(ascii("GIF89a"), new Uint8Array([0x40, 0x01, 0xf0, 0x00, 0x00, 0x00, 0x00]), new Uint8Array(128));
    stubPageAndMedia(gif, "video/mp4", null); // CDN lies about the type
    const resolution = await resolvePublicVideo(PAGE_URL, { SSRF_DNS_CHECK: "false" } as never, { verifyBytes: true });
    expect(resolution.success).toBe(false);
    expect(resolution.mediaUrl).toBeNull();
    const candidate = resolution.detail.streams[0];
    expect(candidate.verifiedContainer).toBe("gif image");
    expect(candidate.verifiedVideo).toBe(false);
    expect(candidate.reason).toMatch(/not a decodable video stream/);
  });

  it("fetch() rejects a WebP served as video/mp4 with NOT_A_VIDEO and stores nothing", async () => {
    const webp = riff("WEBP", concat(ascii("VP8 "), new Uint8Array(256)));
    stubPageAndMedia(webp, "video/mp4", null);
    const bucket = createBucket();
    const env = { SSRF_DNS_CHECK: "false", SCREENSHOTS: bucket } as never;
    // Accept the declared content type at resolve time so the streaming
    // download path — not the probe — is what catches the lying bytes.
    const resolution = await resolvePublicVideo(PAGE_URL, env, { verifyBytes: false });
    expect(resolution.success).toBe(true);
    expect(resolution.mediaUrl).toBe(MEDIA_URL);
    const processor = new VideoProcessor(env, "https://demo.test/mcp");
    const fetched = await processor.fetchVideo({ url: PAGE_URL }, { resolution });
    expect(fetched.success).toBe(false);
    expect(fetched.error).toBe("NOT_A_VIDEO");
    expect(fetched.message).toMatch(/WEBP image/);
    expect(fetched.artifact).toBeNull();
    expect(bucket.objects.size).toBe(0);
  });

  it("download() accepts AVI/FLV only with a page-declared duration, and refuses them without one", async () => {
    const avi = riff("AVI ", concat(ascii("LIST"), new Uint8Array(512)));
    const flv = concat(ascii("FLV"), new Uint8Array([0x01, 0x05, 0x00, 0x00, 0x00, 0x09]), new Uint8Array(512));

    // With page metadata the duration policy is satisfiable: signature (video)
    // + declared duration is an honest, stored download.
    stubPageAndMedia(avi, "video/x-msvideo", 20);
    const bucket = createBucket();
    const processor = new VideoProcessor({ SSRF_DNS_CHECK: "false", SCREENSHOTS: bucket } as never, "https://demo.test/mcp");
    const downloaded = await processor.download(PAGE_URL);
    expect(downloaded.error ?? null).toBeNull();
    expect(downloaded.artifact?.bytes).toBe(avi.byteLength);
    expect(downloaded.artifact?.durationSeconds).toBe(20);

    // Without any duration signal the policy cannot be verified: refuse and
    // delete the partial object rather than persisting an unbounded file.
    stubPageAndMedia(flv, "video/x-flv", null);
    const bucket2 = createBucket();
    const processor2 = new VideoProcessor({ SSRF_DNS_CHECK: "false", SCREENSHOTS: bucket2 } as never, "https://demo.test/mcp");
    const refused = await processor2.download(PAGE_URL);
    expect(refused.artifact).toBeNull();
    expect(refused.error).toBe("UNSUPPORTED_MEDIA");
    expect(refused.message).toMatch(/no duration could be read/i);
    expect(bucket2.objects.size).toBe(0);
  });

  it("fetch() verifies a WebM duration from the EBML header when the page declares none", async () => {
    const head = concat(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), ascii("webm"), new Uint8Array(8));
    const scale = new Uint8Array(8);
    scale.set([0x2a, 0xd7, 0xb1, 0x84], 0);
    new DataView(scale.buffer).setUint32(4, 1_000_000);
    const duration = new Uint8Array(11);
    duration.set([0x44, 0x89, 0x88], 0);
    new DataView(duration.buffer).setFloat64(3, 9500);
    const webm = concat(head, scale, duration, new Uint8Array(512));
    stubPageAndMedia(webm, "video/webm", null);
    const bucket = createBucket();
    const processor = new VideoProcessor({ SSRF_DNS_CHECK: "false", SCREENSHOTS: bucket } as never, "https://demo.test/mcp");
    const fetched = await processor.fetchVideo({ url: PAGE_URL });
    expect(fetched.error ?? null).toBeNull();
    expect(fetched.success).toBe(true);
    expect(fetched.durationSeconds).toBeCloseTo(9.5, 3);
    expect(fetched.durationSource).toBe("head_sample");
    expect(fetched.detectedContainer).toBe("webm");
  });
});
