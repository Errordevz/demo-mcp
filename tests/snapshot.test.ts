import { describe, expect, it } from "vitest";
import { flattenAxTree, renderInteractiveSnapshot, summarisePage } from "../src/browser/snapshot.js";
import type { AxNode } from "../src/browser/types.js";

const TREE: AxNode = {
  role: "RootWebArea",
  name: "Home",
  children: [
    {
      role: "heading",
      name: "Welcome",
      children: [{ role: "text", name: "Welcome", value: "Welcome" }],
    },
    { role: "button", name: "Sign in", disabled: false, focused: true },
    { role: "checkbox", name: "Remember me", checked: true },
    { role: "textbox", name: "Email", value: "someone@example.com", required: true },
    { role: "link", name: "Docs" },
  ],
};

describe("flattenAxTree", () => {
  it("renders an indented role/name tree with states", () => {
    const result = flattenAxTree(TREE);
    expect(result.truncated).toBe(false);
    expect(result.text).toContain("RootWebArea \"Home\"");
    expect(result.text).toContain("heading \"Welcome\"");
    expect(result.text).toContain("checkbox \"Remember me\" [checked]");
    expect(result.text).toContain("textbox \"Email\" value=\"someone@example.com\" [required]");
    expect(result.totalNodes).toBe(7); // root + heading + text + 4 controls
  });

  it("respects maxDepth and maxNodes", () => {
    const shallow = flattenAxTree(TREE, { maxDepth: 0 });
    expect(shallow.nodes).toHaveLength(1);
    expect(shallow.truncated).toBe(true);
    const limited = flattenAxTree(TREE, { maxNodes: 3 });
    expect(limited.nodes).toHaveLength(3);
    expect(limited.text).toMatch(/truncated/);
  });

  it("handles a missing accessibility tree", () => {
    const result = flattenAxTree(null);
    expect(result.text).toBe("(accessibility tree unavailable)");
    expect(result.truncated).toBe(false);
  });
});

describe("renderInteractiveSnapshot", () => {
  it("lists refs, roles and labels", () => {
    const result = renderInteractiveSnapshot([
      {
        ref: "e1",
        tag: "button",
        text: "Sign in",
        role: "button",
        name: "Sign in",
        type: "",
        placeholder: "",
        href: "",
        disabled: false,
        checked: null,
        selector: "button",
        rect: { x: 0, y: 0, width: 0, height: 0 },
        visible: true,
      },
      {
        ref: "e2",
        tag: "a",
        href: "https://example.com/docs",
        text: "Docs",
        role: "link",
        name: "Docs",
        type: "",
        placeholder: "",
        disabled: false,
        checked: null,
        selector: "a",
        rect: { x: 0, y: 0, width: 0, height: 0 },
        visible: true,
      },
      {
        ref: "e3",
        tag: "input",
        type: "email",
        placeholder: "Email",
        text: "",
        role: "textbox",
        name: "Email",
        href: "",
        disabled: true,
        checked: null,
        selector: "input",
        rect: { x: 0, y: 0, width: 0, height: 0 },
        visible: true,
      },
    ]);
    expect(result.text).toContain("[e1] button Sign in");
    expect(result.text).toContain("[e2] link Docs -> https://example.com/docs");
    expect(result.text).toContain("[e3] textbox:email Email (disabled)");
  });

  it("truncates very long labels", () => {
    const result = renderInteractiveSnapshot([{ ref: "e1", tag: "button", text: "x".repeat(500) }] as never, { maxTextLength: 20 });
    expect(result.text.length).toBeLessThan(60);
    expect(result.text).toMatch(/…$/);
  });
});

describe("summarisePage", () => {
  it("produces a compact summary", () => {
    const summary = summarisePage({
      url: "https://example.com/",
      title: "Example",
      meta: { description: "A page" },
      links: [{ text: "a", href: "https://example.com/a" }],
      headings: ["H1", "H2"],
      textLength: 1234,
    });
    expect(summary.split("\n")).toEqual([
      "url: https://example.com/",
      "title: Example",
      "description: A page",
      "headings: H1 | H2",
      "links: 1",
      "textLength: 1234",
    ]);
  });
});
