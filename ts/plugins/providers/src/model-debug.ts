import { closeSync, fsyncSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  fsyncDirectory, isLink, mkstemp, protectPrivateDirectory, protectPrivateFile, replaceFile, writeAll,
} from "@xueness/sessions";
import { modelDebugRecord, type Row } from "./model-diagnostics.ts";

const SCHEMA = "xueness.model-debug.v1";
const MANAGED_FILE = /^[a-zA-Z0-9_-]{1,128}-[a-zA-Z0-9_-]{1,128}\.json$/;

export interface ModelDebugStoreOptions {
  enabled?: boolean;
  maxRecords?: number;
}

/** Opt-in, content-free per-attempt diagnostics in the private state directory. */
export class ModelDebugStore {
  readonly #directory: string;
  readonly #enabled: boolean;
  readonly #maxRecords: number;
  #writeFailures = 0;

  constructor(stateDir: string, options: ModelDebugStoreOptions = {}) {
    this.#directory = join(resolve(stateDir), "model-debug");
    this.#enabled = options.enabled ?? (process.env.XUENESS_MODEL_DEBUG === "1");
    this.#maxRecords = Number.isSafeInteger(options.maxRecords) && (options.maxRecords as number) > 0
      ? options.maxRecords as number
      : 100;
  }

  write(record: Row): void {
    if (!this.#enabled) return;
    let tempPath: string | undefined;
    let tempFd: number | undefined;
    try {
      if (record.schema !== SCHEMA || typeof record.sessionId !== "string") throw new Error("invalid model debug record");
      const projected = modelDebugRecord(record.sessionId, record, asRow(record.request));
      const requestId = projected.requestId;
      const attemptId = projected.attemptId;
      if (typeof requestId !== "string" || typeof attemptId !== "string") throw new Error("missing model debug identity");

      this.#ensureDirectory();
      const destination = join(this.#directory, `${requestId}-${attemptId}.json`);
      if (isLink(destination)) throw new Error("model debug record path is a link");
      const temp = mkstemp(this.#directory, ".model-debug-");
      tempFd = temp.fd;
      tempPath = temp.path;
      protectPrivateFile(temp.fd);
      writeAll(temp.fd, Buffer.from(JSON.stringify(projected), "utf8"));
      fsyncSync(temp.fd);
      closeSync(temp.fd);
      tempFd = undefined;
      replaceFile(temp.path, destination);
      tempPath = undefined;
      fsyncDirectory(this.#directory);
      this.#rotate();
    } catch {
      this.#writeFailures += 1;
    } finally {
      if (tempFd !== undefined) {
        try { closeSync(tempFd); } catch { /* best-effort cleanup */ }
      }
      if (tempPath !== undefined) {
        try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
      }
    }
  }

  snapshot(): { enabled: boolean; records: number; writeFailures: number } {
    return { enabled: this.#enabled, records: this.#managedFiles().length, writeFailures: this.#writeFailures };
  }

  #ensureDirectory(): void {
    if (isLink(this.#directory)) throw new Error("model debug directory is a link");
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    if (isLink(this.#directory)) throw new Error("model debug directory is a link");
    protectPrivateDirectory(this.#directory);
  }

  #managedFiles(): Array<{ name: string; mtimeMs: number }> {
    if (isLink(this.#directory)) return [];
    let names: string[];
    try { names = readdirSync(this.#directory); } catch { return []; }
    const files: Array<{ name: string; mtimeMs: number }> = [];
    for (const name of names) {
      if (!MANAGED_FILE.test(name)) continue;
      try {
        const info = lstatSync(join(this.#directory, name));
        if (info.isFile() && !info.isSymbolicLink()) files.push({ name, mtimeMs: info.mtimeMs });
      } catch { /* Ignore entries that disappeared or cannot be inspected. */ }
    }
    return files;
  }

  #rotate(): void {
    const oldestFirst = this.#managedFiles().sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
    for (const entry of oldestFirst.slice(0, Math.max(0, oldestFirst.length - this.#maxRecords))) {
      const path = join(this.#directory, entry.name);
      const info = lstatSync(path);
      if (info.isFile() && !info.isSymbolicLink()) unlinkSync(path);
    }
  }
}

function asRow(value: unknown): Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : {};
}
