/**
 * Capability report for the DEMO 0.9 capability expansion (git, Internet
 * Archive, feeds, PDF, images, web diff/monitor/extract, OpenAPI, network
 * diagnostics, local utilities, research, URL safety).
 *
 * One source of truth for the MCP resource (`demo://capabilities/expanded`),
 * `demo_ping`, `/health` and `/platform/stats`: presence + limits only — no
 * key names beyond the documented public env var names, no values, ever.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { LIMITS } from "../core/limits.js";
import { resolveGitPolicy } from "../git/config.js";

export const EXPANDED_CAPABILITIES_URI = "demo://capabilities/expanded";

export interface ExpandedCapabilitiesReport {
  schema: 1;
  version: string;
  git: {
    publicOnly: true;
    requiresApiKey: false;
    credentialsAccepted: false;
    supportedHosts: string;
    modes: string[];
    maxPackMb: number;
    rateLimitPerMinute: number;
  };
  internetArchive: { available: true; apiKeyRequired: false; endpoints: string[] };
  feeds: { available: true; formats: string[]; apiKeyRequired: false };
  pdf: { available: true; ocr: boolean; ocrProvider: string | null; scannedDetection: true; tables: string };
  images: { available: true; vision: boolean; visionProvider: string | null; modes: string[] };
  web: {
    extract: true;
    diff: true;
    monitor: boolean;
    snapshots: boolean;
    snapshotStorage: string;
    scheduledChecks: boolean;
    screenshotDiff: boolean;
  };
  openapi: { available: true; formats: string[]; callsDiscoveredApis: false };
  network: { dns: true; http: true; tls: string; scanner: false };
  utilities: { jsonSchema: true; jwt: string; cron: true; textDiff: true; externalCalls: false };
  research: { available: true; provenance: string; humanHandoff: string };
  urlSafety: { available: true; usesSharedSsrfGuard: true };
  limits: Record<string, number>;
  security: string[];
}

export function expandedCapabilitiesReport(env: Record<string, unknown> | undefined, options: { version: string; browserAvailable?: boolean }): ExpandedCapabilitiesReport {
  const hasAi = Boolean(env?.AI && typeof (env?.AI as { run?: unknown }).run === "function");
  const visionModel = hasAi ? String(env?.VIDEO_VISION_MODEL ?? "@cf/llava-hf/llava-1.5-7b-hf") : null;
  const snapshots = Boolean((env?.WEB_SNAPSHOTS ?? env?.SCREENSHOTS) as object | undefined);
  const gitPolicy = resolveGitPolicy(env);
  return {
    schema: 1,
    version: options.version,
    git: {
      publicOnly: true,
      requiresApiKey: false,
      credentialsAccepted: false,
      supportedHosts: "any public Git smart-HTTP host (GitHub, GitLab, Codeberg, Gitea, sourcehut, self-hosted git-http-backend)",
      modes: ["info", "branches", "tags", "log", "commit", "file", "tree", "search", "compare", "patch", "stats", "ignore", "fetch"],
      maxPackMb: Math.round(gitPolicy.maxPackBytes / (1024 * 1024)),
      rateLimitPerMinute: gitPolicy.rateLimitPerMinute,
    },
    internetArchive: {
      available: true,
      apiKeyRequired: false,
      endpoints: ["archive.org/wayback/available", "web.archive.org/cdx", "web.archive.org/web", "archive.org/advancedsearch.php", "archive.org/metadata"],
    },
    feeds: { available: true, formats: ["RSS 2.x", "Atom 1.0", "RDF/RSS 1.0"], apiKeyRequired: false },
    pdf: {
      available: true,
      ocr: hasAi,
      ocrProvider: hasAi ? `cloudflare-ai:${visionModel}` : null,
      scannedDetection: true,
      tables: "whitespace/alignment heuristic (best-effort)",
    },
    images: {
      available: true,
      vision: hasAi,
      visionProvider: hasAi ? `cloudflare-ai:${visionModel}` : null,
      modes: ["info", "describe", "ocr", "analyze", "compare"],
    },
    web: {
      extract: true,
      diff: true,
      monitor: snapshots,
      snapshots,
      snapshotStorage: snapshots ? "existing R2 artifact bucket (expiring objects, scheduled TTL cleanup)" : "unavailable (bind SCREENSHOTS)",
      scheduledChecks: String(env?.WEB_MONITOR_SCHEDULED_CHECKS ?? "false").toLowerCase() === "true",
      screenshotDiff: Boolean(options.browserAvailable),
    },
    openapi: { available: true, formats: ["JSON", "YAML"], callsDiscoveredApis: false },
    network: {
      dns: true,
      http: true,
      tls: options.browserAvailable ? "via browser security details" : "unavailable (no browser binding)",
      scanner: false,
    },
    utilities: {
      jsonSchema: true,
      jwt: "decode only — DECODING ≠ VERIFICATION; no signing keys ever accepted",
      cron: true,
      textDiff: true,
      externalCalls: false,
    },
    research: {
      available: true,
      provenance: "every sourced statement carries source URL + retrieval timestamp; conflicts reported, never resolved by guessing",
      humanHandoff: "browser_captcha_handoff / browser_pause_for_human for CAPTCHA/login walls",
    },
    urlSafety: { available: true, usesSharedSsrfGuard: true },
    limits: {
      publicFetchTimeoutMs: LIMITS.publicFetchTimeoutDefaultMs,
      webpageMaxHtmlBytes: LIMITS.webpageMaxHtmlBytes,
      feedMaxEntries: LIMITS.feedMaxEntriesCap,
      pdfMaxMb: Math.round(LIMITS.pdfMaxBytesCap / (1024 * 1024)),
      imageMaxMb: Math.round(LIMITS.imageMaxBytes / (1024 * 1024)),
      diffMaxLines: LIMITS.diffMaxLinesCap,
      researchMaxSources: LIMITS.researchMaxSourcesCap,
      monitorMinCheckIntervalSeconds: LIMITS.monitorMinCheckIntervalSeconds,
    },
    security: [
      "All fetches re-validated per redirect hop against DEMO's SSRF policy (localhost, RFC1918, link-local, metadata, internal DNS zones, unsafe schemes, credential URLs blocked).",
      "Git: public repositories only; no credential mechanism exists; hooks/LFS/build scripts never run; repository content is untrusted data.",
      "No IP logging, tracking pixels, fingerprints, analytics or telemetry added.",
      "No secrets, filesystem paths, internal URLs or environment values are ever returned.",
      "PDFs/feeds/images/documents are parsed as data; nothing they contain is executed.",
    ],
  };
}

export function registerExpandedResources(mcp: McpServer, ctx: { env: Record<string, unknown> | undefined; version: string; browserAvailable?: boolean }): void {
  mcp.registerResource(
    "expanded_capabilities",
    EXPANDED_CAPABILITIES_URI,
    {
      title: "DEMO Expanded Capabilities (0.9)",
      description:
        "Live capability report for the DEMO 0.9 expanded tools: public Git, Internet Archive/Wayback, RSS/Atom feeds, PDF intelligence (incl. OCR availability), image analysis, web extraction/diff/monitoring, OpenAPI inspection, network diagnostics, JSON Schema/JWT/cron/text-diff utilities, structured research and URL safety — with limits and the security contract. Presence only; no credentials or values.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(expandedCapabilitiesReport(ctx.env, { version: ctx.version, browserAvailable: ctx.browserAvailable }), null, 2),
        },
      ],
    }),
  );
}
