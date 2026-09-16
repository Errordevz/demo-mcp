/**
 * Access-status classification for public video retrieval.
 *
 * The single most important honesty signal DEMO returns. A video that is
 * deleted, private, region-restricted, behind a login wall, expired or blocked
 * by a bot challenge must be *named*, never silently reported as "resolved with
 * no frames" and never papered over with metadata or a thumbnail.
 *
 * Everything here is pure and deterministic: HTTP status codes, platform
 * status codes published in the page's own hydration payload, and text signals
 * the page itself renders. No access control is probed or bypassed.
 */

import type { MediaSignature } from "./probe.js";

/** Why the public video could or could not be reached. */
export type VideoAccessStatus =
  /** A normal public request reached playable media (or a decodable page). */
  | "public"
  /** The item existed and was removed by the creator or the platform. */
  | "deleted"
  /** Only the creator / approved followers can view it. */
  | "private"
  /** The page requires an authenticated session. */
  | "login_required"
  /** Not available to this requester's region. */
  | "region_restricted"
  /** A CAPTCHA / bot check / access denial blocked normal public retrieval. */
  | "challenge_required"
  /** The platform rate limited the request. */
  | "rate_limited"
  /** The URL does not identify an existing item. */
  | "not_found"
  /** A signed media URL or stored artifact passed its expiry. */
  | "expired"
  /** Rejected by the SSRF guard before any request was made. */
  | "blocked_url"
  /** Reachable, but not a supported/decodable video container. */
  | "unsupported"
  /** Reachable page, no playable public media exposed. */
  | "unavailable"
  /** Not enough signal to say. Never presented as success. */
  | "unknown";

export interface AccessStatusInfo {
  status: VideoAccessStatus;
  /** Short human label for the model, e.g. `"Video is private"`. */
  label: string;
  /** Whether the connected AI may describe the video's content. */
  mayDescribeContent: boolean;
}

/**
 * TikTok gateway/item status codes. These are published by TikTok itself in the
 * page hydration payload (`webapp.video-detail.statusCode`) and in its API
 * error table; DEMO only reads the value the page already handed to the
 * browser. Unknown non-zero codes are reported as `unavailable` together with
 * the raw code, never guessed at.
 */
export const TIKTOK_STATUS_CODES: Record<number, { status: VideoAccessStatus; label: string }> = {
  0: { status: "public", label: "Item is publicly available." },
  10000: { status: "challenge_required", label: "TikTok is showing a CAPTCHA instead of the item." },
  10101: { status: "unavailable", label: "TikTok reported a server error for this item." },
  10102: { status: "login_required", label: "TikTok requires a logged-in session for this item." },
  10113: { status: "challenge_required", label: "TikTok blocked the resource." },
  10114: { status: "challenge_required", label: "TikTok blocked the resource." },
  10202: { status: "not_found", label: "The creator account does not exist." },
  10204: { status: "not_found", label: "TikTok reports this video does not exist." },
  10215: { status: "unavailable", label: "The video is currently unavailable." },
  10216: { status: "private", label: "The video is private." },
  10217: { status: "unavailable", label: "The video is currently unavailable." },
  10221: { status: "deleted", label: "The creator account is banned." },
  10227: { status: "unavailable", label: "The video is under review." },
  10228: { status: "unavailable", label: "The video is under risk control." },
  10229: { status: "private", label: "The video is hidden." },
  10230: { status: "unavailable", label: "The video is under risk control." },
  10231: { status: "region_restricted", label: "The video is not visible in this country." },
  10241: { status: "deleted", label: "The video was deleted." },
  10242: { status: "private", label: "This video has restricted access." },
  10404: { status: "not_found", label: "TikTok reported the item could not be listed." },
};

/** Map a platform item status code; `null` when the code is not recognised. */
export function classifyPlatformStatusCode(platform: string, code: number | null | undefined): { status: VideoAccessStatus; label: string } | null {
  if (code === null || code === undefined || !Number.isFinite(code)) return null;
  if (platform !== "tiktok") return null;
  const known = TIKTOK_STATUS_CODES[code];
  if (known) return known;
  if (code === 0) return { status: "public", label: "Item is publicly available." };
  return { status: "unavailable", label: `TikTok returned item status code ${code}, which DEMO does not recognise as "available".` };
}

/** Text the page itself renders when an item cannot be shown publicly. */
const TEXT_SIGNALS: Array<{ status: VideoAccessStatus; label: string; test: RegExp }> = [
  { status: "deleted", label: "The page says this video was removed or deleted.", test: /\b(?:video (?:has been )?(?:removed|deleted)|this (?:video|content|post) (?:is|was) (?:no longer available|removed|deleted)|post (?:has been )?deleted|taken down)\b/i },
  { status: "private", label: "The page says this video is private or followers-only.", test: /\b(?:private (?:video|account|post)|this video is private|only (?:the creator|me|followers) can (?:view|see)|followers-only|hidden by the creator)\b/i },
  { status: "region_restricted", label: "The page says this video is not available in this region.", test: /\b(?:not available in (?:your|this) (?:country|region)|region[- ](?:restricted|locked)|geo[- ]?(?:blocked|restricted)|unavailable in your (?:country|region)|blocked in your country)\b/i },
  { status: "not_found", label: "The page says this video or account could not be found.", test: /\b(?:couldn'?t find (?:this|the) (?:account|page|video)|video (?:is )?not found|page not available|content (?:is )?not available|this (?:page|video|post) (?:doesn'?t|does not) exist|404)\b/i },
  { status: "login_required", label: "The page requires a signed-in session.", test: /\b(?:sign in to (?:continue|view|watch)|log ?in to (?:continue|view|watch)|you must be logged in|authentication required)\b/i },
  { status: "challenge_required", label: "The page is a bot challenge or access denial.", test: /\b(?:verify you are human|are you a robot|captcha|security check|access denied|just a moment|unusual traffic|enable javascript and cookies to continue)\b/i },
  { status: "expired", label: "The page says this link or media has expired.", test: /\b(?:link (?:has )?expired|url (?:has )?expired|signature (?:has )?expired|token (?:has )?expired|access expired)\b/i },
];

export interface AccessClassificationInput {
  platform?: string;
  /** HTTP status of the final public response, when known. */
  httpStatus?: number | null;
  /** Platform item status code from the page's own payload. */
  platformStatusCode?: number | null;
  /** Challenge detected by the resolver. */
  challenge?: { detected: boolean; kind: string | null; reason: string | null } | null;
  /** Resolver error code (`blocked_url`, `VIDEO_NOT_PUBLIC`, …). */
  errorCode?: string | null;
  /** Bounded page text, already stripped of scripts/styles. */
  pageText?: string | null;
  /** A verified playable stream URL was found. */
  playableStreamFound?: boolean;
  /** The stored artifact / signed URL is past its expiry. */
  artifactExpired?: boolean;
  /** Signature of the bytes that were actually retrieved. */
  signature?: MediaSignature | null;
  /** Metadata (title/caption/thumbnail) was found but no playable media. */
  metadataOnly?: boolean;
}

/**
 * Decide the access status from the evidence DEMO actually gathered.
 *
 * Precedence: explicit expiry → SSRF block → challenge/login → platform status
 * code → HTTP status → page text signals → verified playable stream →
 * metadata-only → unknown.
 */
export function classifyAccess(input: AccessClassificationInput): AccessStatusInfo {
  if (input.artifactExpired) return info("expired", "The temporary video artifact or signed media URL has expired.");
  if (input.errorCode === "blocked_url") return info("blocked_url", "The URL was rejected by the SSRF guard before any request was made.");
  // The guard also rejects non-http(s) schemes and unparseable hosts with
  // `invalid_input`. Those are guard refusals, not verdicts about a video: they
  // must never surface as `unknown` (which reads like "we could not tell").
  if (input.errorCode === "invalid_input" || input.errorCode === "unsupported") {
    return info("blocked_url", "The URL was rejected before any request was made: only public http(s) URLs outside private/internal ranges can be resolved.");
  }

  const challenge = input.challenge;
  if (challenge?.detected) {
    if (challenge.kind === "login_wall") return info("login_required", challenge.reason ?? "The page requires an authenticated session.");
    if (challenge.kind === "rate_limit") return info("rate_limited", challenge.reason ?? "The platform rate limited this request.");
    return info("challenge_required", challenge.reason ?? "A CAPTCHA/bot challenge or access denial blocked normal public retrieval.");
  }

  const platformStatus = classifyPlatformStatusCode(input.platform ?? "generic", input.platformStatusCode);
  if (platformStatus && platformStatus.status !== "public") return info(platformStatus.status, platformStatus.label);

  const httpStatus = input.httpStatus ?? null;
  if (httpStatus !== null) {
    if (httpStatus === 404) return info("not_found", "The platform returned HTTP 404 for this URL.");
    if (httpStatus === 410) return info("deleted", "The platform returned HTTP 410 (gone) for this URL.");
    if (httpStatus === 401) return info("login_required", "The platform returned HTTP 401 (authentication required).");
    if (httpStatus === 403) return info("challenge_required", "The platform returned HTTP 403 (access denied) for a normal public request.");
    if (httpStatus === 429) return info("rate_limited", "The platform returned HTTP 429 (too many requests).");
    if (httpStatus === 451) return info("region_restricted", "The platform returned HTTP 451 (unavailable for legal reasons).");
    if (httpStatus >= 500) return info("unavailable", `The platform returned HTTP ${httpStatus} (server error).`);
  }

  if (input.pageText) {
    for (const signal of TEXT_SIGNALS) {
      if (signal.test.test(input.pageText)) return info(signal.status, signal.label);
    }
  }

  if (input.signature && input.signature.kind !== "video" && input.signature.kind !== "unknown") {
    if (input.signature.kind === "playlist") return info("unsupported", "The public URL is a streaming manifest (HLS/DASH), not a bounded video file.");
    if (input.signature.kind === "image") return info("unsupported", "The public URL serves a still image (thumbnail/poster), not a video stream.");
    if (input.signature.kind === "audio") return info("unsupported", "The public URL serves audio only, with no video track.");
    if (input.signature.isDocument) return info("unavailable", "The public URL returned a document (HTML/JSON/text) instead of video bytes.");
  }

  if (platformStatus?.status === "public" && !input.playableStreamFound) {
    return info("unavailable", "TikTok reported the item as available but exposed no playable media URL to a normal public request.");
  }
  if (input.playableStreamFound) return info("public", "A normal public request reached playable video media.");
  if (input.metadataOnly) return info("unavailable", "Only page metadata and a thumbnail were exposed; no playable public media was reachable.");
  return info("unknown", "DEMO could not determine whether this video is publicly accessible.");
}

function info(status: VideoAccessStatus, label: string): AccessStatusInfo {
  return { status, label, mayDescribeContent: status === "public" };
}

/**
 * What the connected AI is allowed to say for a given access status. This is
 * the enforcement text behind the acceptance criterion: no frames ⇒ no claims.
 */
export function accessStatusGuidance(status: VideoAccessStatus): string {
  switch (status) {
    case "public":
      return "The video is publicly reachable. Describe only what the returned frames/transcript actually show.";
    case "deleted":
      return "This video was deleted or removed. Say so; do not describe content and do not use the caption as a substitute.";
    case "private":
      return "This video is private or hidden. Say so; do not describe content.";
    case "login_required":
      return "This video requires a signed-in session, which DEMO never uses. Say so; do not describe content.";
    case "region_restricted":
      return "This video is region-restricted. Say so; do not describe content.";
    case "challenge_required":
      return "A CAPTCHA/bot challenge or access denial blocked retrieval, and DEMO never bypasses one. Say so; do not describe content.";
    case "rate_limited":
      return "The platform rate limited this request. Say so and suggest retrying later; do not describe content.";
    case "not_found":
      return "No such video was found at that URL. Say so; do not describe content.";
    case "expired":
      return "The link or temporary artifact expired. Ask for a fresh link or re-resolve; do not describe content.";
    case "blocked_url":
      return "The URL was rejected by DEMO's SSRF guard (private/internal/unsafe target). Say so; do not describe content.";
    case "unsupported":
      return "The URL is reachable but is not a supported decodable video (manifest, audio-only or a still image). Say so; do not describe content.";
    case "unavailable":
      return "The page was reachable but exposed no playable public media. Say so; metadata or a thumbnail is not evidence of content.";
    default:
      return "Access could not be determined. Say so explicitly; do not describe content.";
  }
}

/** Statuses that mean "DEMO must not claim it watched anything". */
export function isFailureStatus(status: VideoAccessStatus): boolean {
  return status !== "public";
}
