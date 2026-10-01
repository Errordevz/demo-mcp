/**
 * Isolated analysis workspace and target resolution.
 *
 * Two jobs:
 *
 *  1. **Path isolation.** Every extracted file, cached artifact and temporary
 *     blob lives under a per-analysis workspace prefix. Nothing here ever
 *     touches a real filesystem (Workers have none), and every path a caller
 *     supplies is re-validated against the workspace root before use, so
 *     `../../etc/passwd`, an absolute path, a Windows drive letter, a NUL byte
 *     or a symlink-shaped name is refused rather than normalised.
 *
 *  2. **Target resolution.** A target may arrive as inline base64, as a public
 *     URL (fetched through DEMO's existing SSRF guard, never directly), as a
 *     previously stored analysis artifact, or as a workspace path on the
 *     configured analysis service. All four are size-capped before any parsing.
 */

import { BrowserError } from "../core/errors.js";

/** The workspace root every analysis is confined to. */
export const WORKSPACE_ROOT = "re-workspace";

export type TargetSource = "inline" | "url" | "artifact" | "workspace" | "capture";

export interface ResolvedTarget {
  /** Sanitized display name — never a filesystem path. */
  name: string;
  source: TargetSource;
  bytes: Uint8Array;
  sha256: string;
  /** Where the bytes actually came from, for the report. */
  origin: string;
  warnings: string[];
}

export interface LoadTargetContext {
  /** Bounded, SSRF-guarded byte fetch supplied by the MCP layer. */
  fetchBytes?: (url: string, maxBytes: number) => Promise<{ bytes: Uint8Array; finalUrl: string }>;
  /** Storage-backed artifact reader supplied by the MCP layer. */
  readArtifact?: (key: string) => Promise<Uint8Array | null>;
  /** Reader for a path inside the configured analysis-service workspace. */
  readWorkspacePath?: (path: string) => Promise<Uint8Array | null>;
  maxBytes: number;
}

export interface TargetRef {
  source?: TargetSource;
  /** Inline base64 payload. */
  data_base64?: string;
  /** Public URL, or a workspace path, depending on `source`. */
  url?: string;
  path?: string;
  /** A stored analysis artifact key. */
  artifact_key?: string;
  /** Display name for the target. */
  name?: string;
}

/**
 * Reduce a caller-supplied name to a safe display string: no separators, no
 * control characters, bounded length. This is what ends up in the report, so it
 * must never be able to smuggle a path.
 */
export function sanitizeTargetName(raw: string | undefined, fallback = "target.bin"): string {
  const text = String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!text) return fallback;
  const base = text.split(/[\\/]/).pop() || fallback;
  const cleaned = base.replace(/[^A-Za-z0-9._\-+ ]/g, "_").slice(0, 128);
  return cleaned || fallback;
}

/**
 * Validate a path that is supposed to live inside the analysis workspace.
 * Returns the *normalised* workspace-relative path, or throws.
 *
 * The rule is deliberately allow-list based: a path may only contain
 * `[A-Za-z0-9._-]` segments separated by `/`. Anything else — `..`, `.`,
 * an absolute prefix, a backslash, a drive letter, `~`, a NUL byte — is refused
 * before it can be joined to anything.
 */
export function assertSafeWorkspacePath(input: string, root = WORKSPACE_ROOT): string {
  const raw = String(input ?? "");
  if (!raw) throw new BrowserError("invalid_input", "A workspace path is required.");
  if (raw.length > 512) throw new BrowserError("invalid_input", "The workspace path is too long.");
  if (raw.includes("\0")) throw new BrowserError("invalid_input", "The workspace path contains a NUL byte.");
  if (raw.includes("\\")) throw new BrowserError("invalid_input", "Backslashes are not valid in a workspace path.");
  if (raw.startsWith("/") || raw.startsWith("~") || /^[A-Za-z]:/.test(raw)) {
    throw new BrowserError("invalid_input", "Absolute paths are not valid workspace paths.");
  }
  const segments = raw.split("/");
  const clean: string[] = [];
  for (const segment of segments) {
    if (segment === "") throw new BrowserError("invalid_input", "The workspace path contains an empty segment.");
    if (segment === ".") continue;
    if (segment === "..") throw new BrowserError("invalid_input", "Parent-directory segments are not permitted in a workspace path.");
    if (!/^[A-Za-z0-9._\-]+$/.test(segment)) {
      throw new BrowserError("invalid_input", `The workspace path segment "${segment.slice(0, 32)}" contains characters that are not allowed.`);
    }
    if (segment.startsWith("-")) throw new BrowserError("invalid_input", "Workspace path segments may not start with a dash.");
    clean.push(segment);
  }
  if (clean.length === 0) throw new BrowserError("invalid_input", "The workspace path resolves to the workspace root.");
  return `${root}/${clean.join("/")}`;
}

/** True when `candidate` is the workspace root or lives inside it. */
export function isInsideWorkspace(candidate: string, root = WORKSPACE_ROOT): boolean {
  const text = String(candidate ?? "").replace(/\\/g, "/");
  if (!text.startsWith(`${root}/`)) return false;
  const rest = text.slice(root.length + 1);
  if (!rest) return false;
  return rest.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** Reject anything that tries to escape, whatever its shape. */
export function assertInsideWorkspace(candidate: string, root = WORKSPACE_ROOT): string {
  if (!isInsideWorkspace(candidate, root)) {
    throw new BrowserError("invalid_input", "That path is outside the isolated analysis workspace and was refused.", {
      hint: "Every analysis target and artifact stays inside the per-analysis workspace prefix.",
    });
  }
  return candidate;
}

/** Workspace prefix for one analysis. */
export function workspacePrefix(analysisId: string): string {
  return `${WORKSPACE_ROOT}/${sanitizeAnalysisId(analysisId)}/`;
}

export function sanitizeAnalysisId(raw: string): string {
  const text = String(raw ?? "").trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(text) ? text : randomAnalysisId();
}

export function randomAnalysisId(): string {
  return `re_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/** Strict, bounded base64 decode. Rejects anything that is not base64. */
export function decodeBase64Bounded(input: string, maxBytes: number): Uint8Array {
  const text = String(input ?? "").trim();
  if (!text) throw new BrowserError("invalid_input", "data_base64 is empty.");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text.replace(/\s+/g, ""))) {
    throw new BrowserError("invalid_input", "data_base64 is not valid base64.");
  }
  const compact = text.replace(/\s+/g, "");
  // 4 base64 chars -> 3 bytes. Estimate before decoding so an oversized payload
  // is refused before it is materialised.
  const estimated = Math.floor((compact.length * 3) / 4);
  if (estimated > maxBytes) {
    throw new BrowserError("size_limit_exceeded", `The inline target is about ${Math.round(estimated / (1024 * 1024))} MB, above the ${Math.round(maxBytes / (1024 * 1024))} MB limit.`);
  }
  const binary = atob(compact);
  if (binary.length > maxBytes) {
    throw new BrowserError("size_limit_exceeded", `The inline target is ${Math.round(binary.length / (1024 * 1024))} MB, above the ${Math.round(maxBytes / (1024 * 1024))} MB limit.`);
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Resolve a target reference into bytes, enforcing the size cap and the
 * isolation rules. Nothing here executes anything: it only produces bytes the
 * deterministic parsers will read as data.
 */
export async function resolveTarget(ref: TargetRef | string, ctx: LoadTargetContext): Promise<ResolvedTarget> {
  const source: TargetSource =
    typeof ref === "string" ? (/^https?:\/\//i.test(ref.trim()) ? "url" : "workspace") : (ref.source ?? inferSource(ref));
  const warnings: string[] = [];

  if (source === "inline") {
    const data = typeof ref === "string" ? "" : (ref.data_base64 ?? "");
    const bytes = decodeBase64Bounded(data, ctx.maxBytes);
    return {
      name: sanitizeTargetName(typeof ref === "string" ? undefined : ref.name),
      source,
      bytes,
      sha256: await sha256Hex(bytes),
      origin: "inline base64 payload",
      warnings,
    };
  }

  if (source === "url") {
    const url = typeof ref === "string" ? ref.trim() : (ref.url ?? "").trim();
    if (!/^https?:\/\//i.test(url)) throw new BrowserError("invalid_input", "A target URL must be an http(s) URL.");
    if (!ctx.fetchBytes) {
      throw new BrowserError("capability_unavailable", "This deployment has no fetch infrastructure available for URL targets.", {
        capability: "reverse_engineering_url_target",
      });
    }
    const result = await ctx.fetchBytes(url, ctx.maxBytes);
    return {
      name: sanitizeTargetName(typeof ref === "string" ? fileNameFromUrl(url) : ref.name, fileNameFromUrl(url)),
      source,
      bytes: result.bytes,
      sha256: await sha256Hex(result.bytes),
      origin: result.finalUrl,
      warnings,
    };
  }

  if (source === "artifact") {
    const key = typeof ref === "string" ? ref : (ref.artifact_key ?? "");
    const safeKey = assertSafeWorkspacePath(key, "re-art");
    if (!ctx.readArtifact) {
      throw new BrowserError("capability_unavailable", "Analysis artifact storage is not configured on this deployment.", { capability: "reverse_engineering_storage" });
    }
    const bytes = await ctx.readArtifact(safeKey);
    if (!bytes) throw new BrowserError("not_found", "That analysis artifact does not exist (or has expired).");
    if (bytes.byteLength > ctx.maxBytes) throw new BrowserError("size_limit_exceeded", "The stored artifact is above the target size limit.");
    return {
      name: sanitizeTargetName(typeof ref === "string" ? undefined : ref.name, safeKey.split("/").pop()),
      source,
      bytes,
      sha256: await sha256Hex(bytes),
      origin: safeKey,
      warnings,
    };
  }

  // Workspace path: only meaningful for a configured external analysis service.
  const path = typeof ref === "string" ? ref.trim() : (ref.path ?? "").trim();
  const safeKey = assertSafeWorkspacePath(path);
  if (!ctx.readWorkspacePath) {
    throw new BrowserError("capability_unavailable", "Workspace-path targets require a configured external analysis service (RE_ANALYZER_URL).", {
      capability: "reverse_engineering_analyzer",
      hint: "Send the bytes inline (data_base64), as a public URL, or as a stored analysis artifact instead.",
    });
  }
  const bytes = await ctx.readWorkspacePath(safeKey);
  if (!bytes) throw new BrowserError("not_found", "That path does not exist inside the analysis-service workspace.");
  if (bytes.byteLength > ctx.maxBytes) throw new BrowserError("size_limit_exceeded", "The workspace target is above the size limit.");
  return {
    name: sanitizeTargetName(typeof ref === "string" ? safeKey.split("/").pop() : ref.name, safeKey.split("/").pop()),
    source: "workspace",
    bytes,
    sha256: await sha256Hex(bytes),
    origin: safeKey,
    warnings,
  };
}

function inferSource(ref: TargetRef): TargetSource {
  if (ref.data_base64) return "inline";
  if (ref.artifact_key) return "artifact";
  if (ref.url) return "url";
  if (ref.path) return "workspace";
  return "inline";
}

export function fileNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.split("/").filter(Boolean).pop();
    return name ? decodeURIComponent(name) : parsed.hostname;
  } catch {
    return "target.bin";
  }
}

/** Copy bytes so a later mutation of the source buffer cannot poison an artifact. */
export function copyBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}
