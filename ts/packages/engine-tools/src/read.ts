/**
 * read: numbered lines with paging and output caps.
 * Format per line is `<number>\t<text>`; CRLF files read as LF text. Any
 * supported encoding is decoded; binary files are refused.
 *
 * Limits, warnings and error texts follow ZCode v3.15.1 (aac4755, Apache-2.0)
 * `core/src/tool/handlers/read.ts`, `read-text.ts` and `contracts/src/tools/read.ts`.
 */
import { readFile } from "node:fs/promises";
import { resolveWorkspacePath } from "./paths.ts";
import { createPersistedFileReadState } from "./file-state.ts";
import { decodeText, detectEncoding } from "./text-codec.ts";
import { detectLineEnding, toLf } from "./line-endings.ts";
import { failure, READS_WORKSPACE, statOrNull, type ToolDefinition } from "./tool.ts";
import { estimateTokens, formatFileSize, missingFileMessage, systemReminder } from "./zcode-text.ts";
import { basename, extname } from "node:path";
import { pdfPagesFailure, readMedia, type ReadMediaData } from "./read-media.ts";
import { NodeWorkspaceFileSystem, snapshotFromRevision } from "./filesystem.ts";

export const READ_DEFAULT_LIMIT = 2000;
/** ZCode READ_MAX_FILE_SIZE_BYTES: a read without `limit` refuses larger files. */
export const READ_MAX_WHOLE_FILE_BYTES = 256 * 1024;
/** ZCode READ_MAX_OUTPUT_TOKENS, and the 85% target of a partial first view. */
export const READ_MAX_OUTPUT_TOKENS = 25_000;
const READ_PARTIAL_TOKEN_TARGET = Math.floor(READ_MAX_OUTPUT_TOKENS * 0.85);
export const READ_MAX_FILE_BYTES = 32 * 1024 * 1024;
/** ZCode contracts `UNSUPPORTED_BINARY_EXTENSIONS` and `BLOCKING_DEVICE_PATHS`. */
const BINARY_EXTENSIONS = new Set([".7z", ".a", ".bin", ".bz2", ".class", ".dll", ".dmg", ".dylib", ".exe", ".gz", ".jar", ".o", ".pyc", ".rar", ".so", ".tar", ".tgz", ".wasm", ".zip"]);
const BLOCKING_DEVICES = new Set(["/dev/console", "/dev/fd/0", "/dev/fd/1", "/dev/fd/2", "/dev/full", "/dev/random", "/dev/stderr", "/dev/stdin", "/dev/stdout", "/dev/tty", "/dev/urandom", "/dev/zero"]);

export interface ReadInput {
  path: string;
  offset?: number;
  limit?: number;
  /** PDF page range (`"1-5"`), rendered as page images; only when the model accepts PDFs. */
  pages?: string;
}

export interface ReadData {
  path: string;
  encoding: string;
  lineEnding: "LF" | "CRLF";
  totalLines: number;
  startLine: number;
  endLine: number;
  nextOffset: number | null;
}

export const readTool: ToolDefinition<ReadInput, ReadData | ReadMediaData> = {
  name: "read",
  gate: "read",
  mutating: false,
  concurrencySafe: true,
  requires: READS_WORKSPACE,
  description: [
    "Read a text file. Returns lines as `<line number>\\t<text>` (cat -n style, from 1).",
    `Without \`limit\` the whole file is read (up to ${READ_MAX_WHOLE_FILE_BYTES / 1024}KB); page long files with offset/limit.`,
    "UTF-8, UTF-16 and GBK/GB18030 are decoded.",
    "Images (PNG, JPG, GIF, WebP) are attached for the model to see; so are PDFs when the model accepts them (`pages` renders page images).",
  ].join(" "),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", minLength: 1, description: "File path, relative to the working directory." },
      offset: { type: "integer", minimum: 1, description: "First line to return (1-based)." },
      limit: { type: "integer", minimum: 1, maximum: 10_000, description: "Maximum number of lines." },
      pages: { type: "string", description: 'Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum 20 pages per request.' },
    },
  },
  async run(input, env) {
    const pagesInvalid = pdfPagesFailure(input.path, input.pages);
    if (pagesInvalid) return pagesInvalid;
    const lower = input.path.toLowerCase();
    if (BLOCKING_DEVICES.has(lower)) return failure("invalid_argument", `Cannot read '${input.path}': this device file would block or produce infinite output.`);
    const extension = extname(lower);
    if (extension && basename(lower) !== extension && BINARY_EXTENSIONS.has(extension)) {
      return failure("binary_file", `This tool cannot read binary files. The file appears to be a binary ${extension} file. Please use appropriate tools for binary file analysis.`);
    }
    const target = await resolveWorkspacePath(input.path, env.cwd, env.roots);
    const info = await statOrNull(target.absolute);
    if (!info) return failure("not_found", await missingFileMessage(target.absolute, env.cwd));
    const media = await readMedia(input, target.absolute, target.display, info, env);
    if (media) {
      if (!media.ok) return media;
      const bytes = await readFile(target.absolute);
      const currentInfo = await statOrNull(target.absolute);
      if (!currentInfo) return media;
      env.tracker.record(target.absolute, currentInfo, bytes);
      const snapshot = env.tracker.get(target.absolute);
      return snapshot
        ? {
            ...media,
            _read_state: createPersistedFileReadState(
              target.absolute,
              "read",
              snapshot,
              (input.offset ?? 1) > 1 || input.limit !== undefined,
            ),
          }
        : media;
    }
    if (info.isDirectory()) return failure("is_directory", `Path is a directory: ${target.absolute}`);
    const sizeCap = input.limit === undefined ? READ_MAX_WHOLE_FILE_BYTES : READ_MAX_FILE_BYTES;
    if (info.size > sizeCap) {
      return failure("file_too_large", `File content (${formatFileSize(info.size)}) exceeds maximum allowed size (${formatFileSize(sizeCap)}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`);
    }
    if (input.offset !== undefined || input.limit !== undefined) {
      const fs = new NodeWorkspaceFileSystem({ cwd: env.cwd, roots: env.roots });
      const start = input.offset ?? 1;
      const ranged = await fs.readTextRange(input.path, start, input.limit, sizeCap, { signal: env.signal });
      let shown = ranged.lines;
      let notice = "";
      const tokens = estimateTokens(shown.join("\n"));
      if (tokens > READ_MAX_OUTPUT_TOKENS) {
        if (start > 1 || input.limit !== undefined) {
          return failure("file_too_large", `File content (${tokens} tokens) exceeds maximum allowed tokens (${READ_MAX_OUTPUT_TOKENS}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`);
        }
        let low = 0;
        let high = shown.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (estimateTokens(shown.slice(0, mid).join("\n")) <= READ_PARTIAL_TOKEN_TARGET) low = mid; else high = mid - 1;
        }
        if (low === 0) {
          return failure("file_too_large", `File content (${tokens} tokens) exceeds maximum allowed tokens (${READ_MAX_OUTPUT_TOKENS}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`);
        }
        shown = shown.slice(0, low);
        notice = systemReminder(`The file is too large to display in full (${tokens} estimated tokens, limit ${READ_MAX_OUTPUT_TOKENS}). Showing a partial view of lines ${start}-${start + low - 1} of ${ranged.totalLines}. Use Read with offset ${start + low} and limit ${READ_DEFAULT_LIMIT} to continue, or use a search tool to find a specific section.`) + "\n\n";
      }
      const endLine = shown.length ? start + shown.length - 1 : start - 1;
      const complete = start === 1 && endLine >= ranged.totalLines;
      const snapshot = snapshotFromRevision(ranged, !complete);
      env.tracker.restore(target.absolute, snapshot);
      const nextOffset = endLine < ranged.totalLines ? endLine + 1 : null;
      let output: string;
      if (ranged.totalLines === 0) output = systemReminder("Warning: the file exists but the contents are empty.");
      else if (!shown.length) output = systemReminder(`Warning: the file exists but is shorter than the provided offset (${start}). The file has ${ranged.totalLines} lines.`);
      else output = notice + shown.map((text, index) => `${start + index}\t${text}`).join("\n");
      return {
        ok: true,
        output,
        _read_state: createPersistedFileReadState(
          target.absolute,
          "read",
          snapshot,
          (input.offset ?? 1) > 1 || input.limit !== undefined,
        ),
        data: {
          path: target.display, encoding: ranged.encoding, lineEnding: ranged.lineEnding,
          totalLines: ranged.totalLines, startLine: start, endLine, nextOffset,
        },
      };
    }
    const bytes = await readFile(target.absolute);
    const encoding = detectEncoding(bytes);
    const raw = decodeText(bytes, encoding).text;
    const lines = toLf(raw).split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const total = raw === "" ? 0 : lines.length;
    const start = input.offset ?? 1;
    const selected = lines.slice(start - 1, input.limit === undefined ? undefined : start - 1 + input.limit);
    let shown = total === 0 ? [] : selected;
    let notice = "";
    const tokens = estimateTokens(shown.join("\n"));
    if (tokens > READ_MAX_OUTPUT_TOKENS) {
      // ZCode read-text: only a first whole-file read falls back to a partial view.
      if (start > 1 || input.limit !== undefined) {
        return failure("file_too_large", `File content (${tokens} tokens) exceeds maximum allowed tokens (${READ_MAX_OUTPUT_TOKENS}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`);
      }
      let low = 0;
      let high = shown.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (estimateTokens(shown.slice(0, mid).join("\n")) <= READ_PARTIAL_TOKEN_TARGET) low = mid; else high = mid - 1;
      }
      if (low === 0) {
        return failure("file_too_large", `File content (${tokens} tokens) exceeds maximum allowed tokens (${READ_MAX_OUTPUT_TOKENS}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`);
      }
      shown = shown.slice(0, low);
      notice = systemReminder(`The file is too large to display in full (${tokens} estimated tokens, limit ${READ_MAX_OUTPUT_TOKENS}). Showing a partial view of lines ${start}-${start + low - 1} of ${total}. Use Read with offset ${start + low} and limit ${READ_DEFAULT_LIMIT} to continue, or use a search tool to find a specific section.`) + "\n\n";
    }
    const endLine = shown.length ? start + shown.length - 1 : start - 1;
    const complete = start === 1 && endLine >= total;
    env.tracker.record(target.absolute, info, bytes, !complete);
    const snapshot = env.tracker.get(target.absolute);
    const nextOffset = endLine < total ? endLine + 1 : null;
    let output: string;
    if (total === 0) output = systemReminder("Warning: the file exists but the contents are empty.");
    else if (!shown.length) output = systemReminder(`Warning: the file exists but is shorter than the provided offset (${start}). The file has ${total} lines.`);
    else output = notice + shown.map((text, index) => `${start + index}\t${text}`).join("\n");
    return {
      ok: true,
      output,
      ...(snapshot
        ? {
            _read_state: createPersistedFileReadState(
              target.absolute,
              "read",
              snapshot,
              (input.offset ?? 1) > 1 || input.limit !== undefined,
            ),
          }
        : {}),
      data: {
        path: target.display, encoding, lineEnding: detectLineEnding(raw) === "\r\n" ? "CRLF" : "LF",
        totalLines: total, startLine: start, endLine, nextOffset,
      },
    };
  },
};
