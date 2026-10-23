import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pyDeepCopy } from "@xueness/contracts";
import { content, digest, scan, SessionStore } from "../src/index.ts";
import { pythonUnavailableReason } from "../../../test-support/python-oracle.ts";
import { mutate } from "./fixtures.ts";
import { basicSession, cleanDirectory, historyDirectory, journalPath, type Row } from "./history-local.ts";
import { oracle } from "./oracle.ts";
import { SessionFactory } from "../../../test-support/random-session.ts";

const skip = pythonUnavailableReason() ?? false;

describe("session history revision interoperability", { skip }, () => {
  it("lets Python validate and continue TypeScript revisions, then lets TypeScript continue Python's chain", async (t) => {
    const directory = historyDirectory("mixed-revisions");
    t.after(() => cleanDirectory(directory));
    const store = new SessionStore(directory);
    const session = basicSession();
    await store.save(session);
    session.task = "typescript second revision";
    await store.save(session);
    session.steps = 2;
    await store.save(session);
    assert.equal(session.history_revision, 3);

    const pythonSession = pyDeepCopy(session) as Row;
    pythonSession.task = "python fourth revision";
    const saved = oracle({ op: "save", directory, sessions: [pythonSession] }) as Row[];
    assert.equal(saved[0]?.ok, true);
    assert.equal((saved[0]?.session as Row).history_revision, 4);

    const fromPython = await store.load(session.id as string);
    fromPython.status = "running";
    await store.save(fromPython);
    assert.equal(fromPython.history_revision, 5);
    const path = journalPath(directory);
    const scanned = scan(path);
    assert.deepEqual(scanned.state, content(fromPython));
    assert.deepEqual(scanned.records.map((record) => record.seq), [1, 2, 3, 4, 5]);
    assert.equal(scanned.records[3]?.parentHash, scanned.records[2]?.recordHash);

    const pythonScan = oracle({ op: "scan", paths: [path] }) as Row[];
    assert.deepEqual(pythonScan[0], {
      ok: true,
      stateHash: digest(content(fromPython)),
      records: 5,
      size: scanned.size,
      seqs: [1, 2, 3, 4, 5],
    });
  });

  it("validates a seeded mixed-backend sequence with batches of Python saves", async (t) => {
    const directory = historyDirectory("seeded-mixed");
    t.after(() => cleanDirectory(directory));
    const store = new SessionStore(directory);
    const factory = new SessionFactory(0x4d42);
    const sessions = Array.from({ length: 4 }, (_, index) => basicSession(index.toString(16).padStart(32, "0")));
    for (const session of sessions) await store.save(session);

    for (let round = 0; round < 10; round += 1) {
      sessions.forEach((session, index) => {
        for (const key of Object.keys(session)) if (key === "todos" || key.startsWith("x")) delete session[key];
        mutate(factory, session, { flips: false });
        const sid = session.id as string;
        session.task = `${index}:${round}:${factory.text(6)}`;
        session.messages = [{ role: "user", content: `round ${round}`, _message_id: sid, _turn_id: `turn-${round + 1}` }];
        session.revision_probe = `${index}-${round}`;
      });

      if (round % 2 === 0) {
        for (const session of sessions) await store.save(session);
      } else {
        const replies = oracle({ op: "save", directory, sessions: sessions.map((session) => pyDeepCopy(session)) }) as Row[];
        replies.forEach((reply, index) => {
          assert.equal(reply.ok, true, `Python save ${index} at round ${round}`);
          sessions[index] = reply.session as Row;
        });
      }
    }

    const paths = sessions.map((session) => journalPath(directory, session.id as string));
    const pythonScans = oracle({ op: "scan", paths }) as Row[];
    sessions.forEach((session, index) => {
      const ts = scan(paths[index]!);
      assert.equal(ts.records.length, 11);
      assert.deepEqual(ts.records.map((record) => record.seq), Array.from({ length: 11 }, (_, seq) => seq + 1));
      assert.deepEqual(ts.state, content(session));
      assert.equal(pythonScans[index]?.ok, true);
      assert.deepEqual(pythonScans[index]?.seqs, ts.records.map((record) => record.seq));
      assert.equal(pythonScans[index]?.stateHash, digest(content(session)));
    });
  });

});
