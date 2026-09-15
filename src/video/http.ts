import { BrowserError, type BrowserErrorCode } from "../core/errors.js";
import { LIMITS } from "../core/limits.js";
import { assertNavigableUrl, createDohResolver } from "../core/url-guard.js";
import { redactText } from "../core/redact.js";
import { isTikTokUrl, parseTikTok } from "../browser/tiktok.js";
import type { VideoEnv, VideoMetadata, VideoPlatform, VideoResolution } from "./types.js";

const PUBLIC_VIDEO_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-matroska",
  "video/ogg",
  "video/mpeg",
  "video/3gpp",
  "video/x-msvideo",
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
]);
const PUBLIC_AUDIO_TYPES = new Set(["audio/mpeg", "audio/mp3", "audio/mp4", "audio/wav", "audio/x-wav", "audio/ogg", "audio/webm"]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MEDIA_EXTENSIONS = /\.(?:mp4|m4v|webm|mov|mkv|avi|m3u8|mp3|m4a|wav|ogg)(?:$|[?#])/i;
const PAGE_TYPES = /^(?:text\/html|application\/xhtml\+xml|application\/json|text\/plain)(?:;|$)/i;

export interface PublicFetchResult {
  response: Response;
  finalUrl: string;
  redirects: string[];
}

export interface PublicFetchOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  headers?: HeadersInit;
  /** The URL of the public page that exposed a media URL. Never contains cookies. */
  referer?: string;
}

function guardOptions(env: VideoEnv) {
  return {
    allowInsecureHttp: true,
    dns: String(env.SSRF_DNS_CHECK ?? "true").toLowerCase() !== "false" ? createDohResolver() : null,
    // Video downloads are the high-egress path, so they fail closed when a
    // hostname cannot be verified. This is stricter than legacy navigation.
    dnsFailOpen: false,
  };
}

/**
 * Fetch a public resource while validating every redirect hop. `redirect: follow`
 * is intentionally not used: a public hostname may redirect to an internal
 * address, so the next Location must pass the SSRF guard before it is fetched.
 */
export async function fetchPublic(
  input: string,
  env: VideoEnv,
  init: RequestInit = {},
  options: PublicFetchOptions = {},
): Promise<PublicFetchResult> {
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? LIMITS.videoResolveTimeoutMs, 120_000));
  const maxRedirects = Math.max(0, Math.min(options.maxRedirects ?? LIMITS.videoMaxRedirects, 8));
  let current = (await assertNavigableUrl(input, guardOptions(env))).url;
  const redirects: string[] = [];

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("video request timeout"), timeoutMs);
    try {
      const headers = new Headers(init.headers);
      headers.delete("cookie");
      headers.delete("authorization");
      headers.set("accept", headers.get("accept") ?? "text/html,video/*,audio/*,application/json;q=0.9,*/*;q=0.2");
      headers.set("user-agent", headers.get("user-agent") ?? "DEMO-MCP-public-video/1.0 (+https://demo-mcp.pages.dev)");
      if (options.referer) {
        const safeReferer = (await assertNavigableUrl(options.referer, guardOptions(env))).url;
        headers.set("referer", safeReferer);
      }
      const response = await fetch(current, { ...init, headers, redirect: "manual", signal: controller.signal });
      if (!REDIRECTS.has(response.status)) return { response, finalUrl: current, redirects };
      const location = response.headers.get("location");
      if (!location) throw videoError("VIDEO_NOT_PUBLIC", `The public URL returned redirect status ${response.status} without a Location header.`);
      if (hop >= maxRedirects) throw videoError("VIDEO_NOT_PUBLIC", `The URL exceeded the ${maxRedirects}-redirect safety limit.`);
      const next = new URL(location, current).toString();
      const guarded = await assertNavigableUrl(next, guardOptions(env));
      redirects.push(guarded.url);
      current = guarded.url;
    } catch (error) {
      if (isAbort(error)) throw videoError("PROCESSING_TIMEOUT", `Public video request exceeded the ${timeoutMs}ms timeout.`, { retryable: true, cause: error });
      if (error instanceof BrowserError) throw error;
      throw videoError("VIDEO_NOT_PUBLIC", `The public media request failed: ${safeMessage(error)}`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }
  throw videoError("VIDEO_NOT_PUBLIC", "The public URL could not be resolved safely.");
}

export async function readBounded(response: Response, maxBytes: number, timeoutMs: number = LIMITS.videoDownloadTimeoutMs): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw videoError("DOWNLOAD_TOO_LARGE", `The public response declares ${formatBytes(declared)}, above the ${formatBytes(maxBytes)} limit.`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel("video body timeout");
  }, Math.max(1_000, timeoutMs));
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value instanceof Uint8Array ? next.value : new Uint8Array(next.value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel("video size limit").catch(() => undefined);
        throw videoError("DOWNLOAD_TOO_LARGE", `The public response exceeded the ${formatBytes(maxBytes)} limit.`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (timedOut) throw videoError("PROCESSING_TIMEOUT", `Reading the public video body exceeded the ${timeoutMs}ms timeout.`, { retryable: true, cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock?.();
  }
  if (timedOut) throw videoError("PROCESSING_TIMEOUT", `Reading the public video body exceeded the ${timeoutMs}ms timeout.`, { retryable: true });
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readTextBounded(response: Response, maxBytes: number, timeoutMs: number = LIMITS.videoResolveTimeoutMs): Promise<string> {
  const bytes = await readBounded(response, maxBytes, timeoutMs);
  return new TextDecoder().decode(bytes);
}

export function contentType(response: Response): string | null {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || null;
}

export function isVideoContentType(type: string | null): boolean {
  return Boolean(type && (type.startsWith("video/") || PUBLIC_VIDEO_TYPES.has(type)));
}

export function isAudioContentType(type: string | null): boolean {
  return Boolean(type && (type.startsWith("audio/") || PUBLIC_AUDIO_TYPES.has(type)));
}

export function isPlaylistContentType(type: string | null, url = ""): boolean {
  return type === "application/vnd.apple.mpegurl" || type === "application/x-mpegurl" || /\.m3u8(?:$|[?#])/i.test(url);
}

export function looksLikeMediaUrl(value: string): boolean {
  return MEDIA_EXTENSIONS.test(value);
}

export function platformForUrl(value: string): VideoPlatform {
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (isTikTokUrl(value)) return "tiktok";
    if (host === "instagram.com" || host.endsWith(".instagram.com") || host === "instagr.am") return "instagram";
    if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") return "youtube";
    if (host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com")) return "x";
    if (host === "reddit.com" || host.endsWith(".reddit.com") || host === "redd.it") return "reddit";
  } catch {
    /* caller validates URL */
  }
  return "generic";
}

function htmlDecode(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  const body = tag.replace(/^<[^\s>]+|\/?\s*>$/g, "");
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) result[match[1].toLowerCase()] = htmlDecode(match[2] ?? match[3] ?? match[4] ?? "");
  return result;
}

function absoluteCandidate(value: string | null | undefined, base: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(htmlDecode(value).trim(), base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function parseMeta(html: string, base: string): {
  meta: Record<string, string>;
  candidates: string[];
  title: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  rawStates: { universal: string | null; sigi: string | null };
  text: string;
} {
  const meta: Record<string, string> = {};
  const candidates: string[] = [];
  const add = (value: string | null | undefined) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const key = attrs.property ?? attrs.name ?? attrs.itemprop;
    const value = attrs.content;
    if (key && value && !meta[key.toLowerCase()]) meta[key.toLowerCase()] = value.slice(0, 10_000);
  }
  for (const key of ["og:video:url", "og:video:secure_url", "og:video", "twitter:player:stream", "video:url", "video:content_url", "contenturl", "video_url", "video_url_https"]) add(absoluteCandidate(meta[key], base));

  for (const match of html.matchAll(/<(?:video|source|shreddit-player|media-player)\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    for (const key of ["src", "data-src", "data-video-url", "video-url", "contenturl"]) add(absoluteCandidate(attrs[key], base));
  }

  // Public structured data frequently carries a direct contentUrl. This only
  // reads literal URLs already shipped in the page; it does not decipher a
  // signature/cipher or call a private platform API.
  for (const match of html.matchAll(/(?:contentUrl|content_url|videoUrl|video_url|playAddr|play_addr|downloadAddr|download_addr|fallback_url|fallbackUrl|playback_url|playbackUrl|progressive_url|progressiveUrl|src)\s*["']?\s*:\s*["']([^"']{8,})["']/gi)) {
    const value = match[1].replace(/\\u002F/g, "/").replace(/\\\//g, "/");
    if (MEDIA_EXTENSIONS.test(value) || /(?:video|v\.redd\.it|cdninstagram|tiktokcdn|twimg\.com)/i.test(value)) add(absoluteCandidate(value, base));
  }

  // X/Reddit/Instagram often escape the CDN URL outside a named field. Keep
  // this host allow-pattern narrow so ordinary page links are not treated as
  // media candidates.
  for (const match of html.matchAll(/https?:[^"'\s]+/gi)) {
    const value = match[0].replace(/\\u002F/g, "/").replace(/\\\//g, "/");
    if (/(?:video\.twimg\.com|v\.redd\.it|cdninstagram\.com|tiktokcdn\.com)/i.test(value)) add(absoluteCandidate(value, base));
  }

  const rawUniversal = extractScript(html, "__UNIVERSAL_DATA_FOR_REHYDRATION__");
  const rawSigi = extractScript(html, "SIGI_STATE") ?? extractScript(html, "sigi-persisted-data");
  const tiktok = isTikTokUrl(base) ? parseTikTok({ url: base, meta, rawStates: { universal: rawUniversal, sigi: rawSigi } }) : null;
  if (tiktok?.media?.playUrl) add(absoluteCandidate(tiktok.media.playUrl, base));
  if (tiktok?.media?.downloadUrl) add(absoluteCandidate(tiktok.media.downloadUrl, base));

  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? null;
  const title = first(meta["og:title"], meta["twitter:title"], meta["title"], titleTag);
  const description = first(meta["og:description"], meta["twitter:description"], meta.description);
  const thumbnailUrl = absoluteCandidate(first(meta["og:image"], meta["twitter:image"], meta["thumbnailurl"]), base);
  const width = number(first(meta["og:video:width"], meta["video:width"]));
  const height = number(first(meta["og:video:height"], meta["video:height"]));
  const durationSeconds = number(first(meta["video:duration"], meta["duration"]));
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20_000);
  return { meta, candidates, title, description, thumbnailUrl, width, height, durationSeconds, rawStates: { universal: rawUniversal, sigi: rawSigi }, text };
}

function extractScript(html: string, id: string): string | null {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<script[^>]*(?:id=["']${escaped}["']|id\\s*=\\s*["']${escaped}["'])[^>]*>([\\s\\S]*?)<\\/script>`, "i").exec(html);
  return match?.[1]?.trim().slice(0, LIMITS.maxRawStateChars) || null;
}

function first(...values: Array<string | undefined | null>): string | null {
  return values.find((value) => Boolean(value && value.trim()))?.trim() ?? null;
}

function number(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function platformChallenge(status: number, text: string, headers: Headers): { detected: boolean; kind: string | null; reason: string | null } {
  const lower = text.toLowerCase();
  if (status === 401 || /\blogin\b|sign in|log in|private account/.test(lower)) return { detected: true, kind: "login_wall", reason: "The public page requires an account or sign-in." };
  if (status === 403 || status === 429 || /captcha|verify you are human|challenge|access denied|bot check|unusual traffic/.test(lower) || (status >= 400 && headers.get("server")?.toLowerCase().includes("cloudflare"))) {
    return { detected: true, kind: status === 429 ? "rate_limit" : "bot_challenge_or_access_denied", reason: `The platform returned ${status} or a bot/access challenge instead of a public media page.` };
  }
  return { detected: false, kind: null, reason: null };
}

function errorCodeForChallenge(challenge: { detected: boolean; kind: string | null }): BrowserErrorCode {
  if (challenge.kind === "login_wall") return "VIDEO_NOT_PUBLIC";
  return "PLATFORM_BLOCKED";
}

function mediaMetadata(source: Partial<VideoMetadata> = {}): VideoMetadata {
  return {
    durationSeconds: source.durationSeconds ?? null,
    width: source.width ?? null,
    height: source.height ?? null,
    contentType: source.contentType ?? null,
    contentLength: source.contentLength ?? null,
    title: source.title ?? null,
    description: source.description ?? null,
    thumbnailUrl: source.thumbnailUrl ?? null,
  };
}

function resolutionFailure(sourceUrl: string, platform: VideoPlatform, error: string, message: string, extra: Partial<VideoResolution> = {}): VideoResolution {
  return {
    success: false,
    sourceUrl,
    resolvedUrl: extra.resolvedUrl ?? null,
    mediaUrl: extra.mediaUrl ?? null,
    platform,
    metadata: extra.metadata ?? mediaMetadata(),
    status: extra.status ?? "unavailable",
    error,
    message,
    redirects: extra.redirects ?? [],
    challenge: extra.challenge ?? { detected: false, kind: null, reason: null },
    limitations: extra.limitations ?? [],
    ...(extra.pageText ? { pageText: extra.pageText } : {}),
  };
}

async function probeMedia(candidate: string, pageUrl: string, env: VideoEnv): Promise<{ ok: true; url: string; type: string | null; length: number | null } | { ok: false; reason: string }> {
  try {
    const result = await fetchPublic(candidate, env, { method: "HEAD" }, { timeoutMs: LIMITS.videoResolveTimeoutMs, referer: pageUrl });
    const type = contentType(result.response);
    const length = parseLength(result.response.headers.get("content-length"));
    if (result.response.ok && (isVideoContentType(type) || looksLikeMediaUrl(result.finalUrl))) return { ok: true, url: result.finalUrl, type, length };
    if (result.response.status === 405 || result.response.status === 403 || result.response.status === 404) {
      // Some CDNs reject HEAD. A tiny ranged GET is still a normal public
      // request and is never used to work around a challenge.
      const ranged = await fetchPublic(candidate, env, { method: "GET", headers: { range: "bytes=0-65535" } }, { timeoutMs: LIMITS.videoResolveTimeoutMs, referer: pageUrl });
      const rangedType = contentType(ranged.response);
      const rangedLength = parseLength(ranged.response.headers.get("content-length"));
      await ranged.response.body?.cancel().catch(() => undefined);
      if (ranged.response.ok && (isVideoContentType(rangedType) || looksLikeMediaUrl(ranged.finalUrl))) return { ok: true, url: ranged.finalUrl, type: rangedType, length: rangedLength };
    }
    return { ok: false, reason: `Media probe returned HTTP ${result.response.status}${type ? ` (${type})` : ""}.` };
  } catch (error) {
    return { ok: false, reason: safeMessage(error) };
  }
}

/**
 * Resolve a public page or direct media URL. Platform extractors only consume
 * literal URLs and metadata exposed by the page; they do not use cookies,
 * private APIs, signature cracking, or CAPTCHA handling.
 */
export async function resolvePublicVideo(sourceUrl: string, env: VideoEnv): Promise<VideoResolution> {
  const platform = platformForUrl(sourceUrl);
  let guarded: string;
  try {
    guarded = (await assertNavigableUrl(sourceUrl, guardOptions(env))).url;
  } catch (error) {
    const info = error instanceof BrowserError ? error : null;
    return resolutionFailure(sourceUrl, platform, info?.code ?? "VIDEO_NOT_PUBLIC", info?.message ?? safeMessage(error));
  }

  const likelyDirect = looksLikeMediaUrl(guarded);
  let head: PublicFetchResult | null = null;
  try {
    head = await fetchPublic(guarded, env, { method: "HEAD" }, { timeoutMs: LIMITS.videoResolveTimeoutMs });
    const type = contentType(head.response);
    if (head.response.ok && (isVideoContentType(type) || isAudioContentType(type) || likelyDirect)) {
      if (isAudioContentType(type) && !isVideoContentType(type)) {
        return resolutionFailure(sourceUrl, platform, "UNSUPPORTED_MEDIA", "The URL points to audio rather than video.", {
          resolvedUrl: head.finalUrl,
          redirects: head.redirects,
          metadata: mediaMetadata({ contentType: type, contentLength: parseLength(head.response.headers.get("content-length")) }),
        });
      }
      return {
        success: true,
        sourceUrl,
        resolvedUrl: head.finalUrl,
        mediaUrl: head.finalUrl,
        platform,
        metadata: mediaMetadata({ contentType: type, contentLength: parseLength(head.response.headers.get("content-length")) }),
        status: "resolved",
        error: null,
        message: null,
        redirects: head.redirects,
        challenge: { detected: false, kind: null, reason: null },
        limitations: type ? [] : ["The CDN did not provide a video content type; the URL extension was used as a bounded hint."],
      };
    }
  } catch (error) {
    // A failed HEAD is not enough to deny a public page. Fall through to a
    // bounded GET, but preserve a useful error for direct media URLs.
    if (likelyDirect && error instanceof BrowserError && error.code !== "VIDEO_NOT_PUBLIC") {
      return resolutionFailure(sourceUrl, platform, error.code, error.message);
    }
  } finally {
    await head?.response.body?.cancel().catch(() => undefined);
  }

  let page: PublicFetchResult;
  try {
    page = await fetchPublic(guarded, env, { method: "GET", headers: { accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.8" } }, { timeoutMs: LIMITS.videoResolveTimeoutMs });
  } catch (error) {
    const info = error instanceof BrowserError ? error : null;
    return resolutionFailure(sourceUrl, platform, info?.code ?? "VIDEO_NOT_PUBLIC", info?.message ?? safeMessage(error));
  }
  const pageType = contentType(page.response);
  if (isVideoContentType(pageType)) {
    return {
      success: true,
      sourceUrl,
      resolvedUrl: page.finalUrl,
      mediaUrl: page.finalUrl,
      platform,
      metadata: mediaMetadata({ contentType: pageType, contentLength: parseLength(page.response.headers.get("content-length")) }),
      status: "resolved",
      error: null,
      message: null,
      redirects: page.redirects,
      challenge: { detected: false, kind: null, reason: null },
      limitations: [],
    };
  }

  const text = await readTextBounded(page.response, LIMITS.videoMaxHtmlBytes).catch((error) => {
    throw videoError("VIDEO_NOT_PUBLIC", `The public page body could not be read: ${safeMessage(error)}`);
  });
  const challenge = platformChallenge(page.response.status, text, page.response.headers);
  const parsed = parseMeta(text, page.finalUrl);
  const candidates = parsed.candidates.slice(0, 12);

  for (const candidate of candidates) {
    const probe = await probeMedia(candidate, page.finalUrl, env);
    if (!probe.ok) continue;
    return {
      success: true,
      sourceUrl,
      resolvedUrl: page.finalUrl,
      mediaUrl: probe.url,
      platform,
      metadata: mediaMetadata({
        durationSeconds: parsed.durationSeconds,
        width: parsed.width,
        height: parsed.height,
        contentType: probe.type,
        contentLength: probe.length,
        title: parsed.title,
        description: parsed.description,
        thumbnailUrl: parsed.thumbnailUrl,
      }),
      status: "resolved",
      error: null,
      message: null,
      redirects: page.redirects,
      challenge,
      limitations: [
        ...(challenge.detected ? ["The page also contained challenge/login signals; only the separately public media URL was used."] : []),
        ...(probe.type ? [] : ["The media server did not advertise a video content type; the literal public media URL was retained."]),
      ],
      pageText: parsed.text,
    };
  }

  const error = challenge.detected ? errorCodeForChallenge(challenge) : candidates.length ? "VIDEO_NOT_PUBLIC" : "VIDEO_NOT_FOUND";
  return resolutionFailure(sourceUrl, platform, error, challenge.reason ?? "No directly accessible public video media URL was exposed by the page.", {
    resolvedUrl: page.finalUrl,
    redirects: page.redirects,
    metadata: mediaMetadata({ durationSeconds: parsed.durationSeconds, width: parsed.width, height: parsed.height, title: parsed.title, description: parsed.description, thumbnailUrl: parsed.thumbnailUrl }),
    challenge,
    limitations: [
      "Only public HTML metadata and literal media URLs were inspected.",
      "DEMO does not bypass login walls, CAPTCHA/bot challenges, DRM, private accounts or platform access controls.",
      ...(candidates.length ? [`${candidates.length} media candidate(s) were exposed but none accepted a normal public probe.`] : ["No literal playable media URL was exposed in the public HTML response."]),
    ],
    pageText: parsed.text,
  });
}

export function parseLength(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function videoError(
  code: Extract<BrowserErrorCode, "VIDEO_NOT_FOUND" | "VIDEO_NOT_PUBLIC" | "PLATFORM_BLOCKED" | "UNSUPPORTED_MEDIA" | "DOWNLOAD_TOO_LARGE" | "PROCESSING_TIMEOUT" | "FRAMES_UNAVAILABLE" | "TRANSCRIPTION_UNAVAILABLE">,
  message: string,
  options: { retryable?: boolean; cause?: unknown } = {},
): BrowserError {
  return new BrowserError(code, message, { retryable: options.retryable, cause: options.cause });
}

function isAbort(error: unknown): boolean {
  return String(error).toLowerCase().includes("abort") || String(error).toLowerCase().includes("timeout");
}

function safeMessage(error: unknown): string {
  return redactText((error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 500), 500);
}
