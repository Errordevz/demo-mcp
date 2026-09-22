import { afterEach, describe, expect, it, vi } from "vitest";
import { assertNavigableUrl } from "../src/core/url-guard.js";
import { ChallengeManager } from "../src/browser/challenge.js";
import {
  HANDOFF_LIMITS,
  HANDOFF_USER_NOTICE,
  SAFETY_NOTE,
  canTransition,
  createHandoffRecord,
  normaliseTask,
  outcomeFor,
  pushEvent,
  transition,
  HandoffTransitionError,
} from "../src/browser/handoff.js";
import { MediaInspector } from "../src/browser/media.js";
import { BrowserRuntime, createSessionState, normaliseSessionState } from "../src/browser/runtime.js";
import { ScreenshotManager } from "../src/browser/screenshot.js";
import { BrowserSession } from "../src/session/durable-object.js";
import { AFTER_CHALLENGE_PAGE, CAPTCHA_SIMULATION_PAGE, SOLVE_CAPTCHA_SIMULATION, SIMPLE_PAGE } from "./fixtures/pages.js";
import { FakeBrowser, FakeObjectStore, FakePage, FakeProvider, type FakeRoute } from "./helpers/fake-provider.js";

const BASE = "https://demo.test/screenshots";
const CHALLENGE_URL = "https://app.example.com/protected";
const WELCOME_URL = "https://app.example.com/welcome";

function build(routes: Record<string, FakeRoute>, options: { liveView?: boolean; handoff?: boolean } = {}) {
  const provider = new FakeProvider({ routes, liveView: options.liveView ?? true, handoff: options.handoff ?? true });
  const store = new FakeObjectStore();
  const screenshots = new ScreenshotManager(store as never, BASE);
  const challenge = new ChallengeManager(provider);
  const media = new MediaInspector(screenshots);
  const state = createSessionState("s-handoff", "cloudflare", 300_000);
  const runtime = new BrowserRuntime(provider, state, { screenshots, challenge, media }, {
    persist: async () => undefined,
    validateUrl: async (url: string) => (await assertNavigableUrl(url, { dns: null, allowInsecureHttp: true })).url,
    scheduleHeartbeat: async () => undefined,
  });
  return { provider, store, runtime, state, screenshots };
}

function challengeRoutes(): Record<string, FakeRoute> {
  return {
    [CHALLENGE_URL]: { html: CAPTCHA_SIMULATION_PAGE, status: 200, scripts: [SOLVE_CAPTCHA_SIMULATION] },
    [WELCOME_URL]: { html: AFTER_CHALLENGE_PAGE, status: 200 },
  };
}

/** The test harness plays the human: press the simulated challenge control. */
function humanCompletesChallenge(provider: FakeProvider): void {
  const page = provider.browsers[0].pages$[0] as FakePage;
  const button = page.dom.window.document.getElementById("human-verify");
  expect(button, "simulated challenge control missing").toBeTruthy();
  (button as unknown as HTMLButtonElement).click();
}

async function startedHandoff(runtime: BrowserRuntime) {
  await runtime.open(null, CHALLENGE_URL, {});
  return await runtime.captchaHandoffStart(null, {
    timeoutMs: HANDOFF_LIMITS.handoffMinMs,
    task: { workflow: "download-report", step: "step 3: click download on the report page", context: { target: "q3-report.pdf", attempt: "1" } },
  });
}

afterEach(() => {
  FakeBrowser.handoffActive = true;
});

describe("captcha handoff state machine", () => {
  it("walks the documented happy path: RUNNING → … → RUNNING with the named events", () => {
    const record = createHandoffRecord(
      {
        pageId: "p1",
        url: CHALLENGE_URL,
        vendor: "google-recaptcha",
        signals: ["google-recaptcha"],
        challengeStatus: "captcha",
        confidence: 0.9,
        timeoutMs: 60_000,
        liveViewUrl: "https://live.browser.run/x",
        liveViewExpiresAtMs: null,
        handoffId: "h1",
        instructions: "Solve it",
        screenshotUrl: null,
        task: null,
      },
      "s1",
    );
    expect(record.phase).toBe("HUMAN_HANDOFF");
    expect(record.events.map((event) => event.event)).toEqual(["captcha_detected", "human_handoff_started"]);

    transition(record, "USER_INTERACTING", "human_handoff_active");
    transition(record, "CAPTCHA_COMPLETED", "captcha_completed");
    transition(record, "RESUMING", "automation_resumed");
    transition(record, "RUNNING");
    expect(record.events.map((event) => event.event)).toEqual([
      "captcha_detected",
      "human_handoff_started",
      "human_handoff_active",
      "captcha_completed",
      "automation_resumed",
    ]);
    // The runtime stamps resumedAt when it actually hands back control.
    record.resumedAt = Date.now();
    expect(outcomeFor(record)).toBe("completed_and_resumed");
  });

  it("rejects illegal transitions and treats terminal states as final", () => {
    expect(canTransition("HUMAN_HANDOFF", "CAPTCHA_COMPLETED")).toBe(true);
    expect(canTransition("CAPTCHA_DETECTED", "RUNNING")).toBe(false);
    expect(canTransition("FAILED", "HUMAN_HANDOFF")).toBe(false);
    const record = createHandoffRecord(
      {
        pageId: "p1", url: CHALLENGE_URL, vendor: null, signals: [], challengeStatus: "captcha",
        confidence: 0.9, timeoutMs: 60_000, liveViewUrl: null, liveViewExpiresAtMs: null,
        handoffId: null, instructions: "", screenshotUrl: null, task: null,
      },
      "s1",
    );
    expect(() => transition(record, "RESUMING", "automation_resumed")).toThrow(HandoffTransitionError);
  });

  it("bounds the event log and the task context", () => {
    const record = createHandoffRecord(
      {
        pageId: "p1", url: CHALLENGE_URL, vendor: null, signals: [], challengeStatus: "captcha",
        confidence: 0.9, timeoutMs: 60_000, liveViewUrl: null, liveViewExpiresAtMs: null,
        handoffId: null, instructions: "", screenshotUrl: null, task: null,
      },
      "s1",
    );
    for (let i = 0; i < HANDOFF_LIMITS.maxEvents + 20; i++) pushEvent(record, "human_handoff_active");
    expect(record.events.length).toBe(HANDOFF_LIMITS.maxEvents);

    const context: Record<string, string> = {};
    for (let i = 0; i < 30; i++) context[`key-${i}`] = `value-${i}`;
    context["bad key!"] = "dropped";
    const task = normaliseTask({ workflow: "w", step: "s", context }, "s1", "p1", CHALLENGE_URL);
    expect(Object.keys(task.context).length).toBe(HANDOFF_LIMITS.maxTaskContextEntries);
    expect(task.context["bad key!"]).toBeUndefined();
    expect(task.context["key-0"]).toBe("value-0");
    const long = normaliseTask({ context: { big: "x".repeat(1_000) } }, "s1", "p1", CHALLENGE_URL);
    expect(long.context.big.length).toBe(HANDOFF_LIMITS.maxTaskContextValueChars);
  });

  it("never persists challenge contents in the record or its projection", () => {
    const record = createHandoffRecord(
      {
        pageId: "p1",
        url: CHALLENGE_URL,
        vendor: "google-recaptcha",
        signals: ["google-recaptcha", "captcha-widget"],
        challengeStatus: "captcha",
        confidence: 0.9,
        timeoutMs: 60_000,
        liveViewUrl: null,
        liveViewExpiresAtMs: null,
        handoffId: "h1",
        instructions: "Complete the CAPTCHA",
        screenshotUrl: null,
        task: { step: "download", context: {} },
      },
      "s1",
    );
    // The simulated sitekey and the on-page copy must not appear anywhere.
    const dumped = JSON.stringify(record) + JSON.stringify(outcomeFor(record));
    expect(dumped).not.toContain("6LeSIMULATION");
    expect(dumped).not.toContain("Press the button");
    expect(dumped).not.toContain("human-verify");
    expect(record.signals).toEqual(["google-recaptcha", "captcha-widget"]);
  });

  it("normalises states persisted by older versions", () => {
    const legacy = createSessionState("s-old", "cloudflare", 300_000);
    delete (legacy as { captchaHandoff?: unknown }).captchaHandoff;
    expect(normaliseSessionState(legacy as typeof legacy).captchaHandoff).toBeNull();
  });
});

describe("captcha human handoff workflow", () => {
  it("detects the challenge, suspends the task and keeps the same browser session alive", async () => {
    const { runtime, provider, state } = build(challengeRoutes());
    const started = await startedHandoff(runtime);
    expect(started.challengeStatus).toBe("captcha");
    const sessionIdAtStart = state.providerSessionId;
    const page = provider.browsers[0].pages$[0] as FakePage;
    const domAtStart = page.dom;

    expect(started.action).toBe("handoff_started");
    expect(started.phase).toBe("HUMAN_HANDOFF");
    expect(started.outcome).toBe("waiting_for_human");
    expect(started.userNotice).toBe(HANDOFF_USER_NOTICE);
    expect(started.liveViewUrl).toContain("live.browser.run");
    expect(started.handoffId).toBeTruthy();
    expect(started.screenshotUrl).toMatch(/\/screenshots\//);
    // Resumable task snapshot preserved with the session id and step.
    expect(started.task?.workflow).toBe("download-report");
    expect(started.task?.step).toContain("step 3");
    expect(started.task?.context.target).toBe("q3-report.pdf");
    expect(started.events.map((event) => event.event)).toEqual(["captcha_detected", "human_handoff_started"]);

    // One monitoring tick must not rotate the session, reload the page or
    // re-open anything: same browser, same tab, same live DOM.
    const checked = await runtime.captchaHandoffPoll(null, { waitMs: 0 });
    expect(checked.outcome).toBe("waiting_for_human");
    expect(provider.launches).toBe(1);
    expect(state.providerSessionId).toBe(sessionIdAtStart);
    expect(checked.pageId).toBe(started.pageId);
    expect((provider.browsers[0].pages$[0] as FakePage).dom).toBe(domAtStart);
    expect(state.paused?.pageId).toBe(started.pageId);
    const summary = await runtime.summary();
    expect(summary.captchaHandoff?.phase).toBe("USER_INTERACTING");
  });

  it("sees the human working, then auto-resumes the exact task when the challenge disappears", async () => {
    const { runtime, provider, state } = build(challengeRoutes());
    const started = await startedHandoff(runtime);
    const domBefore = (provider.browsers[0].pages$[0] as FakePage).dom;

    // Human opens the live view: interaction cues flip the machine forward.
    const seeing = await runtime.captchaHandoffPoll(null, { waitMs: 0 });
    expect(seeing.outcome).toBe("waiting_for_human");
    expect(seeing.phase).toBe("USER_INTERACTING");
    expect(seeing.events.some((event) => event.event === "human_handoff_active")).toBe(true);

    // The human completes the challenge inside the live page (no reload).
    humanCompletesChallenge(provider);
    const resumed = await runtime.captchaHandoffPoll(null, { waitMs: 0 });
    expect(resumed.outcome).toBe("completed_and_resumed");
    expect(resumed.phase).toBe("RUNNING");
    expect(resumed.completedAt).toBeTruthy();
    expect(resumed.resumedAt).toBeTruthy();
    expect(resumed.task?.step).toContain("step 3");
    expect(resumed.events.map((event) => event.event)).toEqual(expect.arrayContaining(["captcha_completed", "automation_resumed"]));
    expect(state.paused).toBeNull();
    expect(state.captchaHandoff?.phase).toBe("RUNNING");

    // No new session, no reload of the page — the same DOM gained "solved".
    expect(provider.launches).toBe(1);
    expect((provider.browsers[0].pages$[0] as FakePage).dom).toBe(domBefore);
    // Automation really is back in control on the same tab.
    const read = await runtime.read(started.pageId ?? null, { maxTextChars: 500 });
    expect(read.challenge.status).toBe("normal");
    expect(read.text).toContain("complete");
  });

  it("completes via a page transition during the handoff", async () => {
    const { runtime, provider } = build(challengeRoutes());
    await startedHandoff(runtime);
    // The human solves and the site navigates onward (post-challenge redirect).
    const page = provider.browsers[0].pages$[0] as FakePage;
    await page.goto(WELCOME_URL, {});
    const resumed = await runtime.captchaHandoffPoll(null, { waitMs: 0 });
    expect(resumed.outcome).toBe("completed_and_resumed");
    expect(resumed.currentUrl).toBe(WELCOME_URL);
    expect(resumed.challengeStatus).toBe("normal");
  });

  it("reports captcha_failed when the human attempt ends without clearing the challenge", async () => {
    const { runtime, provider, state } = build(challengeRoutes());
    await startedHandoff(runtime);
    const seen = await runtime.captchaHandoffPoll(null, { waitMs: 0 });
    expect(seen.phase).toBe("USER_INTERACTING");

    FakeBrowser.handoffActive = false; // the human closed Live View; challenge untouched
    const failed = await runtime.captchaHandoffPoll(null, { waitMs: 0 });
    expect(failed.outcome).toBe("failed");
    expect(failed.phase).toBe("FAILED");
    expect(failed.challengeStatus).toBe("captcha");
    expect(failed.failure?.reason).toMatch(/handoff ended|still/i);
    expect(failed.events.some((event) => event.event === "captcha_failed")).toBe(true);
    // No retry loop, no session rotation, no reload: the page is untouched.
    expect(provider.launches).toBe(1);
    expect(state.providerSessionId).toBeTruthy();
    const summary = await runtime.summary();
    expect(summary.captchaHandoff?.outcome).toBe("failed");
  });

  it("times out honestly when nobody completes the challenge", async () => {
    const { runtime, state } = build(challengeRoutes());
    await startedHandoff(runtime);
    const seen = await runtime.captchaHandoffPoll(null, { waitMs: 0 });
    expect(seen.outcome).toBe("waiting_for_human");

    const record = state.captchaHandoff!;
    record.deadline = Date.now() - 1; // pretend the handoff budget elapsed
    const timedOut = await runtime.captchaHandoffPoll(null, { waitMs: 0 });
    expect(timedOut.outcome).toBe("timed_out");
    expect(timedOut.phase).toBe("TIMEOUT");
    expect(timedOut.failure?.reason).toMatch(/timed out/i);
    expect(timedOut.events.some((event) => event.event === "captcha_timeout")).toBe(true);
    expect(state.paused).toBeNull();
  });

  it("marks the session lost when the browser dies mid-handoff, and keeps the task context", async () => {
    const { runtime, provider, state } = build(challengeRoutes());
    const started = await startedHandoff(runtime);
    await provider.closeSession(state.providerSessionId!);

    const lost = await runtime.captchaHandoffPoll(null, { waitMs: 0 });
    expect(lost.outcome).toBe("session_lost");
    expect(lost.phase).toBe("SESSION_LOST");
    expect(lost.events.some((event) => event.event === "browser_session_lost")).toBe(true);
    expect(lost.task?.step).toContain("step 3");
    expect(state.providerSessionId).toBeNull();
    expect(state.paused).toBeNull();
    expect(started.pageId).toBe("p1");
  });

  it("supports an explicit cancel fallback without touching the session", async () => {
    const { runtime, provider, state } = build(challengeRoutes());
    await startedHandoff(runtime);

    const cancelled = await runtime.captchaHandoffCancel({ reason: "user gave up" });
    expect(cancelled.action).toBe("cancelled");
    expect(cancelled.phase).toBe("CANCELLED");
    expect(cancelled.outcome).toBe("cancelled");
    expect(cancelled.failure?.reason).toBe("user gave up");
    expect(cancelled.events.some((event) => event.event === "human_handoff_cancelled")).toBe(true);
    expect(state.paused).toBeNull();

    // Session still alive and usable for other work.
    expect(provider.launches).toBe(1);
    const again = await runtime.captchaHandoffCancel({});
    expect(again.action).toBe("no_active_handoff");
    const opened = await runtime.open(null, "https://app.example.com/other", {}).catch(() => null);
    // The challenge route is gone from the route table → 404, but the session works.
    expect(opened === null || opened.sessionId === "s-handoff").toBe(true);
  });

  it("lets the caller start a new handoff after a terminal outcome (explicit, never automatic)", async () => {
    const { runtime, state } = build(challengeRoutes());
    await startedHandoff(runtime);
    state.captchaHandoff!.deadline = Date.now() - 1;
    await runtime.captchaHandoffPoll(null, { waitMs: 0 });
    expect(state.captchaHandoff?.phase).toBe("TIMEOUT");

    const restarted = await startedHandoff(runtime);
    expect(restarted.action).toBe("handoff_started");
    expect(restarted.phase).toBe("HUMAN_HANDOFF");
    expect(state.captchaHandoff?.events[0].event).toBe("captcha_detected");
  });

  it("refuses to start for pages without a CAPTCHA and points to the right tool", async () => {
    const { runtime } = build({
      "https://example.com/": { html: SIMPLE_PAGE },
      "https://app.example.com/login": {
        html: `<html><head><title>Sign in to continue</title></head><body><form><input type="password" name="password"></form><p>You must be logged in to view this page.</p></body></html>`,
      },
    });
    await runtime.open(null, "https://example.com/", {});
    const none = await runtime.captchaHandoffStart(null, {});
    expect(none.action).toBe("no_challenge_detected");

    await runtime.open(null, "https://app.example.com/login", {});
    const login = await runtime.captchaHandoffStart(null, {});
    expect(login.action).toBe("not_handoff_eligible");
    expect(login.next).toMatch(/pause_for_human/);
    expect(runtime.sessionState.captchaHandoff).toBeNull();
  });

  it("returns already_active instead of resetting a running handoff", async () => {
    const { runtime } = build(challengeRoutes());
    const first = await startedHandoff(runtime);
    const second = await runtime.captchaHandoffStart(null, {});
    expect(second.action).toBe("already_active");
    expect(second.handoffId).toBe(first.handoffId);
  });

  it("keeps watching across a bounded window while the challenge persists", async () => {
    const { runtime } = build(challengeRoutes());
    await startedHandoff(runtime);
    const watched = await runtime.captchaHandoffPoll(null, { waitMs: 700, intervalMs: 250 });
    expect(watched.outcome).toBe("waiting_for_human");
    expect(watched.waitedMs).toBeGreaterThanOrEqual(500);
  });

  it("works without Live View or platform handoff (detection + completion still run)", async () => {
    const { runtime, provider } = build(challengeRoutes(), { liveView: false, handoff: false });
    const started = await startedHandoff(runtime);
    expect(started.liveViewUrl).toBeNull();
    expect(started.handoffId).toBeNull();
    expect(started.outcome).toBe("waiting_for_human");

    humanCompletesChallenge(provider);
    const resumed = await runtime.captchaHandoffPoll(null, { waitMs: 0 });
    expect(resumed.outcome).toBe("completed_and_resumed");
    expect(resumed.events.some((event) => event.event === "captcha_completed")).toBe(true);
  });

  it("does not log challenge contents during the handoff lifecycle", async () => {
    const logs: string[] = [];
    for (const method of ["log", "warn", "error", "info"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
    }
    try {
      const { runtime, provider } = build(challengeRoutes());
      await startedHandoff(runtime);
      humanCompletesChallenge(provider);
      await runtime.captchaHandoffPoll(null, { waitMs: 0 });
      const everything = logs.join("\n");
      expect(everything).not.toContain("6LeSIMULATION");
      expect(everything).not.toContain("Press the button");
      expect(everything).not.toContain("I am human");
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("captcha handoff durable-object surface", () => {
  it("exposes the RPC methods and the alarm terminates a handoff when the session died", async () => {
    for (const method of ["captchaHandoffStart", "captchaHandoffWait", "captchaHandoffTick", "captchaHandoffStatus", "captchaHandoffCancel"]) {
      expect(typeof (BrowserSession.prototype as unknown as Record<string, unknown>)[method]).toBe("function");
    }

    const storage = new Map<string, unknown>();
    let alarm: number | null = null;
    const ctx = {
      storage: {
        get: async <T>(key: string) => (storage.get(key) as T) ?? null,
        put: async (key: string, value: unknown) => void storage.set(key, value),
        setAlarm: async (at: number) => void (alarm = at),
        deleteAll: async () => storage.clear(),
      },
      blockConcurrencyWhile: (work: () => Promise<void>) => work(),
      id: { toString: () => "s-do" },
      waitUntil: () => undefined,
    };
    const session = new BrowserSession(ctx as never, {} as never);

    // Seed an active handoff directly, as an older isolate would have persisted it.
    const state = await (session as unknown as { load: () => Promise<ReturnType<typeof createSessionState>> }).load();
    normaliseSessionState(state);
    state.sessionId = "s-do";
    state.providerSessionId = "session-9";
    state.captchaHandoff = createHandoffRecord(
      {
        pageId: "p1", url: CHALLENGE_URL, vendor: "google-recaptcha", signals: ["google-recaptcha"],
        challengeStatus: "captcha", confidence: 0.9, timeoutMs: 60_000, liveViewUrl: null,
        liveViewExpiresAtMs: null, handoffId: "h9", instructions: "solve", screenshotUrl: null, task: null,
      },
      "s-do",
    );
    await (session as unknown as { save: () => Promise<void> }).save();

    // No browser binding in this environment → the ping fails → the alarm must
    // terminate the handoff as SESSION_LOST instead of waking forever.
    await session.alarm();
    const after = await (session as unknown as { load: () => Promise<ReturnType<typeof createSessionState>> }).load();
    expect(after.captchaHandoff?.phase).toBe("SESSION_LOST");
    expect(after.captchaHandoff?.events.some((event) => event.event === "browser_session_lost")).toBe(true);
    expect(alarm).toBeNull();
  });
});
