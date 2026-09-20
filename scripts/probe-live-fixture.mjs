#!/usr/bin/env node
/**
 * Preflight for the live video suite: can the public MP4 fixture be reached
 *   (a) from this runner, and
 *   (b) from the deployed Worker's own egress on Cloudflare's network?
 *
 * (b) is the one that matters — the live tests only ever fetch the fixture
 * through the Worker — and it can only be observed by asking the Worker, which
 * is what this script does via the public `video_resolve` tool (the same guard,
 * HEAD and classification path the tests exercise).
 *
 * The script prints an honest verdict and always exits 0 (except on usage
 * errors): an unreachable fixture makes the fixture-dependent live tests skip
 * with an explicit, labelled environment note rather than fail, and that skip
 * must stay visible in the job log instead of aborting the run. It sends no
 * Authorization header and prints no secret values; the fixture URL is public
 * by design.
 *
 * Usage: node scripts/probe-live-fixture.mjs <worker-url> <fixture-url>
 */

const [workerArg, fixtureArg] = process.argv.slice(2);
if (!workerArg || !fixtureArg) {
  console.error("usage: node scripts/probe-live-fixture.mjs <worker-url> <fixture-url>");
  process.exit(2);
}

let origin;
let fixture;
try {
  origin = new URL(workerArg).origin;
  fixture = new URL(fixtureArg).toString();
} catch (error) {
  console.error(`invalid URL argument: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const HEADER_KEYS = ["content-type", "content-length", "accept-ranges", "cache-control", "server"];

function summariseHeaders(headers) {
  return HEADER_KEYS.map((key) => `${key}=${headers.get(key) ?? "-"}`).join(" ");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** (a) runner → fixture, with a few retries for freshly enabled r2.dev URLs. */
async function probeFromRunner() {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(fixture, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(20_000) });
      console.log(`runner -> fixture: HTTP ${response.status} ${summariseHeaders(response.headers)}`);
      if (response.ok) return true;
      if (response.status < 500 && response.status !== 404 && response.status !== 429) return false;
    } catch (error) {
      console.log(`runner -> fixture: request failed (${error instanceof Error ? error.message : String(error)})`);
    }
    if (attempt < 5) await sleep(3_000 * attempt);
  }
  return false;
}

/** (b) Worker → fixture, observed through the unauthenticated video_resolve tool. */
async function probeFromWorker() {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "video_resolve", arguments: { url: fixture, verify_bytes: true, include_signed_urls: false } },
  };
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${origin}/mcp answered HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  const trimmed = text.trim();
  const rpc = trimmed.startsWith("{")
    ? JSON.parse(trimmed)
    : JSON.parse(trimmed.split("\n").filter((line) => line.startsWith("data:")).pop()?.slice(5).trim() ?? "{}");
  if (rpc.error) throw new Error(`JSON-RPC error ${rpc.error.code}: ${rpc.error.message}`);
  const content = Array.isArray(rpc.result?.content) ? rpc.result.content : [];
  const payloadText = content.filter((entry) => entry?.type === "text").map((entry) => entry.text).join("\n");
  let payload = null;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    throw new Error(`video_resolve returned a non-JSON payload: ${payloadText.slice(0, 300)}`);
  }
  return payload;
}

const runnerOk = await probeFromRunner();

let payload = null;
let workerError = null;
try {
  payload = await probeFromWorker();
} catch (error) {
  workerError = error instanceof Error ? error.message : String(error);
}

if (payload) {
  const verdict = {
    access_status: payload.access_status ?? null,
    http_status: payload.http_status ?? null,
    verification: payload.verification ?? null,
    stream_count: payload.stream_count ?? null,
    content_type: payload.content_type ?? null,
    content_length_bytes: payload.content_length_bytes ?? null,
    challenge: payload.challenge?.kind ?? null,
    error: payload.error ?? null,
    message: typeof payload.message === "string" ? payload.message.slice(0, 300) : null,
    limitations: Array.isArray(payload.limitations) ? payload.limitations.slice(0, 3) : [],
  };
  console.log(`worker -> fixture (video_resolve): ${JSON.stringify(verdict)}`);
} else {
  console.log(`worker -> fixture (video_resolve): could not be asked (${workerError})`);
}

const workerOk = payload?.access_status === "public";
if (workerOk) {
  console.log(`PASS: the Worker can reach the live fixture (${fixture}); the direct-MP4 live tests will run for real.`);
} else {
  const reason = payload
    ? `access_status=${payload.access_status ?? "?"} http_status=${payload.http_status ?? "?"} challenge=${payload.challenge?.kind ?? "-"} error=${payload.error ?? "-"}`
    : `the Worker could not be asked: ${workerError}`;
  console.log(
    `::warning title=Live fixture not reachable from the Worker::${fixture} — ${reason}. ` +
      `The direct-MP4 live tests (video_ingest, inspect_video, video_resolve, video_fetch) will report an explicit ENVIRONMENT SKIP ` +
      `instead of exercising the pipeline. Point LIVE_PUBLIC_VIDEO_URL at a small public MP4 the Worker can fetch.`,
  );
}
if (!runnerOk) {
  console.log("note: the runner itself could not HEAD the fixture; only the Worker-side verdict above decides what the live tests do.");
}
