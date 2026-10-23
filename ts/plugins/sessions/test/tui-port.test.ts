import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { SessionStore } from "@xueness/sessions";
import { MessageQueue } from "../src/queue.ts";
import { createTuiSessionPort } from "../src/tui-session-port.ts";
import { loadProjectPermissionRules, rememberProjectPermission } from "../src/tui-project-permissions.ts";
import type { TuiPermissionRequest, TuiRow } from "../src/tui-types.ts";

const sid = "a".repeat(32);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "xueness-tui-port-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const store = new SessionStore(join(root, "state"));
  return {
    root, workspace, store,
    dispose() {
      const parent = resolve(tmpdir()), target = resolve(root), rel = relative(parent, target);
      assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel), "temporary fixture must remain beneath the OS temp directory");
      rmSync(target, { recursive: true, force: true });
    },
  };
}

function makePort(
  f: ReturnType<typeof fixture>,
  sessionId: string | null,
  api: (method: string, path: string, data?: TuiRow) => Promise<[number, TuiRow]> = async () => [404, {}],
) {
  return createTuiSessionPort({
    store: f.store, stateDir: f.store.directory, root: () => f.workspace, sessionId: () => sessionId,
    enabled: (id) => ["sessions", "files", "providers", "git"].includes(id), commands: () => [],
    selection: () => ({ providerId: "fixture", model: "mock" }), reasoningLevels: () => ["low", "medium", "high"],
    api, setMode: async (mode) => mode, stop() {},
  }).port;
}

test("session port keeps session data through a non-git 404, uses declared effort levels, and confines sorted file choices to root", async () => {
  const f = fixture();
  try {
    const session = await f.store.new("port fixture", f.workspace, { sessionId: sid });
    session.messages = [{ role: "user", content: "visible message" }];
    session.todos = [{ id: "todo-1", text: "keep this todo" }];
    session.provider_usage = [{ usage: { inputTokens: 12, outputTokens: 4 } }];
    session.context_usage = { totalTokens: 12, contextWindow: 1024 };
    session.results = { race: { ok: false, data: { awaitingApproval: true } } };
    await f.store.save(session);

    for (const name of ["z-dir", "a-dir", "node_modules", ".hidden-dir", ".git"]) mkdirSync(join(f.workspace, name));
    for (const name of ["z.txt", "a.txt", ".secret"]) writeFileSync(join(f.workspace, name), "fixture");
    writeFileSync(join(f.root, "outside.txt"), "outside root");
    const calls: string[] = [];
    const port = makePort(f, sid, async (_method, path) => {
      calls.push(path);
      if (path === "/api/providers") return [200, { providers: [{ id: "fixture", model: "mock", reasoningLevels: ["provider-only"] }] }];
      if (path.endsWith("/git/status")) {
        const latest = await f.store.load(sid);
        latest.results = { race: { ok: true, data: { output: "approval completed" } } };
        await f.store.save(latest);
        return [404, { error: "not a git repository" }];
      }
      return [404, {}];
    });

    const sidebar = await port.sidebar();
    assert.deepEqual(sidebar.todos, [{ id: "todo-1", text: "keep this todo" }]);
    assert.deepEqual(sidebar.messages?.map(({ role, content }) => ({ role, content })), [{ role: "user", content: "visible message" }]);
    assert.deepEqual(sidebar.usage, { inputTokens: 12, outputTokens: 4 });
    assert.equal(sidebar.contextUsed, 12);
    assert.equal(sidebar.contextWindow, 1024);
    assert.deepEqual(sidebar.toolResults?.race, { ok: true, data: { output: "approval completed" } });
    assert.ok(calls.includes(`/api/sessions/${sid}/git/status`));

    assert.deepEqual((await port.choices("effort", "")).map((choice) => choice.value), [
      "/effort low", "/effort medium", "/effort high",
    ]);
    const files = await port.choices("file", "");
    assert.deepEqual(files.map((choice) => choice.value), ["a-dir/", "z-dir/", "a.txt", "z.txt"]);
    assert.ok(files.every((choice) => !isAbsolute(choice.value) && !choice.value.split("/").includes("..")));
    assert.deepEqual(await port.choices("file", "../outside.txt"), []);
  } finally { f.dispose(); }
});

test("session port returns real queue and steer receipts and cancels each pending admission", async () => {
  const f = fixture();
  try {
    const session = await f.store.new("live turn", f.workspace, { sessionId: sid });
    session.status = "running"; session.active_turn_id = "turn-1";
    await f.store.save(session);
    await new MessageQueue(f.store).setAccepting(sid, true);
    const port = makePort(f, sid);
    const queued = await port.sendInput("queued text", [], "queue");
    const steered = await port.sendInput("steered text", [], "steer");
    assert.deepEqual([queued.kind, queued.status, queued.text], ["queue", "queued", "queued text"]);
    assert.deepEqual([steered.kind, steered.status, steered.text], ["steer", "queued", "steered text"]);
    const before = await port.sidebar();
    assert.deepEqual(before.queued?.map(({ id, kind, status }) => ({ id, kind, status })), [
      { id: queued.id, kind: "queue", status: "queued" },
      { id: steered.id, kind: "steer", status: "queued" },
    ]);

    await port.cancelInput(queued.id, "queue");
    await port.cancelInput(steered.id, "steer");
    assert.deepEqual((await port.sidebar()).queued, []);
  } finally { f.dispose(); }
});

test("project permission memory persists exact approval rules per root and rejects once or broad-only rules", () => {
  const f = fixture();
  try {
    const otherRoot = join(f.root, "other-workspace"); mkdirSync(otherRoot);
    const request = (code: string, remember: TuiPermissionRequest["remember"]): TuiPermissionRequest => ({
      callId: "call-1", tool: "write_file", kind: "write", subject: "a.txt", code, message: "Needs approval",
      remember, signal: new AbortController().signal,
    });
    const approved = request("approval_required", { exact: ["write:a.txt", "delete:b.txt"], broad: ["write:*"] });
    rememberProjectPermission(f.store.directory, f.workspace, approved, ["write:a.txt"]);
    assert.deepEqual(loadProjectPermissionRules(f.store.directory, f.workspace), ["write:a.txt"]);
    assert.deepEqual(loadProjectPermissionRules(f.store.directory, otherRoot), []);
    assert.throws(() => rememberProjectPermission(f.store.directory, f.workspace, approved, ["write:*"]), /exact project rules/);
    assert.throws(() => rememberProjectPermission(f.store.directory, f.workspace, approved, []), /exact project rules/);
    assert.throws(() => rememberProjectPermission(f.store.directory, f.workspace, request("approval_required", null), ["write:a.txt"]), /exact project rules/);
    assert.throws(() => rememberProjectPermission(f.store.directory, f.workspace, request("approval_denied", approved.remember), ["write:a.txt"]), /exact project rules/);
  } finally { f.dispose(); }
});

test("session port subscribe reports state writes and stops reporting after unsubscribe", async () => {
  const f = fixture();
  try {
    const session = await f.store.new("watch fixture", f.workspace, { sessionId: sid });
    const port = makePort(f, sid);
    let changes = 0;
    const errors: Error[] = [];
    const unsubscribe = port.subscribe!(() => { changes += 1; }, (error) => errors.push(error));
    const wait = async (predicate: () => boolean, timeout = 2000): Promise<void> => {
      const start = Date.now();
      while (!predicate() && Date.now() - start < timeout) await new Promise((resolve) => setTimeout(resolve, 20));
    };
    session.messages = [...session.messages as TuiRow[], { role: "assistant", content: "first change" }];
    await f.store.save(session);
    await wait(() => changes > 0);
    assert.ok(changes > 0, "expected a session file change notification");
    assert.deepEqual(errors, []);

    unsubscribe();
    const afterClose = changes;
    session.messages = [...session.messages as TuiRow[], { role: "assistant", content: "after close" }];
    await f.store.save(session);
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(changes, afterClose);
  } finally { f.dispose(); }
});
