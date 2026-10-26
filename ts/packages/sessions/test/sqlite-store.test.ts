// C-SES-02: primary transactional SQLite session store — persist-then-publish,
// transaction boundaries, the indexed canonical projection, and a restartable
// JSON → SQLite migration that never touches the source journals.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { PyKeyError, PyValueError } from "@xueness/contracts";
import { tempDir } from "./fixtures.ts";
import { clearHistoryCache } from "../src/history.ts";
import {
  migrateJsonJournals, openStartupSessionStore, SESSION_STORE_DB_NAME, sessionFingerprint, sessionStorePath,
  SqliteSessionStore, verifyJsonMigration,
} from "../src/sqlite-store.ts";
import { SessionStore } from "../src/store.ts";

type Row = Record<string, unknown>;
const mid = (char: string) => char.repeat(32);

function clean(path: string): void {
  clearHistoryCache();
}

async function jsonStoreWithSessions(count: number): Promise<{ store: SessionStore; dir: string }> {
  const dir = tempDir("xueness-sqlite-migrate");
  const store = new SessionStore(dir);
  for (let index = 0; index < count; index += 1) {
    const session = await store.new(`task ${index}`, dir, { sessionId: mid(String(index)).padEnd(32, "0").slice(0, 32) });
    (session.messages as Row[]).push(
      { role: "assistant", content: null, tool_calls: [{ id: `call-${index}`, function: { name: "ls", arguments: "{}" } }] },
      { role: "tool", tool_call_id: `call-${index}`, content: "ok" },
    );
    await store.save(session);
  }
  return { store, dir };
}

describe("SqliteSessionStore", () => {
  it("saves and reloads a session losslessly with a message index", async () => {
    const dir = tempDir("xueness-sqlite-save");
    try {
      const store = new SqliteSessionStore(dir);
      const session = await store.new("primary store", dir);
      (session.messages as Row[]).push({ role: "user", content: "again" });
      await store.save(session);
      const loaded = await store.load(session.id as string);
      assert.equal((loaded.messages as Row[]).length, 3);
      assert.equal(sessionFingerprint(loaded).digest, sessionFingerprint(session).digest);
      const index = store.messageIndex(session.id as string);
      assert.equal(index.length, 3);
      assert.deepEqual(index.map((row) => row.role), ["system", "user", "user"]);
      assert.deepEqual(index.map((row) => row.turnId), ["turn-1", "turn-1", "turn-2"]); // the new user message opens turn-2
      assert.ok(index.every((row) => /^[0-9a-f]{32}$/.test(row.messageId)));
      assert.deepEqual((await store.list()).map((item) => item.id), [session.id]);
    } finally {
      clean(dir);
    }
  });

  it("persists before it publishes (C-SES-02)", async () => {
    const dir = tempDir("xueness-sqlite-publish");
    try {
      let observed: number | null = null;
      const store = new SqliteSessionStore(dir, {
        onChanged(sid) {
          const reader = new DatabaseSync(sessionStorePath(dir), { readOnly: true });
          try {
            observed = Number((reader.prepare("select count(*) as n from session where id = ?").get(String(sid)) as Row).n);
          } finally {
            reader.close();
          }
        },
      });
      const session = await store.new("publish after persist", dir);
      assert.equal(observed, 1);
      assert.equal(store.migrationLedger().length, 0);
    } finally {
      clean(dir);
    }
  });

  it("rolls the whole save back when the canonical model rejects the session", async () => {
    const dir = tempDir("xueness-sqlite-rollback");
    try {
      const store = new SqliteSessionStore(dir);
      const session = await store.new("rollback", dir);
      (session.messages as Row[]).push({ role: "alien", content: "invalid role" });
      await assert.rejects(() => store.save(session), PyValueError);
      // Only the failed save rolled back; the previously committed revision survives.
      const survivors = await store.list();
      assert.equal(survivors.length, 1);
      assert.equal(survivors[0]!.id, session.id);
      const reloaded = await store.load(session.id as string);
      assert.equal((reloaded.messages as Row[]).length, 2);
      assert.equal(store.messageIndex(session.id as string).length, 2);
      assert.ok((reloaded.messages as Row[]).every((row) => row.role !== "alien"));
    } finally {
      clean(dir);
    }
  });

  it("update runs read-modify-write in one transaction and rolls back on failure", async () => {
    const dir = tempDir("xueness-sqlite-update");
    try {
      const store = new SqliteSessionStore(dir);
      const created = await store.new("update me", dir);
      const sid = created.id as string;
      const updated = await store.update(sid, (session) => {
        if (session.status !== "pending") throw new Error("unexpected initial state");
        session.status = "running";
        return true;
      });
      assert.equal(updated.status, "running");
      assert.equal((await store.load(sid)).status, "running");
      let published = 0;
      const observing = new SqliteSessionStore(dir, { onChanged: () => { published += 1; } });
      await observing.update(sid, () => false);
      assert.equal(published, 0);
      await assert.rejects(
        () => store.update(sid, (session) => {
          (session.messages as Row[]).push({ role: "alien" });
          return true;
        }),
        PyValueError,
      );
      assert.equal(((await store.load(sid)).messages as Row[]).length, 2); // rolled back
      await store.delete(sid);
      await assert.rejects(() => store.load(sid), PyKeyError);
      assert.deepEqual(store.messageIndex(sid), []);
    } finally {
      clean(dir);
    }
  });

  it("refuses a database with an unsupported schema", async () => {
    const dir = tempDir("xueness-sqlite-schema");
    try {
      const db = new DatabaseSync(sessionStorePath(dir));
      db.exec("create table session (id text primary key)");
      db.close();
      assert.throws(() => new SqliteSessionStore(dir), /unsupported/);
    } finally {
      clean(dir);
    }
  });
});

describe("JSON → SQLite migration", () => {
  it("restarts after an interruption, keeps counts and digests equal, and never rewrites the journals", async () => {
    const { store: json, dir } = await jsonStoreWithSessions(3);
    try {
      const before = new Map(readdirSync(dir).filter((name) => name.endsWith(".json"))
        .map((name) => [name, readFileSync(join(dir, name), "utf8")]));
      assert.equal(before.size, 3);

      // Interrupt on the second imported session: the first two commits survive.
      let imported = 0;
      await assert.rejects(
        () => migrateJsonJournals(json, new SqliteSessionStore(dir), {
          onSession: () => { imported += 1; if (imported === 2) throw new Error("simulated crash"); },
        }),
        /simulated crash/,
      );
      const partial = new SqliteSessionStore(dir);
      assert.equal(partial.migrationLedger().length, 2);

      // Restart: completed sessions are skipped, the rest are imported.
      const report = await migrateJsonJournals(json, new SqliteSessionStore(dir));
      assert.deepEqual({ ...report, migrated: 1, skipped: 2, sessions: 3 }, report);
      assert.equal(report.messages, 3 * 4); // system + user + assistant call + tool result each
      assert.equal(report.attachments, 0);

      const verification = await verifyJsonMigration(json, new SqliteSessionStore(dir));
      assert.deepEqual(verification.mismatches, []);
      assert.equal(verification.sessions, 3);
      assert.equal(verification.messages, report.messages);

      // 原数据不覆盖: the JSON journals are byte-for-byte unchanged.
      for (const [name, bytes] of before) assert.equal(readFileSync(join(dir, name), "utf8"), bytes);
    } finally {
      clean(dir);
    }
  });

  it("counts file associations from media references and recorded attachments", async () => {
    const dir = tempDir("xueness-sqlite-attachments");
    try {
      const json = new SessionStore(dir);
      const session = await json.new("media task", dir);
      (session.messages as Row[]).push({ role: "user", content: "pic", _media_refs: [{ id: "m1" }, { id: "m2" }] });
      session.input_attachments = [{ user_turn: 2, files: [{ path: "a" }, { path: "b" }, { path: "c" }] }];
      await json.save(session);
      const report = await migrateJsonJournals(json, new SqliteSessionStore(dir));
      assert.equal(report.attachments, 5); // two media references plus three recorded files
      const verification = await verifyJsonMigration(json, new SqliteSessionStore(dir));
      assert.deepEqual(verification.mismatches, []);
      assert.equal(verification.attachments, 5);
    } finally {
      clean(dir);
    }
  });

  it("reports a mismatch when a journal changes after its import", async () => {
    const { store: json, dir } = await jsonStoreWithSessions(1);
    try {
      await migrateJsonJournals(json, new SqliteSessionStore(dir));
      const sid = String((await json.list())[0]!.id);
      const session = await json.load(sid);
      (session.messages as Row[]).push({ role: "user", content: "post-import edit" });
      await json.save(session);
      const verification = await verifyJsonMigration(json, new SqliteSessionStore(dir));
      assert.ok(verification.mismatches.some((line) => line.includes("content digest differs")));
    } finally {
      clean(dir);
    }
  });
});

describe("openStartupSessionStore", () => {
  it("starts on JSON, switches to SQLite once opted in or already migrated", async () => {
    const dir = tempDir("xueness-sqlite-startup");
    try {
      const fresh = openStartupSessionStore(dir, { env: {} });
      assert.equal(fresh.kind, "json");
      const optedIn = openStartupSessionStore(dir, { env: { XUENESS_SESSION_STORE: "sqlite" } });
      assert.equal(optedIn.kind, "sqlite");
      await (optedIn.store as unknown as SqliteSessionStore).new("primary", dir);
      const migrated = openStartupSessionStore(dir, { env: {} });
      assert.equal(migrated.kind, "sqlite");
      assert.equal(readdirSync(dir).includes(SESSION_STORE_DB_NAME), true);
    } finally {
      clean(dir);
    }
  });
});
