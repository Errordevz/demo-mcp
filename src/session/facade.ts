/**
 * Facade over `BrowserRuntime` exposing the session surface consumed by the MCP
 * tools. Implemented once, used twice: directly by the in-process fallback and
 * through RPC by the `BrowserSession` Durable Object.
 */

import type { ElementTarget, ScreenshotType, WaitUntil } from "../browser/types.js";
import type { FrameSamplingOptions, MediaReport } from "../browser/media.js";
import type { CaptureOptions, CaptureResult, OpenOptions, OpenResult, ReadOptions, ReadResult, ScrollDirection, SnapshotOptions, SnapshotResultPayload, WaitSpec } from "../browser/ops.js";
import type { BrowserRuntime, SessionSummary, TabRecord, TabSummary } from "../browser/runtime.js";

export class SessionFacade {
  constructor(protected readonly runtime: BrowserRuntime) {}

  summary(): Promise<SessionSummary> {
    return this.runtime.summary();
  }

  open(pageId: string | null | undefined, url: string, options?: OpenOptions) {
    return this.runtime.open(pageId, url, options ?? {});
  }

  screenshot(pageId: string | null | undefined, options?: CaptureOptions) {
    return this.runtime.screenshot(pageId, options ?? {});
  }

  read(pageId: string | null | undefined, options?: ReadOptions) {
    return this.runtime.read(pageId, options ?? {});
  }

  snapshot(pageId: string | null | undefined, options?: SnapshotOptions) {
    return this.runtime.snapshot(pageId, options ?? {});
  }

  click(pageId: string | null | undefined, target: ElementTarget, options?: { timeoutMs?: number; screenshotAfter?: boolean }) {
    return this.runtime.click(pageId, target, options ?? {});
  }

  type(pageId: string | null | undefined, target: ElementTarget, text: string, options?: { secret?: boolean; clear?: boolean; submit?: boolean }) {
    return this.runtime.type(pageId, target, text, options ?? {});
  }

  scroll(pageId: string | null | undefined, direction: ScrollDirection, amount: number) {
    return this.runtime.scroll(pageId, direction, amount);
  }

  wait(pageId: string | null | undefined, spec: WaitSpec) {
    return this.runtime.wait(pageId, spec);
  }

  mediaInfo(pageId: string | null | undefined, options?: { selector?: string | null }): Promise<MediaReport & { sessionId: string; tab: TabRecord }> {
    return this.runtime.mediaInfo(pageId, options ?? {});
  }

  videoFrames(pageId: string | null | undefined, options?: FrameSamplingOptions) {
    return this.runtime.videoFrames(pageId, options ?? {});
  }

  challengeStatus(pageId: string | null | undefined, options?: { screenshot?: boolean; type?: ScreenshotType }) {
    return this.runtime.challengeStatus(pageId, options ?? {});
  }

  pauseForHuman(
    pageId: string | null | undefined,
    options?: { instructions?: string; timeoutMs?: number; screenshot?: boolean; mode?: "tab" | "devtools" | "full" },
  ) {
    return this.runtime.pauseForHuman(pageId, options ?? {});
  }

  resume(pageId: string | null | undefined, options?: { screenshot?: boolean; reload?: boolean; waitMs?: number }) {
    return this.runtime.resume(pageId, options ?? {});
  }

  listTabs(): Promise<{ tabs: TabSummary[]; activeTabId: string | null; sessionId: string }> {
    return this.runtime.listTabs();
  }

  newTab(url: string | null, options?: { waitUntil?: WaitUntil; timeoutMs?: number }) {
    return this.runtime.newTab(url, options ?? {});
  }

  closeTab(pageId: string): Promise<{ closed: string; tabs: TabSummary[]; activeTabId: string | null }> {
    return this.runtime.closeTab(pageId);
  }

  selectTab(pageId: string): Promise<{ activeTabId: string | null; tabs: TabSummary[] }> {
    return this.runtime.selectTab(pageId);
  }

  setViewport(width: number, height: number): Promise<void> {
    return this.runtime.setViewport(width, height);
  }

  close(): Promise<{ sessionId: string; closed: boolean; reason?: string }> {
    return this.runtime.close();
  }

  heartbeat(): Promise<{ alive: boolean; sessionId: string | null }> {
    return this.runtime.heartbeat();
  }
}

export type SessionClient = SessionFacade;
export type { CaptureResult, OpenResult, ReadResult, SnapshotResultPayload };
