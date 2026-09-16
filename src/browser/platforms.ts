/**
 * Instagram / YouTube / X / Reddit public-metadata extraction.
 *
 * Same contract as `tiktok.ts`: DEMO only reports structured data the page
 * itself already handed to the browser. It never signs requests, never calls a
 * private platform API, never deciphers a signature/cipher parameter, never
 * assembles HLS/DASH segment playlists, and never attempts to defeat access
 * controls. When a platform serves a login wall, hides the media, ships only
 * manifests, or requires an account, the parser reports that precisely instead
 * of inventing data.
 *
 * Each parser reads literal values already present in the served HTML:
 * hydration JSON (`ytInitialPlayerResponse`, `__NEXT_DATA__`, shortcode
 * media JSON, `shreddit-player` attributes), JSON-LD, and OpenGraph meta.
 * Everything is bounded so a pathological page cannot burn CPU.
 */

export interface PlatformStreamUrl {
  url: string;
  source:
    | "instagram.video_url"
    | "instagram.playable_url"
    | "youtube.format_url"
    | "youtube.hls"
    | "youtube.dash"
    | "x.variant"
    | "x.hls"
    | "reddit.fallback"
    | "reddit.hls"
    | "reddit.dash";
  width?: number | null;
  height?: number | null;
  bitrate?: number | null;
}

export interface PlatformManifest {
  url: string;
  kind: "hls" | "dash";
}

/**
 * A precise access verdict from the platform's own payload (mirrors TikTok's
 * `statusCode` handling): the page returned HTTP 200 but its JSON says the
 * item is private, login-gated, deleted, or otherwise not publicly playable.
 */
export interface PlatformAccessHint {
  status: "private" | "login_required" | "not_found" | "unavailable" | "unsupported" | "challenge_required" | "rate_limited";
  label: string;
}

export interface PlatformVideoInfo {
  platform: "instagram" | "youtube" | "x" | "reddit";
  videoId: string | null;
  canonicalUrl: string | null;
  author: { uniqueId?: string | null; nickname?: string | null } | null;
  description: string | null;
  createdAt: string | null;
  durationSeconds: number | null;
  thumbnail: string | null;
  width: number | null;
  height: number | null;
  isImagePost: boolean;
  /** True when the page published manifests but no playable progressive URL. */
  manifestOnly: boolean;
  streams: PlatformStreamUrl[];
  /** HLS/DASH playlist URLs: reported for honesty, never streamed. */
  manifests: PlatformManifest[];
  accessHint: PlatformAccessHint | null;
  /** Platform status text (e.g. YouTube's playability verdict). */
  statusMessage: string | null;
  limitations: string[];
  source: "platform_payload" | "json_ld" | "meta" | "none";
}

export interface PlatformParseInput {
  url: string;
  html: string;
  meta?: Record<string, string>;
  jsonLd?: unknown[];
}

type Json = Record<string, unknown>;

const SCAN_BUDGET = 1_500_000;
const MAX_HITS = 25;

function asObject(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Unescape a JSON string value as shipped inside HTML (`\/`, `\u0026`, …). */
function unescapeJsonString(value: string): string {
  return value
    .replace(/\\u0026/gi, "&")
    .replace(/\\u002F/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"');
}

function absoluteUrl(value: string | null | undefined, base: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(unescapeJsonString(value).trim(), base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Bounded balanced-JSON extraction starting at `start` (mirrors http.ts). */
function extractBalancedJson(text: string, start: number, budget = SCAN_BUDGET): string | null {
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

/** `varName = {…}` assignment payload anywhere in the document. */
function extractAssignment(html: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(?=[{\\[])`);
  const match = pattern.exec(html.slice(0, SCAN_BUDGET));
  if (!match || match.index === undefined) return null;
  return extractBalancedJson(html, match.index + match[0].length);
}

/** `<script id="…">` JSON payload. */
function extractScriptJson(html: string, id: string): string | null {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<script[^>]*(?:id=["']${escaped}["'])[^>]*>([\\s\\S]*?)<\\/script>`, "i").exec(html.slice(0, SCAN_BUDGET));
  const raw = match?.[1]?.trim();
  return raw ? raw.slice(0, SCAN_BUDGET) : null;
}

function tryParse(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Bounded depth-first search for objects matching `predicate`. Used for deeply
 * nested hydration payloads (`__NEXT_DATA__`) where the path is unstable but
 * the leaf shape (`video_info.variants`) is not.
 */
function findAll(root: unknown, predicate: (node: Json) => boolean, limit = MAX_HITS): Json[] {
  const hits: Json[] = [];
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  let visited = 0;
  while (stack.length > 0 && hits.length < limit && visited < 20_000) {
    const { node, depth } = stack.pop() as { node: unknown; depth: number };
    visited++;
    if (depth > 40) continue;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0 && stack.length < 20_000; i--) stack.push({ node: node[i], depth: depth + 1 });
      continue;
    }
    const object = asObject(node);
    if (!object) continue;
    if (predicate(object)) hits.push(object);
    const keys = Object.keys(object);
    for (let i = keys.length - 1; i >= 0 && stack.length < 20_000; i--) stack.push({ node: object[keys[i]], depth: depth + 1 });
  }
  return hits;
}

/** First window of `radius` chars around `needle`, for nearby-field reads. */
function windowAround(html: string, needle: string, radius = 800): string | null {
  const index = html.indexOf(needle);
  if (index < 0) return null;
  return html.slice(Math.max(0, index - radius), Math.min(html.length, index + needle.length + radius));
}

function emptyInfo(
  platform: PlatformVideoInfo["platform"],
  videoId: string | null,
  canonicalUrl: string | null,
): PlatformVideoInfo {
  return {
    platform,
    videoId,
    canonicalUrl,
    author: null,
    description: null,
    createdAt: null,
    durationSeconds: null,
    thumbnail: null,
    width: null,
    height: null,
    isImagePost: false,
    manifestOnly: false,
    streams: [],
    manifests: [],
    accessHint: null,
    statusMessage: null,
    limitations: [],
    source: "none",
  };
}

function pushStream(streams: PlatformStreamUrl[], url: string | null, source: PlatformStreamUrl["source"], extra: { width?: number | null; height?: number | null; bitrate?: number | null } = {}): void {
  if (!url || url.length > 4_000) return;
  if (streams.some((entry) => entry.url === url)) return;
  if (streams.length >= MAX_HITS) return;
  streams.push({ url, source, width: extra.width ?? null, height: extra.height ?? null, bitrate: extra.bitrate ?? null });
}

/* -------------------------------------------------------------------------- */
/* Instagram                                                                  */
/* -------------------------------------------------------------------------- */

export function isInstagramUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "instagram.com" || host.endsWith(".instagram.com") || host === "instagr.am";
  } catch {
    return false;
  }
}

export function extractInstagramShortcode(url: string): { kind: string; shortcode: string } | null {
  try {
    const match = /\/(reel|reels|p|tv)\/([A-Za-z0-9_-]{5,})/.exec(new URL(url).pathname);
    return match ? { kind: match[1] === "reels" ? "reel" : match[1], shortcode: match[2] } : null;
  } catch {
    return null;
  }
}

export function parseInstagram(input: PlatformParseInput): PlatformVideoInfo | null {
  if (!isInstagramUrl(input.url)) return null;
  const { url, html, meta = {} } = input;
  const scanned = html.slice(0, SCAN_BUDGET);
  const id = extractInstagramShortcode(url);
  const info = emptyInfo("instagram", id?.shortcode ?? null, id ? `https://www.instagram.com/${id.kind}/${id.shortcode}/` : null);

  // Owner + privacy from the shortcode-media JSON (bounded literal scan).
  const ownerWindow = windowAround(scanned, '"owner"') ?? "";
  const username = /"username"\s*:\s*"([^"]{1,100})"/.exec(ownerWindow)?.[1] ?? null;
  if (username) info.author = { uniqueId: username, nickname: username };
  const ownerPrivate = /"is_private"\s*:\s*true/.test(ownerWindow.slice(0, 2_000));

  const typename = /"__typename"\s*:\s*"(GraphVideo|GraphImage|GraphSidecar|GraphStoryVideo)"/.exec(scanned)?.[1] ?? null;
  if (typename === "GraphImage") info.isImagePost = true;

  // Literal video URLs. Instagram ships several aliases for the same MP4.
  for (const match of scanned.matchAll(/"video_url"\s*:\s*"([^"]{8,2000})"/g)) {
    pushStream(info.streams, absoluteUrl(match[1], url), "instagram.video_url");
    if (info.streams.length >= MAX_HITS) break;
  }
  for (const match of scanned.matchAll(/"playable_url(?:_quality_hd)?"\s*:\s*"([^"]{8,2000})"/g)) {
    pushStream(info.streams, absoluteUrl(match[1], url), "instagram.playable_url");
    if (info.streams.length >= MAX_HITS) break;
  }

  const duration = /"video_duration"\s*:\s*([\d.]{1,12})/.exec(scanned)?.[1];
  if (duration) info.durationSeconds = num(duration);

  const dimensions = windowAround(scanned, '"video_url"') ?? windowAround(scanned, '"playable_url"') ?? "";
  const width = /"width"\s*:\s*(\d{2,5})/.exec(dimensions)?.[1];
  const height = /"height"\s*:\s*(\d{2,5})/.exec(dimensions)?.[1];
  if (width) info.width = num(width);
  if (height) info.height = num(height);

  const caption = /"edge_media_to_caption"[\s\S]{0,600}?"text"\s*:\s*"([^"]{1,2000})"/.exec(scanned)?.[1];
  if (caption) {
    info.description = unescapeJsonString(caption).replace(/\\n/g, "\n").slice(0, 2_000);
  } else if (meta["og:description"]) {
    info.description = meta["og:description"].slice(0, 2_000);
  }

  const takenAt = /"taken_at"\s*:\s*(\d{9,12})/.exec(scanned)?.[1];
  if (takenAt && num(takenAt)) info.createdAt = new Date(Number(takenAt) * 1_000).toISOString();
  info.thumbnail = absoluteUrl(meta["og:image"], url);

  if (info.streams.length > 0 || typename || username || duration) info.source = "platform_payload";
  else if (info.description || info.thumbnail) info.source = "meta";

  if (ownerPrivate && info.streams.length === 0) {
    info.accessHint = { status: "private", label: "The Instagram account publishes its posts as private, so no public media URL is available." };
  }
  if (info.streams.length === 0 && /Log in • Instagram|login_required/i.test(scanned.slice(0, 50_000))) {
    info.accessHint = info.accessHint ?? { status: "login_required", label: "Instagram served a login wall instead of the public post." };
  }

  info.limitations.push("Instagram CDN URLs are expiring: they typically stop working within hours and are never persisted.");
  if (info.isImagePost) info.limitations.push("This Instagram post is a photo, not a video.");
  if (info.streams.length === 0 && !info.isImagePost && !info.accessHint) {
    info.limitations.push("Instagram shipped no literal video URL in the public HTML response; its media usually requires the page's own player session.");
  }
  return info;
}

/* -------------------------------------------------------------------------- */
/* YouTube                                                                    */
/* -------------------------------------------------------------------------- */

export function isYouTubeUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be";
  } catch {
    return false;
  }
}

export function extractYouTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === "youtu.be") {
      const id = parsed.pathname.split("/").filter(Boolean)[0];
      return id && /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : null;
    }
    const param = parsed.searchParams.get("v");
    if (param && /^[A-Za-z0-9_-]{6,}$/.test(param)) return param;
    const match = /\/(shorts|embed|live|v)\/([A-Za-z0-9_-]{6,})/.exec(parsed.pathname);
    return match ? match[2] : null;
  } catch {
    return null;
  }
}

export function parseYouTube(input: PlatformParseInput): PlatformVideoInfo | null {
  if (!isYouTubeUrl(input.url)) return null;
  const { url, html, meta = {} } = input;
  const scanned = html.slice(0, SCAN_BUDGET);
  const videoId = extractYouTubeVideoId(url);
  const info = emptyInfo("youtube", videoId, videoId ? `https://www.youtube.com/watch?v=${videoId}` : null);

  const player = asObject(tryParse(extractAssignment(scanned, "ytInitialPlayerResponse")));
  const details = asObject(player?.videoDetails);
  const playability = asObject(player?.playabilityStatus);
  const playabilityStatus = str(playability?.status);
  const playabilityReason = str(playability?.reason);

  if (details) {
    const title = str(details.title);
    if (title) info.description = str(details.shortDescription)?.slice(0, 2_000) ?? title.slice(0, 2_000);
    const author = str(details.author);
    if (author) info.author = { uniqueId: null, nickname: author };
    const lengthSeconds = num(details.lengthSeconds);
    if (lengthSeconds !== null) info.durationSeconds = lengthSeconds;
    const thumbnails = asObject(details.thumbnail);
    const list = Array.isArray(thumbnails?.thumbnails) ? (thumbnails?.thumbnails as unknown[]) : [];
    const last = asObject(list[list.length - 1]);
    const thumb = str(last?.url);
    if (thumb) info.thumbnail = absoluteUrl(thumb, url);
  }
  if (!info.description && meta["og:title"]) info.description = meta["og:title"].slice(0, 2_000);
  if (!info.thumbnail) info.thumbnail = absoluteUrl(meta["og:image"], url) ?? (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null);

  const publishDate = /"(?:uploadDate|publishDate)"\s*:\s*"([^"]{6,40})"/.exec(scanned)?.[1];
  if (publishDate) {
    const parsed = Date.parse(publishDate);
    if (Number.isFinite(parsed)) info.createdAt = new Date(parsed).toISOString();
  }

  // Streaming formats: ONLY literal `url` values are candidates. Entries with
  // `signatureCipher` are deliberately skipped — deciphering them would defeat
  // a platform access control, which DEMO never does.
  const streaming = asObject(player?.streamingData);
  const formats = Array.isArray(streaming?.formats) ? (streaming?.formats as unknown[]) : [];
  let cipheredCount = 0;
  for (const entry of formats.slice(0, MAX_HITS)) {
    const format = asObject(entry);
    if (!format) continue;
    const literal = str(format.url);
    if (str(format.signatureCipher)) cipheredCount++;
    if (!literal) continue;
    const mimeType = str(format.mimeType) ?? "";
    if (!/video\//i.test(mimeType)) continue;
    pushStream(info.streams, absoluteUrl(literal, url), "youtube.format_url", { width: num(format.width), height: num(format.height), bitrate: num(format.bitrate) });
  }
  const adaptive = Array.isArray(streaming?.adaptiveFormats) ? (streaming?.adaptiveFormats as unknown[]) : [];

  const hlsManifest = str(streaming?.hlsManifestUrl);
  const dashManifest = str(streaming?.dashManifestUrl);
  if (hlsManifest) {
    const absolute = absoluteUrl(hlsManifest, url);
    if (absolute) {
      info.manifests.push({ url: absolute, kind: "hls" });
      pushStream(info.streams, absolute, "youtube.hls");
    }
  }
  if (dashManifest) {
    const absolute = absoluteUrl(dashManifest, url);
    if (absolute) {
      info.manifests.push({ url: absolute, kind: "dash" });
      pushStream(info.streams, absolute, "youtube.dash");
    }
  }

  // First playable stream's dimensions describe the rendition, when present.
  const playable = info.streams.find((entry) => entry.source === "youtube.format_url");
  if (playable?.width) info.width = playable.width;
  if (playable?.height) info.height = playable.height;

  if (player) info.source = "platform_payload";
  else if (info.description || info.thumbnail) info.source = "meta";

  if (playabilityStatus && playabilityStatus !== "OK") {
    info.statusMessage = playabilityReason ? `${playabilityStatus}: ${playabilityReason}`.slice(0, 500) : playabilityStatus;
    if (playabilityStatus === "PRIVATE") {
      info.accessHint = { status: "private", label: "YouTube reports this video as private." };
    } else if (playabilityStatus === "LOGIN_REQUIRED") {
      info.accessHint = { status: "login_required", label: "YouTube requires sign-in to play this video (age gate or restricted visibility)." };
    } else if (playabilityStatus === "UNPLAYABLE") {
      info.accessHint = { status: "unavailable", label: playabilityReason ? `YouTube reports this video as unplayable: ${playabilityReason}`.slice(0, 500) : "YouTube reports this video as unplayable." };
    } else {
      info.accessHint = { status: "unavailable", label: `YouTube's playability verdict is ${playabilityStatus}; no public rendition is playable.` };
    }
  }

  info.manifestOnly = info.manifests.length > 0 && !info.streams.some((entry) => entry.source === "youtube.format_url");
  if (!playabilityStatus && info.streams.length === 0 && /ytInitialPlayerResponse/.test(scanned)) {
    info.limitations.push("YouTube shipped a player response without a playability verdict or any retrievable rendition.");
  }
  if (cipheredCount > 0) {
    info.limitations.push(
      `${cipheredCount} YouTube rendition(s) were published only with an encrypted signature parameter; DEMO never deciphers signatures, so those renditions were not used.`,
    );
  }
  if (adaptive.length > 0) {
    info.limitations.push("YouTube's adaptive (separate audio/video) renditions are not used: only progressive MP4 URLs with audio are candidates.");
  }
  if (info.manifests.length > 0) {
    info.limitations.push("HLS/DASH manifests are reported for honesty but never streamed or assembled into a file.");
  }
  if (info.streams.length === 0 && !info.accessHint) {
    info.limitations.push("No literal progressive video URL was exposed; most YouTube watch pages only expose manifests and ciphered renditions.");
  }
  return info;
}

/* -------------------------------------------------------------------------- */
/* X (Twitter)                                                                */
/* -------------------------------------------------------------------------- */

export function isXUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com");
  } catch {
    return false;
  }
}

export function extractXStatus(url: string): { user: string | null; statusId: string } | null {
  try {
    const parsed = new URL(url);
    const match = /\/([^/]+)\/status\/(\d{5,})/.exec(parsed.pathname);
    if (match) return { user: match[1], statusId: match[2] };
    const bare = /\/status\/(\d{5,})/.exec(parsed.pathname);
    return bare ? { user: null, statusId: bare[1] } : null;
  } catch {
    return null;
  }
}

export function parseX(input: PlatformParseInput): PlatformVideoInfo | null {
  if (!isXUrl(input.url)) return null;
  const { url, html, meta = {} } = input;
  const scanned = html.slice(0, SCAN_BUDGET);
  const status = extractXStatus(url);
  const info = emptyInfo(
    "x",
    status?.statusId ?? null,
    status ? `https://x.com/${status.user ?? "i"}/status/${status.statusId}` : null,
  );
  if (status?.user && status.user !== "i") info.author = { uniqueId: status.user, nickname: null };

  // `__NEXT_DATA__` carries the tweet's `video_info.variants` for public posts.
  const nextData = tryParse(extractScriptJson(scanned, "__NEXT_DATA__"));
  let payloadFound = false;
  let photoOnly = false;
  if (nextData) {
    const videoInfos = findAll(nextData, (node) => Boolean(asObject(node.video_info)?.variants));
    for (const holder of videoInfos) {
      const videoInfo = asObject(holder.video_info);
      const variants = Array.isArray(videoInfo?.variants) ? (videoInfo?.variants as unknown[]) : [];
      if (variants.length === 0) continue;
      payloadFound = true;
      const durationMillis = num(videoInfo?.duration_millis);
      if (durationMillis !== null && info.durationSeconds === null) info.durationSeconds = durationMillis / 1_000;
      for (const entry of variants.slice(0, MAX_HITS)) {
        const variant = asObject(entry);
        const variantUrl = str(variant?.url);
        if (!variantUrl) continue;
        const contentType = str(variant?.content_type) ?? "";
        if (/mpegURL|m3u8/i.test(contentType) || /\.m3u8(?:$|[?#])/i.test(variantUrl)) {
          const absolute = absoluteUrl(variantUrl, url);
          if (absolute) {
            info.manifests.push({ url: absolute, kind: "hls" });
            pushStream(info.streams, absolute, "x.hls");
          }
          continue;
        }
        if (!/video\//i.test(contentType) && !/\.mp4(?:$|[?#])/i.test(variantUrl)) continue;
        pushStream(info.streams, absoluteUrl(variantUrl, url), "x.variant", { bitrate: num(variant?.bitrate) });
      }
    }
    // Tweet text + poster, when the hydration payload is present.
    const texts = findAll(nextData, (node) => typeof node.full_text === "string" && (node.full_text as string).length > 0, 3);
    const fullText = typeof texts[0]?.full_text === "string" ? (texts[0].full_text as string) : null;
    if (fullText) info.description = fullText.slice(0, 2_000);
    const posters = findAll(nextData, (node) => typeof node.media_url_https === "string", 3);
    const poster = typeof posters[0]?.media_url_https === "string" ? (posters[0].media_url_https as string) : null;
    if (poster) info.thumbnail = absoluteUrl(poster, url);
    const created = findAll(nextData, (node) => typeof node.created_at === "string", 3);
    const createdAt = typeof created[0]?.created_at === "string" ? Date.parse(created[0].created_at as string) : Number.NaN;
    if (Number.isFinite(createdAt)) info.createdAt = new Date(createdAt).toISOString();
    const screens = findAll(nextData, (node) => typeof node.screen_name === "string", 3);
    const screenName = typeof screens[0]?.screen_name === "string" ? (screens[0].screen_name as string) : null;
    if (screenName && info.author) info.author = { uniqueId: screenName, nickname: null };
    else if (screenName) info.author = { uniqueId: screenName, nickname: null };
    if (!payloadFound) {
      // Photos without any video_info: an image post, not a video.
      const photos = findAll(nextData, (node) => node.type === "photo" && typeof node.media_url_https === "string", 1);
      if (photos.length > 0) {
        photoOnly = true;
        info.isImagePost = true;
      }
    }
  }
  if (!info.description && meta["og:description"]) info.description = meta["og:description"].slice(0, 2_000);
  if (!info.thumbnail) info.thumbnail = absoluteUrl(meta["og:image"], url);

  if (payloadFound || photoOnly) info.source = "platform_payload";
  else if (info.description || info.thumbnail) info.source = "meta";

  const head = scanned.slice(0, 100_000);
  if (/these posts are protected|protected timeline/i.test(head)) {
    info.accessHint = { status: "private", label: "The X account's posts are protected, so no public media URL is available." };
  } else if (photoOnly) {
    info.limitations.push("This X post carries photos but no video.");
  }
  info.manifestOnly = info.manifests.length > 0 && !info.streams.some((entry) => entry.source === "x.variant");
  if (info.manifests.length > 0) {
    info.limitations.push("The HLS variant playlist is reported for honesty but never streamed or assembled into a file.");
  }
  if (info.streams.length === 0 && !info.accessHint && !info.isImagePost) {
    info.limitations.push("X shipped no literal MP4 variant in the public response; video variants usually require the page's own player session.");
  }
  return info;
}

/* -------------------------------------------------------------------------- */
/* Reddit                                                                     */
/* -------------------------------------------------------------------------- */

export function isRedditUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "reddit.com" || host.endsWith(".reddit.com") || host === "redd.it";
  } catch {
    return false;
  }
}

export function extractRedditPostId(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === "redd.it" || parsed.hostname.toLowerCase().startsWith("v.redd.it")) {
      const id = parsed.pathname.split("/").filter(Boolean)[0];
      return id && /^[a-z0-9]{5,}$/i.test(id) ? id : null;
    }
    const match = /\/comments\/([a-z0-9]{5,})/i.exec(parsed.pathname);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function parseReddit(input: PlatformParseInput): PlatformVideoInfo | null {
  if (!isRedditUrl(input.url) && !/^https?:\/\/v\.redd\.it\//i.test(input.url)) return null;
  const { url, html, meta = {} } = input;
  const scanned = html.slice(0, SCAN_BUDGET);
  const postId = extractRedditPostId(url);
  const info = emptyInfo("reddit", postId, url.split(/[?#]/)[0] || null);

  // New Reddit: `<shreddit-player fallback-url="…/DASH_720.mp4" …>`; old
  // Reddit + embeds: `"fallback_url":"https://v.redd.it/…"` JSON.
  const fallbackAttr = /(?:fallback-url|data-fallback-url)="([^"]{8,2000})"/i.exec(scanned)?.[1];
  const fallbackJson = /"fallback_url"\s*:\s*"([^"]{8,2000})"/.exec(scanned)?.[1];
  const fallback = fallbackAttr ?? fallbackJson;
  if (fallback) pushStream(info.streams, absoluteUrl(fallback, url), "reddit.fallback");

  const hlsAttr = /(?:hls-url|data-hls-url)="([^"]{8,2000})"/i.exec(scanned)?.[1];
  const hlsJson = /"hls_url"\s*:\s*"([^"]{8,2000})"/.exec(scanned)?.[1];
  const hls = hlsAttr ?? hlsJson;
  if (hls) {
    const absolute = absoluteUrl(hls, url);
    if (absolute) {
      info.manifests.push({ url: absolute, kind: "hls" });
      pushStream(info.streams, absolute, "reddit.hls");
    }
  }
  const dashAttr = /(?:dash-url|data-dash-url)="([^"]{8,2000})"/i.exec(scanned)?.[1];
  const dashJson = /"dash_url"\s*:\s*"([^"]{8,2000})"/.exec(scanned)?.[1];
  const dash = dashAttr ?? dashJson;
  if (dash) {
    const absolute = absoluteUrl(dash, url);
    if (absolute) {
      info.manifests.push({ url: absolute, kind: "dash" });
      pushStream(info.streams, absolute, "reddit.dash");
    }
  }

  // Duration/dimensions live next to the reddit_video block; read them in a
  // tight window so unrelated page numbers are never mistaken for media data.
  const window = windowAround(scanned, "fallback_url") ?? windowAround(scanned, "fallback-url") ?? windowAround(scanned, "reddit_video") ?? "";
  const duration = /"duration"\s*:\s*([\d.]{1,12})/.exec(window)?.[1];
  if (duration) info.durationSeconds = num(duration);
  const width = /"width"\s*:\s*(\d{2,5})/.exec(window)?.[1];
  const height = /"height"\s*:\s*(\d{2,5})/.exec(window)?.[1];
  if (width) info.width = num(width);
  if (height) info.height = num(height);

  const author = /"author"\s*:\s*"([^"]{1,100})"/.exec(scanned.slice(0, 200_000))?.[1];
  if (author && author !== "[deleted]") info.author = { uniqueId: author, nickname: null };

  const postTitle = /"title"\s*:\s*"([^"]{1,500})"/.exec(scanned.slice(0, 200_000))?.[1];
  if (postTitle) info.description = unescapeJsonString(postTitle).slice(0, 2_000);
  else if (meta["og:title"]) info.description = meta["og:title"].slice(0, 2_000);
  info.thumbnail = absoluteUrl(meta["og:image"], url);

  const isVideo = /"is_video"\s*:\s*(true|false)/.exec(window)?.[1] ?? /"is_video"\s*:\s*(true|false)/.exec(scanned)?.[1];
  const postHint = /"post_hint"\s*:\s*"([^"]{1,30})"/.exec(scanned)?.[1];
  if ((isVideo === "false" || postHint === "image") && info.streams.length === 0) info.isImagePost = true;

  if (fallback || hls || dash || isVideo !== undefined) info.source = "platform_payload";
  else if (info.description || info.thumbnail) info.source = "meta";

  const head = scanned.slice(0, 100_000);
  if (/this community is private|must be invited to visit this community|private subreddit/i.test(head)) {
    info.accessHint = { status: "private", label: "The subreddit is private, so no public media URL is available." };
  } else if (/this community has been quarantined/i.test(head)) {
    info.accessHint = { status: "challenge_required", label: "The subreddit is quarantined behind a confirmation gate DEMO does not pass." };
  }

  info.manifestOnly = info.manifests.length > 0 && !info.streams.some((entry) => entry.source === "reddit.fallback");
  if (info.streams.some((entry) => entry.source === "reddit.fallback")) {
    info.limitations.push("Reddit's fallback_url is a video-only DASH rendition: it carries no audio track, so transcription from it is impossible.");
  }
  if (info.manifests.length > 0) {
    info.limitations.push("HLS/DASH manifests are reported for honesty but never streamed or assembled into a file.");
  }
  if (info.isImagePost) info.limitations.push("This Reddit post is an image, not a video.");
  if (info.streams.length === 0 && !info.accessHint && !info.isImagePost) {
    info.limitations.push("Reddit shipped no literal media URL in the public response; its player usually loads renditions after page scripts run.");
  }
  return info;
}

/** Dispatch to the right parser for a URL, or null for TikTok/generic. */
export function parsePlatformPage(input: PlatformParseInput): PlatformVideoInfo | null {
  if (isInstagramUrl(input.url)) return parseInstagram(input);
  if (isYouTubeUrl(input.url)) return parseYouTube(input);
  if (isXUrl(input.url)) return parseX(input);
  if (isRedditUrl(input.url) || /^https?:\/\/v\.redd\.it\//i.test(input.url)) return parseReddit(input);
  return null;
}
