/**
 * MCP result helpers.
 *
 * Every browser result is a compact JSON document (screenshots are links, not
 * binaries) plus an optional inline image when the caller opts in. Errors keep a
 * stable shape so the model can branch on `code`.
 */

import { describeError, isBrowserError } from "../core/errors.js";
import { redactValue } from "../core/redact.js";

export type TextContent = {
  type: "text";
  text: string;
};

export type ImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

export type ToolContent = TextContent | ImageContent;

export type ToolResult = {
  content: ToolContent[];
  isError?: boolean;
  /** MCP/OpenAI tool-level OAuth challenge metadata (serialized unchanged). */
  _meta?: Record<string, unknown>;
};

export function textResult(value: unknown): ToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

export function imageResult(images: Array<{ data: string; mimeType: string }>, payload: unknown): ToolResult {
  return {
    content: [
      ...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
      { type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) },
    ],
  };
}

export function errorResult(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function errorFrom(error: unknown): ToolResult {
  if (isBrowserError(error)) {
    const payload: Record<string, unknown> = { error: error.code, message: error.message };
    if (error.hint) payload.hint = error.hint;
    if (error.retryable) payload.retryable = true;
    if (error.capability) payload.capability = error.capability;
    if (error.data) payload.details = redactValue(error.data);
    return { isError: true, content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  }
  const info = describeError(error);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: info.code, message: info.message, ...(info.hint ? { hint: info.hint } : {}) }, null, 2),
      },
    ],
  };
}

/** Wrap a tool body so nothing throws into the MCP transport. */
export async function runTool<T>(work: () => Promise<T>): Promise<ToolResult> {
  try {
    const value = await work();
    if (value && typeof value === "object" && Array.isArray((value as { content?: unknown }).content)) {
      return value as unknown as ToolResult;
    }
    return textResult(value);
  } catch (error) {
    return errorFrom(error);
  }
}
