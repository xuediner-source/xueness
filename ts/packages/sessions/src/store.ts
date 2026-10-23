/**
 * Durable session journals (`core.Store`).
 *
 * `<directory>/<sid>.json` is UTF-8 JSON (`indent=2`, `ensure_ascii=False`),
 * published through a private temp file, a hard-link backup of the previous
 * inode (`.json.bak`), an atomic rename and a directory fsync. A torn live
 * file is restored from the backup on read. Saves run the plugin
 * prepare/commit hooks (work segments and the revision log by default) and
 * then signal in-process readers.
 *
 * Journals are decoded losslessly and re-encoded with Python's encoder, so a
 * journal round-trips byte for byte between the two backends.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, normalize } from "node:path";
import {
  isDict, pyDecodeUtf8, pyEncodeUtf8, pyGet, PyJsonDecodeError, pyJsonDumps, pyJsonLoads, PyKeyError, PyTypeError,
  PyUnicodeDecodeError, PyValueError, uuid4Hex,
} from "@xueness/contracts";
import { recordAttachments, withAttachments, type Attachment } from "./attachments.ts";
import { annotateStoreFailure, isPyKeyError, isPyOSError, isPyValueError, storeStage, type StoreStage } from "./errors.ts";
import { commit as commitHistory, prepare as prepareHistory, type HistoryHost } from "./history.ts";
import { ensureMessageIdentity } from "./identity.ts";
import {
  cleanupStaleSessionTemps, fsyncDirectory, isFile, isLink, mkstemp, protectPrivateFile, readRegularBytes, replaceFile,
  rotateJournalBackup, writeAll,
} from "./journal-fs.ts";
import { foldHostPath, KeyedMutex, LOCK_TIMEOUT_SECONDS, type FileLockHandle, type FileLockProvider } from "./locks.ts";
import { NativeFileLocks } from "./native-locks.ts";
import { realish } from "./realish.ts";
import { SYSTEM_PROMPT } from "./system-prompt.ts";
import { checkpointWork } from "./work-activity.ts";

export type Session = Record<string, unknown>;

/** A plugin's `prepare_session_save` / `commit_session_save` pair. */
export interface SaveHook {
  prepare(store: SessionStore, session: Session): unknown;
  commit(token: unknown): void;
}

/** The sessions plugin's hooks: close observed work segments, stage the revision log. */
export const SESSIONS_SAVE_HOOK: SaveHook = {
  prepare(store, session) {
    checkpointWork(session);
    return prepareHistory(store, session);
  },
  commit(token) {
    commitHistory(token as Parameters<typeof commitHistory>[0]);
  },
};

export interface SessionStoreOptions {
  /** Cross-process file locks; defaults to native flock / LockFileEx. */
  locks?: FileLockProvider;
  /** Effective plugins' save hooks, read at every save (default: the sessions plugin). */
  saveHooks?: () => readonly SaveHook[];
  /** Called after each publication (`session_signals.changed`). */
  onChanged?: (sid: unknown) => void;
}

const SESSION_ID = /^[0-9a-f]{32}$/;
const THREAD_LOCKS = new KeyedMutex();
const DEFAULT_LOCKS = new NativeFileLocks();

export interface NewSessionOptions {
  attachments?: readonly Attachment[];
  sessionId?: string | null;
}

export class SessionStore implements HistoryHost {
  readonly directory: string;
  readonly #locks: FileLockProvider;
  readonly #hooks: () => readonly SaveHook[];
  readonly #changed: ((sid: unknown) => void) | undefined;

  constructor(directory: string, options: SessionStoreOptions = {}) {
    if (isLink(directory)) throw new PyValueError("session directory is a symbolic link or reparse point");
    this.directory = realish(directory);
    mkdirSync(this.directory, { recursive: true });
    this.#locks = options.locks ?? DEFAULT_LOCKS;
    this.#hooks = options.saveHooks ?? (() => [SESSIONS_SAVE_HOOK]);
    this.#changed = options.onChanged;
  }

  /** `_path`: validate the id and refuse linked directories or journals. */
  pathFor(sid: unknown): string {
    if (typeof sid !== "string") throw new PyTypeError("expected string or bytes-like object, got '" + typeof sid + "'");
    if (!SESSION_ID.test(sid)) throw new PyValueError("invalid session id");
    if (isLink(this.directory)) throw new PyValueError("session directory is a symbolic link or reparse point");
    const path = join(this.directory, sid + ".json");
    if (isLink(path)) throw new PyValueError("session file is a symbolic link or reparse point");
    return path;
  }

  get lockDirectory(): string {
    return join(this.directory, ".locks");
  }

  /**
   * Hold the per-journal process lock and the cross-process journal lock
   * (`_thread_lock(sid)` + `journal_lock`) around `body`.
   */
  async withJournalLock<T>(sid: string, body: () => T | Promise<T>): Promise<T> {
    this.pathFor(sid);
    const release = await THREAD_LOCKS.acquire(foldHostPath(normalize(join(this.directory, sid))));
    try {
      const lock = await this.#locks.acquire(this.lockDirectory, sid + ".journal.lock", LOCK_TIMEOUT_SECONDS);
      try {
        return await body();
      } finally {
        await lock.release();
      }
    } finally {
      release();
    }
  }

  /** `session_lease.lease`: the nonblocking run lease (`BlockingIOError` when held). */
  async lease(sid: string): Promise<FileLockHandle> {
    this.pathFor(sid);
    return this.#locks.tryAcquire(this.lockDirectory, sid + ".lock");
  }

  /** `session_lease.exclusive_lock` on another named lock in `.locks`. */
  async exclusiveLock(name: string, timeoutSeconds = LOCK_TIMEOUT_SECONDS): Promise<FileLockHandle> {
    return this.#locks.acquire(this.lockDirectory, name, timeoutSeconds);
  }

  async new(task: string, root: string, options: NewSessionOptions = {}): Promise<Session> {
    const { sessionId = null, attachments = [] } = options;
    if (sessionId !== null && (typeof sessionId !== "string" || !SESSION_ID.test(sessionId))) {
      throw new PyValueError("invalid server session identity");
    }
    const session: Session = {
      id: sessionId || uuid4Hex(), task, root: realish(root), status: "pending",
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: withAttachments(task, attachments) }],
      results: {}, compactions: [], archived_messages: [], steps: 0, completion: null, todos: [], pending_question: null,
    };
    recordAttachments(session, attachments);
    await this.save(session);
    return session;
  }

  async save(session: Session): Promise<void> {
    let stage: StoreStage = "session_path";
    try {
      const sid = this.#sessionId(session);
      this.pathFor(sid);
      stage = "lock";
      await this.withJournalLock(sid, () => this.saveLocked(session));
    } catch (error) {
      if (storeStage(error) === null) annotateStoreFailure(error, stage);
      throw error;
    }
  }

  /**
   * Atomically mutate the latest journal under its locks. `mutate` returns
   * whether it changed the session; `false` skips publication.
   */
  async update(sid: string, mutate: (session: Session) => boolean): Promise<Session> {
    if (typeof mutate !== "function") throw new PyTypeError("session update callback must be callable");
    let stage: StoreStage = "session_path";
    try {
      this.pathFor(sid);
      stage = "lock";
      return await this.withJournalLock(sid, () => {
        stage = "read";
        const session = this.readJournal(sid);
        stage = "mutate";
        const changed: unknown = mutate(session);
        if (typeof changed !== "boolean") throw new PyTypeError("session update callback must return a boolean");
        if (changed) {
          stage = "save";
          this.saveLocked(session);
        }
        return session;
      });
    } catch (error) {
      if (storeStage(error) === null) annotateStoreFailure(error, stage);
      throw error;
    }
  }

  async load(sid: string): Promise<Session> {
    this.pathFor(sid);
    return this.withJournalLock(sid, () => this.readJournal(sid));
  }

  /** `_save_locked`: identities, plugin prepare hooks, publish, commit hooks, signal. */
  saveLocked(session: Session): void {
    ensureMessageIdentity(session);
    const tokens: [SaveHook, unknown][] = [];
    for (const hook of this.#hooks()) tokens.push([hook, hook.prepare(this, session)]);
    this.writeJournal(session);
    for (const [hook, token] of tokens) hook.commit(token);
    this.#changed?.(pyGet(session, "id"));
  }

  /** `_write_journal`: publish `session`. The caller holds the journal lock. */
  writeJournal(session: Session, options: { preserveBackup?: boolean } = {}): void {
    let stage: StoreStage = "session_path";
    let temp: string | null = null;
    let fd: number | null = null;
    try {
      const path = this.pathFor(this.#sessionId(session));
      cleanupStaleSessionTemps(this.directory);
      stage = "temp_create";
      ({ fd, path: temp } = mkstemp(this.directory, ".session-"));
      stage = "protect_temp";
      protectPrivateFile(fd);
      stage = "serialize";
      const encoded = pyEncodeUtf8(pyJsonDumps(session, { indent: 2 }));
      writeAll(fd, encoded);
      stage = "flush";
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      if (!options.preserveBackup && isFile(path) && !isLink(path)) rotateJournalBackup(path);
      stage = "replace";
      replaceFile(temp, path);
      temp = null;
      fsyncDirectory(this.directory);
    } catch (error) {
      annotateStoreFailure(error, stage);
      throw error;
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // Already closed or invalid; the temp file is removed below.
        }
      }
      if (temp !== null) removeQuietly(temp);
    }
  }

  /** `_read_journal`: the journal, restored from the backup when the live file is torn. */
  readJournal(sid: string): Session {
    const path = this.pathFor(sid);
    const raw = readRegularBytes(path);
    try {
      return pyJsonLoads(pyDecodeUtf8(raw), { lossless: true }) as Session;
    } catch (error) {
      if (!(error instanceof PyJsonDecodeError || error instanceof PyUnicodeDecodeError)) throw error;
      const recovered = backupSession(path, sid);
      if (recovered === null) throw error;
      try {
        this.writeJournal(recovered, { preserveBackup: true });
      } catch {
        // The recovered copy is still returned; the next save rewrites it.
      }
      return recovered;
    }
  }

  /** `list`: `{id, task, status}` for every readable journal, sorted by id. */
  async list(): Promise<{ id: unknown; task: unknown; status: unknown }[]> {
    if (isLink(this.directory)) return [];
    let names: string[];
    try {
      names = readdirSync(this.directory).filter((name) => /^[0-9a-f]{32}\.json$/.test(name)).sort();
    } catch {
      return [];
    }
    const result: { id: unknown; task: unknown; status: unknown }[] = [];
    for (const name of names) {
      const path = join(this.directory, name);
      if (isLink(path) || !isFile(path)) continue;
      const sid = name.slice(0, -5);
      try {
        const session = await this.load(sid);
        if (!isDict(session) || pyGet(session, "id") !== sid) continue;
        for (const key of ["task", "status"]) if (!Object.hasOwn(session, key)) throw new PyKeyError(`'${key}'`);
        result.push({ id: session.id, task: session.task, status: session.status });
      } catch (error) {
        if (isPyOSError(error) || isPyValueError(error) || isPyKeyError(error)) continue;
        throw error;
      }
    }
    return result;
  }

  #sessionId(session: Session): string {
    if (!isDict(session) || !Object.hasOwn(session, "id")) throw new PyKeyError("'id'");
    return session.id as string;
  }
}

function removeQuietly(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Python ignores a failed cleanup of the private temp file.
  }
}

/** `_backup_session`: the previous complete journal, or null when it cannot be trusted. */
export function backupSession(path: string, sid: string): Session | null {
  const backup = path + ".bak";
  if (isLink(backup)) return null;
  let session: unknown;
  try {
    if (!isFile(backup)) return null;
    session = pyJsonLoads(pyDecodeUtf8(readRegularBytes(backup)), { lossless: true });
  } catch (error) {
    if (isPyOSError(error) || isPyValueError(error)) return null;
    throw error;
  }
  if (!isDict(session) || pyGet(session, "id") !== sid) return null;
  return session;
}
