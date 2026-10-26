/**
 * What the agent has read. Editing or overwriting a file requires a prior
 * read, and the file must not have changed since: otherwise the model would
 * patch content it has never seen.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

export interface FileSnapshot {
  mtimeMs: number;
  size: number;
  sha256: string;
  partial: boolean;
}

export type ReadStateSourceTool = "read" | "write" | "edit";

/** Private journal metadata used to restore the exact freshness snapshot across runs. */
export interface PersistedFileReadState {
  schema: 1;
  /** Absolute, workspace-resolved path. */
  path: string;
  sourceTool: ReadStateSourceTool;
  snapshot: FileSnapshot;
  /** A requested line range is not sufficient context for a later edit. */
  range: boolean;
}

export function createPersistedFileReadState(
  path: string,
  sourceTool: ReadStateSourceTool,
  snapshot: FileSnapshot,
  range: boolean,
): PersistedFileReadState {
  return { schema: 1, path, sourceTool, snapshot: { ...snapshot }, range };
}

export const FILE_NOT_READ_MESSAGE = "File has not been read yet. Read it first before writing to it.";
export const FILE_STALE_MESSAGE = "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.";
/** A line range or token-truncated view is not the whole file; ZCode write.ts refuses partial views with the not-read error. */
export const FILE_PARTIAL_READ_MESSAGE = "File has not been read in full. Only part of it is in context (a line range or a truncated view). Read the whole file before writing to it.";

export class StaleFileError extends Error {
  override name = "StaleFileError";
  readonly code = "stale_file";
}

export class UnreadFileError extends Error {
  override name = "UnreadFileError";
  readonly code = "read_required";
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class FileStateTracker {
  readonly #snapshots = new Map<string, FileSnapshot>();

  record(path: string, info: { mtimeMs: number; size: number }, bytes: Uint8Array, partial = false): void {
    this.#snapshots.set(path, { mtimeMs: info.mtimeMs, size: info.size, sha256: sha256(bytes), partial });
  }

  get(path: string): FileSnapshot | undefined {
    return this.#snapshots.get(path);
  }

  clear(): void {
    this.#snapshots.clear();
  }

  /** Restore a previously captured snapshot without consulting the current file. */
  restore(path: string, snapshot: FileSnapshot): void {
    this.#snapshots.set(path, { ...snapshot });
  }

  forget(path: string): void {
    this.#snapshots.delete(path);
  }

  /** Throw unless `path` was read whole and is unchanged since (content hash decides). */
  async assertFresh(path: string, displayPath = path): Promise<void> {
    const snapshot = this.#snapshots.get(path);
    // Texts from ZCode v3.15.1 (aac4755) handlers/write.ts and edit.ts (WRITE_NOT_READ_MESSAGE, WRITE_STALE_MESSAGE).
    void displayPath;
    if (!snapshot) throw new UnreadFileError(FILE_NOT_READ_MESSAGE);
    // A later range read clears an earlier full read's authorization, matching the read-state restore in plugins/files.
    if (snapshot.partial) throw new UnreadFileError(FILE_PARTIAL_READ_MESSAGE);
    const info = await stat(path);
    if (info.mtimeMs === snapshot.mtimeMs && info.size === snapshot.size) return;
    if (info.size === snapshot.size && sha256(await readFile(path)) === snapshot.sha256) return;
    throw new StaleFileError(FILE_STALE_MESSAGE);
  }
}
