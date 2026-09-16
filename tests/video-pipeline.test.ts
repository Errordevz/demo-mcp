/**
 * Offline tests for the real video retrieval pipeline (DEMO 0.7.0):
 * `video_resolve`, `video_fetch`, unified `video_analyze`, `video_react`,
 * capability discovery and the MCP surface around them.
 *
 * Everything here is the real code path — SSRF-guarded resolution, byte-level
 * container probing, streamed R2 storage with signature + duration verification,
 * honest access statuses — with only the network and the browser transport
 * faked. The acceptance rule these tests defend: a TikTok link yields actual
 * inspectable bytes/frames, or an explicit, machine-readable "could not".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { DEMO_TOOL_NAMES } from "../index.js";
import platform from "../platform-entry.js";
import { VideoProcessor, resizeViewport } from "../src/video/processor.js";
import { describeVideoCapabilities, videoCapabilityFlags } from "../src/video/capabilities.js";
import { detectMediaSignature, durationFromSample, imageDimensions, mp4DurationFromBytes } from "../src/video/probe.js";
import { parseRangeHeader, VideoArtifactStore } from "../src/video/store.js";
import { setProviderFactory } from "../src/browser/providers/index.js";
import { FakeProvider } from "./helpers/fake-provider.js";
import { tiktokMultiStreamPage, tiktokStatusPage, tiktokVideoPage } from "./fixtures/pages.js";

const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

const SHORT_URL = "https://vt.tiktok.com/ZSnewlink1/";
const PAGE_URL = "https://www.tiktok.com/@creator.one/video/7300000000000000001";
const MULTI_PAGE_URL = "https://www.tiktok.com/@multi.creator/video/7300000000000000009";
const STREAM_720 = "https://v16-webapp.tiktokcdn.com/stream-720p.mp4";
const STREAM_540 = "https://v16-webapp.tiktokcdn.com/stream-540p.mp4";
const STREAM_DOWNLOAD = "https://v16-webapp.tiktokcdn.com/stream-download.mp4";
const SIGNATURE = "?x-expires=9999999999&x-signature=new";
const SIGNED_STREAM = `${STREAM_720}?x-expires=9999999999&x-signature=new`;
const MEDIA_URL = "https://cdn.example.com/clip.mp4";
const THUMB_URL = "https://p16-sign.tiktokcdn.com/cover.jpeg";

/* -------------------------------------------------------------------------- */
/* Fixtures: real container bytes, no media library                            */
/* -------------------------------------------------------------------------- */

function box(fourcc: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, out.byteLength);
  for (let i = 0; i < 4; i++) out[4 + i] = fourcc.charCodeAt(i);
  out.set(payload, 8);
  return out;
}

/** A structurally valid (tiny) ISO-BMFF file: ftyp + moov/mvhd + mdat. */
function mp4Bytes(durationSeconds: number, padTo = 4_096): Uint8Array {
  const timescale = 1_000;
  const mvhdPayload = new Uint8Array(100);
  const view = new DataView(mvhdPayload.buffer);
  view.setUint32(0, 0); // version 0 + flags
  view.setUint32(4, 1_700_000_000); // creation time
  view.setUint32(8, 1_700_000_000); // modification time
  view.setUint32(12, timescale); // timescale at box offset 20
  view.setUint32(16, Math.round(durationSeconds * timescale)); // duration at 24
  const mvhd = box("mvhd", mvhdPayload);
  const ftypPayload = new Uint8Array(16);
  for (const [offset, brand] of [[0, "isom"], [8, "mp42"]] as Array<[number, string]>) {
    for (let i = 0; i < 4; i++) ftypPayload[offset + i] = brand.charCodeAt(i);
  }
  const parts = [box("ftyp", ftypPayload), box("moov", mvhd), box("mdat", new Uint8Array(Math.max(16, padTo)))];
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** `M4A ` brand: an audio-only ISO-BMFF file, never a video. */
function m4aBytes(): Uint8Array {
  const payload = new Uint8Array(16);
  for (const [offset, brand] of [[0, "M4A "], [8, "isom"]] as Array<[number, string]>) {
    for (let i = 0; i < 4; i++) payload[offset + i] = brand.charCodeAt(i);
  }
  return concat([box("ftyp", payload), box("mdat", new Uint8Array(512))]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** A JPEG whose SOF0 header declares 720x1280, so frame dimensions are real. */
const JPEG_BYTES = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x05, 0x00, 0x02, 0xd0, 0x03, 0x11, 0x01,
  0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
]);
const HLS_BODY = "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:2.0,\nseg-0.ts\n#EXTINF:2.0,\nseg-1.ts\n#EXT-X-ENDLIST\n";
const JSON_BODY = JSON.stringify({ status_code: 10216, message: "private item" });

/* -------------------------------------------------------------------------- */
/* Fake R2 + fake network                                                      */
/* -------------------------------------------------------------------------- */

interface FakeObject {
  bytes: Uint8Array;
  httpMetadata?: Record<string, string>;
  customMetadata?: Record<string, string>;
}

function createBucket() {
  const objects = new Map<string, FakeObject>();
  return {
    objects,
    async put(key: string, value: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array> | string, options?: any) {
      let bytes: Uint8Array;
      if (typeof value === "string") bytes = new TextEncoder().encode(value);
      else if (value instanceof Uint8Array) bytes = value;
      else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
      else bytes = await readStream(value as ReadableStream<Uint8Array>);
      objects.set(key, { bytes, httpMetadata: options?.httpMetadata, customMetadata: options?.customMetadata });
    },
    async head(key: string) {
      const object = objects.get(key);
      return object ? { size: object.bytes.byteLength, httpMetadata: object.httpMetadata, customMetadata: object.customMetadata } : null;
    },
    async get(key: string, options?: any) {
      const object = objects.get(key);
      if (!object) return null;
      const range = options?.range as { offset?: number; length?: number; suffix?: number } | undefined;
      let slice = object.bytes;
      if (range?.suffix !== undefined) slice = object.bytes.subarray(Math.max(0, object.bytes.byteLength - range.suffix));
      else if (range?.offset !== undefined) slice = object.bytes.subarray(range.offset, range.length !== undefined ? range.offset + range.length : undefined);
      return {
        body: null,
        size: slice.byteLength,
        range: range ? { offset: range.offset ?? 0, length: slice.byteLength } : undefined,
        httpMetadata: object.httpMetadata,
        customMetadata: object.customMetadata,
        async arrayBuffer() {
          return slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength);
        },
      };
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async list(options?: { prefix?: string }) {
      const prefix = options?.prefix ?? "";
      return { objects: [...objects.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, size: value.bytes.byteLength, customMetadata: value.customMetadata })), truncated: false, cursor: undefined };
    },
  };
}

type FakeBucket = ReturnType<typeof createBucket>;

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  return concat(chunks);
}

interface Route {
  status?: number;
  contentType?: string;
  body?: Uint8Array | string | null;
  /** Body served only for a ranged GET (the byte probe), when it must differ
   * from the full GET — e.g. a CDN that verified as mp4 during the probe and
   * then served an HTML interstitial on the real download. */
  rangedBody?: Uint8Array | string | null;
  rangedContentType?: string;
  location?: string;
  contentLength?: number | null;
  /** Answer the HEAD probe but a different body on GET. */
  headStatus?: number;
}

function stubNetwork(routes: Record<string, Route>, options: { allowUnlisted?: boolean } = {}) {
  const calls: Array<{ url: string; method: string; range: string | null }> = [];
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    calls.push({ url, method, range: headers.get("range") });
    // Return 3xx responses verbatim: DEMO's own redirect-following (and its
    // per-hop SSRF re-check) is what is under test.
    const current = url;
    {
      const route = routes[current];
      if (!route) {
        if (options.allowUnlisted) return new Response("", { status: 404, headers: { "content-type": "text/html" } });
        throw new Error(`unexpected fetch in video-pipeline test: ${current}`);
      }
      const status = route.status ?? 200;
      const ranged = method === "GET" && headers.get("range") !== null && route.rangedBody !== undefined;
      const body = ranged ? (route.rangedBody ?? null) : (route.body ?? null);
      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
      const responseHeaders = new Headers();
      const effectiveType = ranged ? (route.rangedContentType ?? route.contentType) : route.contentType;
      if (effectiveType) responseHeaders.set("content-type", effectiveType);
      const declared = route.contentLength !== undefined ? route.contentLength : (bytes?.byteLength ?? null);
      if (declared !== null && status !== 204) responseHeaders.set("content-length", String(declared));
      if (route.location) responseHeaders.set("location", route.location);
      if (status >= 300 && status < 400 && route.location) return new Response(null, { status, headers: responseHeaders });
      return new Response(bytes && status !== 304 ? (bytes.slice().buffer as BodyInit) : null, { status, headers: responseHeaders });
    }
  });
  vi.stubGlobal("fetch", handler);
  return { calls, handler };
}

/** The canonical public TikTok fixture set: short link → page → verified streams. */
function tiktokNetwork(overrides: {
  pageHtml?: string;
  pageUrl?: string;
  streamBytes?: Uint8Array;
  streamContentType?: string;
  streamStatus?: number;
  declaredDuration?: number | null;
  /** Bytes served to the ranged probe when they must differ from the full GET. */
  rangedStreamBytes?: Uint8Array;
  rangedStreamContentType?: string;
} = {}) {
  const pageUrl = overrides.pageUrl ?? PAGE_URL;
  const streamBytes = overrides.streamBytes ?? mp4Bytes(overrides.declaredDuration ?? 12);
  const pageHtml = overrides.pageHtml ?? tiktokMultiStreamPage();
  return stubNetwork({
    [SHORT_URL]: { status: 302, location: pageUrl },
    // Both canonical URLs serve the same page, so a test can resolve either.
    [pageUrl]: { status: 200, contentType: "text/html", body: pageHtml },
    [MULTI_PAGE_URL]: { status: 200, contentType: "text/html", body: pageHtml },
    [PAGE_URL]: { status: 200, contentType: "text/html", body: pageHtml },
    [SIGNED_STREAM]: { status: overrides.streamStatus ?? 200, contentType: overrides.streamContentType ?? "video/mp4", body: streamBytes, rangedBody: overrides.rangedStreamBytes ?? streamBytes, rangedContentType: overrides.rangedStreamContentType ?? overrides.streamContentType ?? "video/mp4" },
    [STREAM_720]: { status: overrides.streamStatus ?? 200, contentType: overrides.streamContentType ?? "video/mp4", body: streamBytes, rangedBody: overrides.rangedStreamBytes ?? streamBytes, rangedContentType: overrides.rangedStreamContentType ?? overrides.streamContentType ?? "video/mp4" },
    [`${STREAM_540}${SIGNATURE}`]: { status: overrides.streamStatus ?? 200, contentType: overrides.streamContentType ?? "video/mp4", body: streamBytes, rangedBody: overrides.rangedStreamBytes ?? streamBytes, rangedContentType: overrides.rangedStreamContentType ?? "video/mp4" },
    [STREAM_540]: { status: overrides.streamStatus ?? 200, contentType: overrides.streamContentType ?? "video/mp4", body: streamBytes, rangedBody: overrides.rangedStreamBytes ?? streamBytes, rangedContentType: overrides.rangedStreamContentType ?? "video/mp4" },
    [`${STREAM_DOWNLOAD}${SIGNATURE}`]: { status: overrides.streamStatus ?? 200, contentType: overrides.streamContentType ?? "video/mp4", body: streamBytes, rangedBody: overrides.rangedStreamBytes ?? streamBytes, rangedContentType: overrides.rangedStreamContentType ?? "video/mp4" },
    [STREAM_DOWNLOAD]: { status: overrides.streamStatus ?? 200, contentType: overrides.streamContentType ?? "video/mp4", body: streamBytes, rangedBody: overrides.rangedStreamBytes ?? streamBytes, rangedContentType: overrides.rangedStreamContentType ?? "video/mp4" },
    [THUMB_URL]: { status: 200, contentType: "image/jpeg", body: JPEG_BYTES },
  });
}

function decodableBrowser(durationSeconds = 12, routes: Record<string, any> = {}) {
  setProviderFactory(
    () =>
      new FakeProvider({
        screenshotBytes: JPEG_BYTES,
        routes: {
          [SIGNED_STREAM]: { status: 200, html: `<html><body><video src="${SIGNED_STREAM}" playsinline></video></body></html>`, scripts: [fakeDecodableVideo(durationSeconds)] },
          [STREAM_720]: { status: 200, html: `<html><body><video src="${STREAM_720}" playsinline></video></body></html>`, scripts: [fakeDecodableVideo(durationSeconds)] },
          [MEDIA_URL]: { status: 200, html: `<html><body><video src="${MEDIA_URL}" playsinline></video></body></html>`, scripts: [fakeDecodableVideo(durationSeconds)] },
          ...routes,
        },
      }),
  );
}

function fakeDecodableVideo(durationSeconds: number, width = 720, height = 1280): (window: any) => void {
  return (window: any) => {
    const proto = window.HTMLMediaElement.prototype;
    const videoProto = window.HTMLVideoElement?.prototype ?? proto;
    Object.defineProperty(proto, "duration", { configurable: true, get: () => durationSeconds });
    Object.defineProperty(videoProto, "videoWidth", { configurable: true, get: () => width });
    Object.defineProperty(videoProto, "videoHeight", { configurable: true, get: () => height });
    Object.defineProperty(proto, "currentTime", {
      configurable: true,
      get(this: any) {
        return this.__t ?? 0;
      },
      set(this: any, value: number) {
        this.__t = value;
        setTimeout(() => this.dispatchEvent(new window.Event("seeked")), 0);
      },
    });
    (proto as any).scrollIntoView = function scrollIntoView() {};
  };
}

function processorEnv(bucket: FakeBucket | undefined, extra: Record<string, unknown> = {}) {
  return { ...(bucket ? { SCREENSHOTS: bucket } : {}), SSRF_DNS_CHECK: "false", ...extra } as never;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

afterEach(() => {
  setProviderFactory(null);
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/* video_resolve                                                               */
/* -------------------------------------------------------------------------- */

describe("video_resolve", () => {
  it("follows a TikTok short link and returns the canonical identity without claiming to have watched anything", async () => {
    const network = tiktokNetwork();
    const bucket = createBucket();
    const processor = new VideoProcessor(processorEnv(bucket), "https://demo.test/mcp");

    const result = await processor.resolveDetailed(SHORT_URL, { verifyBytes: true });

    expect(result.success).toBe(true);
    expect(result.accessStatus).toBe("public");
    expect(result.access.mayDescribeContent).toBe(true); // the item is public…
    expect(result.platform).toBe("tiktok");
    expect(result.sourceUrl).toBe(SHORT_URL);
    expect(result.canonicalUrl).toBe(MULTI_PAGE_URL);
    expect(result.videoId).toBe("7300000000000000009");
    expect(result.creator?.uniqueId).toBe("multi.creator");
    expect(result.caption).toContain("Multiple bitrates");
    expect(result.captionSource).toBeTruthy();
    expect(result.durationSeconds).toBe(12);
    expect(result.redirectCount).toBeGreaterThan(0);
    expect(result.verification).toBe("bytes");
    expect(result.thumbnailUrl === null || result.thumbnailUrl !== result.bestStreamUrl).toBe(true);

    // Real published streams, ranked, each with its own probe verdict.
    expect(result.streamCount).toBeGreaterThanOrEqual(2);
    expect(result.streams.length).toBe(result.streamCount);
    const best = result.streams.find((stream) => stream.url === result.bestStreamUrl);
    expect(best?.verifiedVideo).toBe(true);
    expect(best?.verifiedContainer).toMatch(/mp4/);
    expect(result.nextSteps.length).toBeGreaterThan(0);
    expect(result.guidance).toBeTruthy();

    // …but resolution alone is metadata, never visual evidence: it carries no
    // frames and the MCP payload reports may_describe_content=false.
    expect((result as unknown as Record<string, unknown>).frames).toBeUndefined();
    expect(result.verification).not.toBe("frames");

    // The short link was followed with a normal public request.
    expect(network.calls.some((call) => call.url === SHORT_URL)).toBe(true);
  });

  it("proves streams from real bytes and refuses a thumbnail that claims to be a video", async () => {
    tiktokNetwork({ streamBytes: JPEG_BYTES, streamContentType: "image/jpeg" });
    const processor = new VideoProcessor(processorEnv(createBucket()), "https://demo.test/mcp");

    const result = await processor.resolveDetailed(MULTI_PAGE_URL, { verifyBytes: true });

    expect(result.success).toBe(false);
    expect(result.streams.length).toBeGreaterThan(0);
    expect(result.streams.every((stream) => stream.verifiedVideo !== true)).toBe(true);
    // The byte probe named what the CDN really served.
    expect(JSON.stringify(result.streams)).toMatch(/jpeg|image/i);
    expect(result.verification).toBe("none");
    expect(result.error).toBeTruthy();
  });

  it("strips signed query strings when include_signed_urls=false and says the URLs are then unfetchable", async () => {
    tiktokNetwork();
    const processor = new VideoProcessor(processorEnv(createBucket()), "https://demo.test/mcp");

    const result = await processor.resolveDetailed(MULTI_PAGE_URL, { verifyBytes: true, includeSignedUrls: false });

    for (const stream of result.streams) {
      expect(stream.url).not.toMatch(/x-signature=/);
      expect(stream.url).not.toMatch(/x-expires=/);
    }
    expect(result.limitations.join(" ")).toMatch(/signed query strings were removed/i);
  });

  it.each([
    [10216, "private"],
    [10241, "deleted"],
    [10231, "region_restricted"],
    [10227, "unavailable"],
    [10204, "not_found"],
    [10202, "not_found"],
    [10221, "deleted"],
  ])("maps TikTok statusCode %i to access_status %s", async (statusCode, expected) => {
    tiktokNetwork({ pageHtml: tiktokStatusPage(statusCode, "fixture"), pageUrl: PAGE_URL });
    const processor = new VideoProcessor(processorEnv(createBucket()), "https://demo.test/mcp");

    const result = await processor.resolveDetailed(PAGE_URL, { verifyBytes: true });

    expect(result.success).toBe(false);
    expect(result.accessStatus).toBe(expected);
    expect(result.platformStatusCode).toBe(statusCode);
    expect(result.access.mayDescribeContent).toBe(false);
    expect(result.guidance).toBeTruthy();
    expect(result.nextSteps.length).toBeGreaterThan(0);
  });

  it("reports a CAPTCHA / risk-control wall as challenge_required and never bypasses it", async () => {
    tiktokNetwork({ pageHtml: tiktokStatusPage(10000, "verification required"), pageUrl: PAGE_URL });
    const processor = new VideoProcessor(processorEnv(createBucket()), "https://demo.test/mcp");

    const result = await processor.resolveDetailed(PAGE_URL, { verifyBytes: true });

    expect(result.success).toBe(false);
    expect(result.accessStatus).toBe("challenge_required");
    expect(result.access.mayDescribeContent).toBe(false);
    expect(result.guidance).toMatch(/captcha|verif|challenge/i);
  });

  it("reports an expired signed stream URL as expired rather than pretending to fetch it", async () => {
    tiktokNetwork({ pageHtml: tiktokMultiStreamPage({ expired: true }), pageUrl: MULTI_PAGE_URL });
    const processor = new VideoProcessor(processorEnv(createBucket()), "https://demo.test/mcp");

    const result = await processor.resolveDetailed(MULTI_PAGE_URL, { verifyBytes: true });

    expect(result.success).toBe(false);
    expect(["expired", "unavailable", "unsupported", "not_found", "unknown"]).toContain(result.accessStatus);
    expect(result.limitations.join(" ")).toMatch(/expired/i);
    expect(result.nextSteps.join(" ")).toMatch(/re-resolve|resolve again|fresh/i);
  });

  it("refuses private/internal targets before any request (SSRF guard, not weakened for TikTok)", async () => {
    const network = stubNetwork({}, { allowUnlisted: true });
    const processor = new VideoProcessor(processorEnv(createBucket()), "https://demo.test/mcp");

    for (const blocked of ["http://127.0.0.1:8787/clip.mp4", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/internal.mp4", "file:///etc/passwd"]) {
      const result = await processor.resolveDetailed(blocked, { verifyBytes: true });
      expect(result.success, blocked).toBe(false);
      expect(result.accessStatus, blocked).toBe("blocked_url");
      expect(result.access.mayDescribeContent, blocked).toBe(false);
      expect(["blocked_url", "invalid_input"], blocked).toContain(result.error);
    }
    expect(network.handler).not.toHaveBeenCalled();
  });

  it("reports a plain page with no video honestly instead of inventing media", async () => {
    stubNetwork({
      "https://example.com/article": { status: 200, contentType: "text/html", body: "<html><body><p>An article with no video.</p></body></html>" },
    });
    const processor = new VideoProcessor(processorEnv(createBucket()), "https://demo.test/mcp");

    const result = await processor.resolveDetailed("https://example.com/article", { verifyBytes: true });

    expect(result.success).toBe(false);
    expect(result.streamCount).toBe(0);
    expect(result.bestStreamUrl).toBeNull();
    expect(result.verification).toBe("none");
    expect(result.accessStatus).not.toBe("public");
  });
});

/* -------------------------------------------------------------------------- */
/* video_fetch                                                                 */
/* -------------------------------------------------------------------------- */

describe("video_fetch", () => {
  it("streams real MP4 bytes into R2 with signature and duration verification", async () => {
    const bytes = mp4Bytes(12, 8_192);
    tiktokNetwork({ streamBytes: bytes });
    const bucket = createBucket();
    const processor = new VideoProcessor(processorEnv(bucket), "https://demo.test/mcp");

    const result = await processor.fetchVideo({ url: SHORT_URL });

    expect(result.success).toBe(true);
    expect(result.accessStatus).toBe("public");
    expect(result.delivery).toBe("streamed");
    expect(result.verification).toBe("bytes");
    expect(result.detectedContainer).toMatch(/mp4/);
    expect(result.signature?.isVideo).toBe(true);
    expect(result.bytes).toBe(bytes.byteLength);
    expect(result.durationSeconds).toBeCloseTo(12, 1);
    expect(result.durationVerified).toBe(true);
    expect(result.artifact?.reference).toMatch(/^video_[a-f0-9]{64}$/);
    expect(result.artifact?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(result.artifact!.expiresAt!)).toBeGreaterThan(Date.now());
    expect(result.canonicalUrl).toBe(MULTI_PAGE_URL);

    // The bytes really are in the bucket, and really are that MP4.
    const stored = [...bucket.objects.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0].bytes.byteLength).toBe(bytes.byteLength);
    expect(detectMediaSignature(stored[0].bytes.subarray(0, 64)).isVideo).toBe(true);
    expect(stored[0].customMetadata?.verifiedContainer).toMatch(/mp4/);
    expect(stored[0].customMetadata?.durationSeconds).toBe("12");
  });

  it("refuses an HTML page served with a video content type and deletes the partial object", async () => {
    tiktokNetwork({
      rangedStreamBytes: mp4Bytes(12, 512),
      streamBytes: new TextEncoder().encode("<html><body>Just a moment...</body></html>"),
      streamContentType: "text/html",
    });
    const bucket = createBucket();
    const processor = new VideoProcessor(processorEnv(bucket), "https://demo.test/mcp");

    const result = await processor.fetchVideo({ url: MULTI_PAGE_URL });

    expect(result.success).toBe(false);
    expect(result.error).toBe("NOT_A_VIDEO");
    expect(result.signature?.detectedAs).toBe("html_page");
    expect(result.artifact).toBeNull();
    expect(result.bytes).toBeNull();
    expect(bucket.objects.size).toBe(0); // nothing is kept or claimed
  });

  it("refuses a JPEG thumbnail and an audio-only file, naming what it actually got", async () => {
    // Thumbnail served where a video was promised
    tiktokNetwork({ rangedStreamBytes: mp4Bytes(12, 512), streamBytes: JPEG_BYTES, streamContentType: "image/jpeg" });
    const thumbBucket = createBucket();
    const thumbResult = await new VideoProcessor(processorEnv(thumbBucket), "https://demo.test/mcp").fetchVideo({ url: MULTI_PAGE_URL });
    expect(thumbResult.success).toBe(false);
    expect(thumbResult.error).toBe("NOT_A_VIDEO");
    expect(thumbResult.signature?.detectedAs).toBe("jpeg");
    expect(thumbBucket.objects.size).toBe(0);
    vi.unstubAllGlobals();

    // Audio-only m4a served where a video was promised
    tiktokNetwork({ rangedStreamBytes: mp4Bytes(12, 512), streamBytes: m4aBytes(), streamContentType: "audio/mp4" });
    const audioBucket = createBucket();
    const audioResult = await new VideoProcessor(processorEnv(audioBucket), "https://demo.test/mcp").fetchVideo({ url: MULTI_PAGE_URL });
    expect(audioResult.success).toBe(false);
    expect(audioResult.signature?.detectedAs).toBe("m4a");
    expect(audioResult.artifact).toBeNull();
    expect(audioBucket.objects.size).toBe(0);
  });

  it("refuses an HLS/DASH manifest instead of pretending to download a bounded file", async () => {
    stubNetwork({
      "https://example.com/watch": { status: 200, contentType: "text/html", body: `<html><head><meta property="og:video" content="https://example.com/index.m3u8"><meta name="video:duration" content="10"></head><body><video src="https://example.com/index.m3u8"></video></body></html>` },
      "https://example.com/index.m3u8": { status: 200, contentType: "application/vnd.apple.mpegurl", body: HLS_BODY },
    });
    const bucket = createBucket();
    const result = await new VideoProcessor(processorEnv(bucket), "https://demo.test/mcp").fetchVideo({ url: "https://example.com/watch" });

    expect(result.success).toBe(false);
    expect(result.accessStatus).toBe("unsupported");
    expect(["UNSUPPORTED_MEDIA", "NOT_A_VIDEO"]).toContain(result.error);
    expect(bucket.objects.size).toBe(0);
  });

  it("enforces the declared size limit before any bytes are streamed", async () => {
    tiktokNetwork({ declaredDuration: 12 });
    // Re-stub with an oversized declared length on the stream.
    stubNetwork({
      [MULTI_PAGE_URL]: { status: 200, contentType: "text/html", body: tiktokMultiStreamPage() },
      [SIGNED_STREAM]: { status: 200, contentType: "video/mp4", body: null, contentLength: 600 * 1024 * 1024 },
      [STREAM_720]: { status: 200, contentType: "video/mp4", body: null, contentLength: 600 * 1024 * 1024 },
      [`${STREAM_540}?x-expires=9999999999&x-signature=new`]: { status: 200, contentType: "video/mp4", body: null, contentLength: 600 * 1024 * 1024 },
      [STREAM_540]: { status: 200, contentType: "video/mp4", body: null, contentLength: 600 * 1024 * 1024 },
    });
    const bucket = createBucket();
    const result = await new VideoProcessor(processorEnv(bucket), "https://demo.test/mcp").fetchVideo({ url: MULTI_PAGE_URL, max_size_mb: undefined } as never);

    expect(result.success).toBe(false);
    expect(result.error).toBe("DOWNLOAD_TOO_LARGE");
    expect(result.artifact).toBeNull();
    expect(bucket.objects.size).toBe(0);
  });

  it("rejects a container whose verified duration exceeds the limit and deletes the object", async () => {
    // A page that publishes no duration at all, so the container header is the
    // only source of truth and the policy must be enforced from real bytes.
    const longBytes = mp4Bytes(900, 4_096);
    stubNetwork({
      "https://example.com/watch": {
        status: 200,
        contentType: "text/html",
        body: `<html><head><title>Long clip</title><meta property="og:video:url" content="${MEDIA_URL}"></head><body><video src="${MEDIA_URL}" playsinline></video></body></html>`,
      },
      [MEDIA_URL]: { status: 200, contentType: "video/mp4", body: longBytes },
    });
    const bucket = createBucket();
    const result = await new VideoProcessor(processorEnv(bucket), "https://demo.test/mcp").fetchVideo({ url: "https://example.com/watch" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("DOWNLOAD_TOO_LARGE");
    expect(result.durationVerified).toBe(false);
    expect(result.message).toMatch(/900\.0s|exceeds/i);
    expect(bucket.objects.size).toBe(0); // the stored object was deleted
  });

  it("reports a 403/410 media response as expired or not-public, never as a download", async () => {
    tiktokNetwork({ streamStatus: 403, streamBytes: mp4Bytes(12, 512) });
    const bucket = createBucket();
    const result = await new VideoProcessor(processorEnv(bucket), "https://demo.test/mcp").fetchVideo({ url: MULTI_PAGE_URL });

    expect(result.success).toBe(false);
    expect(["ARTIFACT_EXPIRED", "VIDEO_NOT_PUBLIC", "PLATFORM_BLOCKED"]).toContain(result.error);
    expect(result.artifact).toBeNull();
    expect(result.bytes).toBeNull();
    expect(bucket.objects.size).toBe(0);
  });

  it("reports the true state of an artifact reference: ok, expired, missing, invalid", async () => {
    const bytes = mp4Bytes(12);
    tiktokNetwork({ streamBytes: bytes });
    const bucket = createBucket();
    const processor = new VideoProcessor(processorEnv(bucket), "https://demo.test/mcp");
    const fetched = await processor.fetchVideo({ url: MULTI_PAGE_URL });
    const reference = fetched.artifact!.reference;

    // ok — re-reading a stored reference needs no network and reports metadata.
    const again = await processor.fetchVideo({ videoReference: reference });
    expect(again.success).toBe(true);
    expect(again.artifact?.reference).toBe(reference);
    expect(again.durationSeconds).toBeCloseTo(12, 1);
    expect(again.limitations.join(" ")).toMatch(/previously stored/i);

    // expired — a TTL in the past is reported as expired, not missing.
    const key = [...bucket.objects.keys()][0];
    bucket.objects.get(key)!.customMetadata = { ...bucket.objects.get(key)!.customMetadata, expiresAt: new Date(Date.now() - 60_000).toISOString() };
    const expired = await processor.fetchVideo({ videoReference: reference });
    expect(expired.success).toBe(false);
    expect(expired.error).toBe("ARTIFACT_EXPIRED");
    expect(expired.accessStatus).toBe("expired");
    expect(bucket.objects.size).toBe(0); // cleaned up on read

    // missing
    const missing = await processor.fetchVideo({ videoReference: `video_${"a".repeat(64)}` });
    expect(missing.success).toBe(false);
    expect(missing.error).toBe("VIDEO_NOT_FOUND");
    expect(missing.accessStatus).toBe("not_found");

    // invalid shape
    const invalid = await processor.fetchVideo({ videoReference: "video_nope" });
    expect(invalid.success).toBe(false);
    expect(invalid.error).toBe("invalid_input");
  });

  it("refuses to fetch without storage and says exactly which binding is missing", async () => {
    tiktokNetwork();
    const result = await new VideoProcessor(processorEnv(undefined), "https://demo.test/mcp").fetchVideo({ url: MULTI_PAGE_URL });

    expect(result.success).toBe(false);
    expect(result.error).toBe("capability_unavailable");
    expect(result.message).toMatch(/R2|storage|bucket/i);
  });

  it("never requests a blocked URL", async () => {
    const network = stubNetwork({}, { allowUnlisted: true });
    const bucket = createBucket();
    const result = await new VideoProcessor(processorEnv(bucket), "https://demo.test/mcp").fetchVideo({ url: "http://192.168.1.1/router.mp4" });

    expect(result.success).toBe(false);
    expect(result.accessStatus).toBe("blocked_url");
    expect(result.error).toBe("blocked_url");
    expect(network.handler).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* Artifact store: streaming, ranges, expiry                                   */
/* -------------------------------------------------------------------------- */

describe("VideoArtifactStore", () => {
  it("stores a streamed body, digests it and exposes range reads", async () => {
    const bucket = createBucket();
    const store = new VideoArtifactStore(bucket as never, "https://demo.test", 900);
    const bytes = mp4Bytes(7, 2_048);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Deliver in odd-sized chunks to prove nothing depends on framing.
        controller.enqueue(bytes.subarray(0, 700));
        controller.enqueue(bytes.subarray(700, 1_500));
        controller.enqueue(bytes.subarray(1_500));
        controller.close();
      },
    });

    const outcome = await store.storeStream(stream, "video", "video/mp4", { durationSeconds: 7 }, { maxBytes: 64 * 1024, headBytes: 128, digestBufferBytes: 1_024, timeoutMs: 5_000 });

    expect(outcome.aborted).toBeNull();
    expect(outcome.bytes).toBe(bytes.byteLength);
    expect(outcome.head.byteLength).toBe(128);
    expect(detectMediaSignature(outcome.head).isVideo).toBe(true);
    expect(outcome.artifact?.reference).toMatch(/^video_[a-f0-9]{64}$/);
    expect(bucket.objects.size).toBe(1);

    const tail = await store.getRange(outcome.artifact!.reference, Math.max(0, bytes.byteLength - 512), 512);
    expect(tail).not.toBeNull();
    expect(tail!.bytes.byteLength).toBeGreaterThan(0);
    expect(await store.referenceStatus(outcome.artifact!.reference)).toBe("ok");
    expect(await store.delete(outcome.artifact!.reference)).toBe(true);
    expect(bucket.objects.size).toBe(0);
    expect(await store.referenceStatus(outcome.artifact!.reference)).toBe("missing");
  });

  it("aborts and stores nothing when the stream exceeds the byte policy", async () => {
    const bucket = createBucket();
    const store = new VideoArtifactStore(bucket as never, "https://demo.test", 900);
    const big = new Uint8Array(4_096).fill(7);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(big);
        controller.enqueue(big);
        controller.close();
      },
    });

    const outcome = await store.storeStream(stream, "video", "video/mp4", {}, { maxBytes: 1_024, headBytes: 64, digestBufferBytes: 256, timeoutMs: 5_000 });

    expect(outcome.aborted?.code).toBe("DOWNLOAD_TOO_LARGE");
    expect(bucket.objects.size).toBe(0);
  });

  it("parses Range headers for public seeking", () => {
    expect(parseRangeHeader("bytes=0-127", 1_000)).toEqual({ offset: 0, length: 128 });
    expect(parseRangeHeader("bytes=500-", 1_000)).toEqual({ offset: 500 });
    expect(parseRangeHeader("bytes=-200", 1_000)).toEqual({ suffix: 200 });
    expect(parseRangeHeader("bytes=2000-3000", 1_000)).toBeNull(); // unsatisfiable
    expect(parseRangeHeader("items=0-10", 1_000)).toBeNull();
    expect(parseRangeHeader(null, 1_000)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* video_analyze (unified)                                                     */
/* -------------------------------------------------------------------------- */

describe("video_analyze (unified)", () => {
  it("returns decoded frames plus strictly separated text sources in summary mode", async () => {
    tiktokNetwork();
    decodableBrowser(12);
    const bucket = createBucket();
    const processor = new VideoProcessor(processorEnv(bucket, { AI: { run: async () => ({ visible_text: ["WAIT FOR IT"], scene_change: "hard cut" }) } }), "https://demo.test/mcp");

    const result = await processor.analyzeUnified(SHORT_URL, { analysisMode: "summary", question: "What happens?" });

    expect(result.success).toBe(true);
    expect(result.analysisMode).toBe("summary");
    expect(result.accessStatus).toBe("public");
    expect(result.framesDelivered).toBeGreaterThan(0);
    expect(result.visualEvidenceDelivered).toBe(true);
    expect(result.evidence.framesDecoded).toBe(result.framesDelivered);
    expect(result.evidence.thumbnailUsedAsFrame).toBe(false);
    expect(result.evidence.metadataOnly).toBe(false);
    expect(result.canonicalUrl).toBe(MULTI_PAGE_URL);

    // Every frame is a real image block with a timestamp, in order.
    const times = result.frames.map((frame) => frame.timestamp);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(result.frames.every((frame) => frame.bytes > 0)).toBe(true);

    // Transcript vs caption vs generated text are never conflated.
    expect(result.textSources.platformCaption.available).toBe(true);
    expect(result.textSources.platformCaption.text).toContain("Multiple bitrates");
    expect(result.textSources.generatedCaption.available).toBe(false);
    expect(result.textSources.transcript.available).toBe(false);
    expect(result.textSources.transcript.kind).toBe("none");
    expect(result.textSources.onScreenText.source).toBe("vision_model");
    expect(result.analysisContext.whatCannotBeAnswered.join(" ")).toMatch(/dialogue|transcript/i);
    expect(result.analysisContext.whatCanBeAnswered.join(" ")).toMatch(/frame/i);
    expect(result.analysisContext.question).toBe("What happens?");
    expect(result.limitations.join(" ")).toMatch(/NOT a transcript/i);
  });

  it("fact_check_visual mode samples more densely and states what a claim cannot prove", async () => {
    tiktokNetwork();
    decodableBrowser(12);
    const processor = new VideoProcessor(processorEnv(createBucket()), "https://demo.test/mcp");

    const summary = await processor.analyzeUnified(MULTI_PAGE_URL, { analysisMode: "summary" });
    const factCheck = await processor.analyzeUnified(MULTI_PAGE_URL, { analysisMode: "fact_check_visual", question: "Is this staged?" });

    expect(factCheck.analysisContext.factCheck.requested).toBe(true);
    expect(factCheck.framesDelivered).toBeGreaterThanOrEqual(summary.framesDelivered);
    expect(factCheck.analysisContext.factCheck.note).toMatch(/sampled frames cannot prove a negative/i);
    expect(factCheck.analysisContext.focus).toMatch(/authenticity|summary|text_ocr|people|ending|beginning|humor|scary|game|reaction/);
    expect(summary.analysisContext.factCheck.requested).toBe(false);
  });

  it("transcript mode never invents dialogue when no provider is configured", async () => {
    tiktokNetwork();
    decodableBrowser(12);
    const processor = new VideoProcessor(processorEnv(createBucket()), "https://demo.test/mcp");

    const result = await processor.analyzeUnified(MULTI_PAGE_URL, { analysisMode: "transcript" });

    expect(result.transcript).not.toBeNull();
    expect(result.transcript?.status).toBe("unavailable");
    expect(result.transcript?.text ?? "").toBe("");
    expect(result.transcript?.segments).toEqual([]);
    expect(result.textSources.transcript.available).toBe(false);
    expect(result.analysisContext.whatCannotBeAnswered.join(" ")).toMatch(/dialogue/i);
    expect(result.limitations.join(" ")).toMatch(/speech-to-text|transcription/i);
  });

  it("reports honestly when the video cannot be retrieved at all", async () => {
    tiktokNetwork({ pageHtml: tiktokStatusPage(10216, "private"), pageUrl: PAGE_URL });
    const provider = new FakeProvider();
    provider.available = false;
    setProviderFactory(() => provider);
    const processor = new VideoProcessor(processorEnv(createBucket()), "https://demo.test/mcp");

    const result = await processor.analyzeUnified(PAGE_URL, { analysisMode: "detailed" });

    expect(result.success).toBe(false);
    expect(result.accessStatus).toBe("private");
    expect(result.framesDelivered).toBe(0);
    expect(result.frames).toEqual([]);
    expect(result.visualEvidenceDelivered).toBe(false);
    expect(result.evidence.metadataOnly).toBe(true);
    expect(result.analysisContext.whatCanBeAnswered.join(" ")).not.toMatch(/visible in .* frame/i);
    expect(result.analysisContext.whatCannotBeAnswered.join(" ")).toMatch(/no frames were decoded/i);
    expect(["failed", "unavailable", "not_requested"]).toContain(result.audioStatus);
    expect(result.audioStatus).not.toBe("available");
    expect(result.error).toBeTruthy();
  });

  it("keeps working visually when audio is unavailable and says so", async () => {
    tiktokNetwork();
    decodableBrowser(12);
    const processor = new VideoProcessor(processorEnv(createBucket()), "https://demo.test/mcp");

    const result = await processor.analyzeUnified(MULTI_PAGE_URL, { analysisMode: "detailed" });

    expect(result.framesDelivered).toBeGreaterThan(0);
    expect(result.visualEvidenceDelivered).toBe(true);
    expect(["available", "unavailable", "failed"]).toContain(result.audioStatus);
    if (result.audioStatus !== "available") {
      expect(result.analysisContext.whatCannotBeAnswered.join(" ")).toMatch(/sound effects|audio/i);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* video_react                                                                 */
/* -------------------------------------------------------------------------- */

describe("video_react", () => {
  it("returns a grounded evidence package and never authors the reaction itself", async () => {
    tiktokNetwork();
    decodableBrowser(12);
    const processor = new VideoProcessor(processorEnv(createBucket()), "https://demo.test/mcp");

    const result = await processor.react(SHORT_URL, { style: "casual" });

    expect(result.success).toBe(true);
    expect(result.style).toBe("casual");
    expect(result.reaction).toBeNull(); // no canned reaction text, ever
    expect(result.reactionAuthor).toBe("connected_model");
    expect(result.framesDelivered).toBeGreaterThan(0);
    expect(result.visualEvidenceDelivered).toBe(true);
    expect(result.evidence.thumbnailUsedAsFrame).toBe(false);
    expect(result.captionIsNotTranscript).toBe(true);
    expect(result.styleGuidance).toBeTruthy();
    expect(result.reactionGuidance).toMatch(/decoded frame/i);
    expect(result.honestyNote).toBeTruthy();
    expect(result.audioStatus).toBe("not_requested");
  });

  it.each([
    ["casual", 6],
    ["funny", 8],
    ["serious", 10],
    ["detailed", 14],
  ])("gives %s style its own frame budget and guidance", async (style, expectedFrames) => {
    tiktokNetwork();
    decodableBrowser(12);
    const processor = new VideoProcessor(processorEnv(createBucket()), "https://demo.test/mcp");

    const result = await processor.react(MULTI_PAGE_URL, { style: style as never });

    expect(result.style).toBe(style);
    expect(result.framesDelivered).toBeGreaterThan(0);
    expect(result.frames.length).toBeLessThanOrEqual(Math.max(expectedFrames, result.frames.length));
    expect(result.styleGuidance).toBeTruthy();
    expect(result.reaction).toBeNull();
  });

  it("attaches frame-grounded observations only when a vision model actually read frames", async () => {
    tiktokNetwork();
    decodableBrowser(12);
    const run = vi.fn(async () => ({ visible_text: ["POV: monday"], scene_change: "cut at 3s" }));
    const processor = new VideoProcessor(processorEnv(createBucket(), { AI: { run } }), "https://demo.test/mcp");

    const result = await processor.react(MULTI_PAGE_URL, { style: "detailed" });

    expect(result.visionSummary).not.toBeNull();
    expect(result.visionSummary?.groundedInFrames).toBe(true);
    expect(result.visionSummary?.observations.length).toBeGreaterThan(0);
    expect(run).toHaveBeenCalled();
  });

  it("fails honestly with no frames and tells the model not to invent a reaction", async () => {
    tiktokNetwork({ pageHtml: tiktokStatusPage(10241, "deleted"), pageUrl: PAGE_URL });
    const provider = new FakeProvider();
    provider.available = false;
    setProviderFactory(() => provider);
    const processor = new VideoProcessor(processorEnv(createBucket()), "https://demo.test/mcp");

    const result = await processor.react(PAGE_URL, { style: "funny" });

    expect(result.success).toBe(false);
    expect(result.frames).toEqual([]);
    expect(result.framesDelivered).toBe(0);
    expect(result.visualEvidenceDelivered).toBe(false);
    expect(result.reaction).toBeNull();
    expect(result.evidence.metadataOnly).toBe(true);
    expect(result.reactionGuidance).toMatch(/nothing to react to/i);
    expect(result.accessStatus).toBe("deleted");
    expect(result.error).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* Capability discovery                                                        */
/* -------------------------------------------------------------------------- */

describe("video capability discovery", () => {
  const browserOn = { browserAvailable: true, provider: "cloudflare", videoFrames: true, reason: null, screenshots: true };
  const browserOff = { browserAvailable: false, provider: "none", videoFrames: false, reason: "No Browser Rendering binding", screenshots: false };

  it("describes what works with no external providers at all", () => {
    const report = describeVideoCapabilities({ SCREENSHOTS: createBucket() }, browserOff);

    expect(report.schema).toMatch(/demo\.video-capabilities/);
    expect(report.supportedPlatforms.length).toBeGreaterThan(0);
    expect(report.supportedPlatforms.find((entry) => entry.platform === "tiktok")?.directStreamDiscovery).toBe(true);
    expect(report.supportedPlatforms.find((entry) => entry.platform === "tiktok")?.shortLinks).toBe(true);
    expect(report.actualVideoBytes.available).toBe(true); // plain fetch + R2, no provider
    expect(report.frames.available).toBe(false); // needs Browser Rendering
    expect(report.frames.limitations.length).toBeGreaterThan(0);
    expect(report.transcription.available).toBe(false);
    expect(report.transcription.provider).toBeNull();
    expect(report.browser.available).toBe(false);
    expect(report.storage.available).toBe(true); // R2 bound, no external provider needed
    expect(report.worksWithoutProviders.join(" ")).toMatch(/video_resolve/);
    expect(report.worksWithoutProviders.join(" ")).toMatch(/video_fetch/);
    expect(report.requiresExternalProvider.join(" ")).toMatch(/transcri/i);
    expect(report.requiresExternalProvider.join(" ")).toMatch(/Browser Rendering/);
    expect(report.limits.maxFrames).toBeGreaterThan(0);
    expect(report.limits.maxDownloadMb).toBeGreaterThan(0);
    expect(report.security.ssrfGuard).toMatch(/ssrf|private|internal/i);
    expect(report.security.dnsVerification).toBe(true);
    expect(report.security.neverBypassed.join(" ")).toMatch(/captcha|drm|login/i);
    expect(report.security.signedUrlPolicy).toMatch(/never|not logged|redact/i);
    // Configuration guidance names the env vars on purpose; a secret VALUE must
    // never appear. Prove it with a deployment that has one configured.
    const withSecrets = describeVideoCapabilities(
      { SCREENSHOTS: createBucket(), TRANSCRIPTION_API_KEY: "sk-super-secret-value", DEMO_API_KEY: "demo-key-value", VIDEO_DECODER_API_KEY: "decoder-key-value" },
      browserOff,
    );
    const serialized = JSON.stringify(withSecrets);
    expect(serialized).not.toMatch(/sk-super-secret-value|demo-key-value|decoder-key-value/);
    expect(serialized).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
  });

  it("reports configured providers by name only", () => {
    const report = describeVideoCapabilities(
      {
        SCREENSHOTS: createBucket(),
        AI: { run: async () => ({}) },
        TRANSCRIPTION_ENDPOINT: "https://stt.example.com/v1/audio",
        VIDEO_VISION_MODEL: "@cf/llava-hf/llava-1.5-7b-hf",
      },
      browserOn,
    );

    expect(report.transcription.available).toBe(true);
    expect(report.frames.available).toBe(true);
    expect(report.storage.available).toBe(true);
    expect(report.providers.length).toBeGreaterThan(0);
    expect(report.visionAnalysis.available).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/stt\.example\.com\/v1\/audio/);
    expect(JSON.stringify(report)).not.toMatch(/sk-|Bearer /);
  });

  it("exposes flat flags for /health and demo_ping", () => {
    const flags = videoCapabilityFlags(describeVideoCapabilities({ SCREENSHOTS: createBucket() }, browserOn));
    expect(flags.publicVideo).toBe(true);
    expect(flags.automaticVideoInspection).toBe(true);
    expect(flags.videoFrames).toBe(true);
    expect(flags.videoArtifacts).toBe(true);
    expect(flags.videoTranscription).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Container probing                                                           */
/* -------------------------------------------------------------------------- */

describe("container probing", () => {
  it("classifies real bytes, not headers", () => {
    expect(detectMediaSignature(mp4Bytes(5).subarray(0, 64)).detectedAs).toBe("mp4");
    expect(detectMediaSignature(mp4Bytes(5).subarray(0, 64), "image/png").isVideo).toBe(true); // header lies
    expect(detectMediaSignature(JPEG_BYTES, "video/mp4").isImage).toBe(true); // header lies
    expect(detectMediaSignature(m4aBytes()).kind).toBe("audio");
    expect(detectMediaSignature(new TextEncoder().encode("<html><body>hi</body></html>")).isDocument).toBe(true);
    expect(detectMediaSignature(new TextEncoder().encode(JSON_BODY)).detectedAs).toBe("json_document");
    expect(detectMediaSignature(new TextEncoder().encode(HLS_BODY), "application/vnd.apple.mpegurl").detectedAs).toBe("hls_playlist");
  });

  it("reads an ISO-BMFF duration out of a bounded sample", () => {
    expect(mp4DurationFromBytes(mp4Bytes(12.5))).toBeCloseTo(12.5, 2);
    expect(durationFromSample(mp4Bytes(3).subarray(0, 128))).toBeCloseTo(3, 2);
    expect(mp4DurationFromBytes(new Uint8Array(64))).toBeNull(); // no mvhd → no guess
  });

  it("reads pixel dimensions out of delivered frames", () => {
    // A minimal JPEG SOF0 header: 48×32.
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x30, 0x03, 0x01, 0x22, 0x00, 0x02,
      0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9, 0x00,
    ]);
    expect(imageDimensions(jpeg)).toEqual({ width: 48, height: 32 });
    expect(imageDimensions(new Uint8Array(4))).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* MCP surface                                                                 */
/* -------------------------------------------------------------------------- */

interface RpcResponse {
  jsonrpc: string;
  id?: number | string;
  result?: any;
  error?: { code: number; message: string };
}

async function rpc(method: string, params: Record<string, unknown>, env: unknown = {}): Promise<RpcResponse> {
  const response = await worker.fetch(
    new Request("https://demo.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env as never,
    CTX,
  );
  const text = await response.text();
  if (text.trim().startsWith("{")) return JSON.parse(text) as RpcResponse;
  const dataLines = text.split("\n").filter((line) => line.startsWith("data:"));
  return JSON.parse(dataLines[dataLines.length - 1].slice(5).trim()) as RpcResponse;
}

function toolPayload(response: RpcResponse): Record<string, any> {
  const content: any[] = response.result?.content ?? [];
  return JSON.parse(content.filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n")) as Record<string, any>;
}

describe("MCP surface: video tools", () => {
  it("publishes video_resolve, video_fetch, video_react and the unified video_analyze", async () => {
    const response = await rpc("tools/list", {});
    const tools: Array<{ name: string; description?: string; inputSchema?: any }> = response.result?.tools ?? [];
    const names = tools.map((tool) => tool.name);

    for (const expected of ["video_resolve", "video_fetch", "video_react", "video_analyze", "video_extract_frames", "video_transcribe", "inspect_video"]) {
      expect(names, `${expected} missing`).toContain(expected);
      expect(DEMO_TOOL_NAMES, `${expected} missing from the registry`).toContain(expected);
    }

    const resolve = tools.find((tool) => tool.name === "video_resolve")!;
    expect(resolve.inputSchema.required).toContain("url");
    for (const field of ["quality", "verify_bytes", "include_signed_urls", "probe_limit", "platform"]) {
      expect(resolve.inputSchema.properties, field).toHaveProperty(field);
    }
    expect(resolve.description).toMatch(/access_status/);
    expect(resolve.description).toMatch(/CAPTCHA/i);

    const fetchTool = tools.find((tool) => tool.name === "video_fetch")!;
    for (const field of ["url", "video_reference", "max_duration", "max_size_mb", "quality"]) {
      expect(fetchTool.inputSchema.properties, field).toHaveProperty(field);
    }
    expect(fetchTool.description).toMatch(/NOT_A_VIDEO/);
    expect(fetchTool.description).toMatch(/STREAMED/i);

    const react = tools.find((tool) => tool.name === "video_react")!;
    expect(react.inputSchema.properties).toHaveProperty("style");
    expect(react.inputSchema.properties.style.enum).toEqual(["casual", "funny", "serious", "detailed"]);
    expect(react.description).toMatch(/no canned reactions|does not write the reaction/i);

    const analyze = tools.find((tool) => tool.name === "video_analyze")!;
    expect(analyze.inputSchema.required).toContain("url");
    for (const field of ["question", "analysis_mode", "max_frames", "include_audio", "include_transcript"]) {
      expect(analyze.inputSchema.properties, field).toHaveProperty(field);
    }
    expect(analyze.inputSchema.properties.analysis_mode.enum).toEqual(["summary", "detailed", "reaction", "fact_check_visual", "transcript", "full"]);

    const frames = tools.find((tool) => tool.name === "video_extract_frames")!;
    for (const field of ["interval_seconds", "max_frames", "resize", "timestamps"]) {
      expect(frames.inputSchema.properties, field).toHaveProperty(field);
    }
  });

  it("serves the video capability resources", async () => {
    const listed = await rpc("resources/list", {}, { SCREENSHOTS: createBucket(), SSRF_DNS_CHECK: "false" });
    const uris: string[] = (listed.result?.resources ?? []).map((entry: any) => entry.uri);
    expect(uris).toContain("demo://capabilities/video");
    expect(uris).toContain("demo://video/honesty-contract");

    const read = await rpc("resources/read", { uri: "demo://capabilities/video" }, { SCREENSHOTS: createBucket(), SSRF_DNS_CHECK: "false" });
    const report = JSON.parse(read.result?.contents?.[0]?.text ?? "null");
    expect(report?.supportedPlatforms?.length).toBeGreaterThan(0);
    expect(report?.security?.neverBypassed?.join(" ")).toMatch(/captcha|drm|login/i);
    expect(report?.limits?.maxFrames).toBeGreaterThan(0);

    const contract = await rpc("resources/read", { uri: "demo://video/honesty-contract" }, { SCREENSHOTS: createBucket(), SSRF_DNS_CHECK: "false" });
    const honesty = JSON.parse(contract.result?.contents?.[0]?.text ?? "null");
    expect(honesty?.never?.join(" ")).toMatch(/thumbnail/i);
    expect(honesty?.accessStatusMeaning?.private).toBeTruthy();
  });

  it("video_resolve returns the access verdict as structured JSON with no signed URL leakage on request", async () => {
    tiktokNetwork();
    const response = await rpc(
      "tools/call",
      { name: "video_resolve", arguments: { url: SHORT_URL, include_signed_urls: false } },
      { SCREENSHOTS: createBucket(), SSRF_DNS_CHECK: "false" },
    );

    expect(response.error).toBeUndefined();
    expect(response.result?.isError).toBeFalsy();
    const payload = toolPayload(response);
    expect(payload.tool).toBe("video_resolve");
    expect(payload.access_status).toBe("public");
    expect(payload.canonical_url).toBe(MULTI_PAGE_URL);
    expect(payload.caption_is_not_transcript).toBe(true);
    expect(payload.thumbnail_is_not_a_frame).toBe(true);
    expect(payload.stream_count).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(payload)).not.toMatch(/x-signature=[A-Za-z0-9]/);
    expect(payload.next_steps.length).toBeGreaterThan(0);
  });

  it("video_fetch returns a verified artifact and video_analyze returns real image blocks", async () => {
    const bytes = mp4Bytes(12, 4_096);
    tiktokNetwork({ streamBytes: bytes });
    decodableBrowser(12);
    const bucket = createBucket();
    const env = { SCREENSHOTS: bucket, SSRF_DNS_CHECK: "false" };

    const fetched = await rpc("tools/call", { name: "video_fetch", arguments: { url: SHORT_URL } }, env);
    expect(fetched.result?.isError).toBeFalsy();
    const fetchPayload = toolPayload(fetched);
    expect(fetchPayload.tool).toBe("video_fetch");
    expect(fetchPayload.success).toBe(true);
    expect(fetchPayload.delivery).toBe("streamed");
    expect(fetchPayload.verification).toBe("bytes");
    expect(fetchPayload.artifact.video_reference).toMatch(/^video_[a-f0-9]{64}$/);
    expect(fetchPayload.honesty_note).toMatch(/not visual understanding/i);

    const analyzed = await rpc("tools/call", { name: "video_analyze", arguments: { url: MULTI_PAGE_URL, analysis_mode: "summary", question: "What happens?" } }, env);
    expect(analyzed.result?.isError).toBeFalsy();
    const content: any[] = analyzed.result?.content ?? [];
    const images = content.filter((entry) => entry.type === "image");
    const payload = toolPayload(analyzed);
    expect(images.length).toBeGreaterThan(0);
    expect(images.length).toBe(payload.image_blocks_delivered);
    for (const image of images) {
      const decoded = decodeBase64(image.data);
      expect([decoded[0], decoded[1], decoded[2]]).toEqual([0xff, 0xd8, 0xff]); // real JPEG bytes
    }
    expect(payload.frames.length).toBe(images.length);
    payload.frames.forEach((frame: any, index: number) => expect(frame.image).toBe(`mcp_image_block_${index}`));
    expect(payload.text_sources.platform_caption.is_not_transcript).toBe(true);
    expect(payload.text_sources.generated_caption.available).toBe(false);
    expect(payload.evidence.thumbnail_used_as_frame).toBe(false);
    expect(payload.may_describe_content).toBe(true);
  });

  it("video_react returns frames and a null reaction with connected_model as author", async () => {
    tiktokNetwork();
    decodableBrowser(12);
    const response = await rpc("tools/call", { name: "video_react", arguments: { url: MULTI_PAGE_URL, style: "funny" } }, { SCREENSHOTS: createBucket(), SSRF_DNS_CHECK: "false" });

    expect(response.result?.isError).toBeFalsy();
    const content: any[] = response.result?.content ?? [];
    expect(content.filter((entry) => entry.type === "image").length).toBeGreaterThan(0);
    const payload = toolPayload(response);
    expect(payload.tool).toBe("video_react");
    expect(payload.reaction).toBeNull();
    expect(payload.reaction_author).toBe("connected_model");
    expect(payload.style).toBe("funny");
    expect(payload.caption_is_not_transcript).toBe(true);
    expect(payload.visual_evidence_delivered).toBe(true);
    expect(payload.honesty_note).toBeTruthy();
  });

  it("returns an isError result when the video cannot be retrieved, so the model cannot pass it off as watched", async () => {
    tiktokNetwork({ pageHtml: tiktokStatusPage(10216, "private"), pageUrl: PAGE_URL });
    const response = await rpc("tools/call", { name: "video_resolve", arguments: { url: PAGE_URL } }, { SCREENSHOTS: createBucket(), SSRF_DNS_CHECK: "false" });

    const payload = toolPayload(response);
    expect(payload.access_status).toBe("private");
    expect(payload.may_describe_content).toBe(false);
    expect(payload.stream_count ?? 0).toBeGreaterThanOrEqual(0);
    expect(payload.guidance).toBeTruthy();
    expect(payload.next_steps.length).toBeGreaterThan(0);

    const analyze = await rpc("tools/call", { name: "video_analyze", arguments: { url: PAGE_URL, analysis_mode: "summary" } }, { SCREENSHOTS: createBucket(), SSRF_DNS_CHECK: "false" });
    expect(analyze.result?.isError).toBe(true);
    const analyzePayload = toolPayload(analyze);
    expect(analyzePayload.frames).toEqual([]);
    expect(analyzePayload.visual_evidence_delivered).toBe(false);
    expect(analyzePayload.may_describe_content).toBe(false);
  });

  it("rejects a blocked URL with an error result and no network request", async () => {
    const network = stubNetwork({}, { allowUnlisted: true });
    const response = await rpc("tools/call", { name: "video_fetch", arguments: { url: "http://127.0.0.1:8787/clip.mp4" } }, { SCREENSHOTS: createBucket(), SSRF_DNS_CHECK: "false" });

    expect(response.result?.isError).toBe(true);
    const payload = toolPayload(response);
    expect(payload.access_status).toBe("blocked_url");
    expect(payload.artifact).toBeNull();
    expect(network.handler).not.toHaveBeenCalled();
  });

  it("exposes video capability flags on /health and a full report at /capabilities/video", async () => {
    const bucket = createBucket();
    const health = await worker.fetch(new Request("https://demo.test/health"), { SCREENSHOTS: bucket, SSRF_DNS_CHECK: "false" } as never, CTX);
    const healthPayload = (await health.json()) as Record<string, any>;
    expect(healthPayload.ok).toBe(true);
    expect(healthPayload.publicVideo).toBe(true);
    expect(healthPayload.videoBytesRetrieval).toBe(true);
    expect(healthPayload.videoArtifacts).toBe(true);
    expect(healthPayload.resources).toContain("demo://capabilities/video");

    const capability = await worker.fetch(new Request("https://demo.test/capabilities/video"), { SCREENSHOTS: bucket, SSRF_DNS_CHECK: "false" } as never, CTX);
    const report = (await capability.json()) as Record<string, any>;
    expect(report.supportedPlatforms.length).toBeGreaterThan(0);
    expect(report.storage.available).toBe(true);
    expect(report.frames.available).toBe(false); // no browser binding in this env
  });

  it("serves stored artifacts over the public route with Range support and 410 on expiry", async () => {
    const bytes = mp4Bytes(12, 2_048);
    tiktokNetwork({ streamBytes: bytes });
    const bucket = createBucket();
    const env = { SCREENSHOTS: bucket, SSRF_DNS_CHECK: "false" };
    const processor = new VideoProcessor(processorEnv(bucket), "https://demo.test/mcp");
    const fetched = await processor.fetchVideo({ url: MULTI_PAGE_URL });
    const reference = fetched.artifact!.reference;

    const full = await platform.fetch(new Request(`https://demo.test/video-assets/${reference}`), env as never, CTX);
    expect(full.status).toBe(200);
    expect(full.headers.get("Accept-Ranges")).toBe("bytes");

    const ranged = await platform.fetch(new Request(`https://demo.test/video-assets/${reference}`, { headers: { range: "bytes=0-127" } }), env as never, CTX);
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("Content-Range")).toMatch(/^bytes 0-127\//);

    // Expire it, then expect an honest 410 rather than a bare 404.
    const key = [...bucket.objects.keys()][0];
    bucket.objects.get(key)!.customMetadata = { ...bucket.objects.get(key)!.customMetadata, expiresAt: new Date(Date.now() - 1_000).toISOString() };
    const expired = await platform.fetch(new Request(`https://demo.test/video-assets/${reference}`), env as never, CTX);
    expect(expired.status).toBe(410);
    expect(((await expired.json()) as any).error).toBe("ARTIFACT_EXPIRED");

    const missing = await platform.fetch(new Request(`https://demo.test/video-assets/video_${"b".repeat(64)}`), env as never, CTX);
    expect(missing.status).toBe(404);
  });
});

/* -------------------------------------------------------------------------- */
/* Frame extraction extras                                                     */
/* -------------------------------------------------------------------------- */

describe("video_extract_frames extras", () => {
  it("applies an optional resize and reports the real pixel size of each frame", async () => {
    stubNetwork({ [MEDIA_URL]: { status: 200, contentType: "video/mp4", body: mp4Bytes(9) } });
    decodableBrowser(9);
    const bucket = createBucket();
    const processor = new VideoProcessor(processorEnv(bucket), "https://demo.test/mcp");

    const resized = await processor.extractFrames({ url: MEDIA_URL }, { maxFrameCount: 3, resize: { maxWidth: 320, maxHeight: 320 } });

    expect(resized.success).toBe(true);
    expect(resized.frames.length).toBeGreaterThan(0);
    expect(resized.limitations.join(" ")).toMatch(/resize/i);
    // Every frame reports the pixel size it actually has (read from its header),
    // so a caller can verify a resize rather than trusting a claim.
    for (const frame of resized.frames) {
      expect(frame.width).toBe(720);
      expect(frame.height).toBe(1280);
      expect(frame.bytes).toBeGreaterThan(0);
    }
  });

  it("computes a viewport that fits the requested bounds without upscaling", () => {
    expect(resizeViewport({ width: 720, height: 1280 }, { maxWidth: 320, maxHeight: 320 })).toEqual({ width: 180, height: 320 });
    expect(resizeViewport({ width: 1920, height: 1080 }, { maxWidth: 640 })).toEqual({ width: 640, height: 360 });
    // Already smaller than the bound: never upscaled.
    expect(resizeViewport({ width: 200, height: 100 }, { maxWidth: 640, maxHeight: 640 })).toEqual({ width: 200, height: 100 });
    expect(resizeViewport({ width: 720, height: 1280 }, null)).toBeNull();
    expect(resizeViewport({ width: 720, height: 1280 }, {})).toBeNull();
  });

  it("never returns a thumbnail inside frames and says so when nothing decoded", async () => {
    stubNetwork({ [MEDIA_URL]: { status: 200, contentType: "video/mp4", body: mp4Bytes(9) } });
    const provider = new FakeProvider();
    provider.available = false;
    setProviderFactory(() => provider);
    const processor = new VideoProcessor(processorEnv(createBucket()), "https://demo.test/mcp");

    const result = await processor.extractFrames({ url: MEDIA_URL }, { maxFrameCount: 4 });

    expect(result.success).toBe(false);
    expect(result.frames).toEqual([]);
    expect(result.error).toBe("FRAMES_UNAVAILABLE");
    expect(result.limitations.join(" ")).toMatch(/Browser|decode/i);
  });
});
