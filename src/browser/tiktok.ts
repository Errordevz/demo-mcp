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
  /** Where the data came from: hydration payload, SIGI payload, meta tags, or nowhere. */
  source: "universal" | "sigi" | "meta" | "none";
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

function fromUniversal(raw: string | null | undefined): Json | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const root = asObject(parsed);
  if (!root) return null;
  const scope = asObject(root.__DEFAULT_SCOPE__) ?? root;
  const detail = asObject(scope["webapp.video-detail"]);
  const itemInfo = asObject(detail?.itemInfo);
  const direct = asObject(itemInfo?.itemStruct);
  if (direct) return direct;
  return findItemStruct(parsed);
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

function buildFromItem(item: Json, source: "universal" | "sigi", url?: string): TikTokInfo | null {
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
  const playUrl = firstString(
    video?.playAddr,
    asArray(video?.playAddrUrlList)[0],
    asArray(video?.downloadAddrUrlList)[0],
    video?.downloadAddr,
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
    limitations: [],
  };
}

function fromMeta(meta: Record<string, string> | undefined, url?: string): TikTokInfo | null {
  if (!meta) return null;
  const description = meta["og:description"] ?? meta["description"] ?? null;
  const videoId = extractTikTokVideoId(url ?? "") ?? extractTikTokVideoId(meta["og:url"] ?? "");
  const hashtags = new Set<string>();
  for (const match of (description ?? "").matchAll(/#([\p{L}\p{N}_]+)/gu)) hashtags.add(match[1]);
  return {
    platform: "tiktok",
    videoId,
    canonicalUrl: meta["og:url"] ?? url ?? null,
    author: null,
    description,
    createdAt: null,
    hashtags: [...hashtags].slice(0, 30),
    durationSeconds: num(meta["video:duration"]) ?? null,
    thumbnail: meta["og:image"] ?? meta["twitter:image"] ?? null,
    isImagePost: false,
    media: {
      durationSeconds: num(meta["video:duration"]) ?? null,
      cover: meta["og:image"] ?? null,
      playUrl: meta["og:video:url"] ?? meta["og:video"] ?? meta["twitter:player:stream"] ?? null,
    },
    stats: null,
    music: null,
    source: "meta",
    limitations: [],
  };
}

export interface TikTokParseInput {
  url?: string;
  meta?: Record<string, string>;
  rawStates?: { universal?: string | null; sigi?: string | null };
}

const BASE_LIMITATIONS = [
  "Only metadata the page exposed to the browser is reported; nothing is fetched from private TikTok APIs.",
  "Media URLs can be signed, region-scoped and short-lived; they may stop working within minutes.",
];

export function parseTikTok(input: TikTokParseInput): TikTokInfo | null {
  const videoIdFromUrl = extractTikTokVideoId(input.url ?? "");
  const universalItem = fromUniversal(input.rawStates?.universal);
  if (universalItem) {
    const info = buildFromItem(universalItem, "universal", input.url);
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
  const metaInfo = fromMeta(input.meta, input.url);
  if (metaInfo && (metaInfo.description || metaInfo.thumbnail || metaInfo.videoId)) {
    metaInfo.limitations = [
      ...BASE_LIMITATIONS,
      "TikTok did not expose its hydration payload to the browser; only OpenGraph/HTML metadata was available.",
      ...tiktokLimitations(metaInfo),
    ];
    return metaInfo;
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
  return notes;
}
