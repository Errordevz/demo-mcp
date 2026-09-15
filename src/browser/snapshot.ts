/**
 * Snapshot rendering: accessibility tree + simplified interactive DOM.
 *
 * Both representations are bounded (node count, depth and string length) so a
 * pathological page cannot flood the MCP response.
 */

import { LIMITS } from "../core/limits.js";
import type { InteractiveElement } from "./page-scripts.js";
import type { AxNode } from "./types.js";

export interface SnapshotNode {
  depth: number;
  role: string;
  name: string;
  value?: string;
  states: string[];
}

export interface SnapshotResult {
  nodes: SnapshotNode[];
  text: string;
  totalNodes: number;
  truncated: boolean;
}

const STATE_KEYS = [
  "disabled",
  "expanded",
  "focused",
  "modal",
  "multiline",
  "multiselectable",
  "readonly",
  "required",
  "selected",
  "checked",
  "pressed",
] as const;

export function flattenAxTree(
  root: AxNode | null,
  options: { maxNodes?: number; maxDepth?: number } = {},
): SnapshotResult {
  const maxNodes = options.maxNodes ?? LIMITS.maxSnapshotNodes;
  const maxDepth = options.maxDepth ?? LIMITS.maxSnapshotDepth;
  const nodes: SnapshotNode[] = [];
  let totalNodes = 0;
  let truncated = false;

  if (!root) return { nodes, text: "(accessibility tree unavailable)", totalNodes: 0, truncated: false };

  const visit = (node: AxNode, depth: number): void => {
    totalNodes += 1;
    if (depth > maxDepth) {
      truncated = true;
      return;
    }
    if (nodes.length >= maxNodes) {
      truncated = true;
      return;
    }
    const states = STATE_KEYS.filter((key) => node[key] === true) as string[];
    const entry: SnapshotNode = {
      depth,
      role: node.role || "generic",
      name: (node.name ?? "").slice(0, 200),
      ...(node.value !== undefined && node.value !== null && node.value !== "" ? { value: String(node.value).slice(0, 200) } : {}),
      states,
    };
    nodes.push(entry);
    for (const child of node.children ?? []) visit(child, depth + 1);
  };

  visit(root, 0);

  const lines = nodes.map((node) => {
    const indent = "  ".repeat(Math.max(0, node.depth - 1));
    const name = node.name ? ` "${node.name}"` : "";
    const value = node.value ? ` value="${node.value}"` : "";
    const states = node.states.length ? ` [${node.states.join(" ")}]` : "";
    return `${indent}${node.role}${name}${value}${states}`;
  });
  if (truncated) lines.push(`… (snapshot truncated: showing ${nodes.length}/${totalNodes} nodes)`);

  return { nodes, text: lines.join("\n"), totalNodes, truncated };
}

export interface InteractiveSnapshot {
  text: string;
  elements: InteractiveElement[];
  truncated: boolean;
}

export function renderInteractiveSnapshot(
  elements: InteractiveElement[],
  options: { maxTextLength?: number } = {},
): InteractiveSnapshot {
  const maxText = options.maxTextLength ?? 120;
  const lines = elements.map((element) => {
    const label = element.name || element.text || element.placeholder || element.href || element.type || "";
    const clipped = label.length > maxText ? `${label.slice(0, maxText)}…` : label;
    const kind = element.role ?? element.tag;
    const disabled = element.disabled ? " (disabled)" : "";
    const href = element.href && !clipped.startsWith("http") ? ` -> ${element.href.slice(0, 120)}` : "";
    return `[${element.ref}] ${kind}${element.type ? `:${element.type}` : ""} ${clipped}${href}${disabled}`;
  });
  return { text: lines.join("\n"), elements, truncated: false };
}

/** Compact textual summary used by `browser_read`. */
export function summarisePage(payload: {
  url: string;
  title: string;
  meta: Record<string, string>;
  links: Array<{ text: string; href: string }>;
  headings: string[];
  textLength: number;
}): string {
  const lines = [
    `url: ${payload.url}`,
    `title: ${payload.title}`,
    `description: ${payload.meta?.description ?? payload.meta?.["og:description"] ?? ""}`.trimEnd(),
    `headings: ${payload.headings.slice(0, 10).join(" | ") || "(none)"}`,
    `links: ${payload.links.length}`,
    `textLength: ${payload.textLength}`,
  ];
  return lines.join("\n");
}
