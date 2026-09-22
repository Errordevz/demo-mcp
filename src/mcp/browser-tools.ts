/**
 * Session-aware browser tools.
 *
 * Design rules:
 *  - Every tool accepts an optional `session_id` / `page_id`. When they are
 *    omitted a session is created on the fly and returned so follow-up calls can
 *    reuse it (open → click → screenshot on the same rendered page).
 *  - Every tool also accepts a legacy `url` argument. Supplying a URL without a
 *    session reproduces the old one-shot behaviour (open, act, close).
 *  - Challenges are reported, never bypassed: `challenge_required` comes back
 *    with a Live View URL and a pointer to `browser_resume`.
 *  - Screenshots are stored outside the MCP payload and returned as links.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { BrowserError } from "../core/errors.js";
import { LIMITS } from "../core/limits.js";
import { safeLog } from "../core/redact.js";
import { parseElementTarget, type ElementTarget, type ScreenshotType, type WaitUntil } from "../browser/types.js";
import type { SessionClient } from "../session/facade.js";
import type { SessionManager, SessionManagerEnv } from "../session/manager.js";
import { errorFrom, imageResult, runTool, textResult, type ToolResult } from "./results.js";

export interface ToolContext {
  env: SessionManagerEnv;
  sessions: SessionManager;
  requestUrl?: string | null;
}

const WAIT_UNTIL = z.enum(["load", "domcontentloaded", "networkidle0", "networkidle2"]);

const sessionFields = {
  session_id: z
    .string()
    .optional()
    .describe("Reuse an existing browser session (returned by browser_open). Omit to start a new one."),
  page_id: z.string().optional().describe("Tab id such as p1. Defaults to the active tab."),
};

const urlField = z
  .string()
  .optional()
  .describe("Optional URL for one-shot use. When given without session_id, DEMO opens it, acts, and closes the session.");

type SessionArgs = { session_id?: string; page_id?: string; url?: string };

/**
 * Run an action against a session.
 *
 * `url` + no `session_id` = legacy one-shot flow (session is closed afterwards).
 * `session_id` (with or without `url`) = persistent session flow.
 */
async function withSession<T>(
  ctx: ToolContext,
  args: SessionArgs,
  work: (client: SessionClient, pageId: string | null) => Promise<T>,
  options: { openOptions?: { waitUntil?: WaitUntil; timeoutMs?: number } } = {},
): Promise<T & { sessionId?: string }> {
  const sessionId = ctx.sessions.sessionId(args.session_id ?? null);
  const client = await ctx.sessions.client(sessionId);
  const oneShot = Boolean(args.url) && !args.session_id;

  if (!oneShot) {
    const result = await work(client, ctx.sessions.pageId(args.page_id ?? null));
    return { ...(result as object), sessionId } as T & { sessionId?: string };
  }

  try {
    const opened = await client.open(null, String(args.url), options.openOptions ?? {});
    const result = await work(client, opened.tab.id);
    return { ...(result as object), sessionId } as T & { sessionId?: string };
  } finally {
    await client.close().catch((error: unknown) => safeLog("warn", "one-shot-close-failed", String(error)));
  }
}

function challengeBlock(verdict: {
  status: string;
  confidence: number;
  reason: string;
  signals: string[];
  requiresHuman: boolean;
  recommendedAction: string;
  vendor?: string;
}) {
  return {
    status: verdict.status,
    confidence: verdict.confidence,
    reason: verdict.reason,
    signals: verdict.signals,
    requiresHuman: verdict.requiresHuman,
    recommendedAction: verdict.recommendedAction,
    ...(verdict.vendor ? { vendor: verdict.vendor } : {}),
  };
}

function targetFrom(input: string): ElementTarget {
  const value = String(input ?? "").trim();
  if (!value) throw new BrowserError("invalid_input", "A target is required (CSS selector, text:…, role:button:Name or ref:e3).");
  return parseElementTarget(value);
}

export function registerBrowserTools(mcp: McpServer, ctx: ToolContext): void {
  const capabilities = () => ctx.sessions.capabilities();

  /* ------------------------------------------------------------ browser_open */

  mcp.registerTool(
    "browser_open",
    {
      title: "Browser Open",
      description:
        "Open a URL in DEMO's Cloudflare browser session, follow redirects, and return the final URL, title, page stats and challenge status. Pass the returned session_id to later browser tools to keep working on the same rendered page.",
      inputSchema: {
        url: z.string().min(1).describe("Absolute http(s) URL to open."),
        ...sessionFields,
        wait_until: WAIT_UNTIL.default("domcontentloaded"),
        timeout: z.number().int().min(1_000).max(LIMITS.navigationTimeoutMaxMs).default(LIMITS.navigationTimeoutDefaultMs),
        settle_ms: z.number().int().min(0).max(10_000).default(750).describe("Extra settle time after the navigation event fires."),
        screenshot: z.boolean().default(false).describe("Also capture a viewport screenshot."),
      },
    },
    (args) =>
      runTool(async (): Promise<ToolResult> => {
        const sessionId = ctx.sessions.sessionId(args.session_id ?? null);
        const client = await ctx.sessions.client(sessionId);
        const opened = await client.open(ctx.sessions.pageId(args.page_id ?? null), args.url, {
          waitUntil: args.wait_until as WaitUntil,
          timeoutMs: args.timeout,
          settleMs: args.settle_ms,
        });
        const shot = args.screenshot ? await client.screenshot(opened.tab.id, { type: "png", fullPage: false }) : null;
        const challenge = challengeBlock(opened.challenge);
        return textResult({
          success: true,
          sessionId,
          pageId: opened.tab.id,
          url: opened.finalUrl,
          finalUrl: opened.finalUrl,
          requestedUrl: opened.requestedUrl,
          title: opened.title,
          status: opened.status,
          redirected: opened.redirected,
          durationMs: opened.durationMs,
          page: opened.page,
          challenge,
          requiresHuman: challenge.requiresHuman,
          tabs: opened.tabs.map((tab) => ({ id: tab.id, url: tab.url, title: tab.title, active: tab.active })),
          sessionStorage: capabilities().sessionStorage,
          ...(shot ? { screenshot: { url: shot.image.url, mimeType: shot.image.mimeType, bytes: shot.image.bytes } } : {}),
          next: challenge.requiresHuman
            ? `A ${challenge.status} page was detected. Call browser_pause_for_human with session_id "${sessionId}" to get a Live View URL, complete the step yourself, then call browser_resume.`
            : `Reuse session_id "${sessionId}" and page_id "${opened.tab.id}" with browser_read, browser_snapshot, browser_click, browser_screenshot, browser_media_info.`,
        });
      }),
  );

  /* ------------------------------------------------------ browser_screenshot */

  mcp.registerTool(
    "browser_screenshot",
    {
      title: "Browser Screenshot",
      description:
        "Capture the viewport, the full page, or a single element of the current page. The image is stored in Cloudflare R2 and returned as a compact link (not inline bytes) unless inline=true.",
      inputSchema: {
        ...sessionFields,
        url: urlField,
        type: z.enum(["png", "jpeg", "webp"]).default("png"),
        full_page: z.boolean().default(false).describe("Capture the whole scrollable page (falls back to the viewport when the page is taller than the safety limit)."),
        selector: z.string().optional().describe("CSS selector to capture a single element."),
        inline: z.boolean().default(false).describe("Also return a base64 image block (only when the image is small enough)."),
        quality: z.number().int().min(1).max(100).optional().describe("JPEG/WebP quality."),
      },
    },
    (args) =>
      runTool(async (): Promise<ToolResult> => {
        const result = await withSession(
          ctx,
          args,
          (client, pageId) =>
            client.screenshot(pageId, {
              type: args.type as ScreenshotType,
              fullPage: args.full_page,
              selector: args.selector ?? null,
              inline: args.inline,
              ...(args.quality !== undefined ? { quality: args.quality } : {}),
            }),
        );
        const payload = {
          success: true,
          captured: true,
          url: result.url,
          title: result.title,
          screenshot: result.image.url,
          mimeType: result.image.mimeType,
          bytes: result.image.bytes,
          fullPage: result.fullPage,
          truncatedToViewport: result.truncatedToViewport,
          width: result.width,
          height: result.height,
          selector: result.selector,
          timestamp: result.capturedAt,
          sessionId: result.sessionId,
          pageId: result.tab.id,
          challenge: challengeBlock(result.challenge),
          note: "Screenshot bytes are stored in DEMO R2; the MCP result contains only this link and metadata.",
        };
        if (args.inline && result.inlineData) {
          return imageResult([{ data: result.inlineData, mimeType: result.image.mimeType }], payload);
        }
        if (args.inline && !result.inlineData) {
          return textResult({ ...payload, inline: false, note: "Image too large to inline; use the link instead." });
        }
        return textResult(payload);
      }),
  );

  /* ------------------------------------------------------------- browser_read */

  mcp.registerTool(
    "browser_read",
    {
      title: "Browser Read",
      description:
        "Read the rendered page: visible text, metadata, links, headings, interactive elements and media counts. This reads the DOM after JavaScript execution, not the raw HTTP response.",
      inputSchema: {
        ...sessionFields,
        url: urlField,
        selector: z.string().optional().describe("Limit the read to a CSS selector."),
        max_text_chars: z.number().int().min(200).max(LIMITS.maxTextChars).default(LIMITS.maxReadTextChars),
        max_links: z.number().int().min(0).max(LIMITS.maxLinks).default(LIMITS.maxLinks),
        include_html: z.boolean().default(false),
        format: z.enum(["text", "structured"]).default("structured"),
      },
    },
    (args) =>
      runTool(async () => {
        const result = await withSession(ctx, args, (client, pageId) =>
          client.read(pageId, {
            selector: args.selector ?? null,
            maxTextChars: args.max_text_chars,
            maxLinks: args.max_links,
            includeHtml: args.include_html,
            format: args.format === "text" ? "text" : "structured",
          }),
        );
        if (args.format === "text") {
          return textResult({
            success: true,
            sessionId: result.sessionId,
            pageId: result.tab.id,
            url: result.url,
            title: result.title,
            text: result.text,
            challenge: challengeBlock(result.challenge),
          });
        }
        return textResult({
          success: true,
          sessionId: result.sessionId,
          pageId: result.tab.id,
          url: result.url,
          title: result.title,
          selector: result.selector,
          selectorMatched: result.selectorMatched,
          text: result.text,
          textLength: result.textLength,
          truncatedText: result.truncatedText,
          metadata: result.metadata,
          links: result.links,
          headings: result.headings,
          interactive: result.interactive,
          forms: result.forms,
          media: result.media,
          scroll: result.scroll,
          ...(result.html ? { html: result.html } : {}),
          challenge: challengeBlock(result.challenge),
        });
      }),
  );

  /* --------------------------------------------------------- browser_snapshot */

  mcp.registerTool(
    "browser_snapshot",
    {
      title: "Browser Snapshot",
      description:
        "Return an accessibility tree and/or a simplified interactive DOM with ref ids (ref:e3) that browser_click and browser_type can address.",
      inputSchema: {
        ...sessionFields,
        url: urlField,
        mode: z.enum(["interactive", "accessibility", "both"]).default("interactive"),
        max_nodes: z.number().int().min(10).max(LIMITS.maxSnapshotNodes).default(LIMITS.maxSnapshotNodes),
        max_elements: z.number().int().min(1).max(LIMITS.maxInteractiveElements).default(LIMITS.maxInteractiveElements),
      },
    },
    (args) =>
      runTool(async () => {
        const result = await withSession(ctx, args, (client, pageId) =>
          client.snapshot(pageId, { mode: args.mode, maxNodes: args.max_nodes, maxElements: args.max_elements }),
        );
        return textResult({
          success: true,
          sessionId: result.sessionId,
          pageId: result.tab.id,
          url: result.url,
          title: result.title,
          mode: result.mode,
          snapshot: result.text,
          truncated: result.truncated,
          nodes: result.nodes,
          elements: result.elements,
          note: result.note,
          challenge: challengeBlock(result.challenge),
        });
      }),
  );

  /* ------------------------------------------------------------ browser_click */

  mcp.registerTool(
    "browser_click",
    {
      title: "Browser Click",
      description:
        "Click a visible element addressed by CSS selector, text:…, role:button:Name, or ref:eN from browser_snapshot.",
      inputSchema: {
        target: z.string().min(1).describe("CSS selector, text:Label, role:button:Name, or ref:e3"),
        ...sessionFields,
        url: urlField,
        timeout: z.number().int().min(1_000).max(LIMITS.waitMaxMs).default(20_000),
        screenshot: z.boolean().default(false),
      },
    },
    (args) =>
      runTool(async () => {
        const target = targetFrom(args.target);
        const result = await withSession(ctx, args, (client, pageId) => client.click(pageId, target, { timeoutMs: args.timeout, screenshotAfter: args.screenshot }));
        return textResult({
          success: true,
          sessionId: result.sessionId,
          pageId: result.tab.id,
          url: result.url,
          title: result.title,
          target: { kind: target.kind, value: "value" in target ? target.value : null },
          challenge: challengeBlock(result.challenge),
          ...(result.screenshot ? { screenshot: { url: result.screenshot.image.url, mimeType: result.screenshot.image.mimeType } } : {}),
        });
      }),
  );

  /* ------------------------------------------------------------- browser_type */

  mcp.registerTool(
    "browser_type",
    {
      title: "Browser Type",
      description:
        "Type text into a field. The typed value is never logged, never echoed back and never included in results — only its length is reported. Mark secret=true for credentials.",
      inputSchema: {
        target: z.string().min(1).describe("CSS selector, text:Label, role:textbox:Name, or ref:e3"),
        text: z.string().min(1).describe("Text to type. Never logged."),
        ...sessionFields,
        url: urlField,
        clear: z.boolean().default(true),
        submit: z.boolean().default(false).describe("Press Enter after typing."),
        secret: z.boolean().default(false).describe("Treat the value as a credential (extra redaction, never persisted)."),
        delay_ms: z.number().int().min(0).max(200).default(0),
      },
    },
    (args) =>
      runTool(async () => {
        const target = targetFrom(args.target);
        const result = await withSession(ctx, args, (client, pageId) =>
          client.type(pageId, target, args.text, { clear: args.clear, submit: args.submit, secret: args.secret }),
        );
        return textResult({
          success: true,
          sessionId: result.sessionId,
          pageId: result.tab.id,
          url: result.url,
          title: result.title,
          typedCharacters: result.typedCharacters,
          target: { kind: target.kind },
          secret: args.secret,
          valueLogged: false,
          note: "The typed value is not stored, logged or returned. Use browser_pause_for_human if a human must enter credentials through Live View.",
        });
      }),
  );

  /* ------------------------------------------------------------ browser_scroll */

  mcp.registerTool(
    "browser_scroll",
    {
      title: "Browser Scroll",
      description: "Scroll the page down, up, left, right, or jump to the top/bottom.",
      inputSchema: {
        direction: z.enum(["down", "up", "top", "bottom", "left", "right"]).default("down"),
        amount: z.number().int().min(1).max(100_000).default(800).describe("Pixels (ignored for top/bottom)."),
        ...sessionFields,
        url: urlField,
      },
    },
    (args) =>
      runTool(async () => {
        const result = await withSession(ctx, args, (client, pageId) => client.scroll(pageId, args.direction, args.amount));
        return textResult({
          success: true,
          sessionId: result.sessionId,
          pageId: result.tab.id,
          direction: args.direction,
          scrollX: result.x,
          scrollY: result.y,
          documentHeight: result.documentHeight,
          viewportHeight: result.viewportHeight,
          atBottom: result.atBottom,
        });
      }),
  );

  /* -------------------------------------------------------------- browser_wait */

  mcp.registerTool(
    "browser_wait",
    {
      title: "Browser Wait",
      description: "Wait for a selector, text, URL change, network idle, or a fixed delay.",
      inputSchema: {
        ...sessionFields,
        url: urlField.describe("Optional URL for one-shot use. With wait_url, DEMO opens the URL and waits for the URL to change."),
        selector: z.string().optional().describe("Wait until this CSS selector is visible."),
        text: z.string().optional().describe("Wait until this text appears."),
        wait_url: z.string().optional().describe("Wait until the page URL contains this string (or omit for any URL change)."),
        network_idle: z.boolean().default(false).describe("Wait until the network has been idle."),
        milliseconds: z.number().int().min(0).max(LIMITS.waitMaxMs).default(0).describe("Fixed delay in ms."),
        timeout: z.number().int().min(1_000).max(LIMITS.waitMaxMs).default(15_000),
        idle_ms: z.number().int().min(100).max(10_000).default(500),
      },
    },
    (args) =>
      runTool(async () => {
        const spec = (() => {
          if (args.selector) return { kind: "selector" as const, selector: args.selector, timeoutMs: args.timeout };
          if (args.text) return { kind: "text" as const, text: args.text, timeoutMs: args.timeout };
          if (args.network_idle) return { kind: "networkidle" as const, timeoutMs: args.timeout, idleMs: args.idle_ms };
          if (args.wait_url) return { kind: "url" as const, url: args.wait_url, timeoutMs: args.timeout };
          return { kind: "delay" as const, ms: args.milliseconds };
        })();
        const result = await withSession(ctx, args, (client, pageId) => client.wait(pageId, spec));
        return textResult({
          success: true,
          sessionId: result.sessionId,
          pageId: result.tab.id,
          waited: result.kind,
          elapsedMs: result.elapsedMs,
          url: result.url,
          title: result.title,
          challenge: challengeBlock(result.challenge),
        });
      }),
  );

  /* -------------------------------------------------------------- browser_tabs */

  mcp.registerTool(
    "browser_tabs",
    {
      title: "Browser Tabs",
      description: "List, open, close or switch between tabs in a browser session.",
      inputSchema: {
        session_id: sessionFields.session_id,
        action: z.enum(["list", "new", "close", "select"]).default("list"),
        page_id: z.string().optional().describe("Tab id for close/select."),
        url: z.string().optional().describe("URL to open for action=new."),
      },
    },
    (args) =>
      runTool(async () => {
        const sessionId = ctx.sessions.sessionId(args.session_id ?? null);
        const client = await ctx.sessions.client(sessionId);
        switch (args.action) {
          case "new": {
            const created = await client.newTab(args.url ?? null, {});
            return textResult({
              success: true,
              action: "new",
              sessionId,
              tab: { id: created.tab.id, url: created.tab.url, title: created.tab.title },
              ...(created.navigation ? { navigation: { finalUrl: created.navigation.finalUrl, title: created.navigation.title, status: created.navigation.status, challenge: challengeBlock(created.navigation.challenge) } } : {}),
            });
          }
          case "close": {
            if (!args.page_id) throw new BrowserError("invalid_input", "page_id is required to close a tab.");
            const closed = await client.closeTab(ctx.sessions.pageId(args.page_id) as string);
            return textResult({ success: true, action: "close", sessionId, closed: closed.closed, activeTabId: closed.activeTabId, tabs: closed.tabs });
          }
          case "select": {
            if (!args.page_id) throw new BrowserError("invalid_input", "page_id is required to select a tab.");
            const selected = await client.selectTab(ctx.sessions.pageId(args.page_id) as string);
            return textResult({ success: true, action: "select", sessionId, activeTabId: selected.activeTabId, tabs: selected.tabs });
          }
          default: {
            const listed = await client.listTabs();
            return textResult({
              success: true,
              action: "list",
              sessionId,
              activeTabId: listed.activeTabId,
              tabs: listed.tabs.map((tab) => ({ id: tab.id, url: tab.url, title: tab.title, active: tab.active, updatedAt: tab.updatedAt })),
            });
          }
        }
      }),
  );

  /* --------------------------------------------------- browser_challenge_status */

  mcp.registerTool(
    "browser_challenge_status",
    {
      title: "Browser Challenge Status",
      description:
        "Classify the current page as normal, loading, login required, consent required, CAPTCHA, bot check, access denied or unavailable. DEMO never solves or bypasses challenges.",
      inputSchema: {
        ...sessionFields,
        url: urlField,
        screenshot: z.boolean().default(true).describe("Capture a screenshot of the current state."),
      },
    },
    (args) =>
      runTool(async () => {
        const result = await withSession(ctx, args, (client, pageId) => client.challengeStatus(pageId, { screenshot: args.screenshot }));
        return textResult({
          success: true,
          sessionId: result.sessionId,
          pageId: result.tab.id,
          url: result.url,
          title: result.title,
          challenge: challengeBlock(result.challenge),
          handoff: result.handoff,
          paused: result.paused,
          screenshot: result.screenshot,
          liveViewUrl: result.liveViewUrl,
          requiresHuman: result.challenge.requiresHuman,
          next: result.challenge.requiresHuman
            ? "Call browser_pause_for_human to keep the session alive and get a Live View URL, then browser_resume when done."
            : "No human intervention is required.",
        });
      }),
  );

  /* ----------------------------------------------------- browser_pause_for_human */

  mcp.registerTool(
    "browser_pause_for_human",
    {
      title: "Browser Pause For Human",
      description:
        "Pause automation and hand the live page to a human (CAPTCHA, login, consent, bot check). Returns a Live View URL; the browser session is kept alive while the human works. DEMO does not solve, bypass or pre-empt any challenge.",
      inputSchema: {
        ...sessionFields,
        instructions: z.string().max(4_000).optional().describe("Instructions shown to the human operator."),
        timeout_ms: z.number().int().min(30_000).max(LIMITS.pauseMaxMs).default(LIMITS.pauseDefaultMs),
        mode: z.enum(["tab", "devtools", "full"]).default("tab"),
      },
    },
    (args) =>
      runTool(async () => {
        const sessionId = ctx.sessions.sessionId(args.session_id ?? null);
        const client = await ctx.sessions.client(sessionId);
        const result = await client.pauseForHuman(ctx.sessions.pageId(args.page_id ?? null), {
          ...(args.instructions ? { instructions: args.instructions } : {}),
          timeoutMs: args.timeout_ms,
          mode: args.mode,
        });
        return textResult({
          success: true,
          status: result.status,
          sessionId,
          pageId: result.tab.id,
          url: result.url,
          title: result.title,
          challenge: challengeBlock(result.challenge),
          liveViewUrl: result.liveViewUrl,
          liveViewExpiresAtMs: result.liveViewExpiresAtMs,
          handoffId: result.handoffId,
          instructions: result.instructions,
          screenshot: result.screenshotUrl,
          waitingForHuman: result.waitingForHuman,
          pauseUntil: result.pauseUntil,
          note: result.note,
          next: "Have a human open liveViewUrl and complete the step, then call browser_resume with this session_id.",
        });
      }),
  );

  /* ------------------------------------------------------------- browser_resume */

  mcp.registerTool(
    "browser_resume",
    {
      title: "Browser Resume",
      description:
        "Re-check the page after a human completed (or abandoned) a challenge and continue automation. Reports whether the blocking state is gone; it never claims to have bypassed anything.",
      inputSchema: {
        ...sessionFields,
        reload: z.boolean().default(false).describe("Reload the current URL before re-checking."),
        wait_ms: z.number().int().min(0).max(10_000).default(0),
        screenshot: z.boolean().default(true),
      },
    },
    (args) =>
      runTool(async () => {
        const sessionId = ctx.sessions.sessionId(args.session_id ?? null);
        const client = await ctx.sessions.client(sessionId);
        const result = await client.resume(ctx.sessions.pageId(args.page_id ?? null), {
          reload: args.reload,
          waitMs: args.wait_ms,
          screenshot: args.screenshot,
        });
        return textResult({
          success: result.status !== "session_expired",
          status: result.status,
          sessionId,
          pageId: result.tab?.id ?? null,
          url: result.url,
          title: result.title,
          challenge: challengeBlock(result.challenge),
          handoff: result.handoff,
          screenshot: result.screenshotUrl,
          textPreview: result.textPreview,
          note: result.note,
        });
      }),
  );

  /* ----------------------------------------------------- browser_captcha_handoff */

  mcp.registerTool(
    "browser_captcha_handoff",
    {
      title: "Browser CAPTCHA Handoff",
      description:
        "CAPTCHA/bot-verification workflow: detect the challenge, immediately pause automation, keep the SAME browser session alive, open a Live View for the user and store a resumable task snapshot. Demo never solves or bypasses the challenge — the human completes it in the live browser and Demo resumes the task automatically.",
      inputSchema: {
        ...sessionFields,
        timeout_ms: z.number().int().min(5_000).max(LIMITS.pauseMaxMs).default(LIMITS.pauseDefaultMs).describe("How long to keep the handoff open before reporting a timeout."),
        instructions: z.string().max(4_000).optional().describe("Optional extra instructions shown to the human operator."),
        mode: z.enum(["tab", "devtools", "full"]).default("tab"),
        task_workflow: z.string().max(64).optional().describe("Name of the suspended workflow (stored in the resumable task snapshot)."),
        task_step: z.string().max(500).optional().describe("Exact step automation stopped on, so the task can resume there after the handoff."),
        task_context: z.record(z.string(), z.string().max(200)).optional().describe("Small key/value task context preserved across the handoff."),
      },
    },
    (args) =>
      runTool(async () => {
        const sessionId = ctx.sessions.sessionId(args.session_id ?? null);
        const client = await ctx.sessions.client(sessionId);
        const result = await client.captchaHandoffStart(ctx.sessions.pageId(args.page_id ?? null), {
          timeoutMs: args.timeout_ms,
          ...(args.instructions ? { instructions: args.instructions } : {}),
          mode: args.mode,
          task: {
            ...(args.task_workflow ? { workflow: args.task_workflow } : {}),
            ...(args.task_step ? { step: args.task_step } : {}),
            ...(args.task_context ? { context: args.task_context } : {}),
          },
        });
        return textResult({
          success: result.action === "handoff_started" || result.action === "already_active",
          action: result.action,
          sessionId,
          pageId: result.pageId,
          phase: result.phase,
          outcome: result.outcome,
          url: result.url,
          challengeStatus: result.challengeStatus,
          vendor: result.vendor,
          signals: result.signals,
          liveViewUrl: result.liveViewUrl,
          handoffId: result.handoffId,
          userNotice: result.userNotice,
          task: result.task,
          deadline: result.deadline,
          safetyNote: result.safetyNote,
          next: result.next,
        });
      }),
  );

  /* ------------------------------------------------------- browser_captcha_wait */

  mcp.registerTool(
    "browser_captcha_wait",
    {
      title: "Browser CAPTCHA Wait",
      description:
        "Monitor an open CAPTCHA handoff for up to 30s: polls the live page (no reloads, no session rotation) and returns as soon as the challenge is completed (automatic resume), failed, timed out, cancelled or the session died. Repeat calls to keep monitoring until a terminal outcome.",
      inputSchema: {
        ...sessionFields,
        wait_ms: z.number().int().min(0).max(30_000).default(10_000).describe("How long this call should watch the page before returning (0 = single check)."),
        interval_ms: z.number().int().min(250).max(5_000).default(1_000).describe("Polling interval inside the watch window."),
      },
    },
    (args) =>
      runTool(async () => {
        const sessionId = ctx.sessions.sessionId(args.session_id ?? null);
        const client = await ctx.sessions.client(sessionId);
        const result = await client.captchaHandoffPoll(ctx.sessions.pageId(args.page_id ?? null), {
          waitMs: args.wait_ms,
          intervalMs: args.interval_ms,
        });
        return textResult({
          success: result.outcome === "completed_and_resumed" || result.outcome === "waiting_for_human" || result.outcome === "no_handoff",
          outcome: result.outcome,
          sessionId,
          pageId: result.pageId,
          phase: result.phase,
          url: result.url,
          currentUrl: result.currentUrl,
          challengeStatus: result.challengeStatus,
          vendor: result.vendor,
          userNotice: result.userNotice,
          task: result.task,
          interaction: result.interaction,
          failure: result.failure,
          completedAt: result.completedAt,
          resumedAt: result.resumedAt,
          deadline: result.deadline,
          waitedMs: result.waitedMs,
          liveViewUrl: result.liveViewUrl,
          events: result.events.map((event) => ({ event: event.event, phase: event.phase, at: event.at, ...(event.detail ? { detail: event.detail } : {}) })),
          safetyNote: result.safetyNote,
          next: result.next,
        });
      }),
  );

  /* ----------------------------------------------------- browser_captcha_cancel */

  mcp.registerTool(
    "browser_captcha_cancel",
    {
      title: "Browser CAPTCHA Cancel",
      description:
        "Explicitly abandon an open CAPTCHA handoff (user fallback). Keeps the browser session, tab and page state; marks the handoff CANCELLED and returns automation control without touching the challenge.",
      inputSchema: {
        ...sessionFields,
        reason: z.string().max(300).optional().describe("Why the handoff is being abandoned (recorded in the event log)."),
      },
    },
    (args) =>
      runTool(async () => {
        const sessionId = ctx.sessions.sessionId(args.session_id ?? null);
        const client = await ctx.sessions.client(sessionId);
        const result = await client.captchaHandoffCancel({ ...(args.reason ? { reason: args.reason } : {}) });
        return textResult({
          success: true,
          action: result.action,
          sessionId,
          pageId: result.pageId,
          phase: result.phase,
          outcome: result.outcome,
          task: result.task,
          failure: result.failure,
          events: result.events.map((event) => ({ event: event.event, phase: event.phase, at: event.at })),
          next: result.next,
        });
      }),
  );

  /* --------------------------------------------------------- browser_media_info */

  mcp.registerTool(
    "browser_media_info",
    {
      title: "Browser Media Info",
      description:
        "Inspect publicly exposed media on the page: video/audio elements, poster, duration, dimensions, source URLs, OpenGraph/Twitter metadata, JSON-LD and (for public TikTok pages) the video's author, caption, id, thumbnail, duration and exposed media URLs. Reports honestly when media is hidden, protected or behind a challenge.",
      inputSchema: {
        ...sessionFields,
        url: urlField,
        selector: z.string().optional().describe("Restrict media inspection to a CSS selector."),
      },
    },
    (args) =>
      runTool(async () => {
        const result = await withSession(ctx, args, (client, pageId) => client.mediaInfo(pageId, { selector: args.selector ?? null }));
        return textResult({
          success: true,
          sessionId: result.sessionId,
          pageId: result.tab.id,
          url: result.url,
          title: result.title,
          platform: result.platform,
          hasVideoElement: result.hasVideoElement,
          meta: result.meta,
          jsonLd: result.jsonLd,
          media: result.media,
          tiktok: result.tiktok,
          limitations: result.limitations,
          inspectedAt: result.inspectedAt,
        });
      }),
  );

  /* -------------------------------------------------------- browser_video_frames */

  mcp.registerTool(
    "browser_video_frames",
    {
      title: "Browser Video Frames",
      description:
        "Sample a bounded number of rendered frames from a publicly playable <video> element by seeking and screenshotting the pixels on screen. Nothing is downloaded and DRM-protected media is never touched.",
      inputSchema: {
        ...sessionFields,
        url: urlField,
        count: z.number().int().min(1).max(LIMITS.framesMaxCount).default(LIMITS.framesDefaultCount),
        index: z.number().int().min(0).max(9).default(0).describe("Which <video> element to sample (0 = first)."),
        selector: z.string().optional().describe("CSS selector scoping the video element."),
        timestamps: z.array(z.number().min(0)).max(LIMITS.framesMaxCount).optional().describe("Explicit timestamps in seconds."),
        type: z.enum(["png", "jpeg", "webp"]).default("png"),
      },
    },
    (args) =>
      runTool(async () => {
        const result = await withSession(ctx, args, (client, pageId) =>
          client.videoFrames(pageId, {
            count: args.count,
            index: args.index,
            selector: args.selector ?? null,
            ...(args.timestamps ? { timestamps: args.timestamps } : {}),
            type: args.type as ScreenshotType,
          }),
        );
        return textResult({
          success: result.available,
          sessionId: result.sessionId,
          pageId: result.tab.id,
          url: result.url,
          title: result.title,
          available: result.available,
          reason: result.reason,
          videoIndex: result.videoIndex,
          durationSeconds: result.durationSeconds,
          intrinsicSize: result.intrinsicSize,
          frames: result.frames,
          limitations: result.limitations,
          capturedAt: result.capturedAt,
        });
      }),
  );

  /* ------------------------------------------------------------ browser_session */

  mcp.registerTool(
    "browser_session",
    {
      title: "Browser Session",
      description: "Inspect, create or close a persistent browser session (tabs, keep-alive, provider state).",
      inputSchema: {
        action: z.enum(["info", "create", "close"]).default("info"),
        session_id: sessionFields.session_id,
      },
    },
    (args) =>
      runTool(async () => {
        const sessionId = ctx.sessions.sessionId(args.session_id ?? null);
        if (args.action === "close") {
          const closed = await ctx.sessions.closeSession(sessionId);
          return textResult({ success: true, action: "close", ...closed });
        }
        const client = await ctx.sessions.client(sessionId);
        const summary = await client.summary();
        return textResult({
          success: true,
          action: args.action,
          sessionStorage: capabilities().sessionStorage,
          session: {
            sessionId: summary.sessionId,
            provider: summary.provider,
            providerSessionId: summary.providerSessionId,
            createdAt: new Date(summary.createdAt).toISOString(),
            lastUsedAt: new Date(summary.lastUsedAt).toISOString(),
            keepAliveMs: summary.keepAliveMs,
            activeTabId: summary.activeTabId,
            lastError: summary.lastError,
          },
          tabs: summary.tabs.map((tab) => ({ id: tab.id, url: tab.url, title: tab.title, active: tab.active })),
          paused: summary.paused,
          capabilities: summary.capabilities,
          limits: summary.limits,
          note:
            capabilities().sessionStorage === "durable-object"
              ? "Sessions are stored in a Durable Object and survive across MCP calls until the keep-alive window expires."
              : "The BROWSER_SESSIONS Durable Object binding is not configured; sessions live only in this Worker isolate and may be lost between calls.",
        });
      }),
  );

  /* --------------------------------------------------------------- browser_close */

  mcp.registerTool(
    "browser_close",
    {
      title: "Browser Close",
      description: "Close a browser session and release the Cloudflare Browser Run instance immediately.",
      inputSchema: { session_id: sessionFields.session_id },
    },
    (args) =>
      runTool(async () => {
        const sessionId = ctx.sessions.sessionId(args.session_id ?? null);
        const closed = await ctx.sessions.closeSession(sessionId);
        return textResult({ success: true, ...closed });
      }),
  );

  /* -------------------------------------------------------- browser_capabilities */

  mcp.registerTool(
    "browser_capabilities",
    {
      title: "Browser Capabilities",
      description: "Report which browser capabilities are available in this deployment and which Cloudflare binding or plan they need.",
      inputSchema: z.object({}),
    },
    () =>
      runTool(async () => {
        const caps = capabilities();
        const limits = await ctx.sessions.provider().provider.limits().catch(() => null);
        return textResult({
          ...caps,
          limits,
          notes: [
            caps.browserAvailable
              ? "Cloudflare Browser Run is bound and usable."
              : "Cloudflare Browser Run is not available: bind `browser` as BROWSER in wrangler.jsonc on a plan that includes Browser Run.",
            caps.screenshots ? "Screenshots are stored in R2 and returned as links." : "Screenshots need the SCREENSHOTS R2 binding.",
            caps.liveView ? "Live View URLs are available for human-in-the-loop steps." : "Live View requires Cloudflare Browser Run (not available with the local Node provider).",
            caps.sessionStorage === "durable-object"
              ? "Sessions persist across MCP calls through the BROWSER_SESSIONS Durable Object."
              : "Without the BROWSER_SESSIONS Durable Object binding, sessions do not survive isolate eviction.",
          ],
        });
      }),
  );
}

export const BROWSER_TOOL_NAMES = [
  "browser_open",
  "browser_screenshot",
  "browser_read",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_scroll",
  "browser_wait",
  "browser_tabs",
  "browser_challenge_status",
  "browser_pause_for_human",
  "browser_resume",
  "browser_captcha_handoff",
  "browser_captcha_wait",
  "browser_captcha_cancel",
  "browser_media_info",
  "browser_video_frames",
  "browser_session",
  "browser_close",
  "browser_capabilities",
] as const;
