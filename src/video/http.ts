import { BrowserError, type BrowserErrorCode } from "../core/errors.js";
import { LIMITS } from "../core/limits.js";
import { assertNavigableUrl, createDohResolver } from "../core/url-guard.js";
import { redactText } from "../core/redact.js";
import { isTikTokUrl, parseJsonLdVideo, parseTikTok, type JsonLdVideo, type TikTokAccessFlags, type TikTokInfo } from "../browser/tiktok.js";
import { classifyAccess, type AccessStatusInfo, type VideoAccessStatus } from "./access.js";
import { detectMediaSignature, type MediaSignature } from "./probe.js";
import { pushCandidate, rankStreams, signedUrlExpired, type QualityPreference, type StreamCandidate, type StreamSource } from "./streams.js";
import type {
  VideoCreator,
  VideoEnv,
  VideoMetadata,
  VideoMetadataSource,
  VideoPlatform,
  VideoResolution,
  VideoResolutionDetail,
  VideoVerification,
} from "./types.js";

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

/**
 * SSRF guard options for the public video pipeline. Exported so the pipeline
 * diagnostic (`video_inspect_pipeline`) can run the exact same validation as
 * the resolver without duplicating the policy.
 */
export function videoGuardOptions(env: VideoEnv) {
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
  let current = (await assertNavigableUrl(input, videoGuardOptions(env))).url;
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
        const safeReferer = (await assertNavigableUrl(options.referer, videoGuardOptions(env))).url;
        headers.set("referer", safeReferer);
      }
      const response = await fetch(current, { ...init, headers, redirect: "manual", signal: controller.signal });
      if (!REDIRECTS.has(response.status)) return { response, finalUrl: current, redirects };
      const location = response.headers.get("location");
      if (!location) throw videoError("VIDEO_NOT_PUBLIC", `The public URL returned redirect status ${response.status} without a Location header.`);
      if (hop >= maxRedirects) throw videoError("VIDEO_NOT_PUBLIC", `The URL exceeded the ${maxRedirects}-redirect safety limit.`);
      const next = new URL(location, current).toString();
      const guarded = await assertNavigableUrl(next, videoGuardOptions(env));
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

/**
 * Extract one balanced JSON object/array starting at `start`.
 *
 * TikTok sometimes ships its hydration payload as a JS assignment
 * (`window['__UNIVERSAL_DATA_FOR_REHYDRATION__'] = {…}`) instead of a
 * `<script id=…>` tag, so id-based extraction alone is fragile. This scans
 * braces while respecting strings and escapes, and is strictly bounded so a
 * pathological page cannot burn CPU.
 */
function extractBalancedJson(text: string, start: number, budget = LIMITS.maxRawStateChars): string | null {
  const open = text[start];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  const end = Math.min(text.length, start + budget);
  for (let i = start; i < end; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** A hydration payload by `<script id>`, or by JS assignment when there is no id. */
function extractScript(html: string, id: string): string | null {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tagged = new RegExp(`<script[^>]*(?:id=["']${escaped}["']|id\\s*=\\s*["']${escaped}["'])[^>]*>([\\s\\S]*?)<\\/script>`, "i").exec(html);
  if (tagged?.[1]?.trim()) return tagged[1].trim().slice(0, LIMITS.maxRawStateChars);
  const assignment = new RegExp(`(?:window\\s*(?:\\[\\s*["']${escaped}["']\\s*\\]|\\.\\s*${escaped})|\\bvar\\s+${escaped}|\\bconst\\s+${escaped}|\\blet\\s+${escaped}|\\b${escaped})\\s*=\\s*(?=[{\\[])`, "i").exec(html);
  if (assignment) {
    const json = extractBalancedJson(html, assignment.index + assignment[0].length);
    if (json) return json.slice(0, LIMITS.maxRawStateChars);
  }
  return null;
}

/** Bounded parse of every `application/ld+json` block on the page. */
export function extractJsonLd(html: string, maxBlocks = LIMITS.maxJsonLdBlocks): unknown[] {
  const blocks: unknown[] = [];
  for (const match of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      // Some pages wrap the JSON in CDATA or trailing comments; retry once.
      const cleaned = raw.replace(/^<!\[CDATA\[|\]\]>$/g, "").trim();
      try {
        blocks.push(JSON.parse(cleaned));
      } catch {
        /* an unparseable block is simply not evidence */
      }
    }
    if (blocks.length >= maxBlocks) break;
  }
  return blocks;
}

export interface ParsedPage {
  meta: Record<string, string>;
  candidates: StreamCandidate[];
  title: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  rawStates: { universal: string | null; sigi: string | null };
  jsonLd: unknown[];
  jsonLdVideo: JsonLdVideo | null;
  tiktok: TikTokInfo | null;
  text: string;
}

/**
 * Parse a bounded public HTML/JSON response for literal media URLs and
 * metadata.
 *
 * Multiple independent sources are collected (platform hydration payload,
 * JSON-LD, OpenGraph/Twitter meta, `<video>`/`<source>` elements, and a narrow
 * CDN-host literal scan) and ranked later. Relying on any single selector is
 * exactly what breaks when a platform ships a new page layout.
 */
export function parsePage(html: string, base: string): ParsedPage {
  const meta: Record<string, string> = {};
  const candidates: StreamCandidate[] = [];
  const add = (value: string | null | undefined, source: StreamSource, extra: { width?: number | null; height?: number | null; bitrate?: number | null } = {}): void => {
    const absolute = absoluteCandidate(value, base);
    if (absolute) pushCandidate(candidates, { url: absolute, source, ...extra });
  };

  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const key = attrs.property ?? attrs.name ?? attrs.itemprop;
    const value = attrs.content;
    if (key && value && !meta[key.toLowerCase()]) meta[key.toLowerCase()] = value.slice(0, 10_000);
  }

  const rawUniversal = extractScript(html, "__UNIVERSAL_DATA_FOR_REHYDRATION__");
  const rawSigi = extractScript(html, "SIGI_STATE") ?? extractScript(html, "sigi-persisted-data");
  const jsonLd = extractJsonLd(html);
  const jsonLdVideo = parseJsonLdVideo(jsonLd);
  const tiktok = isTikTokUrl(base) ? parseTikTok({ url: base, meta, rawStates: { universal: rawUniversal, sigi: rawSigi }, jsonLd }) : null;

  // 1. Platform hydration payload first: it is the richest and most reliable.
  if (tiktok) {
    for (const stream of tiktok.streams) {
      const absoluteUrl = absoluteCandidate(stream.url, base);
      if (absoluteUrl) pushCandidate(candidates, { url: absoluteUrl, source: stream.source, width: stream.width, height: stream.height, bitrate: stream.bitrate });
    }
  }

  // 2. JSON-LD `contentUrl` (schema.org VideoObject).
  if (jsonLdVideo?.contentUrl) add(jsonLdVideo.contentUrl, "json_ld.contentUrl", { width: jsonLdVideo.width, height: jsonLdVideo.height });

  // 3. OpenGraph / Twitter / video meta tags.
  for (const key of ["og:video:url", "og:video:secure_url", "og:video", "twitter:player:stream", "video:url", "video:content_url", "contenturl", "video_url", "video_url_https"]) {
    add(meta[key], "og.video");
  }

  // 4. Literal `<video>`/`<source>` elements in the served HTML.
  for (const match of html.matchAll(/<(?:video|source|shreddit-player|media-player)\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    for (const key of ["src", "data-src", "data-video-url", "video-url", "contenturl"]) add(attrs[key], "html.video_element");
  }

  // 5. Named fields anywhere in the document (escaped JSON, inline configs).
  // This only reads literal URLs already shipped in the page; it does not
  // decipher a signature/cipher or call a private platform API.
  for (const match of html.matchAll(/(?:contentUrl|content_url|videoUrl|video_url|playAddr|play_addr|downloadAddr|download_addr|fallback_url|fallbackUrl|playback_url|playbackUrl|progressive_url|progressiveUrl|src)\s*["']?\s*:\s*["']([^"']{8,})["']/gi)) {
    const value = match[1].replace(/\\u002F/g, "/").replace(/\\\//g, "/");
    if (MEDIA_EXTENSIONS.test(value) || /(?:video|v\.redd\.it|cdninstagram|tiktokcdn|twimg\.com)/i.test(value)) add(value, "html.literal_url");
  }

  // 6. X/Reddit/Instagram often escape the CDN URL outside a named field. Keep
  // this host allow-pattern narrow so ordinary page links are not treated as
  // media candidates.
  for (const match of html.matchAll(/https?:[^"'\s]+/gi)) {
    const value = match[0].replace(/\\u002F/g, "/").replace(/\\\//g, "/");
    if (/(?:video\.twimg\.com|v\.redd\.it|cdninstagram\.com|tiktokcdn\.com)/i.test(value)) add(value, "html.literal_url");
  }

  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? null;
  const title = first(meta["og:title"], meta["twitter:title"], meta.title, titleTag);
  const description = first(meta["og:description"], meta["twitter:description"], meta.description);
  const thumbnailUrl = absoluteCandidate(first(meta["og:image"], meta["twitter:image"], meta.thumbnailurl, jsonLdVideo?.thumbnailUrl ?? undefined), base);
  const width = number(first(meta["og:video:width"], meta["video:width"])) ?? jsonLdVideo?.width ?? null;
  const height = number(first(meta["og:video:height"], meta["video:height"])) ?? jsonLdVideo?.height ?? null;
  const durationSeconds =
    number(first(meta["video:duration"], meta.duration, meta["og:video:duration"])) ??
    jsonLdVideo?.durationSeconds ??
    tiktok?.durationSeconds ??
    null;
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20_000);
  return { meta, candidates, title, description, thumbnailUrl, width, height, durationSeconds, rawStates: { universal: rawUniversal, sigi: rawSigi }, jsonLd, jsonLdVideo, tiktok, text };
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

/** Stable error code for a classified access status. */
export function errorCodeForAccess(status: VideoAccessStatus): BrowserErrorCode {
  switch (status) {
    case "blocked_url":
      return "blocked_url";
    case "login_required":
    case "private":
    case "expired":
      return "VIDEO_NOT_PUBLIC";
    case "challenge_required":
    case "rate_limited":
      return "PLATFORM_BLOCKED";
    case "not_found":
    // A reachable page that exposes no playable public media is reported the
    // same way as a missing item: DEMO found no video to work with.
    case "unavailable":
      return "VIDEO_NOT_FOUND";
    case "unsupported":
      return "UNSUPPORTED_MEDIA";
    default:
      return "VIDEO_NOT_PUBLIC";
  }
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

function emptyAccessFlags(): TikTokAccessFlags {
  return { privateItem: null, secret: null, authorPrivateAccount: null, isEmbedBanned: null, takenDown: null, isAd: null };
}

/** The honest "we know nothing" detail block. */
export function emptyResolutionDetail(status: VideoAccessStatus = "unknown", label = "DEMO could not determine whether this video is publicly accessible."): VideoResolutionDetail {
  return {
    access: { status, label, mayDescribeContent: status === "public" },
    accessStatus: status,
    canonicalUrl: null,
    videoId: null,
    creator: null,
    caption: null,
    captionSource: null,
    hashtags: [],
    createdAt: null,
    stats: null,
    music: null,
    accessFlags: emptyAccessFlags(),
    isImagePost: false,
    streams: [],
    streamCount: 0,
    metadataSource: "none",
    platformStatusCode: null,
    platformStatusMessage: null,
    httpStatus: null,
    verification: "none",
    signature: null,
  };
}

/**
 * Build the rich detail block from a parsed page + probe outcome. Every field
 * comes from something the page published or a request DEMO actually made.
 */
function buildDetail(input: {
  parsed?: ParsedPage | null;
  streams: StreamCandidate[];
  chosen: StreamCandidate | null;
  verification: VideoVerification;
  signature: MediaSignature | null;
  httpStatus: number | null;
  access: AccessStatusInfo;
  resolvedUrl?: string | null;
  metadataSource?: VideoMetadataSource;
}): VideoResolutionDetail {
  const parsed = input.parsed ?? null;
  const tiktok = parsed?.tiktok ?? null;
  const jsonLdVideo = parsed?.jsonLdVideo ?? null;
  const caption = tiktok?.description ?? jsonLdVideo?.description ?? parsed?.description ?? null;
  const captionSource: VideoResolutionDetail["captionSource"] = tiktok?.description
    ? "tiktok_post"
    : jsonLdVideo?.description
      ? "json_ld"
      : parsed?.description
        ? "og_description"
        : parsed?.title
          ? "page_title"
          : null;
  const creator: VideoCreator | null = tiktok?.author
    ? { id: tiktok.author.id ?? null, uniqueId: tiktok.author.uniqueId ?? null, nickname: tiktok.author.nickname ?? null, verified: tiktok.author.verified ?? null }
    : jsonLdVideo?.authorName
      ? { id: null, uniqueId: null, nickname: jsonLdVideo.authorName, verified: null }
      : null;
  const metadataSource: VideoMetadataSource = input.metadataSource ?? (tiktok ? tiktok.source : jsonLdVideo ? "json_ld" : parsed ? "meta" : "none");
  return {
    access: input.access,
    accessStatus: input.access.status,
    canonicalUrl: tiktok?.canonicalUrl ?? input.resolvedUrl ?? null,
    videoId: tiktok?.videoId ?? null,
    creator,
    caption: caption ? caption.slice(0, LIMITS.videoMaxCaptionChars) : null,
    captionSource,
    hashtags: tiktok?.hashtags ?? [],
    createdAt: tiktok?.createdAt ?? jsonLdVideo?.uploadDate ?? null,
    stats: tiktok?.stats ?? null,
    music: tiktok?.music ?? null,
    accessFlags: tiktok?.accessFlags ?? emptyAccessFlags(),
    isImagePost: Boolean(tiktok?.isImagePost),
    streams: input.streams,
    streamCount: input.streams.length,
    metadataSource,
    platformStatusCode: tiktok?.statusCode ?? null,
    platformStatusMessage: tiktok?.statusMessage ?? null,
    httpStatus: input.httpStatus,
    verification: input.verification,
    signature: input.signature,
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
    candidateCount: extra.candidateCount ?? 0,
    challenge: extra.challenge ?? { detected: false, kind: null, reason: null },
    limitations: extra.limitations ?? [],
    detail: extra.detail ?? emptyResolutionDetail(),
    ...(extra.pageText ? { pageText: extra.pageText } : {}),
  };
}

export interface ProbeOutcome {
  /** The candidate, mutated with the probe result. */
  candidate: StreamCandidate;
  /** Final URL after safe redirects. */
  finalUrl: string | null;
  /** True when the candidate should be accepted as the media URL. */
  accepted: boolean;
  acceptedReason: string | null;
}

/**
 * Probe one candidate with normal public requests.
 *
 * Order: HEAD (cheap content type + length), then a bounded ranged GET when the
 * bytes must be verified or when the CDN refused HEAD. A ranged GET of the
 * first 128 KiB is a normal public request — it is never used to work around a
 * challenge, and it is what lets DEMO prove the response is a video container
 * rather than an HTML wall, a JSON error or a JPEG thumbnail.
 */
async function probeStream(candidate: StreamCandidate, pageUrl: string, env: VideoEnv, options: { verifyBytes: boolean }): Promise<ProbeOutcome> {
  const timeoutMs = LIMITS.videoResolveTimeoutMs;
  if (signedUrlExpired(candidate.url)) {
    candidate.reachable = false;
    candidate.reason = "The URL declares a signature expiry that has already passed, so it was not requested.";
    return { candidate, finalUrl: null, accepted: false, acceptedReason: null };
  }
  let type: string | null = null;
  let length: number | null = null;
  let finalUrl: string | null = null;
  let headOk = false;
  try {
    const head = await fetchPublic(candidate.url, env, { method: "HEAD" }, { timeoutMs, referer: pageUrl });
    type = contentType(head.response);
    length = parseLength(head.response.headers.get("content-length"));
    finalUrl = head.finalUrl;
    headOk = head.response.ok;
    await head.response.body?.cancel().catch(() => undefined);
    if (!headOk && head.response.status !== 405 && head.response.status !== 403 && head.response.status !== 501) {
      candidate.reachable = false;
      candidate.contentType = type;
      candidate.reason = `Media probe returned HTTP ${head.response.status}${type ? ` (${type})` : ""}.`;
      return { candidate, finalUrl, accepted: false, acceptedReason: null };
    }
  } catch (error) {
    candidate.reachable = false;
    candidate.reason = safeMessage(error);
    return { candidate, finalUrl, accepted: false, acceptedReason: null };
  }

  const declaredVideo = isVideoContentType(type) || looksLikeMediaUrl(finalUrl ?? candidate.url);
  if (!options.verifyBytes && headOk && declaredVideo) {
    candidate.reachable = true;
    candidate.contentType = type;
    candidate.bytes = length;
    candidate.reason = "Accepted from the declared video content type; body bytes were not read during resolution.";
    return { candidate, finalUrl, accepted: true, acceptedReason: "content_type" };
  }

  // Read a bounded leading sample and classify the actual bytes.
  try {
    const ranged = await fetchPublic(candidate.url, env, { method: "GET", headers: { range: `bytes=0-${LIMITS.videoHeadProbeBytes - 1}`, accept: "video/*,application/octet-stream;q=0.8" } }, { timeoutMs, referer: pageUrl });
    const rangedType = contentType(ranged.response);
    const rangedLength = parseLength(ranged.response.headers.get("content-range")?.split("/")[1] ?? ranged.response.headers.get("content-length"));
    finalUrl = ranged.finalUrl;
    const ok = ranged.response.ok || ranged.response.status === 206;
    const bytes = ok ? await readBounded(ranged.response, LIMITS.videoHeadProbeBytes, timeoutMs) : new Uint8Array();
    if (!ok) {
      await ranged.response.body?.cancel().catch(() => undefined);
      candidate.reachable = false;
      candidate.contentType = rangedType ?? type;
      candidate.reason = `Media probe returned HTTP ${ranged.response.status}${rangedType ? ` (${rangedType})` : ""}.`;
      return { candidate, finalUrl, accepted: false, acceptedReason: null };
    }
    candidate.reachable = true;
    candidate.contentType = rangedType ?? type;
    candidate.bytes = length ?? rangedLength;
    if (bytes.byteLength === 0) {
      // A CDN that answers 200/206 with an empty body gives DEMO no bytes to
      // prove anything. Report that honestly instead of claiming verification.
      candidate.reason = "The probe returned no body bytes; acceptance can only rest on the declared content type.";
      return { candidate, finalUrl, accepted: declaredVideo, acceptedReason: declaredVideo ? "content_type" : null };
    }
    const signature = detectMediaSignature(bytes, candidate.contentType);
    candidate.verifiedContainer = signature.container ?? signature.detectedAs;
    candidate.verifiedVideo = signature.isVideo;
    candidate.reason = signature.isVideo ? `Byte signature proved a ${candidate.verifiedContainer} container.` : signature.detail ?? `The response is ${signature.detectedAs}, not a video container.`;
    if (!signature.isVideo) return { candidate, finalUrl, accepted: false, acceptedReason: null };
    return { candidate, finalUrl, accepted: true, acceptedReason: "bytes" };
  } catch (error) {
    candidate.reachable = false;
    // The declared size from the HEAD probe is still true and still policy-
    // relevant: keep it so a caller can refuse an oversized stream before
    // downloading, instead of losing the only size signal it had.
    if (length !== null) candidate.bytes = length;
    candidate.reason = safeMessage(error);
    return { candidate, finalUrl, accepted: declaredVideo && headOk, acceptedReason: declaredVideo && headOk ? "content_type" : null };
  }
}

export interface ResolveOptions {
  /** Preferred quality when several literal streams are published. */
  quality?: QualityPreference;
  /** How many ranked candidates to probe (bounded by LIMITS.videoMaxProbedStreams). */
  probeLimit?: number;
  /** Read real bytes to prove the response is a video container (default false). */
  verifyBytes?: boolean;
}

/**
 * Resolve a public page or direct media URL. Platform extractors only consume
 * literal URLs and metadata exposed by the page; they do not use cookies,
 * private APIs, signature cracking, or CAPTCHA handling.
 *
 * The result always carries an honest `detail.access` verdict: `public`,
 * `deleted`, `private`, `login_required`, `region_restricted`,
 * `challenge_required`, `rate_limited`, `not_found`, `expired`, `blocked_url`,
 * `unsupported`, `unavailable` or `unknown`. Anything other than `public` means
 * no video content may be described.
 */
export async function resolvePublicVideo(sourceUrl: string, env: VideoEnv, options: ResolveOptions = {}): Promise<VideoResolution> {
  const platform = platformForUrl(sourceUrl);
  const quality = options.quality ?? "auto";
  const probeLimit = Math.max(1, Math.min(options.probeLimit ?? 3, LIMITS.videoMaxProbedStreams));
  const verifyBytes = options.verifyBytes === true;

  let guarded: string;
  try {
    guarded = (await assertNavigableUrl(sourceUrl, videoGuardOptions(env))).url;
  } catch (error) {
    const info = error instanceof BrowserError ? error : null;
    const access = classifyAccess({ platform, errorCode: info?.code ?? "VIDEO_NOT_PUBLIC" });
    return resolutionFailure(sourceUrl, platform, info?.code ?? "VIDEO_NOT_PUBLIC", info?.message ?? safeMessage(error), {
      detail: { ...emptyResolutionDetail(access.status, access.label), access },
    });
  }

  const likelyDirect = looksLikeMediaUrl(guarded);
  const directCandidate: StreamCandidate | null = likelyDirect
    ? pushCandidate([], { url: guarded, source: "direct_url" })
    : null;

  let head: PublicFetchResult | null = null;
  try {
    head = await fetchPublic(guarded, env, { method: "HEAD" }, { timeoutMs: LIMITS.videoResolveTimeoutMs });
    const type = contentType(head.response);
    if (head.response.ok && (isVideoContentType(type) || isAudioContentType(type) || likelyDirect)) {
      if (isAudioContentType(type) && !isVideoContentType(type)) {
        const access = classifyAccess({ platform, httpStatus: head.response.status, signature: { kind: "audio", detectedAs: "mp3", container: "audio", isVideo: false, isImage: false, isDocument: false, signatureIsVideo: false, brand: null, detail: "audio only" } as MediaSignature });
        return resolutionFailure(sourceUrl, platform, "UNSUPPORTED_MEDIA", "The URL points to audio rather than video.", {
          resolvedUrl: head.finalUrl,
          redirects: head.redirects,
          metadata: mediaMetadata({ contentType: type, contentLength: parseLength(head.response.headers.get("content-length")) }),
          detail: { ...emptyResolutionDetail(access.status, access.label), access, httpStatus: head.response.status, metadataSource: "http_headers", verification: "content_type" },
        });
      }
      const streams = directCandidate ? [directCandidate] : [];
      if (directCandidate) {
        directCandidate.reachable = true;
        directCandidate.contentType = type;
        directCandidate.bytes = parseLength(head.response.headers.get("content-length"));
        directCandidate.reason = "The URL itself answered a public HEAD request with a video content type.";
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
        candidateCount: 1,
        challenge: { detected: false, kind: null, reason: null },
        limitations: type ? [] : ["The CDN did not provide a video content type; the URL extension was used as a bounded hint."],
        detail: buildDetail({
          streams,
          chosen: directCandidate,
          verification: type ? "content_type" : "none",
          signature: null,
          httpStatus: head.response.status,
          access: classifyAccess({ platform, httpStatus: head.response.status, playableStreamFound: true }),
          resolvedUrl: head.finalUrl,
          metadataSource: "http_headers",
        }),
      };
    }
  } catch (error) {
    // A failed HEAD is not enough to deny a public page. Fall through to a
    // bounded GET, but preserve a useful error for direct media URLs.
    if (likelyDirect && error instanceof BrowserError && error.code !== "VIDEO_NOT_PUBLIC") {
      const access = classifyAccess({ platform, errorCode: error.code, pageText: error.message });
      return resolutionFailure(sourceUrl, platform, error.code, error.message, {
        detail: { ...emptyResolutionDetail(access.status, access.label), access },
      });
    }
  } finally {
    await head?.response.body?.cancel().catch(() => undefined);
  }

  let page: PublicFetchResult;
  try {
    page = await fetchPublic(guarded, env, { method: "GET", headers: { accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.8" } }, { timeoutMs: LIMITS.videoResolveTimeoutMs });
  } catch (error) {
    const info = error instanceof BrowserError ? error : null;
    const access = classifyAccess({ platform, errorCode: info?.code ?? "VIDEO_NOT_PUBLIC", pageText: info?.message });
    return resolutionFailure(sourceUrl, platform, info?.code ?? "VIDEO_NOT_PUBLIC", info?.message ?? safeMessage(error), {
      detail: { ...emptyResolutionDetail(access.status, access.label), access },
    });
  }
  const pageType = contentType(page.response);
  if (isVideoContentType(pageType)) {
    const streams = directCandidate ? [directCandidate] : [];
    if (directCandidate) {
      directCandidate.reachable = true;
      directCandidate.contentType = pageType;
      directCandidate.bytes = parseLength(page.response.headers.get("content-length"));
    }
    await page.response.body?.cancel().catch(() => undefined);
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
      candidateCount: 1,
      challenge: { detected: false, kind: null, reason: null },
      limitations: [],
      detail: buildDetail({
        streams,
        chosen: directCandidate,
        verification: "content_type",
        signature: null,
        httpStatus: page.response.status,
        access: classifyAccess({ platform, httpStatus: page.response.status, playableStreamFound: true }),
        resolvedUrl: page.finalUrl,
        metadataSource: "http_headers",
      }),
    };
  }

  const text = await readTextBounded(page.response, LIMITS.videoMaxHtmlBytes).catch((error) => {
    throw videoError("VIDEO_NOT_PUBLIC", `The public page body could not be read: ${safeMessage(error)}`);
  });
  const challenge = platformChallenge(page.response.status, text, page.response.headers);
  const parsed = parsePage(text, page.finalUrl);
  const ranked = rankStreams(parsed.candidates, quality);

  // A JSON API response is not a video, and saying so precisely matters.
  const pageSignature = detectMediaSignature(new TextEncoder().encode(text.slice(0, 4_096)), pageType);
  const tiktok = parsed.tiktok;

  let chosen: StreamCandidate | null = null;
  let chosenFinalUrl: string | null = null;
  let verification: VideoVerification = "none";
  let chosenSignature: MediaSignature | null = null;
  let probes = 0;
  for (const candidate of ranked) {
    if (probes >= probeLimit) break;
    if (candidate.kind === "image") continue; // a thumbnail is never a stream
    probes++;
    const outcome = await probeStream(candidate, page.finalUrl, env, { verifyBytes });
    if (!outcome.accepted) continue;
    chosen = candidate;
    chosenFinalUrl = outcome.finalUrl ?? candidate.url;
    verification = outcome.acceptedReason === "bytes" ? "bytes" : "content_type";
    chosenSignature = candidate.verifiedContainer ? { ...emptySignature(), container: candidate.verifiedContainer, detectedAs: candidate.verifiedContainer as MediaSignature["detectedAs"], kind: "video", isVideo: true, signatureIsVideo: outcome.acceptedReason === "bytes" } : null;
    break;
  }

  const metadata = mediaMetadata({
    durationSeconds: parsed.durationSeconds,
    width: chosen?.width ?? parsed.width,
    height: chosen?.height ?? parsed.height,
    contentType: chosen?.contentType ?? null,
    contentLength: chosen?.bytes ?? null,
    title: parsed.title ?? tiktok?.description?.slice(0, 200) ?? null,
    description: parsed.description ?? tiktok?.description ?? parsed.jsonLdVideo?.description ?? null,
    thumbnailUrl: parsed.thumbnailUrl ?? tiktok?.thumbnail ?? null,
  });

  if (chosen) {
    const access = classifyAccess({
      platform,
      httpStatus: page.response.status,
      platformStatusCode: tiktok?.statusCode,
      challenge,
      pageText: parsed.text,
      playableStreamFound: true,
      signature: chosenSignature,
    });
    return {
      success: true,
      sourceUrl,
      resolvedUrl: page.finalUrl,
      mediaUrl: chosenFinalUrl ?? chosen.url,
      platform,
      metadata,
      status: "resolved",
      error: null,
      message: null,
      redirects: page.redirects,
      candidateCount: ranked.length,
      challenge,
      limitations: [
        ...(challenge.detected ? ["The page also contained challenge/login signals; only the separately public media URL was used."] : []),
        ...(verification === "bytes" ? [] : ["The media server's declared content type was accepted without reading body bytes; video_fetch verifies the actual container signature before storing anything."]),
        ...(chosen.signed ? ["The chosen stream URL is signed and short-lived; it may stop working within minutes and is never persisted."] : []),
        ...(tiktok?.isImagePost ? ["This TikTok post is an image carousel, not a video."] : []),
      ],
      pageText: parsed.text,
      detail: buildDetail({
        parsed,
        streams: ranked,
        chosen,
        verification,
        signature: chosenSignature,
        httpStatus: page.response.status,
        access,
        resolvedUrl: page.finalUrl,
      }),
    };
  }

  // A page whose only media candidates are HLS/DASH manifests is not "no video
  // found": it is a delivery format DEMO deliberately does not assemble. Say so
  // precisely, because the honest next step is different (try frame extraction
  // through a real browser rather than re-resolving).
  const playableCandidates = ranked.filter((candidate) => candidate.kind !== "image");
  const manifestOnly = playableCandidates.length > 0 && playableCandidates.every((candidate) => candidate.kind === "manifest");
  // Every published stream was signed and its own expiry parameter had already
  // passed: that is an expired link, not an unknown/unavailable video, and the
  // actionable next step (re-resolve the original link) depends on saying so.
  const allStreamsExpired = playableCandidates.length > 0 && playableCandidates.every((candidate) => candidate.signed && signedUrlExpired(candidate.url));
  // Every published stream was signed and each one refused a normal public
  // request with 403/410. That is how an expired platform signature presents
  // itself, and the actionable next step is to re-resolve the original link.
  const probedCandidates = playableCandidates.filter((candidate) => candidate.reachable !== null);
  const signedStreamsDenied =
    probedCandidates.length > 0 &&
    probedCandidates.every((candidate) => candidate.signed && candidate.reachable === false && /HTTP (?:403|410)/.test(candidate.reason ?? ""));
  const access = classifyAccess({
    platform,
    httpStatus: page.response.status,
    platformStatusCode: tiktok?.statusCode,
    challenge,
    errorCode: null,
    pageText: parsed.text,
    playableStreamFound: false,
    metadataOnly: Boolean(parsed.title || parsed.description || parsed.thumbnailUrl || tiktok),
    artifactExpired: allStreamsExpired || signedStreamsDenied,
    signature: manifestOnly
      ? playlistSignature()
      : pageSignature.isDocument || pageSignature.kind === "playlist"
        ? pageSignature
        : null,
  });
  const error = access.status === "public" ? (ranked.length ? "VIDEO_NOT_PUBLIC" : "VIDEO_NOT_FOUND") : errorCodeForAccess(access.status);
  return resolutionFailure(sourceUrl, platform, error, access.label, {
    resolvedUrl: page.finalUrl,
    redirects: page.redirects,
    candidateCount: ranked.length,
    metadata,
    challenge,
    limitations: [
      "Only public HTML metadata and literal media URLs were inspected.",
      "DEMO does not bypass login walls, CAPTCHA/bot challenges, DRM, private accounts or platform access controls.",
      ...(ranked.length ? [`${ranked.length} media candidate(s) were exposed but none accepted a normal public probe.`] : ["No literal playable media URL was exposed in the public HTML response."]),
      ...(allStreamsExpired ? ["Every published stream URL carried a signature expiry that had already passed, so none were requested. Signed platform media URLs typically live only minutes; re-resolving the original public link yields fresh ones."] : []),
      ...(signedStreamsDenied ? ["Every signed stream URL refused a normal public request (HTTP 403/410), which is how an expired platform signature presents itself. Re-resolve the original public link for fresh URLs; DEMO does not forge or reuse signatures."] : []),
      ...(manifestOnly ? ["Every media candidate was an HLS/DASH manifest. DEMO does not assemble segment playlists into a downloadable file; frame extraction through Cloudflare Browser Rendering may still work on the page itself."] : []),
      ...(parsed.thumbnailUrl ? ["A thumbnail was found but is never substituted for video content."] : []),
      ...(tiktok?.limitations ?? []),
    ],
    pageText: parsed.text,
    detail: buildDetail({ parsed, streams: ranked, chosen: null, verification: "none", signature: manifestOnly ? playlistSignature() : pageSignature.isDocument ? pageSignature : null, httpStatus: page.response.status, access, resolvedUrl: page.finalUrl }),
  });
}

/** Signature value used to classify a manifest-only page as `unsupported`. */
function playlistSignature(): MediaSignature {
  return { kind: "playlist", detectedAs: "hls_playlist", container: null, isVideo: false, isImage: false, isDocument: false, signatureIsVideo: false, brand: null, detail: "Only HLS/DASH manifest candidates were published." };
}

function emptySignature(): MediaSignature {
  return { kind: "video", detectedAs: "mp4", container: null, isVideo: true, isImage: false, isDocument: false, signatureIsVideo: false, brand: null, detail: null };
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
  code: Extract<
    BrowserErrorCode,
    | "VIDEO_NOT_FOUND"
    | "VIDEO_NOT_PUBLIC"
    | "PLATFORM_BLOCKED"
    | "UNSUPPORTED_MEDIA"
    | "DOWNLOAD_TOO_LARGE"
    | "PROCESSING_TIMEOUT"
    | "FRAMES_UNAVAILABLE"
    | "TRANSCRIPTION_UNAVAILABLE"
    | "NOT_A_VIDEO"
    | "ARTIFACT_EXPIRED"
    | "PROVIDER_UNAVAILABLE"
  >,
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
