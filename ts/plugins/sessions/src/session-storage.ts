import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pyJsonDumps, pyJsonLoads, PyValueError } from "@xueness/contracts";
import {
  historyPath, isLink, readRegularBytes, realish, SessionStore, SESSIONS_SAVE_HOOK,
  type SaveHook, type Session, type SessionStoreOptions,
} from "@xueness/sessions";
import {
  captureSessionSnapshot, SESSION_LIBRARY_DB_NAME, sessionLibraryPath, SqliteSessionLibrary,
  type SerializedSessionSnapshot,
} from "./sqlite-library.ts";

export interface SessionStorageEnvironment {
  readonly XUENESS_SESSION_SQLITE?: string;
}

export interface SessionsStoreOptions extends SessionStoreOptions {
  /** Effective plugin lookup; omission means the direct caller owns the sessions context. */
  enabled?: (id: string) => boolean;
  /** Environment override for tests and embedded hosts. */
  env?: SessionStorageEnvironment;
}
const storeBindings = new WeakMap<SessionStore, SessionsStoreOptions>();
export function syncSessionLibrary(store: SessionStore, session: Session): void {
  const options = storeBindings.get(store);
  if (options && sqliteSessionStorageEnabled(options)) new SqliteSessionLibrary(store.directory).upsert(captureSessionSnapshot(session), statSync(store.pathFor(String(session.id))).mtimeMs);
}

export function sqliteSessionStorageEnabled(options: Pick<SessionsStoreOptions, "env" | "enabled">): boolean {
  return (options.env ?? process.env).XUENESS_SESSION_SQLITE === "1" && (options.enabled?.("sessions") ?? true);
}

interface SqliteSaveToken {
  directory: string;
  journalPath: string;
  snapshot: SerializedSessionSnapshot;
}

function sqliteSaveHook(options: Pick<SessionsStoreOptions, "env" | "enabled">): SaveHook {
  return {
    prepare(store, session) {
      if (!sqliteSessionStorageEnabled(options)) return null;
      const snapshot = captureSessionSnapshot(session);
      return { directory: store.directory, journalPath: store.pathFor(snapshot.id), snapshot } satisfies SqliteSaveToken;
    },
    commit(token) {
      if (!token || !sqliteSessionStorageEnabled(options)) return;
      const saved = token as SqliteSaveToken;
      const updatedAt = statSync(saved.journalPath).mtimeMs;
      new SqliteSessionLibrary(saved.directory).upsert(saved.snapshot, updatedAt);
    },
  };
}

/** Build the regular JSON journal store with an optional post-publication SQLite mirror. */
export function createSessionsStore(directory: string, options: SessionsStoreOptions = {}): SessionStore {
  const { enabled, env, saveHooks, ...storeOptions } = options;
  const hook = sqliteSaveHook({ enabled, env });
  const store = new SessionStore(directory, {
    ...storeOptions,
    saveHooks: () => {
      const supplied = saveHooks?.() ?? [];
      return [SESSIONS_SAVE_HOOK, ...supplied.filter((item) => item !== SESSIONS_SAVE_HOOK), hook];
    },
  });
  storeBindings.set(store, options); return store;
}

export interface ReindexOptions {
  validate?: (session: Session) => void | Promise<void>;
}

export interface ReindexResult {
  indexed: number;
  skipped: number;
}

/** Copy readable JSON journals into SQLite in one transaction, leaving source files untouched. */
export async function reindexJsonSessions(store: SessionStore, options: ReindexOptions = {}): Promise<ReindexResult> {
  const pending: { snapshot: SerializedSessionSnapshot; updatedAt: number }[] = [];
  let skipped = 0;
  for (const item of await store.list()) {
    try {
      const session = await store.load(String(item.id));
      await options.validate?.(session);
      pending.push({ snapshot: captureSessionSnapshot(session), updatedAt: statSync(store.pathFor(session.id)).mtimeMs });
    } catch {
      skipped += 1;
    }
  }
  new SqliteSessionLibrary(store.directory).upsertMany(pending);
  return { indexed: pending.length, skipped };
}

export interface ExportResult {
  exported: number;
  copiedHistoryLogs: number;
  outputDirectory: string;
}

/** Export full snapshots and matching revision sidecars into an explicit empty directory. */
export function exportSessionLibrary(stateDirectory: string, outputDirectory: string): ExportResult {
  if (!outputDirectory) throw new PyValueError("export output directory is required");
  if (!existsSync(stateDirectory)) throw new PyValueError("source state directory does not exist");
  const sourceInfo = lstatSync(stateDirectory);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) throw new PyValueError("source state directory is invalid");
  const source = new SessionStore(stateDirectory);
  const sourcePath = resolve(source.directory);
  const requestedOutput = resolve(outputDirectory);
  if (existsSync(requestedOutput) && lstatSync(requestedOutput).isSymbolicLink()) throw new PyValueError("export output directory cannot be a symbolic link");
  const outputPath = realish(requestedOutput);
  const within = (parent: string, child: string): boolean => {
    const rel = relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  if (within(sourcePath, outputPath) || within(outputPath, sourcePath)) {
    throw new PyValueError("export output must be separate from the source state directory");
  }
  if (existsSync(outputPath)) {
    const info = lstatSync(outputPath);
    if (info.isSymbolicLink() || !info.isDirectory() || readdirSync(outputPath).length !== 0) {
      throw new PyValueError("export output directory must be empty");
    }
  } else mkdirSync(outputPath, { recursive: true });

  const entries = new SqliteSessionLibrary(source.directory).listReadOnly(undefined, 10_000);
  const output = new SessionStore(outputPath);
  let copiedHistoryLogs = 0;
  for (const entry of entries) {
    output.writeJournal(entry.session);
    const sourceHistory = historyPath(source, entry.id);
    if (existsSync(sourceHistory)) {
      const bytes = readRegularBytes(sourceHistory);
      writeFileSync(join(output.directory, `${entry.id}.history.jsonl`), bytes, { flag: "wx", mode: 0o600 });
      copiedHistoryLogs += 1;
    }
  }
  return { exported: entries.length, copiedHistoryLogs, outputDirectory: output.directory };
}

export type SessionStorageCommand = "import" | "list" | "export";

interface ParsedCommand { state: string; command: SessionStorageCommand; output?: string }

function parseCommand(args: readonly string[]): ParsedCommand {
  let state: string | undefined, output: string | undefined, command: SessionStorageCommand | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--state" || arg === "--out") {
      const value = args[++index];
      if (!value) throw new PyValueError(`${arg} requires a directory`);
      if (arg === "--state") state = value; else output = value;
    } else if (arg.startsWith("--state=")) state = arg.slice("--state=".length);
    else if (arg.startsWith("--out=")) output = arg.slice("--out=".length);
    else if (["import", "list", "export"].includes(arg) && command === undefined) command = arg as SessionStorageCommand;
    else throw new PyValueError(`unexpected session-storage argument: ${arg}`);
  }
  if (!state) throw new PyValueError("--state DIR is required");
  if (!command) throw new PyValueError("expected import, list, or export");
  if (command === "export" && !output) throw new PyValueError("export requires --out NEWDIR");
  if (command !== "export" && output) throw new PyValueError("--out is only valid with export");
  return { state, command, ...(output ? { output } : {}) };
}

/** CLI business logic; the executable in ts/scripts is intentionally a thin wrapper. */
export async function runSessionStorageCommand(args: readonly string[], enabled?: (stateDirectory: string) => boolean): Promise<string> {
  const parsed = parseCommand(args);
  if (enabled && !enabled(parsed.state)) throw new PyValueError('plugin disabled or dependency unavailable: sessions');
  const store = new SessionStore(parsed.state);
  let result: unknown;
  if (parsed.command === "import") result = await reindexJsonSessions(store);
  else if (parsed.command === "list") {
    result = { sessions: new SqliteSessionLibrary(store.directory).list(undefined, 10_000).map(({ id, root, title, task, status, history_revision, history_hash, updated_at }) => ({
      id, root, title, task, status,
      history_revision: history_revision === null ? null : pyJsonLoads(history_revision, { lossless: true }),
      history_hash, updated_at,
    })) };
  } else result = exportSessionLibrary(store.directory, parsed.output!);
  return pyJsonDumps(result, { indent: 2 });
}

export { SESSION_LIBRARY_DB_NAME, sessionLibraryPath };
