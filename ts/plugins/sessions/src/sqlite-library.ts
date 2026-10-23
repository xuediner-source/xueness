import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDict, pyJsonDumps, pyJsonLoads, PyValueError } from "@xueness/contracts";
import { realish, type Session } from "@xueness/sessions";

export const SESSION_LIBRARY_DB_NAME = "session-library.sqlite";
const SCHEMA_ID = "0001_session_snapshot";
const CREATE_SNAPSHOT = `
create table session_snapshot (
  id text primary key,
  root text not null,
  title text,
  task text,
  status text,
  payload text not null,
  history_revision text,
  history_hash text,
  updated_at integer not null
)
`;
const SCHEMA_CHECKSUM = createHash("sha256").update(CREATE_SNAPSHOT.trim()).digest("hex");
const EXPECTED_COLUMNS = ["id", "root", "title", "task", "status", "payload", "history_revision", "history_hash", "updated_at"];
const SESSION_ID = /^[0-9a-f]{32}$/;

export interface SerializedSessionSnapshot {
  id: string;
  root: string;
  title: string | null;
  task: string | null;
  status: string | null;
  payload: string;
  history_revision: string | null;
  history_hash: string | null;
}

export interface SessionLibraryEntry extends SerializedSessionSnapshot {
  updated_at: number;
  session: Session;
}

export function sessionLibraryPath(directory: string): string {
  return join(directory, SESSION_LIBRARY_DB_NAME);
}

/** Capture the complete journal with the lossless Python-compatible codec. */
export function captureSessionSnapshot(session: Session): SerializedSessionSnapshot {
  if (!isDict(session) || typeof session.id !== "string" || !SESSION_ID.test(session.id)) {
    throw new PyValueError("invalid session snapshot identity");
  }
  const root = typeof session.root === "string" && session.root.trim() ? realish(session.root) : "";
  return {
    id: session.id,
    root,
    title: typeof session.title === "string" ? session.title : null,
    task: typeof session.task === "string" ? session.task : null,
    status: typeof session.status === "string" ? session.status : null,
    payload: pyJsonDumps(session, { indent: 2 }),
    history_revision: Object.hasOwn(session, "history_revision") && session.history_revision != null
      ? pyJsonDumps(session.history_revision)
      : null,
    history_hash: typeof session.history_hash === "string" ? session.history_hash : null,
  };
}

/** A connection is opened, initialized, used and closed for each operation. */
export class SqliteSessionLibrary {
  readonly directory: string;
  readonly databasePath: string;

  constructor(directory: string) {
    this.directory = realish(directory);
    this.databasePath = sessionLibraryPath(this.directory);
  }

  count(root?: string): number {
    return this.withDatabase((db) => {
      const row = root === undefined
        ? db.prepare("select count(*) as count from session_snapshot").get()
        : db.prepare("select count(*) as count from session_snapshot where root = ?").get(realish(root));
      return Number((row as { count: number }).count);
    });
  }

  countRoots(roots: readonly string[]): number {
    const normalized = [...new Set(roots.map(realish))];
    if (normalized.length === 0) return 0;
    return this.withDatabase((db) => {
      const placeholders = normalized.map(() => "?").join(", ");
      const row = db.prepare(`select count(distinct id) as count from session_snapshot where root in (${placeholders})`).get(...normalized);
      return Number((row as { count: number }).count);
    });
  }

  list(root?: string, limit = 500): SessionLibraryEntry[] {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10_000) throw new PyValueError("invalid session library limit");
    return this.withDatabase((db) => this.readEntries(db, root, limit));
  }

  /** Read-only export path: it never creates the source database or applies migrations. */
  listReadOnly(root?: string, limit = 10_000): SessionLibraryEntry[] {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10_000) throw new PyValueError("invalid session library limit");
    if (!existsSync(this.databasePath)) return [];
    if (lstatSync(this.databasePath).isSymbolicLink()) throw new PyValueError("session library database is a symbolic link");
    const db = new DatabaseSync(this.databasePath, { readOnly: true, timeout: 5_000 });
    try {
      db.exec("pragma foreign_keys = on");
      db.exec("pragma busy_timeout = 5000");
      this.validateCurrentSchema(db);
      return this.readEntries(db, root, limit);
    } finally { db.close(); }
  }

  upsert(snapshot: SerializedSessionSnapshot, updatedAt: number): void {
    this.upsertMany([{ snapshot, updatedAt }]);
  }

  delete(id: string): void {
    if (!SESSION_ID.test(id)) throw new PyValueError('invalid session id');
    if (!existsSync(this.databasePath)) return;
    this.withDatabase(db => { db.prepare('delete from session_snapshot where id = ?').run(id); });
  }

  /** All rows are committed together; any failed row rolls back the batch. */
  upsertMany(items: readonly { snapshot: SerializedSessionSnapshot; updatedAt: number }[]): void {
    if (items.length === 0) return;
    for (const { snapshot, updatedAt } of items) {
      if (!SESSION_ID.test(snapshot.id) || !Number.isFinite(updatedAt)) throw new PyValueError("invalid session library row");
    }
    this.withDatabase((db) => {
      db.exec("begin immediate");
      let transaction = true;
      try {
        const upsert = db.prepare(`
          insert into session_snapshot (id, root, title, task, status, payload, history_revision, history_hash, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(id) do update set root=excluded.root, title=excluded.title, task=excluded.task,
            status=excluded.status, payload=excluded.payload, history_revision=excluded.history_revision,
            history_hash=excluded.history_hash, updated_at=excluded.updated_at
        `);
        for (const { snapshot, updatedAt } of items) {
          upsert.run(snapshot.id, snapshot.root, snapshot.title, snapshot.task, snapshot.status, snapshot.payload,
            snapshot.history_revision, snapshot.history_hash, Math.trunc(updatedAt));
        }
        db.exec("commit");
        transaction = false;
      } catch (error) {
        if (transaction) {
          try { db.exec("rollback"); } catch { /* preserve the failed write */ }
        }
        throw error;
      }
    });
  }

  private withDatabase<T>(body: (db: DatabaseSync) => T): T {
    mkdirSync(this.directory, { recursive: true });
    const db = new DatabaseSync(this.databasePath, { timeout: 5_000 });
    try {
      db.exec("pragma foreign_keys = on");
      db.exec("pragma busy_timeout = 5000");
      db.exec("pragma journal_mode = wal");
      this.migrate(db);
      return body(db);
    } finally {
      db.close();
    }
  }

  private migrate(db: DatabaseSync): void {
    db.exec("begin immediate");
    let transaction = true;
    try {
      const before = db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'").all() as unknown as { name: string }[];
      const hasLedger = before.some((table) => table.name === "schema_migration");
      if (!hasLedger && before.length > 0) throw new Error("unsupported unversioned SQLite session library schema");
      db.exec(`create table if not exists schema_migration (
        id text primary key, checksum text not null
      )`);
      const migrations = db.prepare("select id, checksum from schema_migration order by id").all() as unknown as { id: string; checksum: string }[];
      for (const migration of migrations) {
        if (migration.id === SCHEMA_ID) {
          if (migration.checksum !== SCHEMA_CHECKSUM) throw new Error("SQLite session library migration checksum mismatch");
        } else {
          const version = /^(\d+)_/.exec(migration.id);
          if (version && Number(version[1]) > 1) throw new Error(`SQLite session library schema ${migration.id} is newer than this build`);
          throw new Error(`unsupported SQLite session library schema ${migration.id}`);
        }
      }
      const applied = migrations.some((migration) => migration.id === SCHEMA_ID);
      if (!applied) {
        if (before.some((table) => table.name === "session_snapshot")) throw new Error("unsupported unversioned SQLite session snapshot table");
        db.exec(CREATE_SNAPSHOT);
        db.prepare("insert into schema_migration (id, checksum) values (?, ?)").run(SCHEMA_ID, SCHEMA_CHECKSUM);
      }
      this.validateCurrentSchema(db);
      db.exec("commit");
      transaction = false;
    } catch (error) {
      if (transaction) {
        try { db.exec("rollback"); } catch { /* preserve the migration error */ }
      }
      throw error;
    }
  }

  private validateCurrentSchema(db: DatabaseSync): void {
    let migrations: { id: string; checksum: string }[];
    try {
      migrations = db.prepare("select id, checksum from schema_migration order by id").all() as unknown as { id: string; checksum: string }[];
    } catch {
      throw new Error("unsupported SQLite session library schema: migration ledger is unavailable");
    }
    for (const migration of migrations) {
      if (migration.id === SCHEMA_ID) {
        if (migration.checksum !== SCHEMA_CHECKSUM) throw new Error("SQLite session library migration checksum mismatch");
      } else {
        const version = /^(\d+)_/.exec(migration.id);
        if (version && Number(version[1]) > 1) throw new Error(`SQLite session library schema ${migration.id} is newer than this build`);
        throw new Error(`unsupported SQLite session library schema ${migration.id}`);
      }
    }
    if (migrations.length !== 1 || migrations[0]?.id !== SCHEMA_ID) throw new Error("SQLite session library migration is missing");
    const tables = (db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name").all() as unknown as { name: string }[]).map((table) => table.name).sort();
    if (tables.join(",") !== "schema_migration,session_snapshot") throw new Error("SQLite session library schema does not match this build");
    const columns = (db.prepare("pragma table_info(session_snapshot)").all() as unknown as { name: string }[]).map((column) => column.name);
    if (columns.length !== EXPECTED_COLUMNS.length || EXPECTED_COLUMNS.some((name) => !columns.includes(name))) {
      throw new Error("SQLite session library schema does not match this build");
    }
  }

  private readEntries(db: DatabaseSync, root: string | undefined, limit: number): SessionLibraryEntry[] {
    const statement = root === undefined
      ? db.prepare("select * from session_snapshot order by updated_at desc, id desc limit ?")
      : db.prepare("select * from session_snapshot where root = ? order by updated_at desc, id desc limit ?");
    const rows = (root === undefined ? statement.all(limit) : statement.all(realish(root), limit)) as unknown as Record<string, unknown>[];
    return rows.map((row) => {
      const session = pyJsonLoads(String(row.payload), { lossless: true });
      if (!isDict(session) || session.id !== row.id) throw new PyValueError("session library snapshot is invalid");
      return {
        id: String(row.id), root: String(row.root),
        title: row.title == null ? null : String(row.title), task: row.task == null ? null : String(row.task),
        status: row.status == null ? null : String(row.status), payload: String(row.payload),
        history_revision: row.history_revision == null ? null : String(row.history_revision),
        history_hash: row.history_hash == null ? null : String(row.history_hash),
        updated_at: Number(row.updated_at), session: session as Session,
      };
    });
  }
}
