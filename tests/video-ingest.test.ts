/**
 * Offline tests for the one-call public video ingestion pipeline.
 *
 * The *browser transport* is faked (FakeProvider + jsdom, exactly like
 * tests/media.test.ts); everything else — the SSRF-guarded resolver, the
 * bounded downloader, R2 artifact storage, frame mapping, the MCP tool
 * surface, admin gating and redaction — runs for real through the actual
 * Worker module.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { DEMO_TOOL_NAMES, TOOL_COUNT } from "../index.js";
import { VideoProcessor } from "../src/video/processor.js";
import { setProviderFactory } from "../src/browser/providers/index.js";
import { sha256Hex } from "../src/video/store.js";
import { FakeProvider } from "./helpers/fake-provider.js";

const CTX = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;

const PAGE_URL = "https://example.com/clip";
const MEDIA_URL = "https://cdn.example.com/clip.mp4";
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 1, 2, 3, 4, 5, 6, 7, 8]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value));
  }
  return concat(chunks);
}

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, 8 + payload.byteLength);
  out.set(new TextEncoder().encode(type), 4);
  out.set(payload, 8);
  return out;
}

/** Minimal ISO-BMFF (mp4) with a parseable mvhd so the bounded header check sees a real duration. */
function mp4Bytes(durationSeconds: number): Uint8Array {
  const mvhd = new Uint8Array(100);
  const view = new DataView(mvhd.buffer);
  view.setUint32(12, 1_000); // timescale
  view.setUint32(16, Math.round(durationSeconds * 1_000)); // duration
  return concat([box("ftyp", new TextEncoder().encode("isom")), box("moov", box("mvhd", mvhd))]);
}

/** In-DOM patch making the fake <video> behave like a decodable clip. */
function fakeDecodableVideo(durationSeconds: number, width = 720, height = 1280): (window: any) => void {
  return (window: any) => {
    const proto = window.HTMLMediaElement.prototype;
    Object.defineProperty(proto, "duration", { configurable: true, get: () => durationSeconds });
    Object.defineProperty(proto, "videoWidth", { configurable: true, get: () => width });
    Object.defineProperty(proto, "videoHeight", { configurable: true, get: () => height });
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

interface FakeBucket {
  objects: Map<string, { bytes: Uint8Array; httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> }>;
  put(key: string, value: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array> | string, options?: any): Promise<void>;
  head(key: string): Promise<any>;
  get(key: string, options?: any): Promise<any>;
  delete(key: string): Promise<void>;
}

function createBucket(): FakeBucket {
  const objects = new Map<FakeBucket["objects"] extends Map<string, infer V> ? string : never, any>();
  const bucket = {
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
  };
  return bucket;
}

const PAGE_HTML = `<html><head>
  <title>Public clip</title>
  <meta property="og:title" content="Public clip">
  <meta property="og:video:url" content="${MEDIA_URL}">
  <meta name="video:duration" content="10">
  <meta name="og:video:width" content="720">
  <meta name="og:video:height" content="1280">
</head><body><video src="${MEDIA_URL}" playsinline></video></body></html>`;

function stubFetch(mp4: Uint8Array) {
  const calls: string[] = [];
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const method = String(init?.method ?? "GET").toUpperCase();
    if (url === PAGE_URL) {
      if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
      return new Response(PAGE_HTML, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (url === MEDIA_URL) {
      const body = new Uint8Array(mp4); // fresh ArrayBuffer-backed copy for BodyInit
      return new Response(body, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(mp4.byteLength) } });
    }
    throw new Error(`unexpected fetch in video ingest test: ${url}`);
  });
  vi.stubGlobal("fetch", handler);
  return { calls, handler };
}

function processorEnv(bucket: FakeBucket) {
  return {
    SCREENSHOTS: bucket,
    SSRF_DNS_CHECK: "false",
    VIDEO_ARTIFACT_TTL_SECONDS: "3600",
  } as never;
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

// ---------------------------------------------------------------------------
// video_ingest: processor level (real frames through the fake browser)
// ---------------------------------------------------------------------------

describe("video_ingest (processor level)", () => {
  it("downloads the real media to R2 and decodes MCP-ready frames from a public page", async () => {
    const bucket = createBucket();
    const mp4 = mp4Bytes(10);
    stubFetch(mp4);
    setProviderFactory(
      () =>
        new FakeProvider({
          screenshotBytes: JPEG_BYTES,
          routes: {
            [MEDIA_URL]: {
              status: 200,
              html: `<html><body><video src="${MEDIA_URL}" playsinline></video></body></html>`,
              scripts: [fakeDecodableVideo(10, 720, 1280)],
            },
          },
        }),
    );
    const processor = new VideoProcessor(processorEnv(bucket), "https://demo.test/mcp");
    const result = await processor.ingest(PAGE_URL, { outputMode: "all" });

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
    expect(result.sourceUrl).toBe(PAGE_URL);
    expect(result.mediaUrl).toBe(MEDIA_URL);
    expect(result.platform).toBe("generic");
    expect(result.mediaType).toBe("video");
    expect(result.durationSeconds).toBe(10);
    expect(result.width).toBe(720);
    expect(result.height).toBe(1280);
    expect(result.contentType).toBe("video/mp4");

    // R2 artifact: content-addressed, expiring, and the stored bytes match.
    expect(result.videoArtifact).toBeTruthy();
    const artifact = result.videoArtifact as NonNullable<typeof result.videoArtifact>;
    expect(artifact.reference).toMatch(/^video_[a-f0-9]{64}$/);
    expect(artifact.url).toBe(`https://demo.test/video-assets/${artifact.reference}`);
    expect(artifact.sha256).toBe(await sha256Hex(mp4));
    expect(Date.parse(artifact.expiresAt)).toBeGreaterThan(Date.now());
    const stored = bucket.objects.get(`video-artifacts/video/${artifact.sha256}`);
    expect(stored).toBeTruthy();
    expect(stored?.bytes).toEqual(mp4);

    // Frames: actual decoded samples, timestamped, stored, and inline-ready.
    expect(result.analysisReady).toBe(true);
    expect(result.frames.length).toBeGreaterThan(0);
    for (const frame of result.frames) {
      expect(frame.inspected).toBe(true);
      expect(frame.contentType).toBe("image/jpeg");
      expect(frame.timestamp).toBeGreaterThanOrEqual(0);
      expect(frame.timestamp).toBeLessThan(10);
      expect(frame.imageReference).toMatch(/^https:\/\/demo\.test\/screenshots\/screenshots\/[A-Za-z0-9_-]{16,}$/);
      expect(frame.bytes).toBe(JPEG_BYTES.byteLength);
      expect(frame.inlineData).toBeTruthy();
      const inline = decodeBase64(frame.inlineData as string);
      expect(inline[0]).toBe(0xff);
      expect(inline[1]).toBe(0xd8);
      expect(inline[2]).toBe(0xff); // JPEG magic: real image bytes, not a label
    }
    const storedFrames = [...bucket.objects.keys()].filter((key) => key.startsWith("screenshots/"));
    expect(storedFrames.length).toBe(result.frames.length);
  }, 30_000);

  it("honours max_duration_seconds and frame_count", async () => {
    const bucket = createBucket();
    const mp4 = mp4Bytes(10);
    stubFetch(mp4);
    setProviderFactory(
      () =>
        new FakeProvider({
          screenshotBytes: JPEG_BYTES,
          routes: {
            [MEDIA_URL]: {
              status: 200,
              html: `<html><body><video src="${MEDIA_URL}" playsinline></video></body></html>`,
              scripts: [fakeDecodableVideo(10, 720, 1280)],
            },
          },
        }),
    );
    const processor = new VideoProcessor(processorEnv(bucket), "https://demo.test/mcp");
    const result = await processor.ingest(PAGE_URL, { outputMode: "frames", maxDurationSeconds: 6, frameCount: 2 });
    expect(result.success).toBe(true);
    expect(result.videoArtifact).toBeNull(); // output_mode: frames does not download
    expect(result.frames.length).toBe(2);
    for (const frame of result.frames) expect(frame.timestamp).toBeLessThan(6);
  }, 30_000);

  it("reports an honest structured failure when the platform blocks and no browser renders", async () => {
    const bucket = createBucket();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (String(init?.method ?? "GET").toUpperCase() === "HEAD") {
          return new Response(null, { status: 403, headers: { "content-type": "text/html", server: "cloudflare" } });
        }
        return new Response("<html><body>Please verify you are human</body></html>", {
          status: 403,
          headers: { "content-type": "text/html", server: "cloudflare" },
        });
      }),
    );
    const provider = new FakeProvider();
    provider.available = false; // e.g. sandbox without Browser Run
    setProviderFactory(() => provider);
    const processor = new VideoProcessor(processorEnv(bucket), "https://demo.test/mcp");
    const result = await processor.ingest("https://www.tiktok.com/@user/video/123456", { outputMode: "all" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("PLATFORM_BLOCKED");
    expect(result.frames).toEqual([]);
    expect(result.analysisReady).toBe(false);
    expect(result.videoArtifact).toBeNull();
    expect(result.challenge.detected).toBe(true);
    expect(result.limitations.join(" ")).toMatch(/CAPTCHA|login|bypass|Browser Run/i);
    expect(bucket.objects.size).toBe(0); // nothing was stored or fabricated
  });

  it("streams the download and rejects a thumbnail/HTML body with NOT_A_VIDEO, storing nothing", async () => {
    const bucket = createBucket();
    // The page promises a video, but the CDN serves an HTML interstitial with
    // a lying video content type. The streaming path must catch it from the
    // bytes (not the header) and delete the partial object.
    const html = new TextEncoder().encode("<html><body>Just a moment...</body></html>");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = String(init?.method ?? "GET").toUpperCase();
        if (url === PAGE_URL) {
          if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
          return new Response(PAGE_HTML, { status: 200, headers: { "content-type": "text/html" } });
        }
        if (url === MEDIA_URL) {
          if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(html.byteLength) } });
          // Ranged probe during resolution sees the same HTML bytes.
          return new Response(html.slice() as unknown as BodyInit, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(html.byteLength) } });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const provider = new FakeProvider();
    provider.available = false;
    setProviderFactory(() => provider);
    const processor = new VideoProcessor(processorEnv(bucket), "https://demo.test/mcp");
    const resolution = await processor.resolve(PAGE_URL);
    // Resolution with default (non-byte-verifying) options accepts the declared
    // type; the download path must still refuse it from the actual bytes.
    expect(resolution.success).toBe(true);
    const downloaded = await processor.downloadResolved(resolution);
    expect(downloaded.artifact).toBeNull();
    expect(downloaded.error).toBe("NOT_A_VIDEO");
    expect(downloaded.message).toMatch(/HTML|interstitial|not video/i);
    expect(bucket.objects.size).toBe(0); // partial object deleted, nothing claimed
  });

  it("refuses a verifiable container whose duration cannot be read, storing nothing", async () => {
    const bucket = createBucket();
    // Valid ISO-BMFF signature (ftyp + mdat) but no moov/mvhd anywhere, and the
    // page publishes no duration either — the policy must refuse it.
    const noMoov = concat([box("ftyp", new TextEncoder().encode("isom")), box("mdat", new Uint8Array(512))]);
    const pageNoDuration = PAGE_HTML.replace('<meta name="video:duration" content="10">', "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = String(init?.method ?? "GET").toUpperCase();
        if (url === PAGE_URL) {
          if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
          return new Response(pageNoDuration, { status: 200, headers: { "content-type": "text/html" } });
        }
        if (url === MEDIA_URL) {
          const body = new Uint8Array(noMoov);
          return new Response(body as unknown as BodyInit, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(noMoov.byteLength) } });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const provider = new FakeProvider();
    provider.available = false;
    setProviderFactory(() => provider);
    const processor = new VideoProcessor(processorEnv(bucket), "https://demo.test/mcp");
    const downloaded = await processor.download(PAGE_URL);
    expect(downloaded.artifact).toBeNull();
    expect(downloaded.error).toBe("UNSUPPORTED_MEDIA");
    expect(downloaded.message).toMatch(/duration could not be verified|no duration/i);
    expect(bucket.objects.size).toBe(0);
  });

  it("never touches blocked URLs: the SSRF guard stops it before any request", async () => {
    const bucket = createBucket();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const processor = new VideoProcessor(processorEnv(bucket), "https://demo.test/mcp");
    const result = await processor.ingest("http://127.0.0.1:9/secret.mp4", { outputMode: "all" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("blocked_url");
    expect(result.frames).toEqual([]);
    expect(result.videoArtifact).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// video_inspect_pipeline: stage-by-stage diagnostic
// ---------------------------------------------------------------------------

describe("video_inspect_pipeline (processor level)", () => {
  it("reports every stage and names the first failing stage (no browser)", async () => {
    const bucket = createBucket();
    stubFetch(mp4Bytes(10));
    const provider = new FakeProvider();
    provider.available = false;
    setProviderFactory(() => provider);
    const processor = new VideoProcessor(processorEnv(bucket), "https://demo.test/mcp");
    const report = await processor.inspectPipeline(PAGE_URL, { includeDownload: true, includeFrames: true });

    const byStage = Object.fromEntries(report.stages.map((stage) => [stage.stage, stage]));
    expect(Object.keys(byStage).sort()).toEqual([
      "artifact_url_generation",
      "browser_access",
      "frame_extraction",
      "mcp_serialization",
      "media_discovery",
      "media_retrieval",
      "r2_upload",
      "redirect_resolution",
      "url_validation",
    ]);
    expect(byStage.url_validation.status).toBe("ok");
    expect(byStage.redirect_resolution.status).toBe("ok");
    expect(byStage.media_discovery.status).toBe("ok");
    expect(byStage.media_discovery.detail.media_url).toBe(MEDIA_URL);
    expect(byStage.media_discovery.detail.candidate_count).toBe(1);
    expect(byStage.browser_access.status).toBe("failed");
    expect(String(byStage.browser_access.error)).toMatch(/Browser Run|binding/i);
    expect(byStage.media_retrieval.status).toBe("ok");
    expect(byStage.media_retrieval.detail.content_type).toBe("video/mp4");
    expect(byStage.media_retrieval.detail.sample_shape).toMatch(/iso-base-media/i);
    expect(byStage.frame_extraction.status).toBe("skipped");
    expect(byStage.r2_upload.status).toBe("ok");
    expect(byStage.r2_upload.detail.cleaned).toBe(true);
    expect(bucket.objects.size).toBe(0); // the diagnostic object was read back and deleted
    expect(byStage.artifact_url_generation.status).toBe("ok");
    expect(byStage.artifact_url_generation.detail.route).toContain("/video-assets/");
    expect(byStage.mcp_serialization.status).toBe("ok");
    expect(byStage.mcp_serialization.detail.contains_secrets).toBe(false);
    expect(report.overall).toBe("partial");
    expect(report.firstFailure).toBe("browser_access");
    expect(report.message).toMatch(/browser_access/);
  });

  it("reports frame_extraction ok when the (fake) browser decodes media", async () => {
    const bucket = createBucket();
    stubFetch(mp4Bytes(10));
    setProviderFactory(
      () =>
        new FakeProvider({
          screenshotBytes: JPEG_BYTES,
          routes: {
            [MEDIA_URL]: {
              status: 200,
              html: `<html><body><video src="${MEDIA_URL}" playsinline></video></body></html>`,
              scripts: [fakeDecodableVideo(10, 720, 1280)],
            },
          },
        }),
    );
    const processor = new VideoProcessor(processorEnv(bucket), "https://demo.test/mcp");
    const report = await processor.inspectPipeline(PAGE_URL, { includeDownload: true, includeFrames: true });
    const byStage = Object.fromEntries(report.stages.map((stage) => [stage.stage, stage]));
    expect(byStage.browser_access.status).toBe("ok");
    expect(byStage.frame_extraction.status).toBe("ok");
    expect(byStage.frame_extraction.detail.frames_captured).toBeGreaterThan(0);
    expect(report.overall).toBe("ok");
    expect(report.firstFailure).toBeNull();
  }, 30_000);

  it("stops at url_validation for blocked URLs and never fetches them", async () => {
    const bucket = createBucket();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const processor = new VideoProcessor(processorEnv(bucket), "https://demo.test/mcp");
    const report = await processor.inspectPipeline("http://169.254.169.254/latest/meta-data/", {});
    expect(report.stages).toHaveLength(1);
    expect(report.stages[0].stage).toBe("url_validation");
    expect(report.stages[0].status).toBe("failed");
    expect(report.overall).toBe("failed");
    expect(report.firstFailure).toBe("url_validation");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// video_ingest / video_inspect_pipeline: MCP surface (real Worker + transport)
// ---------------------------------------------------------------------------

interface RpcResponse {
  jsonrpc: string;
  id?: number | string;
  result?: any;
  error?: { code: number; message: string };
}

async function rpc(method: string, params: Record<string, unknown>, env: unknown = {}, headers: Record<string, string> = {}): Promise<RpcResponse> {
  const response = await worker.fetch(
    new Request("https://demo.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
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

describe("MCP surface: video_ingest and video_inspect_pipeline", () => {
  it("registers both tools in the inventory", async () => {
    const response = await rpc("tools/list", {});
    const names: string[] = (response.result?.tools ?? []).map((tool: { name: string }) => tool.name);
    expect(names.length).toBe(TOOL_COUNT);
    expect(names).toContain("video_ingest");
    expect(names).toContain("video_inspect_pipeline");
    for (const name of DEMO_TOOL_NAMES) expect(names).toContain(name);
  });

  it("returns the artifact plus an honest frames limitation when no browser is bound", async () => {
    const bucket = createBucket();
    stubFetch(mp4Bytes(10));
    const response = await rpc("tools/call", { name: "video_ingest", arguments: { url: PAGE_URL, output_mode: "all" } }, { SCREENSHOTS: bucket, SSRF_DNS_CHECK: "false" });
    expect(response.error).toBeUndefined();
    const content = response.result?.content ?? [];
    const text = content
      .map((entry: { text?: string }) => entry.text ?? "")
      .join("\n");
    const payload = JSON.parse(text) as Record<string, any>;
    expect(content.some((entry: { type?: string }) => entry.type === "image")).toBe(false);
    expect(payload.success).toBe(true);
    expect(payload.video_artifact.url).toMatch(/^https:\/\/demo\.test\/video-assets\/video_[a-f0-9]{64}$/);
    expect(payload.frames).toEqual([]);
    expect(payload.analysis_ready).toBe(false);
    expect(payload.limitations.join(" ")).toMatch(/Browser Run|frame/i);
  });

  it("ships decoded frames as MCP image content blocks with a JSON manifest", async () => {
    const bucket = createBucket();
    stubFetch(mp4Bytes(10));
    setProviderFactory(
      () =>
        new FakeProvider({
          screenshotBytes: JPEG_BYTES,
          routes: {
            [MEDIA_URL]: {
              status: 200,
              html: `<html><body><video src="${MEDIA_URL}" playsinline></video></body></html>`,
              scripts: [fakeDecodableVideo(10, 720, 1280)],
            },
          },
        }),
    );
    const response = await rpc("tools/call", { name: "video_ingest", arguments: { url: PAGE_URL, output_mode: "all" } }, { SCREENSHOTS: bucket, SSRF_DNS_CHECK: "false" });
    expect(response.error).toBeUndefined();
    const content = response.result?.content ?? [];
    const images = content.filter((entry: { type?: string }) => entry.type === "image");
    const textEntries = content.filter((entry: { type?: string }) => entry.type === "text");
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image.mimeType).toBe("image/jpeg");
      const decoded = decodeBase64(image.data);
      expect([decoded[0], decoded[1], decoded[2]]).toEqual([0xff, 0xd8, 0xff]);
    }
    const payload = JSON.parse(textEntries.map((entry: { text: string }) => entry.text).join("\n")) as Record<string, any>;
    expect(payload.success).toBe(true);
    expect(payload.analysis_ready).toBe(true);
    expect(payload.frames.length).toBe(images.length);
    for (const frame of payload.frames) {
      expect(typeof frame.timestamp_seconds).toBe("number");
      expect(frame.mime_type).toBe("image/jpeg");
      expect(frame.url).toMatch(/^https:\/\/demo\.test\/screenshots\//);
    }
    expect(payload.video_artifact.url).toMatch(/\/video-assets\/video_[a-f0-9]{64}$/);
    expect(payload.source_url).toBe(PAGE_URL);
  }, 30_000);

  it("validates video_ingest input before any work happens", async () => {
    const bad = await rpc("tools/call", { name: "video_ingest", arguments: { url: "not a url" } }, {});
    expect(bad.error?.code ?? bad.result?.isError).toBeTruthy();
  });

  it("runs the public video diagnostic without any MCP bearer", async () => {
    const bucket = createBucket();
    stubFetch(mp4Bytes(10));
    const provider = new FakeProvider();
    provider.available = false;
    setProviderFactory(() => provider);

    // The public diagnostic returns its stage report without any DEMO bearer.
    const open = await rpc("tools/call", { name: "video_inspect_pipeline", arguments: { url: PAGE_URL } }, { SCREENSHOTS: bucket, SSRF_DNS_CHECK: "false" });
    const openText = (open.result?.content ?? []).map((entry: { text?: string }) => entry.text ?? "").join("\n");
    expect(open.result?.isError).toBeFalsy();
    const report = JSON.parse(openText) as Record<string, any>;
    expect(report.success).toBe(true); // overall is partial, not failed
    expect(report.overall).toBe("partial");
    expect(report.first_failure).toBe("browser_access");
    expect(report.stages.length).toBe(9);

    // A private-tool credential must not gate the public diagnostic.
    const accepted = await worker.fetch(
      new Request("https://demo.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "video_inspect_pipeline", arguments: { url: PAGE_URL } } }),
      }),
      { SCREENSHOTS: bucket, SSRF_DNS_CHECK: "false" } as never,
      CTX,
    );
    expect(accepted.status).toBe(200);
    const payload = await accepted.text();
    expect(payload).not.toContain("Unauthorized");
    expect(payload).toContain("browser_access");
  }, 30_000);
});
