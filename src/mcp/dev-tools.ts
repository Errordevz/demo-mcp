import { z } from "zod";
import { errorResult, textResult } from "./results.js";

export const DEV_TOOL_NAMES = ["dev_chat", "dev_capabilities"] as const;

type DevEnv = Record<string, unknown> & {
  DEV_BASE_URL?: string;
};

function baseUrl(env: DevEnv) {
  return String(env.DEV_BASE_URL ?? "").trim().replace(/\/$/, "");
}

export function registerDevTools(mcp: any, { env }: { env: DevEnv }) {
  mcp.registerTool(
    "dev_capabilities",
    {
      title: "Dev Capabilities",
      description: "Report whether the DEMO Dev coding agent is configured and available. Presence only; never exposes model credentials.",
      inputSchema: z.object({}),
    },
    async () => {
      const url = baseUrl(env);
      if (!url) return textResult({ enabled: false, reason: "DEV_BASE_URL is not configured." });
      try {
        const r = await fetch(url + "/api/status", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
        const data = await r.json().catch(() => ({}));
        return textResult({ enabled: r.ok, ...data, endpointConfigured: true });
      } catch (e) {
        return textResult({ enabled: false, endpointConfigured: true, reason: String(e) });
      }
    },
  );

  mcp.registerTool(
    "dev_chat",
    {
      title: "Dev Coding Agent",
      description: "Use DEMO's Dev agent for coding-focused reasoning, repository inspection, targeted edits and verification. Dev is public/no-login; only public GitHub repositories may be attached to a hosted task.",
      inputSchema: {
        message: z.string().min(1).max(12000),
        repo: z.string().url().optional(),
      },
    },
    async ({ message, repo }) => {
      const url = baseUrl(env);
      if (!url) return errorResult("Dev is not configured on this DEMO deployment. Set the server-side DEV_BASE_URL.");
      try {
        const r = await fetch(url + "/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ message, repo }),
          signal: AbortSignal.timeout(120000),
        });
        const text = await r.text();
        if (!r.ok) return errorResult(`Dev request failed (HTTP ${r.status}): ${text.slice(0, 1200)}`);
        return textResult(JSON.parse(text));
      } catch (e) {
        return errorResult(`Dev request failed: ${String(e)}`);
      }
    },
  );
}
