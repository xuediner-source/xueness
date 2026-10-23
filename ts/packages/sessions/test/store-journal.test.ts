import assert from "node:assert/strict";
import { copyFileSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { JsonFloat, pyDeepCopy, pyJsonLoads } from "@xueness/contracts";
import { clearHistoryCache, scan, SessionStore } from "../src/index.ts";
import { pythonUnavailableReason } from "../../../test-support/python-oracle.ts";
import { EDGE_VALUES, hexId, plainKeys, storeSession, tempDir } from "./fixtures.ts";
import { oracle } from "./oracle.ts";
import { SessionFactory } from "../../../test-support/random-session.ts";

const skip = pythonUnavailableReason() ?? false;
type Row = Record<string, unknown>;

function stableSession(id: string): Row {
  return {
    id,
    task: "byte-stable journal",
    status: "pending",
    messages: [
      { role: "system", content: "fixed", _turn_id: "turn-1", _message_id: "a".repeat(32) },
      { role: "user", content: "hello 😀", _turn_id: "turn-1", _message_id: "b".repeat(32) },
    ],
    edge_values: plainKeys(Object.fromEntries(EDGE_VALUES.map((value, index) => [`v${index}`, value]))),
  };
}

function clean(path: string): void {
  clearHistoryCache();
  rmSync(path, { recursive: true, force: true });
}

function copySessionFiles(source: string, destination: string, id: string): void {
  for (const name of readdirSync(source).filter((item) => item.startsWith(id))) {
    copyFileSync(join(source, name), join(destination, name));
  }
}

describe("session journal storage", { skip }, () => {
  it("loads and re-saves a Python journal byte-for-byte without adding a revision", async () => {
    const directory = tempDir("python-roundtrip");
    try {
      const id = "1234567890abcdef1234567890abcdef";
      const pythonReply = oracle({ op: "save", directory, sessions: [stableSession(id)] }) as Row[];
      assert.equal(pythonReply[0]?.ok, true);
      const journal = join(directory, `${id}.json`);
      const history = join(directory, `${id}.history.jsonl`);
      const beforeJournal = readFileSync(journal);
      const beforeHistory = readFileSync(history);
      const beforeScan = (oracle({ op: "scan", paths: [history] }) as Row[])[0]!;

      const store = new SessionStore(directory);
      const loaded = await store.load(id);
      assert.deepEqual(loaded, (pythonReply[0] as Row).session);
      await store.save(loaded);

      assert.deepEqual(readFileSync(journal), beforeJournal);
      assert.deepEqual(readFileSync(history), beforeHistory);
      assert.deepEqual((oracle({ op: "scan", paths: [history] }) as Row[])[0], beforeScan);
      assert.equal((scan(history).records.at(-1)?.seq), 1);
    } finally {
      clean(directory);
    }
  });

  it("round-trips a seeded batch of generated Python journals byte-for-byte", async () => {
    const directory = tempDir("generated-roundtrip");
    try {
      const factory = new SessionFactory(20261018);
      // The seeded alphabet uses Unicode scalar strings, including emoji, but
      // no isolated surrogate code units that Python and JS would pair differently.
      const sessions = Array.from({ length: 40 }, () => storeSession(factory, hexId(factory)));
      const firstSaves = oracle({ op: "save", directory, sessions }) as Row[];
      assert.equal(firstSaves.length, sessions.length);
      assert.equal(firstSaves.filter((reply) => reply.ok === true).length, sessions.length);

      // Python may raise _turn_count on its second save when the first save
      // assigned turn-1 to a transcript with no ordinary user message. Use
      // Python's stable second-save result as the byte-roundtrip baseline;
      // the edge behavior itself has a focused cross-backend test below.
      const replies = oracle({ op: "save", directory, sessions: firstSaves.map((reply) => reply.session) }) as Row[];
      assert.equal(replies.filter((reply) => reply.ok === true).length, sessions.length);

      const snapshots = new Map<string, { journal: Buffer; history: Buffer }>();
      for (const session of sessions) {
        const id = session.id as string;
        snapshots.set(id, {
          journal: readFileSync(join(directory, `${id}.json`)),
          history: readFileSync(join(directory, `${id}.history.jsonl`)),
        });
      }

      const store = new SessionStore(directory);
      for (const session of replies) {
        const loaded = await store.load((session.session as Row).id as string);
        assert.deepEqual(loaded, session.session);
        await store.save(loaded);
        const saved = snapshots.get(loaded.id as string)!;
        const actualJournal = readFileSync(join(directory, `${loaded.id as string}.json`));
        assert.deepEqual(pyJsonLoads(actualJournal.toString("utf8"), { lossless: true }),
          pyJsonLoads(saved.journal.toString("utf8"), { lossless: true }), `journal values changed for ${loaded.id as string}`);
        assert.deepEqual(actualJournal, saved.journal);
        assert.deepEqual(readFileSync(join(directory, `${loaded.id as string}.history.jsonl`)), saved.history);
      }
    } finally {
      clean(directory);
    }
  });

  it("matches Python's second-save identity normalization for assistant-only journals", async () => {
    const source = tempDir("identity-source");
    const pythonDirectory = tempDir("identity-python");
    const tsDirectory = tempDir("identity-ts");
    try {
      const id = "fedcba9876543210fedcba9876543210";
      const first = stableSession(id);
      first.messages = [{ role: "assistant", content: "no user turn", _message_id: "c".repeat(32) }];
      const firstReply = (oracle({ op: "save", directory: source, sessions: [first] }) as Row[])[0]!;
      const firstSession = firstReply.session as Row;
      assert.equal(firstSession._turn_count, 0);
      assert.equal((firstSession.messages as Row[])[0]?._turn_id, "turn-1");
      copySessionFiles(source, pythonDirectory, id);
      copySessionFiles(source, tsDirectory, id);

      const pythonReply = (oracle({ op: "save", directory: pythonDirectory, sessions: [firstSession] }) as Row[])[0]!;
      const store = new SessionStore(tsDirectory);
      const loaded = await store.load(id);
      await store.save(loaded);

      const pythonBytes = readFileSync(join(pythonDirectory, `${id}.json`));
      const tsBytes = readFileSync(join(tsDirectory, `${id}.json`));
      assert.deepEqual(tsBytes, pythonBytes);
      const tsJournal = pyJsonLoads(tsBytes.toString("utf8"), { lossless: true }) as Row;
      assert.equal(tsJournal._turn_count, 1);
      assert.equal(tsJournal.history_revision, 2);
      assert.deepEqual(tsJournal, pythonReply.session);

      const scans = oracle({ op: "scan", paths: [join(pythonDirectory, `${id}.history.jsonl`), join(tsDirectory, `${id}.history.jsonl`)] }) as Row[];
      assert.equal(scans[0]?.ok, true);
      assert.equal(scans[1]?.ok, true);
      assert.equal(scans[0]?.stateHash, scans[1]?.stateHash);
      assert.deepEqual(scans[0]?.seqs, scans[1]?.seqs);
    } finally {
      clean(source);
      clean(pythonDirectory);
      clean(tsDirectory);
    }
  });

  it("recovers the same previous bytes from a torn journal in both backends", async () => {
    const source = tempDir("recovery-source");
    const pythonDirectory = tempDir("recovery-python");
    const tsDirectory = tempDir("recovery-ts");
    try {
      const id = "abcdef0123456789abcdef0123456789";
      const first = stableSession(id);
      oracle({ op: "save", directory: source, sessions: [first] });
      const previousBytes = readFileSync(join(source, `${id}.json`));
      const second = pyDeepCopy(first) as Row;
      second.task = "newer snapshot";
      oracle({ op: "save", directory: source, sessions: [second] });
      assert.deepEqual(readFileSync(join(source, `${id}.json.bak`)), previousBytes);

      for (const target of [pythonDirectory, tsDirectory]) {
        copySessionFiles(source, target, id);
        writeFileSync(join(target, `${id}.json`), Buffer.from('{"id":'));
      }

      const pythonLoaded = (oracle({ op: "load", directory: pythonDirectory, ids: [id] }) as Row[])[0]!.ok;
      const tsLoaded = await new SessionStore(tsDirectory).load(id);
      assert.deepEqual(tsLoaded, pythonLoaded);
      assert.deepEqual(readFileSync(join(pythonDirectory, `${id}.json`)), previousBytes);
      assert.deepEqual(readFileSync(join(tsDirectory, `${id}.json`)), previousBytes);
      assert.deepEqual(readFileSync(join(pythonDirectory, `${id}.json`)), readFileSync(join(tsDirectory, `${id}.json`)));
    } finally {
      clean(source);
      clean(pythonDirectory);
      clean(tsDirectory);
    }
  });

  it("records numeric representation edits in both Python and TS revision chains", async () => {
    const directory = tempDir("numeric-flips");
    try {
      const id = "00112233445566778899aabbccddeeff";
      const session: Row = { ...stableSession(id), integer: 1, boolean: true, zero: new JsonFloat(0) };
      const store = new SessionStore(directory);
      await store.save(session);
      session.integer = new JsonFloat(1);
      session.boolean = 1;
      session.zero = new JsonFloat(-0);
      await store.save(session);

      const historyPath = join(directory, `${id}.history.jsonl`);
      const local = scan(historyPath);
      const python = (oracle({ op: "scan", paths: [historyPath] }) as Row[])[0]!;
      assert.equal(local.records.length, 2);
      assert.equal(python.ok, true, "Python can replay the corrected TS chain");
      assert.equal(python.records, 2);
      const changedPaths = local.records[1]!.operations as Row[];
      assert.deepEqual(changedPaths.filter((item) => item.op === "set").map((item) => (item.path as unknown[])[0]).sort(),
        ["boolean", "integer", "zero"]);

      const pythonDifferences = oracle({ op: "difference", pairs: [
        [1, new JsonFloat(1)], [true, 1], [new JsonFloat(0), new JsonFloat(-0)],
      ] }) as unknown[][];
      assert.deepEqual(pythonDifferences, [
        [{ op: "set", path: [], value: new JsonFloat(1) }],
        [{ op: "set", path: [], value: 1 }],
        [{ op: "set", path: [], value: new JsonFloat(-0) }],
      ]);
      assert.equal(local.records[1]!.stateHash, python.stateHash);
    } finally {
      clean(directory);
    }
  });
});
