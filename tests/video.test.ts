import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePublicVideo } from "../src/video/http.js";
import { VideoArtifactStore } from "../src/video/store.js";

const env = { SSRF_DNS_CHECK: "false" };

function response(body: BodyInit | null, init: ResponseInit & { headers?: Record<string, string> } = {}) {
  return new Response(body, init);
}

afterEach(() => vi.unstubAllGlobals());

describe("public video resolver", () => {
  it("accepts a literal public media candidate exposed by a webpage", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://example.com/page" && init?.method === "HEAD") return response(null, { status: 200, headers: { "content-type": "text/html" } });
      if (url === "https://example.com/page") return response('<html><head><meta property="og:title" content="Public clip"><meta property="og:video:url" content="https://cdn.example.com/clip.mp4"></head></html>', { status: 200, headers: { "content-type": "text/html" } });
      if (url === "https://cdn.example.com/clip.mp4") return response(null, { status: 200, headers: { "content-type": "video/mp4", "content-length": "1234" } });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolvePublicVideo("https://example.com/page", env);
    expect(result.success).toBe(true);
    expect(result.mediaUrl).toBe("https://cdn.example.com/clip.mp4");
    expect(result.metadata.title).toBe("Public clip");
    expect(result.metadata.contentType).toBe("video/mp4");
  });

  it("validates redirect targets instead of following an SSRF redirect", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } })));
    const result = await resolvePublicVideo("https://example.com/redirect", env);
    expect(result.success).toBe(false);
    expect(result.error).toBe("blocked_url");
  });

  it("reports bot challenges without inventing a media URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "HEAD") return response(null, { status: 403, headers: { "content-type": "text/html", server: "cloudflare" } });
      return response("<html><body>Please verify you are human</body></html>", { status: 403, headers: { "content-type": "text/html", server: "cloudflare" } });
    }));
    const result = await resolvePublicVideo("https://www.tiktok.com/@public/video/123456789", env);
    expect(result.success).toBe(false);
    expect(result.error).toBe("PLATFORM_BLOCKED");
    expect(result.mediaUrl).toBeNull();
    expect(result.challenge.detected).toBe(true);
  });
});

describe("video artifact references", () => {
  it("uses content-addressed expiring references and never a filesystem path", async () => {
    const objects = new Map<string, any>();
    const bucket = {
      async put(key: string, value: Uint8Array, options: any) {
        objects.set(key, { bytes: value, customMetadata: options.customMetadata, httpMetadata: options.httpMetadata });
      },
      async head(key: string) {
        return objects.get(key) ?? null;
      },
      async get(key: string) {
        const object = objects.get(key);
        if (!object) return null;
        return {
          ...object,
          async arrayBuffer() {
            return object.bytes.buffer;
          },
        };
      },
    };
    const store = new VideoArtifactStore(bucket, "https://demo.test", 300);
    const artifact = await store.store(new Uint8Array([1, 2, 3]), "video", "video/mp4", { durationSeconds: 3 });
    expect(artifact.reference).toMatch(/^video_[a-f0-9]{64}$/);
    expect(artifact.url).toBe(`https://demo.test/video-assets/${artifact.reference}`);
    expect(artifact.reference).not.toContain("/");
    expect((await store.get(artifact.reference))?.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });
});
