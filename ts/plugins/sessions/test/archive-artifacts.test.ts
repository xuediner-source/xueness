/** Round 11: permanent deletion removes the session's tool media and visualizations; archiving keeps them. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { it } from "node:test";
import { SessionStore } from "@xueness/sessions";
import { archiveSession, deleteArchivedSession, removeSessionArtifacts } from "../src/archive.ts";
import { createSessionsStore } from '../src/session-storage.ts';
import { SqliteSessionLibrary } from '../src/sqlite-library.ts';
import { createSessionRuntimeEventLog } from '../src/runtime-event-log.ts';

it("drops tool media and visualizations only when an archived session is deleted for good", async () => {
  const state = mkdtempSync(join(tmpdir(), "xueness-archive-artifacts-")), sid = "d".repeat(32), other = "e".repeat(32);
  try {
    const store = createSessionsStore(state, { env: { XUENESS_SESSION_SQLITE: '1' } });
    await store.new("artifacts", state, { sessionId: sid });
    await store.new('other session', state, { sessionId: other });
    for (const id of [sid, other]) createSessionRuntimeEventLog(state, id).append({ type: 'TurnPhase', payload: { phase: 'idle' } });
    const dirs = (id: string) => ["tool-media", "visualizations", 'file-history'].map((name) => join(state, name, id));
    for (const dir of [...dirs(sid), ...dirs(other)]) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "a.bin"), "x"); }
    await archiveSession(store, sid);
    assert.ok(dirs(sid).every(existsSync), "archived sessions can be restored with their media");
    assert.equal(new SqliteSessionLibrary(state).count(), 2);
    const archived = join(state, "deleted-sessions", basename(store.pathFor(sid)));
    await deleteArchivedSession(store, sid, createHash("sha256").update(readFileSync(archived)).digest("hex"));
    assert.ok(!existsSync(archived));
    assert.ok(dirs(sid).every((dir) => !existsSync(dir)));
    assert.ok(dirs(other).every(existsSync), "other sessions keep theirs");
    assert.equal(existsSync(join(state, 'session-events', sid + '.jsonl')), false);
    assert.equal(existsSync(join(state, 'session-events', other + '.jsonl')), true);
    assert.deepEqual(new SqliteSessionLibrary(state).list().map(row => row.id), [other]);
    removeSessionArtifacts(state, "../" + other);
    assert.ok(dirs(other).every(existsSync));
  } finally { rmSync(state, { recursive: true, force: true }); }
});
