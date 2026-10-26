/**
 * Primary transactional SQLite session store and the JSON → SQLite
 * migration path (C-SES-02).
 *
 * The store keeps one row per session (the complete lossless journal
 * payload) plus an indexed `session_message` projection derived from the
 * canonical message model (C-SES-01). Every write is one `begin immediate`
 * transaction: a session and its message index commit together or not at
 * all, and publication (`onChanged`) happens strictly after the commit —
 * persist first, publish after.
 *
 * `migrateJsonJournals` copies a JSON journal store into this database one
 * session per transaction, recording each completed session in a
 * `json_migration` ledger. An interrupted migration is restarted by simply
 * running it again: sessions whose ledger digest already matches are
 * skipped, everything else is imported. The JSON journals are only read,
 * never rewritten, so falling back to the JSON store is always possible.
 */
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDict, pyDictGet, pyJsonDumps, pyJsonLoads, PyKeyError, PyTypeError, PyValueError, uuid4Hex } from "@xueness/contracts";
import { recordAttachments, withAttachments } from "./attachments.ts";
import { digest } from "./history-ops.ts";
import { canonicalSessionDigest, decodeSessionMessages } from "./message-model.ts";
import { ensureMessageIdentity } from "./identity.ts";
import { realish } from "./realish.ts";
import { SYSTEM_PROMPT } from "./system-prompt.ts";
import { type NewSessionOptions, type Session, SessionStore, type SessionStoreOptions } from "./store.ts";

export const SESSION_STORE_DB_NAME = "session-store.sqlite";
const SESSION_ID = /^[0-9a-f]{32}$/;
const SCHEMA_ID = "0001_sessions_primary";
const SCHEMA_SQL = `
create table session (
  id text primary key,
  root text not null,
  title text,
  task text,
  status text,
  payload text not null,
  history_revision text,
  history_hash text,
  message_count integer not null,
  attachment_count integer not null,
  content_digest text not null,
  updated_at integer not null
);
create index session_root on session(root);
create index session_updated on session(updated_at desc, id desc);
create table session_message (
  session_id text not null references session(id) on delete cascade,
  seq integer not null,
  message_id text not null,
  turn_id text not null,
  role text not null,
  origin text not null,
  visibility text not null,
  revision integer not null,
  digest text not null,
  primary key (session_id, message_id)
);
create index session_message_turn on session_message(turn_id);
create index session_message_seq on session_message(session_id, seq);
create table json_migration (
  session_id text primary key,
  digest text not null,
  message_count integer not null,
  attachment_count integer not null,
  migrated_at integer not null
);
`;
const CHECKSUM = digest(SCHEMA_SQL.trim());

export interface SqliteSessionStoreOptions {
  /** Called after a save transaction has committed (publish-after-persist). */
  onChanged?: (sid: unknown) => void;
  /** Environment override for tests and embedded hosts. */
  env?: Record<string, string | undefined>;
}

export interface MessageIndexRow {
  seq: number; messageId: string; turnId: string; role: string;
  origin: string; visibility: string; revision: number; digest: string;
}

export interface SessionFingerprint {
  messages: number;
  attachments: number;
  digest: string;
}

export function sessionStorePath(directory: string): string {
  return join(directory, SESSION_STORE_DB_NAME);
}

/** Message and file-association counts plus the canonical content digest. */
export function sessionFingerprint(session: Session): SessionFingerprint {
  const decoded = decodeSessionMessages(session);
  let attachments = 0;
  for (const { message } of decoded) {
    attachments += message.parts.filter((part) => part.type === "media_ref").length;
  }
  const recorded = pyDictGet(session, "input_attachments");
  if (Array.isArray(recorded)) {
    for (const turn of recorded) {
      const files = pyDictGet(turn as Record<string, unknown>, "files");
      if (Array.isArray(files)) attachments += files.length;
    }
  }
  return { messages: decoded.length, attachments, digest: canonicalSessionDigest(session) };
}

/** The primary store surface shared by the SQLite and JSON backends. */
export interface PrimarySessionStore {
  "new"(task: string, root: string, options?: NewSessionOptions): Promise<Session>;
  save(session: Session): Promise<void>;
  load(sid: string): Promise<Session>;
  list(): Promise<{ id: unknown; task: unknown; status: unknown }[]>;
}

export class SqliteSessionStore implements PrimarySessionStore {
  readonly directory: string;
  readonly databasePath: string;
  readonly #changed: ((sid: unknown) => void) | undefined;

  constructor(directory: string, options: SqliteSessionStoreOptions = {}) {
    if (lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new PyValueError("session directory is a symbolic link or reparse point");
    }
    this.directory = realish(directory);
    mkdirSync(this.directory, { recursive: true });
    this.databasePath = sessionStorePath(this.directory);
    if (existsSync(this.databasePath) && lstatSync(this.databasePath).isSymbolicLink()) {
      throw new PyValueError("session store database is a symbolic link");
    }
    this.#changed = options.onChanged;
    this.withDatabase(() => undefined);
  }

  /** Open, migrate and use one connection per operation; WAL for concurrent readers. */
  withDatabase<T>(body: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.databasePath, { timeout: 5_000 });
    let transaction = false;
    try {
      db.exec("pragma busy_timeout = 5000");
      db.exec("pragma journal_mode = wal");
      db.exec("pragma foreign_keys = on");
      db.exec("begin immediate");
      transaction = true;
      this.migrate(db);
      const result = body(db);
      db.exec("commit");
      transaction = false;
      return result;
    } catch (error) {
      if (transaction) {
        try { db.exec("rollback"); } catch { /* preserve the original error */ }
      }
      throw error;
    } finally {
      db.close();
    }
  }

  private migrate(db: DatabaseSync): void {
    const before = db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as unknown as { name: string }[];
    db.exec(`create table if not exists schema_migration (id text primary key, checksum text not null)`);
    const applied = db.prepare("select id, checksum from schema_migration order by id").all() as unknown as { id: string; checksum: string }[];
    for (const migration of applied) {
      if (migration.id !== SCHEMA_ID || migration.checksum !== CHECKSUM) {
        throw new Error(`unsupported SQLite session store schema ${migration.id}`);
      }
    }
    if (applied.length === 0) {
      if (before.some((table) => table.name !== "schema_migration")) {
        throw new Error("unsupported unversioned SQLite session store schema");
      }
      db.exec(SCHEMA_SQL);
      db.prepare("insert into schema_migration (id, checksum) values (?, ?)").run(SCHEMA_ID, CHECKSUM);
    }
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

  /** `_save_locked` equivalent: one transaction, then publish after the commit. */
  async save(session: Session): Promise<void> {
    this.write(session);
    this.#changed?.(sessionIdentity(session));
  }

  async load(sid: string): Promise<Session> {
    return this.read(sid);
  }

  /** Read-modify-write inside a single transaction; a failed mutation rolls back. */
  async update(sid: string, mutate: (session: Session) => boolean): Promise<Session> {
    if (typeof mutate !== "function") throw new PyTypeError("session update callback must be callable");
    let published = false;
    const session = this.withDatabase((db) => {
      const loaded = readSessionRow(db, sid);
      const changed: unknown = mutate(loaded);
      if (typeof changed !== "boolean") throw new PyTypeError("session update callback must return a boolean");
      if (changed) writeSessionRow(db, loaded, Date.now());
      published = Boolean(changed);
      return loaded;
    });
    if (published) this.#changed?.(sid);
    return session;
  }

  async delete(sid: string): Promise<void> {
    requireSessionId(sid);
    this.withDatabase((db) => { db.prepare("delete from session where id = ?").run(sid); });
  }

  async list(): Promise<{ id: unknown; task: unknown; status: unknown }[]> {
    const rows = this.withDatabase((db) =>
      db.prepare("select id, task, status from session order by updated_at desc, id desc").all() as unknown as Record<string, unknown>[]);
    return rows.map((row) => ({ id: row.id, task: row.task ?? null, status: row.status ?? null }));
  }

  /** The indexed canonical projection of one session's messages. */
  messageIndex(sid: string): MessageIndexRow[] {
    requireSessionId(sid);
    return this.withDatabase((db) =>
      (db.prepare(
        "select seq, message_id, turn_id, role, origin, visibility, revision, digest from session_message where session_id = ? order by seq",
      ).all(sid) as unknown as Record<string, unknown>[]).map((row) => ({
        seq: Number(row.seq), messageId: String(row.message_id), turnId: String(row.turn_id), role: String(row.role),
        origin: String(row.origin), visibility: String(row.visibility), revision: Number(row.revision), digest: String(row.digest),
      })));
  }

  /** Rows of the migration ledger, for resume and audit. */
  migrationLedger(): { sessionId: string; digest: string }[] {
    return this.withDatabase((db) =>
      (db.prepare("select session_id, digest from json_migration").all() as unknown as Record<string, unknown>[]).map((row) => ({
        sessionId: String(row.session_id), digest: String(row.digest),
      })));
  }

  private write(session: Session, updatedAt = Date.now()): void {
    this.withDatabase((db) => writeSessionRow(db, session, updatedAt));
  }

  private read(sid: string): Session {
    return this.withDatabase((db) => readSessionRow(db, sid));
  }
}

function requireSessionId(sid: string): void {
  if (typeof sid !== "string" || !SESSION_ID.test(sid)) throw new PyValueError("invalid session id");
}

function sessionIdentity(session: Session): string {
  if (!isDict(session) || !Object.hasOwn(session, "id")) throw new PyKeyError("'id'");
  const sid = session.id as unknown;
  if (typeof sid !== "string") throw new PyValueError("invalid session id");
  return sid;
}

/** Insert or replace a session and rebuild its message index in the caller's transaction. */
function writeSessionRow(db: DatabaseSync, session: Session, updatedAt: number): void {
  ensureMessageIdentity(session); // same in-place identity assignment as the JSON store
  const sid = sessionIdentity(session);
  requireSessionId(sid);
  const fingerprint = sessionFingerprint(session); // rejects duplicate identities before any write
  db.prepare(`
    insert into session (id, root, title, task, status, payload, history_revision, history_hash,
      message_count, attachment_count, content_digest, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(id) do update set root=excluded.root, title=excluded.title, task=excluded.task,
      status=excluded.status, payload=excluded.payload, history_revision=excluded.history_revision,
      history_hash=excluded.history_hash, message_count=excluded.message_count,
      attachment_count=excluded.attachment_count, content_digest=excluded.content_digest,
      updated_at=excluded.updated_at
  `).run(
    sid,
    typeof session.root === "string" && session.root.trim() ? realish(session.root) : "",
    typeof session.title === "string" ? session.title : null,
    typeof session.task === "string" ? session.task : null,
    typeof session.status === "string" ? session.status : null,
    pyJsonDumps(session, { indent: 2 }),
    Object.hasOwn(session, "history_revision") && session.history_revision != null ? pyJsonDumps(session.history_revision) : null,
    typeof session.history_hash === "string" ? session.history_hash : null,
    fingerprint.messages, fingerprint.attachments, fingerprint.digest, Math.trunc(updatedAt),
  );
  db.prepare("delete from session_message where session_id = ?").run(sid);
  const insert = db.prepare(
    "insert into session_message (session_id, seq, message_id, turn_id, role, origin, visibility, revision, digest) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  decodeSessionMessages(session).forEach(({ message }, seq) => {
    insert.run(sid, seq, message.messageId, message.turnId, message.role, message.origin, message.visibility, message.revision,
      digest(message));
  });
}

function readSessionRow(db: DatabaseSync, sid: string): Session {
  requireSessionId(sid);
  const row = db.prepare("select payload from session where id = ?").get(sid) as unknown as Record<string, unknown> | undefined;
  if (row === undefined) throw new PyKeyError(sid);
  const session = pyJsonLoads(String(row.payload), { lossless: true });
  if (!isDict(session) || session.id !== sid) throw new PyValueError("session store snapshot is invalid");
  return session as Session;
}

export interface MigrationOptions {
  /** Observes each imported session; throw to simulate a crash mid-migration. */
  onSession?: (sid: string, fingerprint: SessionFingerprint) => void;
}

export interface MigrationReport {
  migrated: number;
  skipped: number;
  sessions: number;
  messages: number;
  attachments: number;
}

/**
 * Import a JSON journal store into the SQLite primary store. Each session
 * commits in its own transaction and is recorded in `json_migration`, so an
 * interrupted run resumes where it stopped. JSON files are never written.
 */
export async function migrateJsonJournals(
  json: SessionStore,
  target: SqliteSessionStore,
  options: MigrationOptions = {},
): Promise<MigrationReport> {
  const report: MigrationReport = { migrated: 0, skipped: 0, sessions: 0, messages: 0, attachments: 0 };
  for (const item of await json.list()) {
    const sid = String(item.id);
    const session = await json.load(sid);
    const fingerprint = sessionFingerprint(session);
    const ledger = target.migrationLedger().find((row) => row.sessionId === sid);
    if (ledger && ledger.digest === fingerprint.digest) {
      report.skipped += 1;
    } else {
      target.withDatabase((db) => {
        writeSessionRow(db, session, Date.now());
        db.prepare("insert into json_migration (session_id, digest, message_count, attachment_count, migrated_at) values (?, ?, ?, ?, ?)")
          .run(sid, fingerprint.digest, fingerprint.messages, fingerprint.attachments, Date.now());
      });
      report.migrated += 1;
      options.onSession?.(sid, fingerprint);
    }
    report.sessions += 1;
    report.messages += fingerprint.messages;
    report.attachments += fingerprint.attachments;
  }
  return report;
}

export interface MigrationVerification {
  sessions: number;
  messages: number;
  attachments: number;
  mismatches: string[];
}

/** Compare every JSON journal with its SQLite row: counts and canonical digests must agree. */
export async function verifyJsonMigration(json: SessionStore, target: SqliteSessionStore): Promise<MigrationVerification> {
  const verification: MigrationVerification = { sessions: 0, messages: 0, attachments: 0, mismatches: [] };
  const rows = target.withDatabase((db) =>
    db.prepare("select id, message_count, attachment_count, content_digest from session").all() as unknown as Record<string, unknown>[]);
  const indexed = new Map(rows.map((row) => [String(row.id), row]));
  for (const item of await json.list()) {
    const sid = String(item.id);
    const fingerprint = sessionFingerprint(json.readJournal(sid));
    const row = indexed.get(sid);
    if (row === undefined) {
      verification.mismatches.push(`${sid}: missing from the SQLite primary store`);
      continue;
    }
    if (Number(row.message_count) !== fingerprint.messages) verification.mismatches.push(`${sid}: message count differs`);
    if (Number(row.attachment_count) !== fingerprint.attachments) verification.mismatches.push(`${sid}: attachment count differs`);
    if (String(row.content_digest) !== fingerprint.digest) verification.mismatches.push(`${sid}: content digest differs`);
    verification.sessions += 1;
    verification.messages += fingerprint.messages;
    verification.attachments += fingerprint.attachments;
  }
  return verification;
}

export type StartupStoreKind = "json" | "sqlite";

/** The startup primary store: SQLite once opted in or already migrated, JSON before that. */
export function openStartupSessionStore(
  directory: string,
  options: SqliteSessionStoreOptions & { kind?: StartupStoreKind; json?: SessionStoreOptions } = {},
): { kind: StartupStoreKind; store: PrimarySessionStore } {
  const env = options.env ?? process.env;
  const existing = existsSync(sessionStorePath(directory));
  const kind = options.kind ?? (env.XUENESS_SESSION_STORE === "sqlite" || existing ? "sqlite" : "json");
  if (kind === "json") return { kind, store: new SessionStore(directory, options.json) };
  return { kind, store: new SqliteSessionStore(directory, options) };
}
