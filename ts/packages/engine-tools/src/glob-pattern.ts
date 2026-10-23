/**
 * Glob patterns for the glob and grep tools: `*`, `?`, `[...]` classes,
 * `**` across directories and nested `{a,b}` alternatives. A pattern without
 * `/` matches the file name at any depth, as in ripgrep and the Python tool
 * this replaces; a pattern with `/` matches the path from the search root.
 */
import { isAbsolute } from "node:path";
import { globBody } from "./ignore.ts";

export const GLOB_MAX_EXPANSIONS = 256;
export const GLOB_MAX_PATTERN_CHARS = 1024;

interface BraceGroup {
  start: number;
  end: number;
  options: string[];
}

function skipClass(text: string, start: number): number {
  const close = text.indexOf("]", start + 2);
  return close === -1 ? start : close;
}

function findBraceGroup(text: string): BraceGroup | null {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "[") {
      index = skipClass(text, index);
      continue;
    }
    if (char !== "{") continue;
    let depth = 0;
    let partStart = index + 1;
    const options: string[] = [];
    for (let cursor = index; cursor < text.length; cursor += 1) {
      const inner = text[cursor];
      if (inner === "\\") cursor += 1;
      else if (inner === "{") depth += 1;
      else if (inner === "," && depth === 1) {
        options.push(text.slice(partStart, cursor));
        partStart = cursor + 1;
      } else if (inner === "}") {
        depth -= 1;
        if (depth === 0) {
          if (!options.length) break;
          options.push(text.slice(partStart, cursor));
          return { start: index, end: cursor, options };
        }
      }
    }
  }
  return null;
}

/** Expand `{a,b}` alternatives (nested, escaped braces stay literal). */
export function expandBraces(pattern: string, limit = GLOB_MAX_EXPANSIONS): string[] {
  const results: string[] = [];
  const stack = [pattern];
  while (stack.length) {
    const current = stack.pop() as string;
    const group = findBraceGroup(current);
    if (!group) {
      results.push(current);
      if (results.length > limit) throw new TypeError(`glob expands to more than ${limit} patterns`);
      continue;
    }
    for (const option of [...group.options].reverse()) {
      stack.push(current.slice(0, group.start) + option + current.slice(group.end + 1));
    }
  }
  return results;
}

export interface GlobMatcher {
  readonly pattern: string;
  readonly regex: RegExp;
  test(path: string): boolean;
}

export interface GlobOptions {
  /** Defaults to true on Windows and macOS, whose file systems ignore case. */
  ignoreCase?: boolean;
  /** Treat backslashes as glob escapes, even on Windows (permission rules). */
  backslashEscapes?: boolean;
}

const DEFAULT_IGNORE_CASE = process.platform === "win32" || process.platform === "darwin";

/** Reject absolute patterns and `..` segments: globs stay inside the search root. */
export function assertRelativeGlob(pattern: string): void {
  if (typeof pattern !== "string" || !pattern.trim()) throw new TypeError("pattern must be a nonempty string");
  if (pattern.length > GLOB_MAX_PATTERN_CHARS) throw new TypeError(`pattern is longer than ${GLOB_MAX_PATTERN_CHARS} characters`);
  const slashed = pattern.replace(/\\/g, "/");
  if (isAbsolute(pattern) || slashed.startsWith("/") || /^[A-Za-z]:/.test(pattern) || slashed.split("/").includes("..")) {
    throw new TypeError("pattern must be relative to the search path and must not contain '..'");
  }
}

export function compileGlob(pattern: string, options: GlobOptions = {}): GlobMatcher {
  let text = process.platform === "win32" && !options.backslashEscapes ? pattern.replace(/\\/g, "/") : pattern;
  while (text.startsWith("./")) text = text.slice(2);
  const sources = expandBraces(text).map((alternative) => {
    let body = alternative;
    if (body.endsWith("/")) body += "**";
    if (!body.includes("/")) return `(?:.*/)?${globBody(body)}`;
    return globBody(body.replace(/^\/+/, ""));
  });
  const regex = new RegExp(`^(?:${sources.join("|")})$`, (options.ignoreCase ?? DEFAULT_IGNORE_CASE) ? "i" : "");
  return { pattern, regex, test: (path) => regex.test(path) };
}
