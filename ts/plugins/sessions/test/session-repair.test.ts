import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { historyPath, scan, SessionStore, type Session } from "@xueness/sessions";
import { repairSessions, runSessionStorageCommand } from "../src/session-storage.ts";

type Row = Record<string, unknown>;
const makeRoot = (prefix: string): string => mkdtempSync(join(tmpdir(), `xue-repair-${prefix}-`));

describe("workspace and history migration repair", () => {
  it("relocates sessions after their workspace directory moved and continues the revision chain", async () => {
    const base = makeRoot("moved"), state = join(base, "state"), oldRoot = join(base, "old-work"), newRoot = join(base, "new-work");
    try {
      mkdirSync(state); mkdirSync(oldRoot); mkdirSync(join(oldRoot, "nested"));
      const store = new SessionStore(state);
      const session = await store.new("moved workspace", oldRoot, { sessionId: "a".repeat(32) });
      const sid = String(session.id);
      session.task = "edited before the move";
      await store.save(session);
      const revisionsBefore = scan(historyPath(store, sid)).records.length;
      renameSync(oldRoot, newRoot);

      const result = await repairSessions(store, { relocations: [{ from: oldRoot, to: newRoot }] });
      assert.equal(result.repaired, 1);
      assert.equal(result.reports[0]!.repairs.includes("relocated_root"), true);
      const relocated = await store.load(sid);
      assert.equal(relocated.root, newRoot, "the session is locatable at the new workspace");

      relocated.task = "continued after repair";
      await store.save(relocated);
      const records = scan(historyPath(store, sid)).records;
      assert.equal(records.length, revisionsBefore + 2, "repair and continuation each append one revision");
      const nestedSession = await store.new("nested root", join(oldRoot, "nested"), { sessionId: "b".repeat(32) });
      const again = await repairSessions(store, { relocations: [{ from: oldRoot, to: newRoot }] });
      assert.deepEqual(again.reports.map((row) => row.status).sort(), ["ok", "repaired"]);
      assert.equal((await store.load(String(nestedSession.id))).root, join(newRoot, "nested"), "subdirectories keep their suffix");
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("reports a missing workspace it cannot map instead of guessing a root", async () => {
    const base = makeRoot("missing"), state = join(base, "state"), root = join(base, "gone-work");
    try {
      mkdirSync(state); mkdirSync(root);
      const store = new SessionStore(state);
      const session = await store.new("missing workspace", root, { sessionId: "c".repeat(32) });
      const sid = String(session.id);
      rmSync(root, { recursive: true, force: true });
      const journal = readFileSync(store.pathFor(sid));

      const result = await repairSessions(store);
      assert.equal(result.unrepairable, 1);
      assert.match(result.reports[0]!.reason!, /^missing_workspace: .*gone-work does not exist/);
      assert.deepEqual(readFileSync(store.pathFor(sid)), journal, "an unrepairable journal is left untouched");

      const mapped = await repairSessions(store, { relocations: [{ from: root, to: join(base, "nowhere") }] });
      assert.equal(mapped.unrepairable, 1, "a relocation whose target is also absent does not repair anything");
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("upgrades legacy journals to the current schema and reports unsupported shapes accurately", async () => {
    const base = makeRoot("legacy"), state = join(base, "state"), root = join(base, "work");
    try {
      mkdirSync(state); mkdirSync(root);
      const store = new SessionStore(state);
      const legacy: Session = {
        id: "d".repeat(32), task: "old journal", root, status: "running",
        messages: [{ role: "system", content: "prompt" }, { role: "user", content: "task" }],
      };
      store.writeJournal(legacy);
      const broken: Session = { ...legacy, id: "e".repeat(32), messages: "flattened" };
      store.writeJournal(broken);
      const brokenJournal = readFileSync(store.pathFor(String(broken.id)));

      const result = await repairSessions(store);
      assert.deepEqual(result.reports.map((row) => row.id).sort(), ["d".repeat(32), "e".repeat(32)].sort());
      const upgraded = result.reports.find((row) => row.id === legacy.id)!;
      assert.equal(upgraded.status, "repaired");
      assert.match(upgraded.repairs.join(","), /^schema_defaults:/);
      const healed = await store.load(String(legacy.id));
      for (const key of ["results", "compactions", "archived_messages", "todos"]) assert.ok(Array.isArray(healed[key]) || typeof healed[key] === "object", `${key} restored`);
      assert.equal(healed.steps, 0); assert.equal(healed.completion, null); assert.equal(healed.pending_question, null);
      assert.equal(healed.task, "old journal", "legacy content is preserved");
      const refused = result.reports.find((row) => row.id === broken.id)!;
      assert.equal(refused.status, "unrepairable");
      assert.match(refused.reason!, /^unsupported_journal_shape: messages must be a list \(got string\)/);
      assert.deepEqual(readFileSync(store.pathFor(String(broken.id))), brokenJournal);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("resyncs a drifted history cursor so the next save appends a valid reset record", async () => {
    const base = makeRoot("cursor"), state = join(base, "state"), root = join(base, "work");
    try {
      mkdirSync(state); mkdirSync(root);
      const store = new SessionStore(state);
      const session = await store.new("cursor drift", root, { sessionId: "f".repeat(32) });
      const sid = String(session.id);
      const chain = scan(historyPath(store, sid)).records;
      const last = chain[chain.length - 1]!;

      const drifted: Session = { ...session, history_revision: 99, history_hash: "0".repeat(64) };
      store.writeJournal(drifted);
      const result = await repairSessions(store);
      assert.equal(result.reports[0]!.repairs.includes("history_cursor_resync"), true);
      assert.equal(scan(historyPath(store, sid)).records.length, chain.length, "a cursor-only repair appends no junk record");
      const healed = await store.load(sid);
      assert.equal(healed.history_revision, last.seq);
      assert.equal(healed.history_hash, last.stateHash);

      healed.task = "written after cursor repair";
      await store.save(healed);
      const records = scan(historyPath(store, sid)).records;
      assert.equal(records.length, chain.length + 1);
      assert.equal(records.at(-1)!.reset, false, "the resynced chain continues with a regular diff record");

      // A sidecar that vanished leaves a stale cursor behind; repair clears it.
      unlinkSync(historyPath(store, sid));
      store.writeJournal({ ...healed, history_revision: last.seq, history_hash: last.stateHash });
      const cleared = await repairSessions(store);
      assert.equal(cleared.reports[0]!.repairs.includes("history_cursor_reset"), true);
      const fresh = await store.load(sid);
      await store.save(fresh);
      assert.equal(scan(historyPath(store, sid)).records.length, 1, "the next save writes a fresh baseline");
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("keeps local credentials and unrelated state untouched while repairing", async () => {
    const base = makeRoot("creds"), state = join(base, "state"), oldRoot = join(base, "old-work"), newRoot = join(base, "new-work");
    try {
      mkdirSync(state); mkdirSync(oldRoot);
      const store = new SessionStore(state);
      const session = await store.new("credentials", oldRoot, { sessionId: "9".repeat(32) });
      const sid = String(session.id);
      session.model_auth = { token: "secret-token", account: "local" };
      await store.save(session);
      const credentials = join(state, "credentials.json");
      writeFileSync(credentials, '{"api_keys":{"primary":"local-secret"}}', { mode: 0o600 });
      const credentialsBefore = readFileSync(credentials);
      renameSync(oldRoot, newRoot);

      const result = await repairSessions(store, { relocations: [{ from: oldRoot, to: newRoot }] });
      assert.equal(result.repaired, 1);
      assert.deepEqual(readFileSync(credentials), credentialsBefore, "files outside session journals are never rewritten");
      const healed = await store.load(sid);
      assert.deepEqual(healed.model_auth as Row, { token: "secret-token", account: "local" }, "journal credentials survive the migration");
      assert.equal(existsSync(join(state, "session-library.sqlite")), false, "repair does not fabricate a SQLite library");
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("exposes repair through the CLI with dry-run leaving journals untouched", async () => {
    const base = makeRoot("cli"), state = join(base, "state"), oldRoot = join(base, "old-work"), newRoot = join(base, "new-work");
    try {
      mkdirSync(state); mkdirSync(oldRoot);
      const store = new SessionStore(state);
      await store.new("cli repair", oldRoot, { sessionId: "8".repeat(32) });
      renameSync(oldRoot, newRoot);
      const journal = readFileSync(store.pathFor("8".repeat(32)));

      const planned = JSON.parse(await runSessionStorageCommand(["--state", state, "repair", "--relocate", `${oldRoot}=${newRoot}`, "--dry-run"])) as Row;
      assert.equal(planned.repaired, 1); assert.equal(planned.dryRun, true);
      assert.deepEqual(readFileSync(store.pathFor("8".repeat(32))), journal, "dry-run writes nothing");

      const applied = JSON.parse(await runSessionStorageCommand(["--state", state, "repair", `--relocate=${oldRoot}=${newRoot}`])) as Row;
      assert.equal(applied.repaired, 1); assert.equal(applied.dryRun, false);
      assert.equal((await store.load("8".repeat(32))).root, newRoot);

      await assert.rejects(
        runSessionStorageCommand(["--state", state, "repair", "--relocate", "no-separator"]),
        /--relocate expects FROM=TO/,
      );
      await assert.rejects(runSessionStorageCommand(["--state", state, "list", "--dry-run"]), /only valid with repair/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
