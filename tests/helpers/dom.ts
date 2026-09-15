import { JSDOM } from "jsdom";
import vm from "node:vm";

/**
 * Execute one of the real in-page functions from `src/browser/page-scripts.ts`
 * inside a jsdom document.
 *
 * The functions are serialised with `Function.prototype.toString()` by
 * Puppeteer, so running them through `vm` reproduces the browser path closely
 * and guarantees the "self-contained function" contract holds.
 */
export function runInPage<T>(html: string, fn: (arg: any) => T, arg?: unknown, url = "https://example.com/"): T {
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const context = dom.getInternalVMContext();
  const source = arg === undefined ? `(${fn.toString()})()` : `(${fn.toString()})(${JSON.stringify(arg)})`;
  const script = new vm.Script(source);
  const result = script.runInContext(context);
  dom.window.close();
  return result as T;
}

/** Same as runInPage but keeps the window open for multi-step interaction. */
export function createPage(html: string, url = "https://example.com/") {
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const context = dom.getInternalVMContext();
  return {
    dom,
    run<T>(fn: (arg: any) => T, arg?: unknown): T {
      const source = arg === undefined ? `(${fn.toString()})()` : `(${fn.toString()})(${JSON.stringify(arg)})`;
      return new vm.Script(source).runInContext(context) as T;
    },
    close() {
      dom.window.close();
    },
  };
}
