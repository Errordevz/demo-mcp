/**
 * TikTok public-metadata extraction.
 *
 * DEMO only reports structured data that the page itself already handed to the
 * browser (the hydration payload TikTok ships with every public video page).
 * It never signs requests, never calls private TikTok APIs, never downloads
 * protected media and never attempts to defeat access controls. When TikTok
 * serves a challenge, hides the media or requires login, this module reports
 * that honestly instead of inventing data.
 */

export interface TikTokAuthor {
  id?: string;
  uniqueId?: string;
  nickname?: string;
  verified?: boolean;
  avatar?: string;
}

export interface TikTokMediaUrls {
  durationSeconds?: number | null;
  cover?: string | null;
  dynamicCover?: string | null;
  originCover?: string | null;
  playUrl?: string | null;
  downloadUrl?: string | null;
  width?: number | null;
  height?: number | null;
  ratio?: string | null;
}

/** One literal media URL published by the page, with its provenance. */
export interface TikTokStreamUrl {
  url: string;
  source: "tiktok.playAddr" | "tiktok.playAddrUrlList" | "tiktok.bitrateInfo" | "tiktok.playApi" | "tiktok.downloadAddr" | "tiktok.imagePost";
  width?: number | null;
  height?: number | null;
  bitrate?: number | null;
  /** Gear/quality label when the payload provides one (`720p`, `lowbr`, …). */
  gear?: string | null;
}

/** Access flags the item itself publishes — read, never probed or bypassed. */
export interface TikTokAccessFlags {
  privateItem: boolean | null;
  secret: boolean | null;
  authorPrivateAccount: boolean | null;
  isEmbedBanned: boolean | null;
  takenDown: boolean | null;
  isAd: boolean | null;
}

export interface TikTokStats {
  plays?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
}

export interface TikTokMusic {
  id?: string | null;
  title?: string | null;
  author?: string | null;
  playUrl?: string | null;
  album?: string | null;
}

export interface TikTokInfo {
  platform: "tiktok";
  videoId: string | null;
  canonicalUrl: string | null;
  author: TikTokAuthor | null;
  description: string | null;
  createdAt: string | null;
  hashtags: string[];
  durationSeconds: number | null;
  thumbnail: string | null;
  isImagePost: boolean;
  media: TikTokMediaUrls | null;
  stats: TikTokStats | null;
  music: TikTokMusic | null;
  /** Where the data came from: hydration payload, SIGI payload, JSON-LD, meta tags, or nowhere. */
  source: "universal" | "sigi" | "json_ld" | "meta" | "none";
  /** Every literal media URL the page published, with provenance. */
  streams: TikTokStreamUrl[];
  /** `webapp.video-detail.statusCode` — TikTok's own availability verdict. */
  statusCode: number | null;
  statusMessage: string | null;
  accessFlags: TikTokAccessFlags;
  limitations: string[];
}

const TIKTOK_HOSTS = ["tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com", "vm.vt.tiktok.com"];

export function isTikTokUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return TIKTOK_HOSTS.includes(host) || host.endsWith(".tiktok.com");
  } catch {
    return false;
  }
}

export function extractTikTokVideoId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  const videoIndex = segments.findIndex((segment) => segment.toLowerCase() === "video");
  if (videoIndex >= 0 && segments[videoIndex + 1]) return segments[videoIndex + 1].split("?")[0];
  const last = segments[segments.length - 1];
  if (last && /^\d{6,}$/.test(last)) return last;
  return null;
}

export function canonicalTikTokUrl(author: string | undefined | null, videoId: string | null): string | null {
  if (!videoId) return null;
  return author ? `https://www.tiktok.com/@${author}/video/${videoId}` : `https://www.tiktok.com/video/${videoId}`;
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const candidate = str(value);
    if (candidate) return candidate;
  }
  return null;
}

/** Bounded depth-first search for the first object that looks like a TikTok item. */
function findItemStruct(root: unknown, depth = 0, budget = { nodes: 4000 }): Json | null {
  if (depth > 8 || budget.nodes <= 0) return null;
  const object = asObject(root);
  if (!object) return null;
  budget.nodes -= 1;
  if (typeof object.id === "string" && /^\d{5,}$/.test(object.id) && (object.video || object.imagePost) && object.author) {
    return object;
  }
  for (const key of Object.keys(object)) {
    const value = object[key];
    if (value && typeof value === "object") {
      if (Array.isArray(value)) {
        for (const entry of value.slice(0, 10)) {
          const found = findItemStruct(entry, depth + 1, budget);
          if (found) return found;
        }
      } else {
        const found = findItemStruct(value, depth + 1, budget);
        if (found) return found;
      }
    }
  }
  return null;
}

/** Result of reading TikTok's hydration payload: the item plus its verdict. */
interface UniversalPayload {
  item: Json | null;
  statusCode: number | null;
  statusMessage: string | null;
}

function fromUniversal(raw: string | null | undefined): UniversalPayload | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // TikTok sometimes HTML-escapes the payload or ships it as a JS assignment.
    try {
      parsed = JSON.parse(String(raw).replace(/\\"/g, '"').replace(/\\u002F/g, "/"));
    } catch {
      return null;
    }
  }
  const root = asObject(parsed);
  if (!root) return null;
  const scope = asObject(root.__DEFAULT_SCOPE__) ?? root;
  const detail = asObject(scope["webapp.video-detail"]);
  const statusCode = num(detail?.statusCode) ?? num(detail?.status_code) ?? num(root.statusCode);
  const statusMessage = str(detail?.statusMsg) ?? str(detail?.status_msg) ?? null;
  const itemInfo = asObject(detail?.itemInfo);
  const direct = asObject(itemInfo?.itemStruct) ?? asObject(detail?.itemStruct);
  if (direct) return { item: direct, statusCode, statusMessage };
  const found = findItemStruct(parsed);
  if (found) return { item: found, statusCode, statusMessage };
  // No item at all, but the page still published a verdict (deleted/private/
  // region-restricted). That verdict is the honest answer, so keep it.
  if (statusCode !== null || statusMessage) return { item: null, statusCode, statusMessage };
  return null;
}

function fromSigi(raw: string | null | undefined, videoId: string | null): Json | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const root = asObject(parsed);
  if (!root) return null;
  const module = asObject(root.ItemModule);
  if (module) {
    if (videoId && asObject(module[videoId])) return asObject(module[videoId]);
    const keys = Object.keys(module);
    if (keys.length > 0) return asObject(module[keys[0]]);
  }
  return findItemStruct(parsed);
}

/** Resolve a possibly protocol-relative or root-relative URL against the page. */
function absolute(value: string | null, base?: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4_000) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!base) return trimmed.startsWith("//") ? `https:${trimmed}` : null;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return trimmed.startsWith("//") ? `https:${trimmed}` : null;
  }
}

/**
 * Every literal media URL the page published, with provenance.
 *
 * TikTok's payload shape changes often: older pages ship `video.playAddr`,
 * newer ones ship `video.bitrateInfo[].PlayAddr.UrlList` and/or a relative
 * `video.playApi`. Collecting all of them (instead of trusting one selector) is
 * what makes resolution robust. Only URLs already present in the public payload
 * are returned — nothing is signed, constructed from private endpoints or
 * fetched from an authenticated API.
 */
function collectStreams(item: Json, video: Json | null, imagePost: Json | null, images: string[], base?: string): TikTokStreamUrl[] {
  const streams: TikTokStreamUrl[] = [];
  const seen = new Set<string>();
  const push = (raw: string | null, source: TikTokStreamUrl["source"], extra: { width?: number | null; height?: number | null; bitrate?: number | null; gear?: string | null } = {}): void => {
    const resolved = absolute(raw, base);
    if (!resolved || seen.has(resolved)) return;
    if (streams.length >= 24) return;
    seen.add(resolved);
    streams.push({ url: resolved, source, width: extra.width ?? null, height: extra.height ?? null, bitrate: extra.bitrate ?? null, gear: extra.gear ?? null });
  };

  push(str(video?.playAddr), "tiktok.playAddr", { width: num(video?.width), height: num(video?.height) });
  for (const entry of asArray(video?.playAddrUrlList)) push(str(entry), "tiktok.playAddrUrlList", { width: num(video?.width), height: num(video?.height) });
  for (const entry of asArray(video?.downloadAddrUrlList)) push(str(entry), "tiktok.downloadAddr");
  push(str(video?.downloadAddr), "tiktok.downloadAddr");

  for (const entry of asArray(video?.bitrateInfo)) {
    const gear = asObject(entry);
    const playAddr = asObject(gear?.PlayAddr) ?? asObject(gear?.playAddr);
    const width = num(playAddr?.Width) ?? num(playAddr?.width) ?? num(gear?.PlayAddrWidth);
    const height = num(playAddr?.Height) ?? num(playAddr?.height) ?? num(gear?.PlayAddrHeight);
    const bitrate = num(gear?.Bitrate) ?? num(gear?.bitrate) ?? num(gear?.bitRate);
    const gearName = str(gear?.GearName) ?? str(gear?.gearName) ?? str(gear?.QualityType);
    for (const url of asArray(playAddr?.UrlList ?? playAddr?.url_list)) push(str(url), "tiktok.bitrateInfo", { width, height, bitrate, gear: gearName });
    push(str(playAddr?.Uri), "tiktok.bitrateInfo", { width, height, bitrate, gear: gearName });
  }

  // `playApi` is the relative playback URL the web player itself uses; it is a
  // literal string in the public payload, so it is treated like any other
  // candidate (and ranked below the direct CDN addresses).
  push(str(video?.playApi) ?? str(video?.play_api), "tiktok.playApi", { width: num(video?.width), height: num(video?.height) });

  if (imagePost) for (const image of images) push(image, "tiktok.imagePost");

  return streams;
}

function accessFlagsFor(item: Json, author: Json | null): TikTokAccessFlags {
  return {
    privateItem: bool(item.privateItem) ?? bool(item.private_item) ?? null,
    secret: bool(item.secret) ?? null,
    authorPrivateAccount: author ? (bool(author.privateAccount) ?? bool(author.private_account) ?? null) : null,
    isEmbedBanned: bool(item.isEmbedBanned) ?? null,
    takenDown: bool(item.takenDown) ?? null,
    isAd: bool(item.isAD) ?? bool(item.isAd) ?? null,
  };
}

function buildFromItem(item: Json, source: "universal" | "sigi", url?: string, statusCode: number | null = null, statusMessage: string | null = null): TikTokInfo | null {
  const videoId = str(item.id);
  const author = asObject(item.author) ?? asObject(item.authorInfo);
  const video = asObject(item.video);
  const imagePost = asObject(item.imagePost);
  const stats = asObject(item.stats) ?? asObject(item.statistics);
  const music = asObject(item.music);
  const description = str(item.desc) ?? str(item.title) ?? null;
  const createTime = num(item.createTime);
  const images: string[] = [];
  for (const entry of asArray(imagePost?.images)) {
    const image = asObject(entry);
    const url = image ? firstString(asArray(asObject(image.imageURL)?.url_list)[0], image.url) : null;
    if (url) images.push(url);
    if (images.length >= 20) break;
  }
  const hashtags = new Set<string>();
  for (const match of (description ?? "").matchAll(/#([\p{L}\p{N}_]+)/gu)) hashtags.add(match[1]);
  for (const challenge of asArray(item.challenges ?? item.textExtra)) {
    const entry = asObject(challenge);
    const title = str(entry?.title) ?? str(entry?.hashtagName);
    if (title) hashtags.add(title.replace(/^#/, ""));
  }
  const streams = collectStreams(item, video, imagePost, images, url);
  const playUrl = firstString(
    streams.find((entry) => entry.source === "tiktok.playAddr")?.url,
    video?.playAddr,
    streams.find((entry) => entry.source === "tiktok.bitrateInfo")?.url,
    asArray(video?.playAddrUrlList)[0],
    asArray(video?.downloadAddrUrlList)[0],
    video?.downloadAddr,
    streams.find((entry) => entry.source === "tiktok.playApi")?.url,
    images.length > 0 ? images[0] : null,
  );
  const thumbnail = firstString(
    video?.cover,
    video?.originCover,
    video?.dynamicCover,
    video?.refCover,
    images.length > 0 ? images[0] : null,
  );
  const media: TikTokMediaUrls | null = video || imagePost
    ? {
        durationSeconds: num(video?.duration) ?? null,
        cover: str(video?.cover) ?? null,
        dynamicCover: str(video?.dynamicCover) ?? null,
        originCover: str(video?.originCover) ?? null,
        playUrl,
        downloadUrl: str(video?.downloadAddr) ?? null,
        width: num(video?.width) ?? null,
        height: num(video?.height) ?? null,
        ratio: str(video?.ratio) ?? null,
      }
    : null;
  const videoIdValue = videoId ?? null;
  return {
    platform: "tiktok",
    videoId: videoIdValue,
    canonicalUrl: canonicalTikTokUrl(str(author?.uniqueId) ?? str(author?.unique_id), videoIdValue) ?? str(url) ?? null,
    author: author
      ? {
          id: str(author.id) ?? str(author.uid) ?? undefined,
          uniqueId: str(author.uniqueId) ?? str(author.unique_id) ?? str(author.name) ?? undefined,
          nickname: str(author.nickname) ?? undefined,
          verified: bool(author.verified),
          avatar: firstString(author.avatarLarger, author.avatarThumb, author.avatarMedium) ?? undefined,
        }
      : null,
    description,
    createdAt: createTime ? new Date(createTime * 1000).toISOString() : null,
    hashtags: [...hashtags].slice(0, 30),
    durationSeconds: num(video?.duration) ?? null,
    thumbnail,
    isImagePost: Boolean(imagePost),
    media,
    stats: stats
      ? {
          plays: num(stats.playCount) ?? num(stats.views) ?? null,
          likes: num(stats.diggCount) ?? num(stats.likes) ?? null,
          comments: num(stats.commentCount) ?? null,
          shares: num(stats.shareCount) ?? null,
          saves: num(stats.collectCount) ?? num(stats.saves) ?? null,
        }
      : null,
    music: music
      ? {
          id: str(music.id) ?? null,
          title: str(music.title) ?? null,
          author: str(music.authorName) ?? str(music.author) ?? null,
          playUrl: str(music.playUrl) ?? null,
          album: str(music.album) ?? null,
        }
      : null,
    source,
    streams,
    statusCode,
    statusMessage,
    accessFlags: accessFlagsFor(item, author),
    limitations: [],
  };
}

function emptyAccessFlags(): TikTokAccessFlags {
  return { privateItem: null, secret: null, authorPrivateAccount: null, isEmbedBanned: null, takenDown: null, isAd: null };
}

function fromMeta(meta: Record<string, string> | undefined, url?: string): TikTokInfo | null {
  if (!meta) return null;
  const description = meta["og:description"] ?? meta["description"] ?? null;
  const videoId = extractTikTokVideoId(url ?? "") ?? extractTikTokVideoId(meta["og:url"] ?? "");
  const hashtags = new Set<string>();
  for (const match of (description ?? "").matchAll(/#([\p{L}\p{N}_]+)/gu)) hashtags.add(match[1]);
  const streams: TikTokStreamUrl[] = [];
  for (const key of ["og:video:url", "og:video:secure_url", "og:video", "twitter:player:stream"]) {
    const value = meta[key];
    if (!value) continue;
    const resolved = absolute(value, url ?? meta["og:url"]);
    if (resolved && !streams.some((entry) => entry.url === resolved)) streams.push({ url: resolved, source: "tiktok.playAddr", width: num(meta["og:video:width"]), height: num(meta["og:video:height"]) });
  }
  return {
    platform: "tiktok",
    videoId,
    canonicalUrl: meta["og:url"] ?? url ?? null,
    author: null,
    description,
    createdAt: null,
    hashtags: [...hashtags].slice(0, 30),
    durationSeconds: num(meta["video:duration"]) ?? isoDuration(meta["og:video:duration"]),
    thumbnail: meta["og:image"] ?? meta["twitter:image"] ?? null,
    isImagePost: false,
    media: {
      durationSeconds: num(meta["video:duration"]) ?? isoDuration(meta["og:video:duration"]),
      cover: meta["og:image"] ?? null,
      playUrl: streams[0]?.url ?? null,
      width: num(meta["og:video:width"]),
      height: num(meta["og:video:height"]),
    },
    stats: null,
    music: null,
    source: "meta",
    streams,
    statusCode: null,
    statusMessage: null,
    accessFlags: emptyAccessFlags(),
    limitations: [],
  };
}

/** ISO-8601 duration (`PT9S`, `PT1M2.5S`) → seconds. Used by JSON-LD/og. */
export function isoDuration(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/i.exec(value.trim());
  if (!match) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }
  const [, days, hours, minutes, secs] = match;
  const total = Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes ?? 0) * 60 + Number(secs ?? 0);
  return Number.isFinite(total) && total > 0 ? total : null;
}

/**
 * Read a `schema.org/VideoObject` block. Many platforms (including TikTok's
 * public pages) ship JSON-LD, and it survives markup changes that break
 * hydration-payload parsing — which is why it is a first-class fallback rather
 * than a last resort.
 */
export interface JsonLdVideo {
  contentUrl: string | null;
  embedUrl: string | null;
  thumbnailUrl: string | null;
  name: string | null;
  description: string | null;
  durationSeconds: number | null;
  uploadDate: string | null;
  authorName: string | null;
  width: number | null;
  height: number | null;
}

export function parseJsonLdVideo(blocks: unknown[]): JsonLdVideo | null {
  const queue: unknown[] = [...blocks];
  let budget = 200;
  while (queue.length && budget-- > 0) {
    const entry = queue.shift();
    if (Array.isArray(entry)) {
      queue.unshift(...entry);
      continue;
    }
    const object = asObject(entry);
    if (!object) continue;
    const graph = asArray(object["@graph"]);
    if (graph.length) queue.unshift(...graph);
    const type = typeof object["@type"] === "string" ? object["@type"] : Array.isArray(object["@type"]) ? object["@type"].join(" ") : "";
    if (!/VideoObject|Video\b/i.test(type)) continue;
    const contentUrl = firstString(object.contentUrl, object.content_url, asArray(object.contentUrl)[0]);
    const embedUrl = firstString(object.embedUrl, object.embed_url);
    const thumbnailUrl = firstString(object.thumbnailUrl, object.thumbnail_url, asArray(object.thumbnailUrl)[0]);
    const author = asObject(object.author) ?? asObject(object.creator) ?? asObject(object.publisher);
    const width = num(object.width) ?? num(asObject(object.videoFrameSize)?.width);
    const height = num(object.height) ?? num(asObject(object.videoFrameSize)?.height);
    if (!contentUrl && !embedUrl && !thumbnailUrl && !object.name && !object.description) continue;
    return {
      contentUrl: contentUrl ? absolute(contentUrl) : null,
      embedUrl: embedUrl ? absolute(embedUrl) : null,
      thumbnailUrl: thumbnailUrl ? absolute(thumbnailUrl) : null,
      name: str(object.name),
      description: str(object.description),
      durationSeconds: isoDuration(str(object.duration)) ?? num(object.duration),
      uploadDate: str(object.uploadDate) ?? str(object.datePublished),
      authorName: author ? firstString(author.name, author.alternateName) : null,
      width,
      height,
    };
  }
  return null;
}

function fromJsonLd(jsonLd: JsonLdVideo, url?: string): TikTokInfo | null {
  const videoId = extractTikTokVideoId(url ?? "") ?? extractTikTokVideoId(jsonLd.embedUrl ?? "");
  const streams: TikTokStreamUrl[] = [];
  if (jsonLd.contentUrl) streams.push({ url: jsonLd.contentUrl, source: "tiktok.playAddr", width: jsonLd.width, height: jsonLd.height });
  const hashtags = new Set<string>();
  for (const match of (jsonLd.description ?? "").matchAll(/#([\p{L}\p{N}_]+)/gu)) hashtags.add(match[1]);
  return {
    platform: "tiktok",
    videoId,
    // JSON-LD rarely carries the uniqueId, so the page URL is the canonical
    // reference; `canonicalTikTokUrl` is only used when both parts are known.
    canonicalUrl: url ?? canonicalTikTokUrl(null, videoId) ?? jsonLd.embedUrl ?? null,
    author: jsonLd.authorName ? { uniqueId: jsonLd.authorName.replace(/^@/, ""), nickname: jsonLd.authorName } : null,
    description: jsonLd.description ?? jsonLd.name,
    createdAt: jsonLd.uploadDate,
    hashtags: [...hashtags].slice(0, 30),
    durationSeconds: jsonLd.durationSeconds,
    thumbnail: jsonLd.thumbnailUrl,
    isImagePost: false,
    media: {
      durationSeconds: jsonLd.durationSeconds,
      cover: jsonLd.thumbnailUrl,
      playUrl: jsonLd.contentUrl,
      width: jsonLd.width,
      height: jsonLd.height,
    },
    stats: null,
    music: null,
    source: "json_ld",
    streams,
    statusCode: null,
    statusMessage: null,
    accessFlags: emptyAccessFlags(),
    limitations: [],
  };
}

export interface TikTokParseInput {
  url?: string;
  meta?: Record<string, string>;
  rawStates?: { universal?: string | null; sigi?: string | null };
  /** Pre-parsed `<script type="application/ld+json">` blocks from the page. */
  jsonLd?: unknown[];
}

const BASE_LIMITATIONS = [
  "Only metadata the page exposed to the browser is reported; nothing is fetched from private TikTok APIs.",
  "Media URLs can be signed, region-scoped and short-lived; they may stop working within minutes.",
];

export function parseTikTok(input: TikTokParseInput): TikTokInfo | null {
  const videoIdFromUrl = extractTikTokVideoId(input.url ?? "");
  const universal = fromUniversal(input.rawStates?.universal);
  if (universal?.item) {
    const info = buildFromItem(universal.item, "universal", input.url, universal.statusCode, universal.statusMessage);
    if (info) {
      if (!info.videoId && videoIdFromUrl) info.videoId = videoIdFromUrl;
      info.limitations = [...BASE_LIMITATIONS, ...tiktokLimitations(info)];
      return info;
    }
  }
  const sigiItem = fromSigi(input.rawStates?.sigi, videoIdFromUrl ?? null);
  if (sigiItem) {
    const info = buildFromItem(sigiItem, "sigi", input.url);
    if (info) {
      if (!info.videoId && videoIdFromUrl) info.videoId = videoIdFromUrl;
      info.limitations = [...BASE_LIMITATIONS, ...tiktokLimitations(info)];
      return info;
    }
  }
  if (input.jsonLd?.length) {
    const jsonLd = parseJsonLdVideo(input.jsonLd);
    if (jsonLd) {
      const info = fromJsonLd(jsonLd, input.url);
      if (info) {
        if (!info.videoId && videoIdFromUrl) info.videoId = videoIdFromUrl;
        info.statusCode = universal?.statusCode ?? null;
        info.statusMessage = universal?.statusMessage ?? null;
        info.limitations = [...BASE_LIMITATIONS, "TikTok's hydration payload was absent; this came from the page's JSON-LD structured data.", ...tiktokLimitations(info)];
        return info;
      }
    }
  }
  const metaInfo = fromMeta(input.meta, input.url);
  if (metaInfo && (metaInfo.description || metaInfo.thumbnail || metaInfo.videoId || (universal?.statusCode ?? null) !== null)) {
    metaInfo.statusCode = universal?.statusCode ?? null;
    metaInfo.statusMessage = universal?.statusMessage ?? null;
    metaInfo.limitations = [
      ...BASE_LIMITATIONS,
      "TikTok did not expose its hydration payload to the browser; only OpenGraph/HTML metadata was available.",
      ...tiktokLimitations(metaInfo),
    ];
    return metaInfo;
  }
  // The page published an availability verdict (deleted/private/region) with no
  // item data at all. Reporting that verdict is more honest than returning
  // `null`, which downstream would read as "nothing was found".
  if (universal && (universal.statusCode !== null || universal.statusMessage)) {
    return {
      platform: "tiktok",
      videoId: videoIdFromUrl,
      canonicalUrl: input.url ?? null,
      author: null,
      description: null,
      createdAt: null,
      hashtags: [],
      durationSeconds: null,
      thumbnail: null,
      isImagePost: false,
      media: null,
      stats: null,
      music: null,
      source: "universal",
      streams: [],
      statusCode: universal.statusCode,
      statusMessage: universal.statusMessage,
      accessFlags: emptyAccessFlags(),
      limitations: [...BASE_LIMITATIONS, "TikTok published an availability status code for this item but no item data, so no media could be inspected."],
    };
  }
  return null;
}

function tiktokLimitations(info: TikTokInfo): string[] {
  const notes: string[] = [];
  if (info.isImagePost) notes.push("This post is an image/photo carousel, not a video.");
  if (!info.media?.playUrl) {
    notes.push("No playable media URL was exposed to the browser. TikTok may be serving a challenge, requiring login, or restricting this video by region.");
  }
  if (!info.durationSeconds && !info.isImagePost) notes.push("Duration was not available in the page payload.");
  if (!info.author) notes.push("Author information was not present in the page payload.");
  if (info.accessFlags.privateItem === true) notes.push("TikTok marks this item as private.");
  if (info.accessFlags.takenDown === true) notes.push("TikTok marks this item as taken down.");
  if (info.accessFlags.authorPrivateAccount === true) notes.push("The creator's account is private.");
  if (info.accessFlags.isEmbedBanned === true) notes.push("TikTok marks this item as banned from embedding.");
  if (info.statusCode !== null && info.statusCode !== 0) notes.push(`TikTok reported item status code ${info.statusCode}${info.statusMessage ? ` ("${info.statusMessage}")` : ""}.`);
  return notes;
}
