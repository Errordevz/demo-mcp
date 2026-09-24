/**
 * A small, dependency-free `.gitignore` matcher.
 *
 * isomorphic-git's `isIgnored` reads the *working tree*, but DEMO clones
 * without a checkout (no repository-provided file is ever written to disk or
 * executed). So `git_repository` explains `.gitignore` itself: parse the
 * patterns at a revision and test candidate paths against them. Semantics are
 * the practical subset of `gitignore(5)`: comments, negation via `!`, trailing
 * `/` (directory-only), leading `/` (rooted), `*`/`?`/`[…]` globs, `**` for
 * crossing directories, and basename matching for patterns without a slash.
 * Ambiguities are reported as `limitations`, never silently guessed.
 */

export interface IgnoreRule {
  line: number;
  pattern: string;
  negated: boolean;
  directoryOnly: boolean;
  rooted: boolean;
}

export interface IgnoreMatcher {
  rules: IgnoreRule[];
  limitations: string[];
}

export function parseGitignore(source: string): IgnoreMatcher {
  const limitations: string[] = [];
  const rules: IgnoreRule[] = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    let pattern = line.trim();
    let negated = false;
    if (pattern.startsWith("!")) {
      negated = true;
      pattern = pattern.slice(1);
    }
    if (pattern.startsWith("\\!")) pattern = pattern.slice(1);
    let directoryOnly = false;
    if (pattern.endsWith("/")) {
      directoryOnly = true;
      pattern = pattern.slice(0, -1);
    }
    let rooted = false;
    if (pattern.startsWith("/")) {
      rooted = true;
      pattern = pattern.slice(1);
    } else if (pattern.includes("/")) {
      // A slash anywhere but the end anchors the pattern at the root, as in git.
      rooted = true;
    }
    if (/\$|\{|\}/.test(pattern)) limitations.push(`line ${index + 1}: pattern "${pattern.slice(0, 60)}" uses syntax beyond the supported glob subset; treated literally`);
    rules.push({ line: index + 1, pattern, negated, directoryOnly, rooted });
  });
  return { rules, limitations: limitations.slice(0, 20) };
}

function globToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` crosses directories; `**` alone behaves like `*` on each segment.
        if (pattern[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 3;
          continue;
        }
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i++;
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      i++;
      continue;
    }
    if (char === "[") {
      const close = pattern.indexOf("]", i);
      if (close === -1) {
        out += "\\[";
        i++;
        continue;
      }
      const body = pattern.slice(i + 1, close).replace(/\\/g, "\\\\");
      out += `[${body.startsWith("!") ? "^" : ""}${body.startsWith("!") ? body.slice(1) : body}]`;
      i = close + 1;
      continue;
    }
    out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  return new RegExp(`^${out}$`);
}

export type IgnoreDecision = "ignored" | "not-ignored" | "negated";

/**
 * Last matching rule wins (git semantics). An ancestor directory match ignores
 * everything below it; `directoryOnly` rules never match a plain file path.
 */
export function testPath(matcher: IgnoreMatcher, path: string, isDirectory = false): IgnoreDecision {
  const clean = path.replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (!clean) return "not-ignored";
  const segments = clean.split("/");
  const prefixes: string[] = [];
  for (let i = 1; i <= segments.length; i++) prefixes.push(segments.slice(0, i).join("/"));
  let decision: IgnoreDecision = "not-ignored";
  for (const rule of matcher.rules) {
    const regex = globToRegExp(rule.pattern);
    let matched = false;
    if (rule.rooted) {
      if (regex.test(clean)) matched = true;
      if (!matched && rule.directoryOnly) {
        // An ignored directory at any ancestor level hides everything beneath it.
        for (let i = 1; i < segments.length; i++) if (regex.test(prefixes[i - 1])) { matched = true; break; }
      }
    } else if (!rule.pattern.includes("/")) {
      // Basename pattern: matches any component; directory-only rules match directories or ancestors.
      segments.forEach((segment, index) => {
        if (!regex.test(segment)) return;
        if (rule.directoryOnly && index === segments.length - 1 && !isDirectory) return;
        matched = true;
      });
    } else {
      // Slash pattern (rooted above); unreachable defensive branch.
      if (regex.test(clean)) matched = true;
    }
    if (matched) decision = rule.negated ? "not-ignored" : "ignored";
  }
  return decision;
}
