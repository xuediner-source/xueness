import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { createNodeReplTool, formatReplValue, ReplSessions, type NodeReplData } from "../src/index.ts";
import { workspace } from "./helpers.ts";

const ws = workspace();

describe("persistent repl state (F12.01)", () => {
  it("shares variables and helpers across calls in one session", async () => {
    const sessions = new ReplSessions();
    const first = await sessions.run("s1", "const total = 21; total * 2");
    assert.equal(first.ok, true);
    assert.equal(first.kind, "number");
    assert.equal((first as { value: string }).value, "42");
    const second = await sessions.run("s1", "total + 1");
    assert.equal((second as { value: string }).value, "22");
    // Imported modules persist like any other binding.
    const third = await sessions.run("s1", "const path = await import('node:path'); path.basename('/a/b.txt')");
    assert.equal(third.ok, true);
    assert.equal((third as { value: string }).value, '"b.txt"');
    const fourth = await sessions.run("s1", "path.join('x', 'y')");
    assert.equal((fourth as { value: string }).value, JSON.stringify(join("x", "y")));
  });

  it("isolates different sessions from each other", async () => {
    const sessions = new ReplSessions();
    await sessions.run("alice", "let mine = 'alice'");
    const cross = await sessions.run("bob", "typeof mine");
    assert.equal(cross.ok, true);
    assert.equal((cross as { value: string }).value, '"undefined"');
  });

  it("reset gives a clean context while keeping the session alive", async () => {
    const sessions = new ReplSessions();
    await sessions.run("s", "const gone = 1; 1");
    const before = sessions.info("s");
    const reset = sessions.reset("s");
    assert.equal(reset.epoch, before.epoch + 1);
    assert.equal(reset.calls, 0);
    const after = await sessions.run("s", "typeof gone");
    assert.equal((after as { value: string }).value, '"undefined"');
    assert.equal(sessions.info("s").calls, 1);
  });

  it("supports top-level await and awaited promises", async () => {
    const sessions = new ReplSessions();
    const outcome = await sessions.run("async", "await Promise.resolve(7)");
    assert.equal((outcome as { value: string }).value, "7");
  });

  it("imports host modules through nodeImport and dynamic import", async () => {
    const sessions = new ReplSessions();
    const shim = await sessions.run("imp", "const os = await nodeImport('node:os'); typeof os.EOL");
    assert.equal((shim as { value: string }).value, '"string"');
    const dynamic = await sessions.run("imp2", "(await import('node:util')).types.isDate(new Date())");
    assert.equal(dynamic.ok, true);
    assert.equal((dynamic as { value: string }).value, "true");
  });
});

describe("repl cancellation and bounds (F12.01)", () => {
  it("cuts infinite loops with tool_timeout and keeps the session usable", async () => {
    const sessions = new ReplSessions();
    const hung = await sessions.run("loop", "while (true) {}", { timeoutMs: 200 });
    assert.equal(hung.ok, false);
    assert.equal((hung as { code: string }).code, "tool_timeout");
    const fine = await sessions.run("loop", "1 + 1", { timeoutMs: 1000 });
    assert.equal((fine as { value: string }).value, "2");
    // State written before the timeout survives.
    await sessions.run("loop2", "keeper = 5", { timeoutMs: 500 });
    await sessions.run("loop2", "while (true) {}", { timeoutMs: 100 });
    const kept = await sessions.run("loop2", "keeper");
    assert.equal((kept as { value: string }).value, "5");
  });

  it("cuts never-settling awaits with tool_timeout and keeps the session usable", async () => {
    const sessions = new ReplSessions();
    const pending = await sessions.run("hang", "await new Promise(() => {})", { timeoutMs: 150 });
    assert.equal(pending.ok, false);
    assert.equal((pending as { code: string }).code, "tool_timeout");
    const fine = await sessions.run("hang", "2 + 2");
    assert.equal((fine as { value: string }).value, "4");
  });

  it("refuses to run once the manager is disposed", async () => {
    const sessions = new ReplSessions();
    await sessions.run("gone", "1");
    sessions.dispose();
    await assert.rejects(() => sessions.run("gone", "1"), /sessions are closed/);
  });

  it("honours an abort signal settled before the call", async () => {
    const sessions = new ReplSessions();
    const controller = new AbortController();
    controller.abort();
    const outcome = await sessions.run("aborted", "1", { signal: controller.signal });
    assert.equal((outcome as { code: string }).code, "cancelled");
  });

  it("caps concurrent sessions", async () => {
    const sessions = new ReplSessions();
    for (let i = 0; i < 16; i += 1) await sessions.run(`owner-${i}`, "1");
    await assert.rejects(() => sessions.run("owner-17", "1"), /too many repl sessions/);
  });

  it("runs dispose hooks for host-granted resources", async () => {
    const sessions = new ReplSessions();
    let released = false;
    sessions.onDispose(() => {
      released = true;
    });
    sessions.dispose();
    assert.equal(released, true);
  });
});

describe("repl errors and serialization (F12.01)", () => {
  it("classifies syntax errors as invalid_argument", async () => {
    const sessions = new ReplSessions();
    const outcome = await sessions.run("syntax", "const const");
    assert.equal(outcome.ok, false);
    assert.equal((outcome as { code: string }).code, "invalid_argument");
  });

  it("captures console output from the sandbox", async () => {
    const sessions = new ReplSessions();
    const outcome = await sessions.run("log", "console.log('hello', {a: 1}); console.error('bad'); 'done'");
    assert.deepEqual(outcome.lines, ["hello { a: 1 }", "error: bad"]);
    assert.equal((outcome as { value: string }).value, '"done"');
  });

  it("formats results without throwing on cycles, proxies and functions", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    assert.equal(formatReplValue(cyclic), "{ self: [Circular] }");
    assert.equal(formatReplValue(() => undefined), "[Function: anonymous]");
    assert.equal(formatReplValue(new Map([["k", 1]])), 'Map(1) { "k" => 1 }');
    const hostile = new Proxy({}, { get() {
      throw new Error("no");
    } });
    assert.equal(typeof formatReplValue(hostile), "string");
  });
});

describe("node_repl tool (F12.01)", () => {
  const tool = createNodeReplTool();

  it("returns session identity and output through the tool result", async () => {
    const result = await ws.run<NodeReplData>(tool, { code: "2 ** 10" });
    assert.equal(result.ok, true);
    assert.equal(result.data?.result, "1024");
    assert.equal(result.data?.owner, "default");
    assert.match(result.data?.session_id ?? "", /^repl-[0-9a-f]{12}$/);
    assert.match(result.output, /=> 1024/);
  });

  it("carries the owner session from the environment", async () => {
    const sessions = new ReplSessions();
    const owned = createNodeReplTool({ sessions });
    ws.env.owner = "session-xyz";
    try {
      assert.equal((await ws.run(owned, { code: "own = 3" })).ok, true);
      const persisted = await ws.run<NodeReplData>(owned, { code: "own * 3" });
      assert.equal(persisted.data?.result, "9");
      assert.equal(persisted.data?.owner, "session-xyz");
    } finally {
      ws.env.owner = undefined;
    }
  });

  it("reset:true restarts the context under the same session", async () => {
    await ws.run(tool, { code: "const marker = 'keep-me'" });
    const reset = await ws.run<NodeReplData>(tool, { code: "typeof marker", reset: true });
    assert.equal(reset.data?.result, '"undefined"');
  });

  it("a cancelled first call reports identity without inventing a session", async () => {
    // runTool short-circuits an aborted env, so this exercises the tool's own
    // path: a cancel that arrives before the first context exists must still
    // report the would-be identity instead of failing as unknown_session.
    const sessions = new ReplSessions();
    const controller = new AbortController();
    controller.abort();
    const result = await createNodeReplTool({ sessions }).run(
      { code: "1" }, { ...ws.env, owner: "cancelled", signal: controller.signal },
    );
    assert.equal(result.ok, false);
    assert.equal(result.data?.error_code, "cancelled");
    assert.match(result.data?.session_id ?? "", /^repl-[0-9a-f]{12}$/);
    assert.equal(result.data?.epoch, 1);
    assert.deepEqual(sessions.list(), []);
  });

  it("reports invalid input through the schema gate", async () => {
    const bad = await ws.run(tool, {});
    assert.equal(bad.ok, false);
    assert.equal(bad.error?.code, "invalid_argument");
  });
});

describe("repl teardown with the workspace", () => {
  it("disposes cleanly", () => {
    const sessions = new ReplSessions();
    sessions.dispose();
    assert.deepEqual(sessions.list(), []);
  });
});
