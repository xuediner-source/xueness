import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { JsonFloat } from "@xueness/contracts";
import { historyPath, scan, SessionStore } from "@xueness/sessions";
import {
  captureSessionSnapshot, SESSION_LIBRARY_DB_NAME, SqliteSessionLibrary,
} from "../src/sqlite-library.ts";
import {
  createSessionsStore, runSessionStorageCommand,
} from "../src/session-storage.ts";
import { createSessionStorageApi } from "../src/storage-api.ts";

type Row = Record<string, unknown>;
const enabledEnv = { XUENESS_SESSION_SQLITE: "1" };
const makeRoot = (prefix: string): string => mkdtempSync(join(tmpdir(), `xue-${prefix}-`));

function session(id: string, root: string, task = "storage session"): Row {
  return { id, root, task, title: task, status: "completed", messages: [], history_revision: 0 };
}

describe("SQLite session library", () => {
  it("round-trips lossless values and rolls back a failed multi-session import", () => {
    const base = makeRoot("sqlite-codec"), state = join(base, "state");
    try {
      mkdirSync(state);
      const library = new SqliteSessionLibrary(state);
      const rich = session("a".repeat(32), base) as Row;
      rich.large_integer = 9_007_199_254_740_993n;
      rich.integral_float = new JsonFloat(1);
      rich.negative_zero = new JsonFloat(-0);
      library.upsert(captureSessionSnapshot(rich), 10);
      assert.deepEqual(library.list()[0]!.session, rich);

      const db = new DatabaseSync(library.databasePath);
      try {
        db.exec(`create trigger reject_second before insert on session_snapshot
          when new.id = '${"c".repeat(32)}'
          begin select raise(abort, 'injected transaction failure'); end`);
      } finally { db.close(); }
      const first = captureSessionSnapshot(session("b".repeat(32), base) as Row);
      const second = captureSessionSnapshot(session("c".repeat(32), base) as Row);
      assert.throws(() => library.upsertMany([{ snapshot: first, updatedAt: 11 }, { snapshot: second, updatedAt: 12 }]), /injected transaction failure/);
      assert.equal(library.count(), 1, "the first row in the failed batch must roll back");
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("rejects a database carrying a newer migration id", () => {
    const base = makeRoot("sqlite-newer"), state = join(base, "state");
    try {
      mkdirSync(state);
      const library = new SqliteSessionLibrary(state);
      assert.equal(library.count(), 0);
      const db = new DatabaseSync(library.databasePath);
      try { db.prepare("insert into schema_migration (id, checksum) values (?, ?)").run("0002_future_schema", "future"); }
      finally { db.close(); }
      assert.throws(() => library.count(), /newer than this build/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("does not create or write a database while the feature switch is off", async () => {
    const base = makeRoot("sqlite-disabled"), state = join(base, "state");
    try {
      mkdirSync(state);
      const store = createSessionsStore(state, { enabled: () => true, env: {} });
      const saved = await store.new("disabled mirror", base, { sessionId: "d".repeat(32) });
      saved.status = "completed";
      await store.save(saved);
      assert.equal(existsSync(join(state, SESSION_LIBRARY_DB_NAME)), false);
      assert.equal((await store.list()).length, 1);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("mirrors a save before returning and supports a cold SQLite query", async () => {
    const base = makeRoot("sqlite-sync"), state = join(base, "state");
    try {
      mkdirSync(state);
      const store = createSessionsStore(state, { enabled: () => true, env: enabledEnv });
      const saved = await store.new("first", base, { sessionId: "e".repeat(32) });
      const cold = new SqliteSessionLibrary(state);
      assert.equal(cold.count(), 1);
      saved.task = "updated before save returned";
      await store.save(saved);
      const row = cold.list(realRoot(base))[0]!;
      assert.equal(row.session.task, "updated before save returned");
      assert.equal(row.session.history_revision, saved.history_revision);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("reindexes without changing journals and exports snapshots plus revision sidecars", async () => {
    const base = makeRoot("sqlite-export"), state = join(base, "state"), output = join(base, "exported");
    try {
      mkdirSync(state);
      const source = new SessionStore(state);
      const saved = await source.new("before import", base, { sessionId: "f".repeat(32) });
      saved.task = "source latest";
      await source.save(saved);
      const journalBefore = readFileSync(source.pathFor(saved.id));
      const historyBefore = readFileSync(historyPath(source, String(saved.id)));
      assert.match(await runSessionStorageCommand(["--state", state, "import"]), /"indexed": 1/);
      assert.deepEqual(readFileSync(source.pathFor(saved.id)), journalBefore);
      assert.deepEqual(readFileSync(historyPath(source, String(saved.id))), historyBefore);

      const databaseBefore = readFileSync(join(state, SESSION_LIBRARY_DB_NAME));
      const result = await runSessionStorageCommand(["--state", state, "export", "--out", output]);
      assert.match(result, /"copiedHistoryLogs": 1/);
      assert.deepEqual(readFileSync(join(state, SESSION_LIBRARY_DB_NAME)), databaseBefore);
      const exported = new SessionStore(output), restored = await exported.load(String(saved.id));
      assert.deepEqual(readFileSync(historyPath(exported, String(saved.id))), historyBefore);
      restored.task = "continued after export";
      await exported.save(restored);
      assert.equal(restored.history_revision, (saved.history_revision as number) + 1);
      assert.equal(scan(historyPath(exported, String(saved.id))).records.length, 3);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("filters API counts and lists by authorized root and gates the sessions plugin", async () => {
    const base = makeRoot("sqlite-api"), state = join(base, "state"), allowed = join(base, "allowed"), hidden = join(base, "hidden");
    try {
      mkdirSync(state); mkdirSync(allowed); mkdirSync(hidden);
      const env = enabledEnv;
      const store = createSessionsStore(state, { enabled: () => true, env });
      await store.new("visible", allowed, { sessionId: "1".repeat(32) });
      await store.new("hidden", hidden, { sessionId: "2".repeat(32) });
      const options = {
        store, stateDir: state, webRuns: join(base, "runs"), projectDir: join(base, "project"),
        allowedRoots: () => [allowed], enabled: () => true, env,
      };
      const api = createSessionStorageApi(options);
      const status = await api.dispatch("GET", ["api", "sessions", "storage"], {}, {});
      assert.deepEqual(status, [200, { enabled: true, count: 1 }]);
      const legacyStore = new SessionStore(state);
      await legacyStore.new("legacy visible", allowed, { sessionId: "3".repeat(32) });
      assert.deepEqual(await api.dispatch("POST", ["api", "sessions", "storage", "reindex"], {}, {}), [200, { ok: true }]);
      const listed = await api.dispatch("GET", ["api", "sessions", "storage", "list"], { root: [realRoot(allowed)] }, {});
      assert.equal(listed?.[0], 200);
      assert.deepEqual(((listed?.[1] as Row).sessions as Row[]).map((row) => row.id).sort(), ["1".repeat(32), "3".repeat(32)].sort());
      const deniedRoot = await api.dispatch("GET", ["api", "sessions", "storage", "list"], { root: [hidden] }, {});
      assert.equal(deniedRoot?.[0], 400);
      const disabled = createSessionStorageApi({ ...options, enabled: () => false });
      assert.equal((await disabled.dispatch("GET", ["api", "sessions", "storage"], {}, {}))?.[0], 403);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

function realRoot(path: string): string {
  return path.replaceAll("\\", "/");
}
