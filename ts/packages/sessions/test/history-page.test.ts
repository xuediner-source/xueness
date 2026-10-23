import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { JsonFloat } from "@xueness/contracts";
import { historyPage, scan, SessionStore } from "../src/index.ts";
import { pythonUnavailableReason } from "../../../test-support/python-oracle.ts";
import { basicSession, cleanDirectory, historyDirectory, journalPath, scanResult, type Row } from "./history-local.ts";
import { oracle } from "./oracle.ts";

const skip = pythonUnavailableReason() ?? false;
type Query = [unknown, unknown];

async function pageResult(store: SessionStore, sid: string, cursor: unknown, limit: unknown): Promise<Row> {
  try {
    return { ok: await historyPage(store, sid, cursor, limit) };
  } catch (error) {
    return { error: (error as Error).name };
  }
}

describe("session history pages", { skip }, () => {
  it("matches Python for valid cursors, sequence gaps, large cursors and invalid inputs", async (t) => {
    const directory = historyDirectory("pages");
    t.after(() => cleanDirectory(directory));
    const sid = "0123456789abcdef0123456789abcdef";
    const store = new SessionStore(directory);
    const session = basicSession(sid);
    await store.save(session);
    session.status = "running";
    await store.save(session);
    session.task = "revision three";
    await store.save(session);
    session.history_revision = 6;
    session.status = "completed";
    await store.save(session);
    assert.equal(session.history_revision, 7);

    const queries: Query[] = [
      [0, 1], [0, 2], [2, 2], [3, 1], [6, 1], [7, 2], [8, 2], [2n ** 60n, 1],
      [true, 1], [new JsonFloat(1), 1], [-1, 1], ["1", 1], [0, 0], [0, 501], [0, true],
    ];
    const actual: Row[] = [];
    for (const [cursor, limit] of queries) actual.push(await pageResult(store, sid, cursor, limit));
    const expected = oracle({ op: "page", directory, queries: queries.map(([cursor, limit]) => [sid, cursor, limit]) }) as Row[];
    assert.deepEqual(actual, expected);

    const pageAtGap = actual[3]?.ok as Row;
    assert.equal(pageAtGap.resync, true);
    assert.deepEqual((pageAtGap.records as Row[]).map((record) => record.seq), [7]);
    assert.equal(((actual[6]?.ok as Row).resync), true);
    assert.equal((actual[9] as Row).error, "ValueError");
  });

  it("repairs an unpublished snapshot from either backend before returning a page", async (t) => {
    const sid = "0123456789abcdef0123456789abcdef";
    type Backend = "ts" | "python";
    type Tail = "missing" | "torn";
    const run = async (tail: Tail, repairer: Backend, writer: Backend) => {
      const directory = historyDirectory(`page-${tail}-${repairer}`);
      t.after(() => cleanDirectory(directory));
      const session = basicSession(sid);
      if (writer === "ts") {
        const store = new SessionStore(directory);
        await store.save(session);
        session.status = "running";
        await store.save(session);
      } else {
        let saved = (oracle({ op: "save", directory, sessions: [session] }) as Row[])[0];
        assert.equal(saved?.ok, true);
        const pythonSession = saved?.session as Row;
        pythonSession.status = "running";
        saved = (oracle({ op: "save", directory, sessions: [pythonSession] }) as Row[])[0];
        assert.equal(saved?.ok, true);
      }

      const path = journalPath(directory, sid);
      const original = readFileSync(path);
      const firstNewline = original.indexOf(0x0a);
      assert.notEqual(firstNewline, -1);
      const prefix = original.subarray(0, firstNewline + 1);
      writeFileSync(path, tail === "missing" ? prefix : Buffer.concat([prefix, Buffer.from('{"torn":') ]));

      const primary = repairer === "ts"
        ? { ok: await historyPage(new SessionStore(directory), sid, 1, 1) }
        : (oracle({ op: "page", directory, queries: [[sid, 1, 1]] }) as Row[])[0];
      const verifier = repairer === "ts"
        ? (oracle({ op: "page", directory, queries: [[sid, 1, 1]] }) as Row[])[0]
        : { ok: await historyPage(new SessionStore(directory), sid, 1, 1) };
      assert.deepEqual(verifier, primary);
      const page = primary?.ok as Row;
      assert.deepEqual((page.records as Row[]).map((record) => record.seq), [3]);
      assert.equal(((page.records as Row[])[0] as Row).reset, true);
      assert.equal(page.resync, true);

      const repaired = readFileSync(path);
      assert.deepEqual(repaired.subarray(0, prefix.length), prefix);
      assert.equal(repaired.toString("utf8").includes('"torn":'), false);
      const tsSummary = scanResult(path);
      const pythonSummary = (oracle({ op: "scan", paths: [path] }) as Row[])[0];
      assert.deepEqual(tsSummary, pythonSummary);
      const semanticRecords = scan(path).records.map((record) => {
        const semantic: Row = { ...record };
        delete semantic.timestamp;
        delete semantic.parentHash;
        delete semantic.recordHash;
        return semantic;
      });
      assert.deepEqual(semanticRecords.map((record) => record.seq), [1, 3]);
      return semanticRecords;
    };

    const missingTs = await run("missing", "ts", "python");
    const missingPython = await run("missing", "python", "ts");
    assert.deepEqual(missingTs, missingPython);
    const tornTs = await run("torn", "ts", "python");
    const tornPython = await run("torn", "python", "ts");
    assert.deepEqual(tornTs, tornPython);
  });
});
