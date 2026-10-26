import { mkdtemp } from "../../../test-support/canonical-temp.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentRunner, type AgentContext, type Row } from "@xueness/agent";
import { SessionStore, type Session } from "@xueness/sessions";
import {
  createPersistedFileReadState,
  createToolEnv,
  editTool,
  FileStateTracker,
  readTool,
  runTool,
  writeTool,
  type FileSnapshot,
  type PersistedFileReadState,
} from "@xueness/engine-tools";
import { filesReadStateExtension } from "../src/read-state.ts";

const SNAPSHOT: FileSnapshot = {
  mtimeMs: 1_800_000_000_000,
  size: 5,
  sha256: "a".repeat(64),
  partial: false,
};

async function setup() {
  const base = await mkdtemp(join(tmpdir(), "xueness-files-read-state-"));
  const root = join(base, "workspace");
  const artifactsDir = join(base, "artifacts");
  await mkdir(root);
  await mkdir(artifactsDir);
  const tracker = new FileStateTracker();
  const env = createToolEnv({ cwd: root, roots: [root], artifactsDir });
  env.tracker = tracker;
  return { base, root, env, tracker };
}

function journalCall(
  name: string,
  id: string,
  state?: PersistedFileReadState,
  ok = true,
): Row[] {
  return [
    {
      role: "assistant",
      tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }],
    },
    {
      role: "tool",
      tool_call_id: id,
      content: JSON.stringify({ ok }),
      ...(state ? { _read_state: state } : {}),
    },
  ];
}

function context(root: string, messages: Row[]): AgentContext {
  return { root, session: { messages } as unknown as Session } as AgentContext;
}

describe("files read-state restoration", () => {
  it("restores a real Read snapshot after clearing and allows Edit", async () => {
    const ws = await setup();
    try {
      const path = join(ws.root, "note.txt");
      await writeFile(path, "alpha\n");
      const read = await readTool.run({ path: "note.txt" }, ws.env);
      assert.equal(read.ok, true);
      assert.equal(read._read_state?.path, path);
      assert.equal(read._read_state?.sourceTool, "read");
      assert.deepEqual(Object.keys(read._read_state?.snapshot ?? {}).sort(), ["mtimeMs", "partial", "sha256", "size"]);

      ws.tracker.clear();
      const extension = filesReadStateExtension(ws.tracker);
      await extension.beforeRun!(context(ws.root, journalCall("read", "read-1", read._read_state)));
      assert.deepEqual(ws.tracker.get(path), read._read_state?.snapshot);

      const edit = await runTool(editTool, { path: "note.txt", old_string: "alpha", new_string: "ALPHA" }, ws.env);
      assert.equal(edit.ok, true, edit.output);
      assert.equal(await readFile(path, "utf8"), "ALPHA\n");
      assert.equal(edit._read_state?.sourceTool, "edit");
    } finally {
      await rm(ws.base, { recursive: true, force: true });
    }
  });

  it("rejects an external file change after restoring the persisted snapshot", async () => {
    const ws = await setup();
    try {
      const path = join(ws.root, "note.txt");
      await writeFile(path, "alpha\n");
      const read = await readTool.run({ path: "note.txt" }, ws.env);
      ws.tracker.clear();
      await filesReadStateExtension(ws.tracker).beforeRun!(context(ws.root, journalCall("read", "read-2", read._read_state)));

      await writeFile(path, "omega\n");
      await utimes(path, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
      const edit = await runTool(editTool, { path: "note.txt", old_string: "omega", new_string: "OMEGA" }, ws.env);
      assert.equal(edit.error?.code, "stale_file");
      assert.equal(await readFile(path, "utf8"), "omega\n");
    } finally {
      await rm(ws.base, { recursive: true, force: true });
    }
  });

  it("clears older authorization for a range Read and skips failures, missing metadata, and non-file calls", async () => {
    const ws = await setup();
    try {
      for (const name of ["range.txt", "failed.txt", "missing.txt", "grep.txt"]) {
        await writeFile(join(ws.root, name), "one\ntwo\nthree\n");
      }
      const full = await readTool.run({ path: "range.txt" }, ws.env);
      const range = await readTool.run({ path: "range.txt", offset: 2, limit: 1 }, ws.env);
      assert.equal(range._read_state?.range, true);
      assert.equal(range._read_state?.snapshot.sha256, createHash("sha256").update(await readFile(join(ws.root, "range.txt"))).digest("hex"));
      assert.equal(range._read_state?.snapshot.partial, true);

      const failedState = createPersistedFileReadState(join(ws.root, "failed.txt"), "read", SNAPSHOT, false);
      const grepState = createPersistedFileReadState(join(ws.root, "grep.txt"), "read", SNAPSHOT, false);
      const messages = [
        ...journalCall("read", "range-full", full._read_state),
        ...journalCall("read", "range-later", range._read_state),
        ...journalCall("read", "failed", failedState, false),
        ...journalCall("read", "missing"),
        ...journalCall("grep", "not-a-file-tool", grepState),
      ];

      ws.tracker.clear();
      await filesReadStateExtension(ws.tracker).beforeRun!(context(ws.root, messages));
      for (const name of ["range.txt", "failed.txt", "missing.txt", "grep.txt"]) {
        assert.equal(ws.tracker.get(join(ws.root, name)), undefined, name);
      }
    } finally {
      await rm(ws.base, { recursive: true, force: true });
    }
  });

  it("uses the newest successful file-tool snapshot for a path", async () => {
    const ws = await setup();
    try {
      const path = join(ws.root, "note.txt");
      await writeFile(path, "alpha\n");
      const read = await readTool.run({ path: "note.txt" }, ws.env);
      const write = await writeTool.run({ path: "note.txt", content: "bravo\n" }, ws.env);
      assert.equal(write.ok, true);
      assert.equal(write._read_state?.sourceTool, "write");
      assert.notDeepEqual(write._read_state?.snapshot, read._read_state?.snapshot);

      ws.tracker.clear();
      const messages = [
        ...journalCall("read", "read-3", read._read_state),
        ...journalCall("write", "write-3", write._read_state),
      ];
      await filesReadStateExtension(ws.tracker).beforeRun!(context(ws.root, messages));
      assert.deepEqual(ws.tracker.get(path), write._read_state?.snapshot);
      const edit = await runTool(editTool, { path: "note.txt", old_string: "bravo", new_string: "BRAVO" }, ws.env);
      assert.equal(edit.ok, true, edit.output);
    } finally {
      await rm(ws.base, { recursive: true, force: true });
    }
  });

  it("does not run the restore hook when the files plugin is disabled", async () => {
    const ws = await setup();
    try {
      const path = join(ws.root, "note.txt");
      ws.tracker.restore(path, SNAPSHOT);
      const store = new SessionStore(join(ws.base, "state"));
      const session = {
        id: "b".repeat(32),
        root: ws.root,
        task: "test",
        status: "pending",
        steps: 0,
        messages: [{ role: "system", content: "System" }, { role: "user", content: "task" }],
        results: {},
        compactions: [],
        archived_messages: [],
        completion: null,
      } as unknown as Session;
      await store.save(session);
      const extension = filesReadStateExtension(ws.tracker);
      const runner = new AgentRunner({
        store,
        provider: { async complete() { return { content: "done" }; } },
        toolBridge: { async call() { throw new Error("no tools expected"); }, async callAll() { throw new Error("no tools expected"); } },
        hooks: {
          enabled: (id) => id !== "files",
          toolOwner: () => null,
          tools: () => [],
          extensions: [extension],
        },
        root: ws.root,
      });

      await runner.run(session);
      assert.deepEqual(ws.tracker.get(path), SNAPSHOT);
    } finally {
      await rm(ws.base, { recursive: true, force: true });
    }
  });
});
