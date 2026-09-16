/**
 * Stream candidate collection and quality selection.
 *
 * A public video page usually exposes several literal media URLs (TikTok's
 * `playAddr`, `downloadAddr`, `bitrateInfo[].PlayAddr.UrlList`, `playApi`,
 * OpenGraph `og:video`, `<video src>`, JSON-LD `contentUrl`). DEMO ranks them,
 * probes the best few with normal public requests, and reports *which* one
 * verified as real video bytes.
 *
 * Nothing here signs a request, decrypts a cipher or calls a private API: only
 * URLs the page already published are considered, and a signed URL is treated
 * as an opaque public URL with a short lifetime.
 */

import { LIMITS } from "../core/limits.js";

/** Where a candidate URL came from, so the result can explain itself. */
export type StreamSource =
  | "tiktok.playAddr"
  | "tiktok.playAddrUrlList"
  | "tiktok.bitrateInfo"
  | "tiktok.playApi"
  | "tiktok.downloadAddr"
  | "tiktok.imagePost"
  | "json_ld.contentUrl"
  | "og.video"
  | "html.video_element"
  | "html.literal_url"
  | "direct_url"
  | "resolved_reference";

export type StreamKind = "play" | "download" | "page" | "manifest" | "audio" | "image";

export interface StreamCandidate {
  url: string;
  kind: StreamKind;
  source: StreamSource;
  /** Declared by the platform payload, when present (never verified from here). */
  width: number | null;
  height: number | null;
  bitrate: number | null;
  /** True when the URL carries signature/expiry query parameters. */
  signed: boolean;
  /** Parsed `x-expires`/`expires` parameter as an ISO timestamp, when present. */
  expiresAt: string | null;
  /** Probe outcome; `null` when this candidate was not probed. */
  reachable: boolean | null;
  contentType: string | null;
  bytes: number | null;
  /** Container name from the byte-signature probe (`mp4`, `jpeg`, `html_page`, …). */
  verifiedContainer: string | null;
  /** True only after the bytes verified as a real video container. */
  verifiedVideo: boolean;
  reason: string | null;
}

/** Quality preference for `video_fetch`. */
export type QualityPreference = "auto" | "lowest" | "low" | "medium" | "high" | "highest";

export const QUALITY_PREFERENCES: QualityPreference[] = ["auto", "lowest", "low", "medium", "high", "highest"];

/** Query parameters that mark a URL as signed / short-lived. */
const SIGNED_PARAMS = /^(?:x-expires|x-signature|expires|expire|signature|sig|auth[_-]?key|seal|hdnts|hdntl|n[_-]?sig|s|token|access[_-]?token|oh|oe|_nc_[a-z]+)$/i;
const EXPIRY_PARAMS = /^(?:x-expires|expires|expire|oe|x-goog-expires)$/i;

function parseExpiry(value: string | null): string | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 1_000_000_000) {
    // Seconds (10 digits) or milliseconds (13 digits) since the epoch.
    const ms = numeric > 1e12 ? numeric : numeric * 1_000;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** True when the URL carries signature/expiry style query parameters. */
export function isSignedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    for (const key of parsed.searchParams.keys()) if (SIGNED_PARAMS.test(key)) return true;
    return false;
  } catch {
    return false;
  }
}

/** Expiry of a signed URL as an ISO timestamp, when it declares one. */
export function signedUrlExpiry(url: string): string | null {
  try {
    const parsed = new URL(url);
    for (const key of parsed.searchParams.keys()) {
      if (!EXPIRY_PARAMS.test(key)) continue;
      const expiry = parseExpiry(parsed.searchParams.get(key));
      if (expiry) return expiry;
    }
    return null;
  } catch {
    return null;
  }
}

/** True when the URL declares an expiry that has already passed. */
export function signedUrlExpired(url: string, now: number = Date.now()): boolean {
  const expiry = signedUrlExpiry(url);
  if (!expiry) return false;
  const at = Date.parse(expiry);
  return Number.isFinite(at) && at <= now;
}

/**
 * Strip the signed query string, keeping scheme+host+path. Used when a caller
 * asks not to receive signed URLs, and for log/metadata persistence. The result
 * is explicitly marked as *not* directly fetchable.
 */
export function unsignedUrlShape(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function kindForSource(source: StreamSource, url: string): StreamKind {
  if (source === "tiktok.imagePost" || /\.(?:jpe?g|png|webp|gif|avif)(?:$|[?#])/i.test(url)) return "image";
  if (/\.m3u8(?:$|[?#])/i.test(url) || /\.mpd(?:$|[?#])/i.test(url)) return "manifest";
  if (/\.(?:mp3|m4a|wav|aac|flac)(?:$|[?#])/i.test(url)) return "audio";
  if (source === "tiktok.downloadAddr") return "download";
  if (source.startsWith("tiktok.")) return "play";
  if (source === "direct_url") return "play";
  return "page";
}

export interface NewStreamCandidate {
  url: string;
  source: StreamSource;
  width?: number | null;
  height?: number | null;
  bitrate?: number | null;
}

/** Build a normalised candidate, deduplicated against an existing list. */
export function pushCandidate(list: StreamCandidate[], candidate: NewStreamCandidate): StreamCandidate | null {
  const url = candidate.url.trim();
  if (!url || url.length > 4_000) return null;
  if (list.some((entry) => entry.url === url)) return null;
  if (list.length >= LIMITS.videoMaxStreamCandidates) return null;
  const entry: StreamCandidate = {
    url,
    kind: kindForSource(candidate.source, url),
    source: candidate.source,
    width: candidate.width ?? null,
    height: candidate.height ?? null,
    bitrate: candidate.bitrate ?? null,
    signed: isSignedUrl(url),
    expiresAt: signedUrlExpiry(url),
    reachable: null,
    contentType: null,
    bytes: null,
    verifiedContainer: null,
    verifiedVideo: false,
    reason: null,
  };
  list.push(entry);
  return entry;
}

function pixelScore(candidate: StreamCandidate): number {
  if (candidate.width && candidate.height) return candidate.width * candidate.height;
  // Infer a rough score from the URL when the payload gave no dimensions.
  const match = /(?:^|[^\d])(\d{3,4})p(?:[^\d]|$)/i.exec(candidate.url);
  if (match) {
    const height = Number(match[1]);
    return Number.isFinite(height) ? height * height * 1.78 : 0;
  }
  return 0;
}

/** Download-oriented sources first: they are usually unsigned and longer-lived. */
function sourceScore(candidate: StreamCandidate): number {
  switch (candidate.source) {
    case "tiktok.downloadAddr":
      return 60;
    case "tiktok.playAddr":
    case "tiktok.playAddrUrlList":
    case "tiktok.bitrateInfo":
    case "tiktok.playApi":
      return 50;
    case "json_ld.contentUrl":
      return 45;
    case "og.video":
      return 40;
    case "html.video_element":
      return 35;
    case "direct_url":
      return 55;
    case "html.literal_url":
      return 20;
    default:
      return 10;
  }
}

function baseScore(candidate: StreamCandidate): number {
  let score = sourceScore(candidate);
  if (candidate.kind === "play" || candidate.kind === "download") score += 25;
  if (candidate.kind === "manifest") score -= 40;
  if (candidate.kind === "image" || candidate.kind === "audio") score -= 100;
  if (candidate.signed) score -= 8; // signed URLs expire mid-pipeline
  if (candidate.expiresAt && signedUrlExpired(candidate.url)) score -= 500;
  if (/\.mp4(?:$|[?#])/i.test(candidate.url)) score += 12;
  if (/\.webm(?:$|[?#])/i.test(candidate.url)) score += 8;
  if (/\.m3u8(?:$|[?#])/i.test(candidate.url)) score -= 30;
  return score;
}

/**
 * Rank candidates for a quality preference.
 *
 * `auto`/`highest` prefer the largest declared resolution among playable
 * candidates; `lowest`/`low` prefer the smallest (cheaper, faster, still real
 * video); `medium` prefers something near 720p. Non-playable kinds (images,
 * manifests) always sink to the bottom, and already-expired signed URLs sink
 * below everything else.
 */
export function rankStreams(candidates: StreamCandidate[], quality: QualityPreference = "auto"): StreamCandidate[] {
  const playable = candidates.filter((candidate) => candidate.kind !== "image" && candidate.kind !== "audio");
  const nonPlayable = candidates.filter((candidate) => candidate.kind === "image" || candidate.kind === "audio");
  const resolutions = playable.map(pixelScore).filter((value) => value > 0).sort((a, b) => a - b);
  const target =
    quality === "lowest" || quality === "low"
      ? (resolutions[0] ?? 0)
      : quality === "medium"
        ? (resolutions[Math.floor(resolutions.length / 2)] ?? 0)
        : (resolutions[resolutions.length - 1] ?? 0);

  const scored = playable.map((candidate) => {
    const pixels = pixelScore(candidate);
    let qualityScore: number;
    if (!pixels || !target) qualityScore = 0;
    else if (quality === "highest" || quality === "auto") qualityScore = pixels / Math.max(1, target);
    else if (quality === "lowest") qualityScore = target / Math.max(1, pixels);
    else if (quality === "low") qualityScore = 1 - Math.min(1, pixels / Math.max(1, target)) * 0.5;
    else qualityScore = 1 - Math.min(1, Math.abs(pixels - target) / Math.max(1, target));
    return { candidate, score: baseScore(candidate) + qualityScore * 20 };
  });
  scored.sort((a, b) => b.score - a.score || a.candidate.url.length - b.candidate.url.length);
  return [...scored.map((entry) => entry.candidate), ...nonPlayable];
}

/** The best verified video candidate, or the best candidate of any kind. */
export function bestVerifiedStream(candidates: StreamCandidate[]): StreamCandidate | null {
  return candidates.find((candidate) => candidate.verifiedVideo) ?? null;
}

/** Compact, redaction-safe summary of a candidate for tool output. */
export function describeStream(candidate: StreamCandidate, options: { includeSignedUrls?: boolean } = {}): Record<string, unknown> {
  const includeSigned = options.includeSignedUrls !== false;
  return {
    url: includeSigned || !candidate.signed ? candidate.url : `${unsignedUrlShape(candidate.url)}?signed_query_removed=true`,
    kind: candidate.kind,
    source: candidate.source,
    width: candidate.width,
    height: candidate.height,
    bitrate: candidate.bitrate,
    content_type: candidate.contentType,
    bytes: candidate.bytes,
    signed: candidate.signed,
    expires_at: candidate.expiresAt,
    reachable: candidate.reachable,
    verified_video: candidate.verifiedVideo,
    verified_container: candidate.verifiedContainer,
    ...(candidate.reason ? { reason: candidate.reason } : {}),
  };
}
