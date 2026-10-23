/** Workspace-scoped Node filesystem adapter used by tools and plugin APIs. */
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { decodeText, detectEncoding, encodeText, type TextEncodingName } from "./text-codec.ts";
import { detectLineEnding } from "./line-endings.ts";
import { writeFileAtomic } from "./atomic-write.ts";
import type { FileSnapshot } from "./file-state.ts";
import { WorkspaceFileTooLargeError, WorkspaceRevisionMismatchError } from "./filesystem-errors.ts";
import { IgnoreMatcher, parseIgnoreFile } from "./ignore.ts";
import { resolveWorkspacePath, type ResolvedPath } from "./paths.ts";
import { hashHandle, readBinaryRangeFromHandle, readTextRangeFromHandle, textFallbackRange, validateByteRange, validateTextRange, type WorkspaceBinaryRange, type WorkspaceRevision, type WorkspaceTextRange } from "./filesystem-ranges.ts";
export type { WorkspaceBinaryRange, WorkspaceRevision, WorkspaceTextRange } from "./filesystem-ranges.ts";

const IO_CHUNK_BYTES = 64 * 1024;

export interface NodeWorkspaceFileSystemOptions {
  cwd: string;
  roots: readonly string[];
}

export interface WorkspaceStat extends ResolvedPath {
  info: Stats | null;
}

export interface WorkspaceTextFile extends WorkspaceRevision {
  path: string;
  content: string;
  encoding: TextEncodingName;
  lineEnding: "LF" | "CRLF";
}

export interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  ignored: boolean;
}

export interface WorkspaceIOOptions {
  signal?: AbortSignal;
}

export interface WorkspaceWriteOptions extends WorkspaceIOOptions {
  encoding?: TextEncodingName;
  /** null means create only; a string requires the current SHA-256 to match. */
  expectedRevision?: string | null;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("File system operation was cancelled") as Error & { code: string };
  error.name = "AbortError";
  error.code = "cancelled";
  throw error;
}

function hashBuffer(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function revision(info: Stats, sha256: string): WorkspaceRevision {
  return { sha256, size: info.size, mtimeMs: info.mtimeMs };
}

export class NodeWorkspaceFileSystem {
  private readonly options: NodeWorkspaceFileSystemOptions;

  constructor(options: NodeWorkspaceFileSystemOptions) {
    this.options = options;
  }

  resolve(path: string): Promise<ResolvedPath> {
    return resolveWorkspacePath(path, this.options.cwd, this.options.roots);
  }

  async stat(path: string, options: WorkspaceIOOptions = {}): Promise<WorkspaceStat> {
    throwIfAborted(options.signal);
    const target = await this.resolve(path);
    let info: Stats | null;
    try {
      info = await stat(target.absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      info = null;
    }
    throwIfAborted(options.signal);
    return { ...target, info };
  }

  async readTextFile(path: string, options: WorkspaceIOOptions = {}): Promise<WorkspaceTextFile> {
    const target = await this.resolve(path);
    const { info, bytes } = await this.readWhole(target.absolute, undefined, options.signal);
    if (!info.isFile()) throw new TypeError(`Cannot read non-file path as text: ${target.absolute}`);
    const encoding = detectEncoding(bytes);
    const content = decodeText(bytes, encoding).text;
    return {
      path: target.display,
      content,
      encoding,
      lineEnding: detectLineEnding(content) === "\r\n" ? "CRLF" : "LF",
      ...revision(info, hashBuffer(bytes)),
    };
  }

  async readBinaryFile(path: string, maxBytes: number, options: WorkspaceIOOptions = {}): Promise<{ path: string; bytes: Buffer } & WorkspaceRevision> {
    const target = await this.resolve(path);
    const { info, bytes } = await this.readWhole(target.absolute, maxBytes, options.signal);
    if (!info.isFile()) throw new TypeError(`Cannot read non-file path as binary: ${target.absolute}`);
    return { path: target.display, bytes, ...revision(info, hashBuffer(bytes)) };
  }

  async readBinaryRange(
    path: string,
    offset: number,
    limit: number,
    maxBytes: number,
    options: WorkspaceIOOptions = {},
  ): Promise<WorkspaceBinaryRange> {
    validateByteRange(offset, limit, maxBytes);
    const target = await this.resolve(path);
    throwIfAborted(options.signal);
    const handle = await open(target.absolute, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new TypeError(`Cannot read non-file path as binary: ${target.absolute}`);
      return await readBinaryRangeFromHandle(handle, info, target, offset, limit, maxBytes, options.signal);
    } finally {
      await handle.close();
    }
  }

  async readTextRange(
    path: string,
    startLine: number,
    limit: number | undefined,
    maxBytes: number,
    options: WorkspaceIOOptions = {},
  ): Promise<WorkspaceTextRange> {
    validateTextRange(startLine, limit, maxBytes);
    const target = await this.resolve(path);
    throwIfAborted(options.signal);
    const handle = await open(target.absolute, "r");
    let info: Stats;
    try {
      info = await handle.stat();
      if (!info.isFile()) throw new TypeError(`Cannot read non-file path as text: ${target.absolute}`);
      if (info.size > maxBytes) throw new WorkspaceFileTooLargeError(maxBytes);
      const result = await readTextRangeFromHandle(handle, info, target, startLine, limit, maxBytes, options.signal);
      if (result) return result;
    } finally {
      await handle.close();
    }
    // UTF-16 and GBK/GB18030 stay on the established codec path, bounded by the caller's cap.
    const { info: fallbackInfo, bytes } = await this.readWhole(target.absolute, maxBytes, options.signal);
    return textFallbackRange(bytes, fallbackInfo, target, startLine, limit);
  }

  async writeTextFile(path: string, content: string, options: WorkspaceWriteOptions = {}): Promise<{ path: string; bytesWritten: number } & WorkspaceRevision> {
    const target = await this.resolve(path);
    throwIfAborted(options.signal);
    const bytes = encodeText(content, options.encoding ?? "utf-8");
    const atomicOptions = {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.expectedRevision === null ? { createOnly: true } : {}),
      ...(typeof options.expectedRevision === "string"
        ? { beforeRename: () => this.assertRevision(target.absolute, options.expectedRevision as string, options.signal) }
        : {}),
    };
    try {
      await writeFileAtomic(target.absolute, bytes, atomicOptions);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST" && options.expectedRevision === null) throw new WorkspaceRevisionMismatchError();
      throw error;
    }
    const info = await stat(target.absolute);
    return { path: target.display, bytesWritten: bytes.length, ...revision(info, hashBuffer(bytes)) };
  }

  async removeFile(path: string, expectedRevision?: string | null, options: WorkspaceIOOptions = {}): Promise<boolean> {
    const target = await this.resolve(path);
    throwIfAborted(options.signal);
    if (expectedRevision !== undefined) await this.assertRevision(target.absolute, expectedRevision, options.signal);
    try {
      await unlink(target.absolute);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async createDirectory(path: string, options: WorkspaceIOOptions = {}): Promise<string> {
    const target = await this.resolve(path);
    throwIfAborted(options.signal);
    await mkdir(target.absolute, { recursive: true });
    throwIfAborted(options.signal);
    return target.display;
  }

  async listDirectory(path: string, options: WorkspaceIOOptions = {}): Promise<WorkspaceDirectoryEntry[]> {
    const target = await this.resolve(path);
    throwIfAborted(options.signal);
    const info = await stat(target.absolute);
    if (!info.isDirectory()) throw new TypeError(`Directory listing path must be a directory: ${target.absolute}`);
    const entries = await readdir(target.absolute, { withFileTypes: true });
    const matcher = await directoryIgnoreMatcher(target.absolute);
    throwIfAborted(options.signal);
    return entries.map((entry) => ({
      name: entry.name,
      path: join(target.absolute, entry.name),
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
      ignored: matcher.ignoresEntry(entry.name, entry.isDirectory()),
    }));
  }

  private async readWhole(path: string, maxBytes: number | undefined, signal?: AbortSignal): Promise<{ info: Stats; bytes: Buffer }> {
    throwIfAborted(signal);
    const handle = await open(path, "r");
    try {
      const info = await handle.stat();
      if (maxBytes !== undefined && info.size > maxBytes) throw new WorkspaceFileTooLargeError(maxBytes);
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        throwIfAborted(signal);
        const buffer = Buffer.allocUnsafe(IO_CHUNK_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (maxBytes !== undefined && total > maxBytes) throw new WorkspaceFileTooLargeError(maxBytes);
        chunks.push(buffer.subarray(0, bytesRead));
      }
      return { info, bytes: Buffer.concat(chunks, total) };
    } finally {
      await handle.close();
    }
  }

  private async assertRevision(path: string, expectedRevision: string | null, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    let info: Stats;
    try {
      info = await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && expectedRevision === null) return;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WorkspaceRevisionMismatchError();
      throw error;
    }
    if (expectedRevision === null || !info.isFile() || await hashPath(path, signal) !== expectedRevision) throw new WorkspaceRevisionMismatchError();
  }
}

async function hashPath(path: string, signal?: AbortSignal): Promise<string> {
  const handle = await open(path, "r");
  try {
    return await hashHandle(handle, signal);
  } finally {
    await handle.close();
  }
}

async function directoryIgnoreMatcher(path: string): Promise<IgnoreMatcher> {
  const rules = [];
  for (const name of [".gitignore", ".ignore"]) {
    try {
      rules.push(...parseIgnoreFile(await readFile(join(path, name), "utf8")));
    } catch {
      // Missing or unreadable ignore files do not change directory visibility.
    }
  }
  try {
    const gitDir = join(path, ".git");
    if ((await stat(gitDir)).isDirectory()) rules.push(...parseIgnoreFile(await readFile(join(gitDir, "info", "exclude"), "utf8")));
  } catch {
    // A missing Git exclude file is normal.
  }
  return new IgnoreMatcher().with("", rules);
}

export function snapshotFromRevision(value: WorkspaceRevision, partial = false): FileSnapshot {
  return { mtimeMs: value.mtimeMs, size: value.size, sha256: value.sha256, partial };
}
