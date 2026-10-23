/** Bounded byte and line range readers for NodeWorkspaceFileSystem. */
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { BinaryFileError, decodeText, detectEncoding, looksBinary, type TextEncodingName } from "./text-codec.ts";
import { detectLineEnding, toLf } from "./line-endings.ts";
import { WorkspaceFileTooLargeError } from "./filesystem-errors.ts";
import type { ResolvedPath } from "./paths.ts";

const IO_CHUNK_BYTES = 64 * 1024;

export interface WorkspaceRevision {
  sha256: string;
  size: number;
  mtimeMs: number;
}

export interface WorkspaceBinaryRange extends WorkspaceRevision {
  path: string;
  bytes: Buffer;
  totalBytes: number;
  nextOffset: number | null;
  offset: number;
}

export interface WorkspaceTextRange extends WorkspaceRevision {
  path: string;
  lines: string[];
  encoding: TextEncodingName;
  lineEnding: "LF" | "CRLF";
  totalLines: number;
  startLine: number;
  endLine: number;
  nextOffset: number | null;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("File system operation was cancelled") as Error & { code: string };
  error.name = "AbortError";
  error.code = "cancelled";
  throw error;
}

function revision(info: Stats, sha256: string): WorkspaceRevision {
  return { sha256, size: info.size, mtimeMs: info.mtimeMs };
}

function selectedLine(number: number, start: number, limit: number | undefined): boolean {
  return number >= start && (limit === undefined || number < start + limit);
}

export function validateByteRange(offset: number, limit: number, maxBytes: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("byte range must use non-negative safe integers");
  }
  if (limit > maxBytes) throw new WorkspaceFileTooLargeError(maxBytes);
}

export function validateTextRange(startLine: number, limit: number | undefined, maxBytes: number): void {
  if (!Number.isSafeInteger(startLine) || startLine < 1 || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError("text range must use positive line numbers and non-negative byte limits");
  }
}

export async function readBinaryRangeFromHandle(
  handle: FileHandle,
  info: Stats,
  target: ResolvedPath,
  offset: number,
  limit: number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<WorkspaceBinaryRange> {
  validateByteRange(offset, limit, maxBytes);
  const bytes = await readAt(handle, offset, Math.min(limit, Math.max(0, info.size - offset)), signal);
  const sha256 = await hashHandle(handle, signal);
  const nextOffset = offset + bytes.length < info.size ? offset + bytes.length : null;
  return { path: target.display, bytes, offset, totalBytes: info.size, nextOffset, ...revision(info, sha256) };
}

export async function readTextRangeFromHandle(
  handle: FileHandle,
  info: Stats,
  target: ResolvedPath,
  startLine: number,
  limit: number | undefined,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<WorkspaceTextRange | null> {
  validateTextRange(startLine, limit, maxBytes);
  if (info.size > maxBytes) throw new WorkspaceFileTooLargeError(maxBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const collector = new RangeLineCollector(startLine, limit);
  const hash = createHash("sha256");
  const sample: number[] = [];
  let bytesRead = 0;
  let validUtf8 = true;
  let position = 0;
  for (;;) {
    throwIfAborted(signal);
    const buffer = Buffer.allocUnsafe(IO_CHUNK_BYTES);
    const { bytesRead: count } = await handle.read(buffer, 0, buffer.length, position);
    if (count === 0) break;
    position += count;
    bytesRead += count;
    if (bytesRead > maxBytes) throw new WorkspaceFileTooLargeError(maxBytes);
    const chunk = buffer.subarray(0, count);
    hash.update(chunk);
    for (let index = 0; index < chunk.length && sample.length < 8192; index += 1) sample.push(chunk[index] as number);
    try {
      collector.push(decoder.decode(chunk, { stream: true }));
    } catch {
      validUtf8 = false;
      break;
    }
  }
  if (validUtf8) {
    try {
      collector.push(decoder.decode());
    } catch {
      validUtf8 = false;
    }
  }
  if (!validUtf8) return null;
  if (looksBinary(Uint8Array.from(sample))) throw new BinaryFileError("binary file is not supported as text");
  const scanned = collector.finish();
  const endLine = scanned.lines.length ? startLine + scanned.lines.length - 1 : startLine - 1;
  return {
    path: target.display,
    ...revision(info, hash.digest("hex")),
    lines: scanned.lines,
    encoding: sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf ? "utf-8-bom" : "utf-8",
    lineEnding: scanned.crlf > scanned.lf ? "CRLF" : "LF",
    totalLines: scanned.totalLines,
    startLine,
    endLine,
    nextOffset: endLine < scanned.totalLines ? endLine + 1 : null,
  };
}

export function textFallbackRange(
  bytes: Uint8Array,
  info: Stats,
  target: ResolvedPath,
  startLine: number,
  limit: number | undefined,
): WorkspaceTextRange {
  const encoding = detectEncoding(bytes);
  const raw = decodeText(bytes, encoding).text;
  const all = toLf(raw).split("\n");
  if (all.length > 1 && all[all.length - 1] === "") all.pop();
  const totalLines = raw === "" ? 0 : all.length;
  const lines = totalLines ? all.slice(startLine - 1, limit === undefined ? undefined : startLine - 1 + limit) : [];
  const endLine = lines.length ? startLine + lines.length - 1 : startLine - 1;
  return {
    path: target.display,
    ...revision(info, createHash("sha256").update(bytes).digest("hex")),
    lines,
    encoding,
    lineEnding: detectLineEnding(raw) === "\r\n" ? "CRLF" : "LF",
    totalLines,
    startLine,
    endLine,
    nextOffset: endLine < totalLines ? endLine + 1 : null,
  };
}

interface StreamLines {
  lines: string[];
  totalLines: number;
  crlf: number;
  lf: number;
}

/** Carries a CR split across chunks and drops only the CR belonging to CRLF. */
class RangeLineCollector {
  #line = "";
  #lineNumber = 1;
  #lastCharacter = "";
  #lines: string[] = [];
  #crlf = 0;
  #lf = 0;

  private readonly start: number;
  private readonly limit: number | undefined;

  constructor(start: number, limit: number | undefined) {
    this.start = start;
    this.limit = limit;
  }

  push(text: string): void {
    let segmentStart = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) !== 10) continue;
      const segment = text.slice(segmentStart, index);
      if (selectedLine(this.#lineNumber, this.start, this.limit)) this.#line += segment;
      const previous = index > 0 ? text[index - 1] : this.#lastCharacter;
      if (previous === "\r") {
        this.#crlf += 1;
        if (selectedLine(this.#lineNumber, this.start, this.limit) && this.#line.endsWith("\r")) this.#line = this.#line.slice(0, -1);
      } else this.#lf += 1;
      if (selectedLine(this.#lineNumber, this.start, this.limit)) this.#lines.push(this.#line);
      this.#line = "";
      this.#lineNumber += 1;
      segmentStart = index + 1;
    }
    if (segmentStart < text.length && selectedLine(this.#lineNumber, this.start, this.limit)) this.#line += text.slice(segmentStart);
    if (text.length) this.#lastCharacter = text[text.length - 1] as string;
  }

  finish(): StreamLines {
    if (this.#lastCharacter !== "" && this.#lastCharacter !== "\n" && selectedLine(this.#lineNumber, this.start, this.limit)) this.#lines.push(this.#line);
    const totalLines = this.#lineNumber - 1 + (this.#lastCharacter !== "" && this.#lastCharacter !== "\n" ? 1 : 0);
    return { lines: this.#lines, totalLines, crlf: this.#crlf, lf: this.#lf };
  }
}

async function readAt(handle: FileHandle, offset: number, limit: number, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let position = offset;
  let total = 0;
  while (total < limit) {
    throwIfAborted(signal);
    const buffer = Buffer.allocUnsafe(Math.min(IO_CHUNK_BYTES, limit - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    position += bytesRead;
    total += bytesRead;
  }
  return Buffer.concat(chunks, total);
}

export async function hashHandle(handle: FileHandle, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  let position = 0;
  for (;;) {
    throwIfAborted(signal);
    const buffer = Buffer.allocUnsafe(IO_CHUNK_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) return hash.digest("hex");
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}
