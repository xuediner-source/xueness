import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SessionStore } from "@xueness/sessions";
import {
  CANDIDATE_LIMIT, DynamicRunError, cancelRun, chat, dispatchDynamicRuns, listRuns, ownerSessionId,
  parseInvocation, resumeRun, SESSION, SUBCOMMANDS, USAGE,
} from "../src/dynamic-runs.ts";
import type { DynamicHttpOptions } from "../src/dynamic-runs.ts";
import { WorkflowStore } from "../src/store.ts";

const SID = "a".repeat(32);
const OTHER = "b".repeat(32);
const PLAN = { name: "Fixture plan", nodes: [{ id: "one", kind: "command", argv: ["echo", "hi"] }], concurrency: 1 };
const AGENT_PLAN = { name: "Actor plan", nodes: [{ id: "one", kind: "agent", prompt: "say hi" }], concurrency: 1 };

function fixture(): { state: string; root: string; sessions: SessionStore; cleanup(): void } {
  const state = mkdtempSync(join(tmpdir(), "xueness-dwf-"));
  const root = join(state, "workspace");
  mkdirSync(root, { recursive: true });
  return { state, root, sessions: new SessionStore(join(state, "sessions")), cleanup: () => rmSync(state, { recursive: true, force: true }) };
}

async function session(sessions: SessionStore, root: string, id = SID): Promise<void> {
  await sessions.new("fixture task", root, { sessionId: id });
}

function http(options: Partial<DynamicHttpOptions> & Pick<DynamicHttpOptions, "stateDir" | "sessions">): DynamicHttpOptions {
  return { allowedRoots: () => [options.stateDir], ...options };
}

/** The `DynamicRunError` `body` raises (`assert.throws` returns nothing). */
function refused(body: () => unknown): DynamicRunError {
  try {
    body();
  } catch (error) {
    assert.ok(error instanceof DynamicRunError, `expected a DynamicRunError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected a DynamicRunError");
}

describe("dynamic workflow runs", () => {
  it("keeps the fixed constants and only accepts 32-hex session ids", () => {
    assert.equal(SESSION.source, "^[0-9a-f]{32}$");
    assert.deepEqual([...SUBCOMMANDS], ["list", "cancel", "resume"]);
    assert.equal(CANDIDATE_LIMIT, 8);
    assert.equal(USAGE, "dwf [list|cancel [runId]|resume <runId>] --session <id>");
    assert.equal(ownerSessionId({ id: SID }), SID);
    for (const bad of [{}, { id: "A".repeat(32) }, { id: "a".repeat(31) }, { id: "a".repeat(33) }, { id: 42 }, null, undefined]) {
      assert.equal(ownerSessionId(bad as never), null);
    }
  });

  it("lists only the runs attributed to the asking session", async () => {
    const f = fixture();
    try {
      await session(f.sessions, f.root);
      await session(f.sessions, f.root, OTHER);
      const store = new WorkflowStore(f.state);
      const mine = store.create(PLAN, f.root, undefined, SID);
      const theirs = store.create(PLAN, f.root, undefined, OTHER);
      const plain = store.create(PLAN, f.root);
      const listed = listRuns(f.state, f.sessions, SID);
      const ids = (listed.runs as Record<string, unknown>[]).map((run) => run.id);
      assert.deepEqual(ids, [mine.id, plain.id].sort((a, b) => ids.indexOf(a) - ids.indexOf(b)));
      assert.equal(ids.includes(theirs.id), false);
      const byId = new Map((listed.runs as Record<string, unknown>[]).map((run) => [run.id, run]));
      assert.equal(byId.get(mine.id)!.attribution, "session");
      assert.equal(byId.get(plain.id)!.attribution, "workspace");
      assert.equal(listed.session, SID);
      assert.equal(listed.workspace, f.root);
      assert.equal(byId.get(mine.id)!.resumable, false);
      assert.deepEqual(byId.get(mine.id)!.resumeRefusal, {
        reason: "not_started", detail: "运行尚未启动过，请使用 workflow start 或在面板批准计划后启动。",
      });
    } finally { f.cleanup(); }
  });

  it("caps the candidate rows at CANDIDATE_LIMIT", async () => {
    const f = fixture();
    try {
      await session(f.sessions, f.root);
      const store = new WorkflowStore(f.state);
      for (let index = 0; index < CANDIDATE_LIMIT + 2; index += 1) store.create(PLAN, f.root, undefined, SID);
      const error = refused(() => cancelRun(f.state, f.sessions, SID));
      assert.equal(error.reason, "none_in_flight");
      assert.equal(error.status, 409);
      assert.equal((error.extra.runs as unknown[]).length, CANDIDATE_LIMIT);
      assert.deepEqual(Object.keys(error.payload()), ["ok", "status", "refusal", "runs"]);
    } finally { f.cleanup(); }
  });

  it("parses every supported invocation and refuses the rest", () => {
    assert.deepEqual(parseInvocation(""), ["list", null]);
    assert.deepEqual(parseInvocation("   "), ["list", null]);
    assert.deepEqual(parseInvocation("list"), ["list", null]);
    assert.deepEqual(parseInvocation("LIST"), ["list", null]);
    assert.deepEqual(parseInvocation("cancel"), ["cancel", null]);
    assert.deepEqual(parseInvocation(`cancel ${SID}`), ["cancel", SID]);
    assert.deepEqual(parseInvocation(`resume ${SID}`), ["resume", SID]);
    const refusals: [string, string][] = [
      ["nope", "未知的 dwf 子命令: nope；用法 /" + USAGE],
      [`list ${SID}`, "用法 /" + USAGE],
      [`cancel ${SID} extra`, "用法 /" + USAGE],
      ["resume", "resume 必须指定一个 runId；用法 /" + USAGE],
    ];
    for (const [text, message] of refusals) {
      const error = refused(() => parseInvocation(text));
      assert.equal(error.reason, "invalid_arguments");
      assert.equal(error.status, 400);
      assert.equal(error.message, "invalid_arguments: " + message);
    }
  });

  it("cancels a settled run idempotently and an active run for real", async () => {
    const f = fixture();
    try {
      await session(f.sessions, f.root);
      const store = new WorkflowStore(f.state);
      const settled = store.create(PLAN, f.root, undefined, SID);
      store.update(settled.id, (record) => { record.status = "cancelled"; });
      const repeat = cancelRun(f.state, f.sessions, SID, settled.id);
      assert.equal(repeat.alreadyCancelled, true);
      assert.equal((repeat.run as Record<string, unknown>).status, "cancelled");
      assert.equal(store.load(settled.id).status, "cancelled");
      const active = store.create(PLAN, f.root, undefined, SID);
      store.update(active.id, (record) => { record.status = "running"; });
      const cancelled = cancelRun(f.state, f.sessions, SID, active.id);
      assert.equal(cancelled.alreadyCancelled, false);
      assert.equal((cancelled.run as Record<string, unknown>).status, "stopping");
      assert.equal(store.load(active.id).status, "stopping");
      const finished = store.create(PLAN, f.root, undefined, SID);
      store.update(finished.id, (record) => { record.status = "completed"; });
      const error = refused(() => cancelRun(f.state, f.sessions, SID, finished.id));
      assert.equal(error.reason, "not_active");
      assert.equal(error.status, 409);
      assert.equal(error.detail, "运行已结束（completed），无法取消；记录保持不变。");
    } finally { f.cleanup(); }
  });

  it("refuses to resume a run that lives in another workspace", async () => {
    const f = fixture();
    try {
      await session(f.sessions, f.root);
      const elsewhere = join(f.state, "elsewhere");
      mkdirSync(elsewhere, { recursive: true });
      const foreign = new WorkflowStore(f.state).create(PLAN, elsewhere);
      const error = refused(() => resumeRun(f.state, f.sessions, SID, foreign.id, { approved: true }));
      assert.equal(error.reason, "not_found");
      assert.equal(error.status, 404);
      assert.equal(error.detail, `该会话的工作区里没有 id 为 ${foreign.id} 的工作流运行`);
      const bad = refused(() => resumeRun(f.state, f.sessions, SID, "nope", { approved: true }));
      assert.equal(bad.reason, "invalid_run");
      assert.equal(bad.status, 400);
    } finally { f.cleanup(); }
  });

  it("requires approval for command plans and the host switch for actor plans", async () => {
    const f = fixture();
    try {
      await session(f.sessions, f.root);
      const store = new WorkflowStore(f.state);
      const command = store.create(PLAN, f.root, undefined, SID);
      store.update(command.id, (record) => { record.status = "failed"; });
      const needsApproval = refused(() => resumeRun(f.state, f.sessions, SID, command.id));
      assert.equal(needsApproval.reason, "approval_required");
      assert.equal(needsApproval.status, 403);
      const actor = store.create(AGENT_PLAN, f.root, undefined, SID);
      store.update(actor.id, (record) => { record.status = "failed"; });
      const needsModel = refused(() => resumeRun(f.state, f.sessions, SID, actor.id));
      assert.equal(needsModel.reason, "model_execution_disabled");
      assert.equal(needsModel.status, 403);
    } finally { f.cleanup(); }
  });

  it("answers the chat face with the same refusals", async () => {
    const f = fixture();
    try {
      await session(f.sessions, f.root);
      const listed = chat(f.state, f.sessions, { id: SID }, "");
      assert.equal(listed.session, SID);
      const missing = refused(() => chat(f.state, f.sessions, {}, "list"));
      assert.equal(missing.reason, "session_not_found");
      assert.equal(missing.status, 404);
      assert.equal(missing.detail, "当前还没有会话，无法管理动态工作流运行。");
      const unknown = refused(() => chat(f.state, f.sessions, { id: OTHER }, "list"));
      assert.equal(unknown.reason, "session_not_found");
      assert.equal(unknown.detail, `未知会话: ${OTHER}`);
    } finally { f.cleanup(); }
  });

  it("dispatches only /api/workflows/dwf and answers bad run ids with a refusal body", async () => {
    const f = fixture();
    try {
      await session(f.sessions, f.root);
      const options = http({ stateDir: f.state, sessions: f.sessions, allowedRoots: () => [f.root] });
      assert.equal(dispatchDynamicRuns("GET", ["api", "sessions"], {}, {}, options), null);
      assert.equal(dispatchDynamicRuns("GET", ["api", "workflows", "other"], {}, {}, options), null);
      assert.deepEqual(dispatchDynamicRuns("GET", ["api", "workflows", "dwf", "bogus"], {}, {}, options), [404, { error: "operation not found" }]);
      assert.deepEqual(dispatchDynamicRuns("GET", ["api", "workflows", "dwf", "cancel"], {}, {}, options), [405, { error: "method not allowed" }]);
      assert.deepEqual(dispatchDynamicRuns("POST", ["api", "workflows", "dwf"], {}, {}, options), [405, { error: "method not allowed" }]);
      assert.deepEqual(dispatchDynamicRuns("POST", ["api", "workflows", "dwf", "resume"], {}, { session: SID }, options), [400, { error: "resume requires runId" }]);
      assert.deepEqual(dispatchDynamicRuns("POST", ["api", "workflows", "dwf", "cancel"], {}, { session: SID, runId: 7 }, options), [400, { error: "runId must be a string" }]);
      assert.deepEqual(dispatchDynamicRuns("POST", ["api", "workflows", "dwf", "cancel"], {}, { session: SID, extra: 1 }, options), [400, { error: "expected session, optional runId and approve" }]);
      const [status, body] = dispatchDynamicRuns("POST", ["api", "workflows", "dwf", "cancel"], {}, { session: SID, runId: "nope" }, options)!;
      assert.equal(status, 400);
      assert.deepEqual(body, { ok: false, status: 400, refusal: { reason: "invalid_run", detail: "runId 需要 32 位十六进制的工作流 id" } });
      const [listed, listing] = dispatchDynamicRuns("GET", ["api", "workflows", "dwf"], { session: [SID] }, {}, options)!;
      assert.equal(listed, 200);
      assert.equal((listing as Record<string, unknown>).session, SID);
      const denied = http({ stateDir: f.state, sessions: f.sessions, allowedRoots: () => [join(f.state, "elsewhere")] });
      const [blocked, deniedBody] = dispatchDynamicRuns("GET", ["api", "workflows", "dwf"], { session: [SID] }, {}, denied)!;
      assert.equal(blocked, 403);
      assert.deepEqual(deniedBody, { ok: false, status: 403, refusal: { reason: "workspace_not_allowed", detail: "会话工作区不在服务器允许的范围内。" } });
    } finally { f.cleanup(); }
  });
});
