/**
 * grep: regular-expression search over file contents.
 *
 * Files decode with the same codecs as read (UTF-8, UTF-16, GBK/GB18030), so
 * Chinese legacy files are searchable; binary and very large files are
 * skipped and counted. Output follows ripgrep (`path:line:text`, context
 * lines as `path-line-text`, `--` between groups) and is paged with
 * head_limit/offset.
 */
import { readFile, stat } from "node:fs/promises";
import { compileGlob } from "./glob-pattern.ts";
import { joinDisplay, mapLimit } from "./glob.ts";
import { toLf } from "./line-endings.ts";
import { resolveWorkspacePath } from "./paths.ts";
import { compileSearchRegex } from "./search-regex.ts";
import { decodeText, detectEncoding, looksBinary } from "./text-codec.ts";
import { failure, READS_WORKSPACE, statOrNull, type ToolDefinition } from "./tool.ts";
import { walkFiles } from "./walk.ts";

export type GrepMode = "content" | "files_with_matches" | "count";
export const GREP_DEFAULT_HEAD_LIMIT = 250;
export const GREP_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const GREP_MAX_LINE_CHARS = 500;
const READ_CONCURRENCY = 8;
const MAX_MATCHES_PER_FILE = 10_000;

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  /** Name used by the Python tool; same meaning as glob. */
  include?: string;
  output_mode?: GrepMode;
  case_insensitive?: boolean;
  context?: number;
  multiline?: boolean;
  head_limit?: number;
  offset?: number;
  include_ignored?: boolean;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface GrepData {
  pattern: string;
  mode: GrepMode;
  filesSearched: number;
  filesMatched: number;
  truncated: boolean;
  skipped: { binary: number; tooLarge: number; undecodable: number };
  matches: GrepMatch[];
  files: string[];
  counts: Record<string, number>;
}

interface FileHit {
  path: string;
  absolute: string;
  lines: string[];
  matched: number[];
}

function cut(text: string): string {
  return text.length > GREP_MAX_LINE_CHARS ? `${text.slice(0, GREP_MAX_LINE_CHARS)}…` : text;
}

function matchedLines(lines: string[], text: string, regex: RegExp, multiline: boolean): number[] {
  const found: number[] = [];
  if (!multiline) {
    for (let index = 0; index < lines.length && found.length < MAX_MATCHES_PER_FILE; index += 1) {
      if (regex.test(lines[index] as string)) found.push(index + 1);
    }
    return found;
  }
  const seen = new Set<number>();
  regex.lastIndex = 0;
  let newlines = 0;
  let scanned = 0;
  for (let match = regex.exec(text); match && seen.size < MAX_MATCHES_PER_FILE; match = regex.exec(text)) {
    for (; scanned < match.index; scanned += 1) if (text.charCodeAt(scanned) === 10) newlines += 1;
    let extra = 0;
    for (const char of match[0]) if (char === "\n") extra += 1;
    for (let line = newlines + 1; line <= newlines + 1 + extra; line += 1) seen.add(line);
    if (match[0] === "") regex.lastIndex += 1;
  }
  found.push(...[...seen].filter((line) => line <= lines.length).sort((a, b) => a - b));
  return found;
}

function contentEntries(hit: FileHit, context: number): string[] {
  const shown = new Set<number>();
  for (const line of hit.matched) {
    for (let near = Math.max(1, line - context); near <= Math.min(hit.lines.length, line + context); near += 1) shown.add(near);
  }
  const matched = new Set(hit.matched);
  const out: string[] = [];
  let previous = 0;
  for (const line of [...shown].sort((a, b) => a - b)) {
    if (context > 0 && previous && line > previous + 1) out.push("--");
    const separator = matched.has(line) ? ":" : "-";
    out.push(`${hit.path}${separator}${line}${separator}${cut(hit.lines[line - 1] as string)}`);
    previous = line;
  }
  return out;
}

export const grepTool: ToolDefinition<GrepInput, GrepData> = {
  name: "grep",
  gate: "grep",
  mutating: false,
  concurrencySafe: true,
  requires: READS_WORKSPACE,
  description: [
    "Search file contents with a regular expression (JavaScript syntax; Python-style (?P<name>) and (?i) accepted).",
    "output_mode: content (default, `path:line:text`), files_with_matches (newest first) or count.",
    "Filter files with glob (e.g. `*.ts`, `src/**/*.py`); add context lines with context; page with head_limit/offset.",
    "Respects .gitignore and skips binary files, .git and node_modules unless include_ignored is true.",
  ].join(" "),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string", minLength: 1, maxLength: 1024 },
      path: { type: "string", minLength: 1, description: "File or directory to search. Default: working directory." },
      glob: { type: "string", minLength: 1, maxLength: 1024 },
      include: { type: "string", minLength: 1, maxLength: 1024, description: "Same as glob." },
      output_mode: { type: "string", enum: ["content", "files_with_matches", "count"] },
      case_insensitive: { type: "boolean" },
      context: { type: "integer", minimum: 0, maximum: 20 },
      multiline: { type: "boolean", description: "Let the pattern span lines; `.` matches newlines." },
      head_limit: { type: "integer", minimum: 1, maximum: 5000 },
      offset: { type: "integer", minimum: 0 },
      include_ignored: { type: "boolean" },
    },
  },
  async run(input, env) {
    const multiline = input.multiline ?? false;
    const regex = compileSearchRegex(input.pattern, { ignoreCase: input.case_insensitive ?? false, multiline });
    const mode = input.output_mode ?? "content";
    const filter = input.glob ?? input.include;
    const fileFilter = filter ? compileGlob(filter) : null;
    const base = await resolveWorkspacePath(input.path ?? ".", env.cwd, env.roots);
    const info = await statOrNull(base.absolute);
    if (!info) return failure("not_found", `path not found: ${base.display}`);
    const ignoring = !input.include_ignored;
    let candidates: { path: string; absolute: string }[];
    let walkTruncated = false;
    if (info.isFile()) candidates = [{ path: base.display, absolute: base.absolute }];
    else {
      const walk = await walkFiles(base.absolute, { respectIgnore: ignoring, skipDefaultExcludes: ignoring, ...(env.signal ? { signal: env.signal } : {}) });
      walkTruncated = walk.truncated;
      candidates = walk.files
        .filter((file) => !fileFilter || fileFilter.test(file.path))
        .map((file) => ({ path: joinDisplay(base.display, file.path), absolute: file.absolute }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    }
    const skipped = { binary: 0, tooLarge: 0, undecodable: 0 };
    const limit = input.head_limit ?? GREP_DEFAULT_HEAD_LIMIT;
    const offset = input.offset ?? 0;
    const context = mode === "content" ? input.context ?? 0 : 0;
    const hits: FileHit[] = [];
    let contentCount = 0;
    let stoppedEarly = false;
    for (let start = 0; start < candidates.length && !stoppedEarly; start += READ_CONCURRENCY * 4) {
      env.signal?.throwIfAborted();
      const batch = candidates.slice(start, start + READ_CONCURRENCY * 4);
      const results = await mapLimit(batch, READ_CONCURRENCY, async (file): Promise<FileHit | null> => {
        const size = (await stat(file.absolute).catch(() => null))?.size;
        if (size === undefined) return null;
        if (size > GREP_MAX_FILE_BYTES) {
          skipped.tooLarge += 1;
          return null;
        }
        const bytes = await readFile(file.absolute).catch(() => null);
        if (!bytes) return null;
        if (looksBinary(bytes)) {
          skipped.binary += 1;
          return null;
        }
        let text: string;
        try {
          text = toLf(decodeText(bytes, detectEncoding(bytes)).text);
        } catch {
          skipped.undecodable += 1;
          return null;
        }
        const lines = text.split("\n");
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
        const matched = matchedLines(lines, text, regex, multiline);
        return matched.length ? { path: file.path, absolute: file.absolute, lines, matched } : null;
      });
      for (const hit of results) {
        if (!hit) continue;
        hits.push(hit);
        if (mode === "content") {
          contentCount += contentEntries(hit, context).filter((entry) => entry !== "--").length;
          if (contentCount > offset + limit) stoppedEarly = true;
          if (stoppedEarly) break;
        }
      }
    }
    let entries: string[];
    const counts: Record<string, number> = {};
    const matches: GrepMatch[] = [];
    if (mode === "content") {
      entries = [];
      let kept = 0;
      for (const hit of hits) {
        for (const entry of contentEntries(hit, context)) {
          if (entry === "--") {
            if (kept > offset && entries.length && entries[entries.length - 1] !== "--") entries.push("--");
            continue;
          }
          kept += 1;
          if (kept > offset && kept <= offset + limit) entries.push(entry);
        }
        for (const line of hit.matched) matches.push({ path: hit.path, line, text: cut(hit.lines[line - 1] as string) });
      }
      while (entries[entries.length - 1] === "--") entries.pop();
    } else if (mode === "count") {
      for (const hit of hits) counts[hit.path] = hit.matched.length;
      entries = hits.map((hit) => `${hit.path}:${hit.matched.length}`).slice(offset, offset + limit);
    } else {
      const stamped = await mapLimit(hits, 32, async (hit) => ({ path: hit.path, mtime: (await stat(hit.absolute).catch(() => null))?.mtimeMs ?? 0 }));
      stamped.sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      entries = stamped.map((entry) => entry.path).slice(offset, offset + limit);
    }
    const total = mode === "content" ? contentCount : hits.length;
    const truncated = stoppedEarly || total > offset + limit;
    const notes: string[] = [];
    if (truncated) notes.push(`[results truncated at ${limit}${offset ? ` after offset ${offset}` : ""}; continue with offset=${offset + limit} or narrow the search]`);
    if (walkTruncated) notes.push("[search stopped at the entry budget; narrow the path]");
    const skippedTotal = skipped.binary + skipped.tooLarge + skipped.undecodable;
    if (skippedTotal) notes.push(`[skipped ${skipped.binary} binary, ${skipped.tooLarge} larger than ${GREP_MAX_FILE_BYTES} bytes, ${skipped.undecodable} undecodable]`);
    let output = entries.join("\n");
    if (!hits.length) {
      output = `No matches for ${JSON.stringify(input.pattern)} in ${base.display} (${candidates.length} files searched).`;
      if (ignoring && !info.isFile()) output += " Ignored files and dependency directories were skipped (include_ignored: true searches them).";
    }
    if (notes.length) output += `\n\n${notes.join("\n")}`;
    return {
      ok: true,
      output,
      data: {
        pattern: input.pattern, mode, filesSearched: candidates.length, filesMatched: hits.length, truncated, skipped,
        matches, files: mode === "content" ? hits.map((hit) => hit.path) : entries.map((entry) => (mode === "count" ? entry.slice(0, entry.lastIndexOf(":")) : entry)),
        counts,
      },
    };
  },
};
