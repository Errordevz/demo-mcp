/**
 * Media container detection by file signature.
 *
 * Cloudflare Workers have no FFmpeg, no `ffprobe` and no media framework, so
 * the only honest way to answer "is this response actually a video?" is to look
 * at the bytes. This module inspects a bounded leading sample and classifies it
 * as a video container, an audio container, an image (i.e. a thumbnail, never a
 * video), a document (HTML/JSON/plain text — what a login wall or a JSON error
 * body looks like), an HLS playlist, or unknown.
 *
 * Every video retrieval path in DEMO runs this before it claims a download
 * succeeded, so an HTML interstitial, a JSON error, an OpenGraph thumbnail or a
 * placeholder image can never be reported as "the video".
 */

/** Coarse classification of a bounded byte sample. */
export type MediaKind = "video" | "audio" | "image" | "playlist" | "html" | "json" | "text" | "unknown";

/** Machine readable sub-classification used in error payloads. */
export type DetectedAs =
  | "mp4"
  | "mov"
  | "webm"
  | "matroska"
  | "ogg"
  | "mpeg_ts"
  | "flv"
  | "avi"
  | "3gp"
  | "mp3"
  | "flac"
  | "wav"
  | "m4a"
  | "jpeg"
  | "png"
  | "gif"
  | "webp"
  | "bmp"
  | "avif"
  | "hls_playlist"
  | "html_page"
  | "json_document"
  | "text"
  | "unknown";

export interface MediaSignature {
  kind: MediaKind;
  /** Stable sub-classification, safe to surface to the model. */
  detectedAs: DetectedAs;
  /** Container label suitable for humans/logs, e.g. `iso-base-media (mp4)`. */
  container: string | null;
  isVideo: boolean;
  isImage: boolean;
  /** HTML/JSON/plain text: what a wall, an API error or a redirect page looks like. */
  isDocument: boolean;
  /** True only when the signature alone proves video (content type not needed). */
  signatureIsVideo: boolean;
  /** ISO-BMFF major brand when present (`isom`, `mp42`, `qt  `, `dash`, …). */
  brand: string | null;
  detail: string | null;
}

const ISO_BRANDS_VIDEO = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "mp4v", "avc1", "dash", "M4V ", "m4v ", "3gp4", "3gp5", "3g2a", "XAVC", "hvc1", "hev1", "av01", "mmp4"]);
const ISO_BRANDS_AUDIO = new Set(["M4A ", "m4a ", "M4B ", "f4a "]);
const ISO_BRANDS_MOV = new Set(["qt  "]);

const VIDEO_CONTENT_TYPES = /^(?:video\/|application\/mp4|application\/ogg|application\/vnd\.apple\.mpegurl|application\/x-mpegurl)/i;
const AUDIO_CONTENT_TYPES = /^audio\//i;
const IMAGE_CONTENT_TYPES = /^image\//i;
const HTML_CONTENT_TYPES = /^(?:text\/html|application\/xhtml\+xml)/i;
const JSON_CONTENT_TYPES = /^(?:application\/json|application\/ld\+json|text\/json)/i;
const TEXT_CONTENT_TYPES = /^(?:text\/plain|text\/xml|application\/xml)/i;
const PLAYLIST_CONTENT_TYPES = /^(?:application\/vnd\.apple\.mpegurl|application\/x-mpegurl|audio\/x-mpegurl)/i;

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.byteLength) return "";
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function startsWith(bytes: Uint8Array, sequence: number[]): boolean {
  if (bytes.byteLength < sequence.length) return false;
  return sequence.every((value, index) => bytes[index] === value);
}

function signature(bytes: Uint8Array, detectedAs: DetectedAs, kind: MediaKind, container: string | null, detail: string | null, brand: string | null = null): MediaSignature {
  return {
    kind,
    detectedAs,
    container,
    isVideo: kind === "video",
    isImage: kind === "image",
    isDocument: kind === "html" || kind === "json" || kind === "text",
    signatureIsVideo: kind === "video",
    brand,
    detail,
  };
}

function looksLikeText(bytes: Uint8Array, sample = 512): boolean {
  const limit = Math.min(bytes.byteLength, sample);
  if (limit === 0) return false;
  let printable = 0;
  for (let i = 0; i < limit; i++) {
    const byte = bytes[i];
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126) || byte >= 0x80) printable++;
  }
  return printable / limit > 0.95;
}

/**
 * Classify a bounded leading sample of a response body.
 *
 * `contentTypeHint` only breaks ties: a `video/mp4` header over PNG bytes is
 * still reported as an image, because the whole point of this module is that a
 * hostile or misconfigured CDN header must not be trusted on its own.
 */
export function detectMediaSignature(bytes: Uint8Array, contentTypeHint: string | null = null): MediaSignature {
  const hint = contentTypeHint?.split(";")[0]?.trim().toLowerCase() ?? null;

  // ── ISO Base Media File Format (mp4 / mov / m4a / 3gp / fragmented mp4) ──
  // Box header: [size(4)][fourCC(4)]. `ftyp`/`styp` carry the major brand.
  if (bytes.byteLength >= 12) {
    for (const fourcc of ["ftyp", "styp", "moov", "mdat", "free", "skip", "wide", "sidx"]) {
      if (ascii(bytes, 4, 4) === fourcc) {
        const rawBrand = fourcc === "ftyp" || fourcc === "styp" ? ascii(bytes, 8, 4) : "";
        const brand = rawBrand.trim() ? rawBrand : null;
        const brandKey = brand ?? "";
        const brandLabel = brandKey.trim();
        if (ISO_BRANDS_MOV.has(brandKey)) return signature(bytes, "mov", "video", "quicktime (mov)", `ISO base media file, brand "${brandLabel}"`, brand);
        if (ISO_BRANDS_AUDIO.has(brandKey)) return signature(bytes, "m4a", "audio", "mpeg-4 audio (m4a)", `ISO base media file, audio brand "${brandLabel}"`, brand);
        if (brandKey === "avif" || brandKey === "avis") return signature(bytes, "avif", "image", "avif image", `AVIF still image, brand "${brandLabel}" — a still image, not a video stream`, brand);
        if (brandLabel.startsWith("3g")) return signature(bytes, "3gp", "video", "3gpp", `ISO base media file, brand "${brandLabel}"`, brand);
        if (fourcc === "ftyp" || fourcc === "styp") {
          const known = ISO_BRANDS_VIDEO.has(brandKey);
          return signature(bytes, "mp4", "video", "iso-base-media (mp4)", `ISO base media file, brand "${brandLabel || "unknown"}"${known ? "" : " (brand not in the known video list)"}`, brand);
        }
        // A leading moov/mdat with no ftyp is still an ISO-BMFF stream.
        return signature(bytes, "mp4", "video", "iso-base-media (mp4)", `ISO base media file starting with a "${fourcc}" box`, brand);
      }
    }
  }

  // ── Matroska / WebM (EBML header) ──
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    const docType = ascii(bytes, 0, 64);
    const webm = docType.includes("webm");
    return signature(bytes, webm ? "webm" : "matroska", "video", webm ? "webm" : "matroska", `EBML header, doctype ${webm ? "webm" : "matroska"}`);
  }

  // ── Ogg (video or audio) ──
  if (ascii(bytes, 0, 4) === "OggS") {
    const head = ascii(bytes, 0, 64).toLowerCase();
    if (head.includes("theora") || head.includes("vp8") || head.includes("uvp")) return signature(bytes, "ogg", "video", "ogg video", "OggS container with a video codec header");
    if (head.includes("vorbis") || head.includes("opus") || head.includes("flac")) return signature(bytes, "ogg", "audio", "ogg audio", "OggS container with an audio codec header");
    return signature(bytes, "ogg", "video", "ogg", "OggS container (codec not identified in the sample)");
  }

  // ── MPEG transport stream: 0x47 sync byte every 188 bytes ──
  if (bytes[0] === 0x47 && bytes.byteLength >= 188 * 3) {
    let sync = true;
    for (let i = 1; i < 4; i++) if (bytes[i * 188] !== 0x47) sync = false;
    if (sync) return signature(bytes, "mpeg_ts", "video", "mpeg transport stream", "0x47 sync bytes at 188-byte intervals");
  }

  // ── FLV ──
  if (ascii(bytes, 0, 3) === "FLV") return signature(bytes, "flv", "video", "flash video (flv)", "FLV container header");

  // ── AVI (RIFF....AVI ) ──
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 3) === "AVI") return signature(bytes, "avi", "video", "avi", "RIFF/AVI container header");
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") return signature(bytes, "wav", "audio", "wav", "RIFF/WAVE audio container");
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return signature(bytes, "webp", "image", "webp image", "RIFF/WEBP image — a still image, not a video");

  // ── Still images: the classic "thumbnail instead of video" failure ──
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return signature(bytes, "jpeg", "image", "jpeg image", "JPEG image — a thumbnail or cover image, not a video stream");
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return signature(bytes, "png", "image", "png image", "PNG image — a thumbnail, poster or screenshot, not a video stream");
  if (ascii(bytes, 0, 4) === "GIF8") return signature(bytes, "gif", "image", "gif image", "GIF image — an animated still, not a decodable video stream");
  if (ascii(bytes, 0, 2) === "BM") return signature(bytes, "bmp", "image", "bmp image", "BMP image — a still image, not a video stream");

  // ── Audio-only containers ──
  // MPEG audio frame sync is 11 set bits (0xFF followed by 0xE0-masked byte).
  const mpegAudioSync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  if (ascii(bytes, 0, 3) === "ID3" || mpegAudioSync) {
    return signature(bytes, "mp3", "audio", "mpeg audio", "MPEG audio frame or ID3 tag — audio only, no video track");
  }
  if (ascii(bytes, 0, 4) === "fLaC") return signature(bytes, "flac", "audio", "flac audio", "FLAC audio — audio only, no video track");

  // ── Text-shaped bodies: HLS playlists, HTML walls, JSON errors ──
  if (looksLikeText(bytes)) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 4_096));
    const trimmed = text.trim();
    if (/^#EXTM3U/i.test(trimmed) || /#EXT-X-(?:VERSION|STREAM-INF|TARGETDURATION|MEDIA)/i.test(trimmed)) {
      return signature(bytes, "hls_playlist", "playlist", "hls playlist", "HLS/DASH playlist — a manifest of segments, not a bounded video file");
    }
    if (/^<\?xml/i.test(trimmed) && /<MPD/i.test(trimmed)) {
      return signature(bytes, "hls_playlist", "playlist", "dash manifest", "DASH MPD manifest — not a bounded video file");
    }
    if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed) || /<head[\s>]/i.test(trimmed.slice(0, 2_000)) || /<body[\s>]/i.test(trimmed.slice(0, 2_000))) {
      return signature(bytes, "html_page", "html", "html document", "An HTML page was returned instead of video bytes (interstitial, login wall, error page or player shell)");
    }
    if (/^[{[]/.test(trimmed)) {
      try {
        JSON.parse(trimmed);
        return signature(bytes, "json_document", "json", "json document", "A JSON document was returned instead of video bytes (API error or metadata response)");
      } catch {
        return signature(bytes, "json_document", "json", "json document", "A JSON-shaped document was returned instead of video bytes");
      }
    }
    if (trimmed.length > 0) return signature(bytes, "text", "text", "plain text", "Plain text was returned instead of video bytes");
  }

  // ── No signature recognised: fall back to the declared content type ──
  if (hint) {
    if (PLAYLIST_CONTENT_TYPES.test(hint)) return signature(bytes, "hls_playlist", "playlist", "hls playlist", `Declared ${hint}; no bounded video signature was present`);
    if (VIDEO_CONTENT_TYPES.test(hint)) {
      return { ...signature(bytes, "unknown", "unknown", null, `Declared ${hint} but the bytes carry no recognised video signature`), kind: "unknown" };
    }
    if (AUDIO_CONTENT_TYPES.test(hint)) return signature(bytes, "unknown", "audio", null, `Declared ${hint} but no recognised audio signature was present`);
    if (IMAGE_CONTENT_TYPES.test(hint)) return signature(bytes, "unknown", "image", null, `Declared ${hint}: an image response, not a video`);
    if (HTML_CONTENT_TYPES.test(hint)) return signature(bytes, "html_page", "html", "html document", `Declared ${hint}: an HTML page, not video bytes`);
    if (JSON_CONTENT_TYPES.test(hint)) return signature(bytes, "json_document", "json", "json document", `Declared ${hint}: a JSON document, not video bytes`);
    if (TEXT_CONTENT_TYPES.test(hint)) return signature(bytes, "text", "text", "plain text", `Declared ${hint}: plain text, not video bytes`);
  }
  return signature(bytes, "unknown", "unknown", null, "No recognised media signature and no usable content type");
}

/** Content-type-only check, used when no bytes have been read yet (HEAD). */
export function contentTypeIsVideo(type: string | null): boolean {
  return Boolean(type && VIDEO_CONTENT_TYPES.test(type));
}

export function contentTypeIsPlaylist(type: string | null): boolean {
  return Boolean(type && PLAYLIST_CONTENT_TYPES.test(type));
}

/** Human/agent readable reason for a `NOT_A_VIDEO` rejection. */
export function notAVideoMessage(detected: MediaSignature): string {
  switch (detected.detectedAs) {
    case "jpeg":
    case "png":
    case "gif":
    case "webp":
    case "bmp":
    case "avif":
      return `The response is a ${detected.detectedAs.toUpperCase()} image (a thumbnail/poster), not a video stream. DEMO never substitutes a thumbnail for video content.`;
    case "html_page":
      return "The response is an HTML page (interstitial, login wall, challenge or player shell), not video bytes.";
    case "json_document":
      return "The response is a JSON document (API/metadata response or error body), not video bytes.";
    case "hls_playlist":
      return "The response is a streaming manifest (HLS/DASH playlist), not a bounded downloadable video file.";
    case "text":
      return "The response is plain text, not video bytes.";
    case "mp3":
    case "flac":
    case "wav":
    case "m4a":
      return `The response is audio only (${detected.detectedAs}), with no video track.`;
    default:
      return "The response carried no recognised video container signature.";
  }
}

/* -------------------------------------------------------------------------- */
/* ISO-BMFF duration parsing (policy check only — this is not a decoder)       */
/* -------------------------------------------------------------------------- */

const MAX_PLAUSIBLE_DURATION = 86_400;

function plausibleDuration(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value < MAX_PLAUSIBLE_DURATION;
}

function durationFromMvhdAt(bytes: Uint8Array, boxStart: number): number | null {
  // [size(4)][type(4)="mvhd"][version(1)][flags(3)] then version-specific fields.
  const version = bytes[boxStart + 8];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (version === 0 && boxStart + 28 <= bytes.byteLength) {
    const timescale = view.getUint32(boxStart + 20);
    const duration = view.getUint32(boxStart + 24);
    return timescale > 0 ? duration / timescale : null;
  }
  if (version === 1 && boxStart + 40 <= bytes.byteLength) {
    const timescale = view.getUint32(boxStart + 28);
    const duration = view.getUint32(boxStart + 32) * 2 ** 32 + view.getUint32(boxStart + 36);
    return timescale > 0 ? duration / timescale : null;
  }
  return null;
}

function walkIsoBoxes(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 8 <= view.byteLength) {
    let size = view.getUint32(offset);
    const type = ascii(bytes, offset + 4, 4);
    let header = 8;
    if (size === 1 && offset + 16 <= view.byteLength) {
      size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
      header = 16;
    } else if (size === 0) {
      size = view.byteLength - offset;
    }
    if (!Number.isFinite(size) || size < header || offset + size > view.byteLength) break;
    if (type === "moov") {
      let child = offset + header;
      const end = Math.min(offset + size, view.byteLength);
      while (child + 8 <= end) {
        const childSize = view.getUint32(child);
        if (ascii(bytes, child + 4, 4) === "mvhd") {
          const duration = durationFromMvhdAt(bytes, child);
          if (duration !== null && plausibleDuration(duration)) return duration;
        }
        if (!childSize || childSize < 8) break;
        child += childSize;
      }
    }
    offset += size;
  }
  return null;
}

/** Byte scan for an `mvhd` fourCC — used when a sample starts mid-box (a tail
 * range read) or when the box walk stops early on a fragmented file. */
function scanForMvhd(bytes: Uint8Array): number | null {
  for (let i = 0; i + 40 <= bytes.byteLength; i++) {
    if (bytes[i] !== 0x6d || bytes[i + 1] !== 0x76 || bytes[i + 2] !== 0x68 || bytes[i + 3] !== 0x64) continue;
    const duration = durationFromMvhdAt(bytes, i - 4);
    if (duration !== null && plausibleDuration(duration)) return duration;
  }
  return null;
}

/**
 * Parse an ISO-BMFF (`mvhd`) duration out of a bounded byte sample.
 *
 * Works on a leading sample (faststart files, where `moov` is first) and on a
 * trailing sample (`moov` at the end of the file), which is why a tail range
 * read of the stored artifact can still verify the duration policy.
 */
export function mp4DurationFromBytes(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 16) return null;
  const walked = walkIsoBoxes(bytes);
  if (walked !== null) return walked;
  return scanForMvhd(bytes);
}

/** Read an EBML variable-length integer (vint): the position of the first
 * set bit gives the byte length, the remaining bits the value. Returns null
 * for truncated or all-zero input. */
function readEbmlVint(bytes: Uint8Array, offset: number): { length: number; value: number } | null {
  if (offset >= bytes.byteLength) return null;
  const first = bytes[offset];
  let length = 0;
  for (let bit = 7; bit >= 0; bit--) {
    if (first & (1 << bit)) {
      length = 8 - bit;
      break;
    }
  }
  if (length === 0 || length > 8 || offset + length > bytes.byteLength) return null;
  let value = length === 8 ? 0 : first & ((1 << (8 - length)) - 1);
  for (let k = 1; k < length; k++) value = value * 256 + bytes[offset + k];
  return { length, value };
}

/** WebM/Matroska duration lives in an EBML `Segment > Info > Duration` element.
 * A best-effort bounded scan for element id 0x2ad7b1 (TimecodeScale, default
 * 1ms) and 0x4489 (Duration, a 4/8-byte float in timecode ticks). Element data
 * lengths are parsed as EBML vints, as real muxers write them. Returns null
 * when the sample does not contain a usable Duration rather than guessing. */
export function webmDurationFromBytes(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 32) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let timecodeScale = 1_000_000;
  for (let i = 0; i + 4 <= bytes.byteLength; i++) {
    if (bytes[i] === 0x2a && bytes[i + 1] === 0xd7 && bytes[i + 2] === 0xb1) {
      const vint = readEbmlVint(bytes, i + 3);
      if (vint && vint.value >= 1 && vint.value <= 8 && i + 3 + vint.length + vint.value <= bytes.byteLength) {
        let value = 0;
        for (let j = 0; j < vint.value; j++) value = value * 256 + bytes[i + 3 + vint.length + j];
        if (value > 0) timecodeScale = value;
      }
    }
    if (bytes[i] === 0x44 && bytes[i + 1] === 0x89) {
      const vint = readEbmlVint(bytes, i + 2);
      if (!vint || (vint.value !== 4 && vint.value !== 8)) continue;
      const dataAt = i + 2 + vint.length;
      if (dataAt + vint.value > bytes.byteLength) continue;
      const raw = vint.value === 4 ? view.getFloat32(dataAt) : view.getFloat64(dataAt);
      if (Number.isFinite(raw) && raw > 0) {
        const seconds = (raw * timecodeScale) / 1_000_000_000;
        if (plausibleDuration(seconds)) return seconds;
      }
    }
  }
  return null;
}

/** Duration from any bounded sample of a supported container. */
export function durationFromSample(bytes: Uint8Array, detected?: MediaSignature | null): number | null {
  const signatureValue = detected ?? detectMediaSignature(bytes);
  if (signatureValue.detectedAs === "webm" || signatureValue.detectedAs === "matroska") return webmDurationFromBytes(bytes);
  if (signatureValue.detectedAs === "mp4" || signatureValue.detectedAs === "mov" || signatureValue.detectedAs === "3gp" || signatureValue.detectedAs === "m4a") return mp4DurationFromBytes(bytes);
  return mp4DurationFromBytes(bytes);
}

/* -------------------------------------------------------------------------- */
/* Image dimensions (so a frame can report the size it actually has)           */
/* -------------------------------------------------------------------------- */

/**
 * Read the pixel dimensions out of a JPEG/PNG/WebP/GIF sample.
 *
 * Workers have no image library, but the dimension fields sit in well-defined
 * headers. This is used to report the true size of a decoded frame (and to
 * confirm a requested resize actually took effect) — never to modify pixels.
 */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // PNG: IHDR immediately after the 8-byte signature.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  // GIF: logical screen size at offset 6.
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  // WebP: VP8/VP8L/VP8X chunk.
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && ascii(bytes, 8, 4) === "WEBP") {
    const chunk = ascii(bytes, 12, 4);
    if (chunk === "VP8X" && bytes.byteLength >= 30) {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return { width, height };
    }
    if (chunk === "VP8 " && bytes.byteLength >= 30) {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    if (chunk === "VP8L" && bytes.byteLength >= 25) {
      const bits = view.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  // BMP: DIB header at offset 14 carries width/height as signed 32-bit LE.
  // A negative height means top-down row order; the pixel size is the same.
  if (bytes[0] === 0x42 && bytes[1] === 0x4d && bytes.byteLength >= 26) {
    const width = view.getInt32(18, true);
    const height = view.getInt32(22, true);
    if (width > 0 && width <= 100_000 && height !== 0 && Math.abs(height) <= 100_000) {
      return { width, height: Math.abs(height) };
    }
  }
  // AVIF: dimensions live in the meta > iprp > ipco > ispe box chain.
  if (bytes.byteLength >= 12 && ascii(bytes, 4, 4) === "ftyp" && (ascii(bytes, 8, 4) === "avif" || ascii(bytes, 8, 4) === "avis")) {
    const avif = avifDimensions(bytes);
    if (avif) return avif;
  }
  // JPEG: walk segments to the first SOFn marker.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      // Standalone markers (RSTn, SOI, EOI, TEM) carry no length field.
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        offset += 2;
        continue;
      }
      const length = view.getUint16(offset + 2);
      if (length < 2) break;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof && offset + 9 <= bytes.byteLength) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

/**
 * Read AVIF dimensions from the `ispe` (image spatial extents) box nested
 * under `meta` > `iprp` > `ipco`. A strictly bounded nested walk: unknown
 * boxes are skipped by their declared size, malformed sizes abort the walk,
 * and implausible dimensions are rejected rather than returned.
 */
function avifDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readBox = (offset: number, end: number): { type: string; header: number; size: number } | null => {
    if (offset + 8 > end) return null;
    let size = view.getUint32(offset);
    const type = ascii(bytes, offset + 4, 4);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) return null;
      size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (!Number.isFinite(size) || size < header || offset + size > end) return null;
    return { type, header, size };
  };
  const search = (start: number, end: number, depth: number): { width: number; height: number } | null => {
    if (depth > 6) return null;
    let offset = start;
    let boxes = 0;
    while (offset + 8 <= end && boxes < 64) {
      const box = readBox(offset, end);
      if (!box) return null;
      boxes++;
      const payloadStart = offset + box.header + (box.type === "meta" ? 4 : 0);
      if (box.type === "ispe" && box.size >= 20 && payloadStart + 8 <= end) {
        const width = view.getUint32(payloadStart + 4);
        const height = view.getUint32(payloadStart + 8);
        if (width > 0 && width <= 100_000 && height > 0 && height <= 100_000) return { width, height };
      } else if ((box.type === "meta" || box.type === "iprp" || box.type === "ipco") && payloadStart < offset + box.size) {
        const found = search(payloadStart, Math.min(offset + box.size, end), depth + 1);
        if (found) return found;
      }
      offset += box.size;
    }
    return null;
  };
  return search(0, view.byteLength, 0);
}
