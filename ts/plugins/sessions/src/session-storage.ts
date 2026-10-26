import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isDict, pyJsonDumps, pyJsonLoads, PyValueError } from "@xueness/contracts";
import {
  foldHostPath, historyPath, isLink, readRegularBytes, realish, scan, SessionStore, SESSIONS_SAVE_HOOK,
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

export type SessionStorageCommand = "import" | "list" | "export" | "repair";

/** A workspace relocation offered to the repair pass: sessions under `from` move to `to`. */
export interface RootRelocation {
  from: string;
  to: string;
}

export interface SessionRepairReport {
  id: string;
  root: string | null;
  status: "ok" | "repaired" | "unrepairable";
  repairs: string[];
  reason?: string;
}

export interface RepairSessionsOptions {
  relocations?: readonly RootRelocation[];
  dryRun?: boolean;
}

export interface RepairSessionsResult {
  repaired: number;
  ok: number;
  unrepairable: number;
  dryRun: boolean;
  reports: SessionRepairReport[];
}

const LEGACY_DEFAULTS: ReadonlyArray<[string, unknown]> = [
  ["results", {}], ["compactions", []], ["archived_messages", []],
  ["steps", 0], ["completion", null], ["todos", []], ["pending_question", null],
];

/** Fill the current journal schema defaults; return the repair name or null when the shape is unsupported. */
function repairLegacySchema(session: Session): string | null {
  if (!Array.isArray(session.messages)) return null;
  const applied: string[] = [];
  if (typeof session.task !== "string") { session.task = ""; applied.push("task"); }
  if (typeof session.status !== "string") { session.status = "pending"; applied.push("status"); }
  for (const [key, value] of LEGACY_DEFAULTS) if (!Object.hasOwn(session, key)) { session[key] = value; applied.push(key); }
  if (applied.length === 0) return "";
  return "schema_defaults:" + applied.sort().join(",");
}

/** Map a recorded root onto a relocated workspace that exists on this machine. */
function relocatedRoot(root: string, relocations: readonly RootRelocation[]): string | null {
  for (const { from, to } of relocations) {
    const source = realish(from), target = realish(to), current = realish(root);
    const suffix = relative(foldHostPath(source), foldHostPath(current));
    if (suffix === ".." || suffix.startsWith("..\\") || suffix.startsWith("../") || isAbsolute(suffix)) continue;
    const candidate = join(target, relative(source, current));
    if (existsSync(candidate) && lstatSync(candidate).isDirectory()) return candidate;
  }
  return null;
}

/** Resync `history_revision`/`history_hash` with the durable chain; the next save appends a reset record. */
function repairHistoryCursor(store: SessionStore, sid: string, session: Session): string | null {
  const records = scan(historyPath(store, sid)).records;
  const last = records.length ? records[records.length - 1]! : null;
  if (last === null) {
    if (session.history_revision === undefined && session.history_hash === undefined) return null;
    delete session.history_revision; delete session.history_hash;
    return "history_cursor_reset";
  }
  if (session.history_revision === last.seq && session.history_hash === last.stateHash) return null;
  session.history_revision = last.seq;
  session.history_hash = last.stateHash;
  return "history_cursor_resync";
}

/**
 * Repair entry point for workspace and history migrations: relocated roots,
 * missing workspaces, legacy journal schema and stale history cursors.
 *
 * Journals are only rewritten through `store.save`, so every repair appends a
 * regular revision and the hash chain continues; nothing else in the state
 * directory (queue, media, credentials) is read or written here.
 */
export async function repairSessions(store: SessionStore, options: RepairSessionsOptions = {}): Promise<RepairSessionsResult> {
  const relocations = options.relocations ?? [];
  const reports: SessionRepairReport[] = [];
  let repaired = 0, ok = 0, unrepairable = 0;
  const names = existsSync(store.directory)
    ? readdirSync(store.directory).filter((name) => /^[0-9a-f]{32}\.json$/.test(name)).sort()
    : [];
  for (const name of names) {
    const sid = name.slice(0, -5);
    let session: Session;
    try {
      session = await store.load(sid);
      if (!isDict(session) || session.id !== sid) throw new PyValueError("journal identity does not match its file name");
    } catch (error) {
      unrepairable += 1;
      reports.push({ id: sid, root: null, status: "unrepairable", repairs: [], reason: `unreadable_journal: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    const repairs: string[] = [];
    let reason: string | undefined;
    const schema = repairLegacySchema(session);
    if (schema === null) reason = `unsupported_journal_shape: messages must be a list (got ${typeof session.messages})`;
    else if (schema !== "") repairs.push(schema);
    const root = typeof session.root === "string" && session.root.trim() ? session.root : null;
    if (reason === undefined && root === null) {
      reason = "missing_workspace_root: the journal records no workspace path";
    } else if (reason === undefined && !existsSync(root!)) {
      const moved = relocatedRoot(root!, relocations);
      if (moved === null) reason = `missing_workspace: ${root} does not exist on this machine`;
      else { session.root = moved; repairs.push("relocated_root"); }
    }
    if (reason === undefined) {
      try {
        const cursor = repairHistoryCursor(store, sid, session);
        if (cursor !== null) repairs.push(cursor);
      } catch {
        reason = `history_chain_invalid: ${historyPath(store, sid)} cannot be replayed`;
      }
    }
    if (reason !== undefined) {
      unrepairable += 1;
      reports.push({ id: sid, root, status: "unrepairable", repairs: [], reason });
      continue;
    }
    if (repairs.length === 0) { ok += 1; reports.push({ id: sid, root: root!, status: "ok", repairs: [] }); continue; }
    if (!options.dryRun) {
      try {
        await store.save(session);
      } catch (error) {
        unrepairable += 1;
        reports.push({ id: sid, root, status: "unrepairable", repairs: [], reason: `repair_publication_failed: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
    }
    repaired += 1;
    reports.push({ id: sid, root: (session.root as string) ?? root, status: "repaired", repairs });
  }
  return { repaired, ok, unrepairable, dryRun: options.dryRun === true, reports };
}


interface ParsedCommand {
  state: string;
  command: SessionStorageCommand;
  output?: string;
  relocations?: RootRelocation[];
  dryRun?: boolean;
}

function parseCommand(args: readonly string[]): ParsedCommand {
  let state: string | undefined, output: string | undefined, command: SessionStorageCommand | undefined;
  let dryRun = false;
  const relocations: RootRelocation[] = [];
  const relocation = (value: string): void => {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) throw new PyValueError("--relocate expects FROM=TO directories");
    relocations.push({ from: value.slice(0, separator), to: value.slice(separator + 1) });
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--state" || arg === "--out" || arg === "--relocate") {
      const value = args[++index];
      if (!value) throw new PyValueError(`${arg} requires a value`);
      if (arg === "--state") state = value;
      else if (arg === "--out") output = value;
      else relocation(value);
    } else if (arg.startsWith("--state=")) state = arg.slice("--state=".length);
    else if (arg.startsWith("--out=")) output = arg.slice("--out=".length);
    else if (arg.startsWith("--relocate=")) relocation(arg.slice("--relocate=".length));
    else if (arg === "--dry-run") dryRun = true;
    else if (["import", "list", "export", "repair"].includes(arg) && command === undefined) command = arg as SessionStorageCommand;
    else throw new PyValueError(`unexpected session-storage argument: ${arg}`);
  }
  if (!state) throw new PyValueError("--state DIR is required");
  if (!command) throw new PyValueError("expected import, list, export, or repair");
  if (command === "export" && !output) throw new PyValueError("export requires --out NEWDIR");
  if (command !== "export" && output) throw new PyValueError("--out is only valid with export");
  if (command !== "repair" && (dryRun || relocations.length)) throw new PyValueError("--dry-run and --relocate are only valid with repair");
  return { state, command, ...(output ? { output } : {}), ...(relocations.length ? { relocations } : {}), ...(dryRun ? { dryRun: true } : {}) };
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
  } else result = parsed.command === "repair"
    ? await repairSessions(store, { relocations: parsed.relocations, dryRun: parsed.dryRun })
    : exportSessionLibrary(store.directory, parsed.output!);
  return pyJsonDumps(result, { indent: 2 });
}

export { SESSION_LIBRARY_DB_NAME, sessionLibraryPath };
