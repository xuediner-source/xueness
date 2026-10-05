import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExpertPanel, expertPhaseStates, refreshExpertPanel, selectExpertRun, type ExpertRun } from "./ExpertPanel";

function run(overrides: Partial<ExpertRun>): ExpertRun {
  return {
    id: "e".repeat(32), session: null, task: "修复登录超时", root: "/workspace",
    permission_mode: "build", status: "running", phase: "plan",
    phases: {
      research: { status: "completed", summary: "调研纪要" },
      plan: { status: "running", summary: "" },
      implement: { status: "pending", summary: "" },
      review: { status: "pending", summary: "" },
    },
    created_at: 1, updated_at: 2, ...overrides,
  };
}

test("selectExpertRun prefers the session's active run over a newer settled one", () => {
  const settled = run({ id: "a".repeat(32), status: "done" });
  const active = run({ id: "b".repeat(32), status: "paused" });
  assert.equal(selectExpertRun([settled, active])?.id, "b".repeat(32));
  assert.equal(selectExpertRun([settled])?.id, "a".repeat(32));
  assert.equal(selectExpertRun([]), null);
});

test("expertPhaseStates keeps the fixed research→plan→implement→review order", () => {
  const states = expertPhaseStates(run({}));
  assert.deepEqual(states.map(state => state.id), ["research", "plan", "implement", "review"]);
  assert.deepEqual(states.map(state => state.status),
    ["completed", "running", "pending", "pending"]);
  // A missing phase entry reads as pending, never as an error.
  assert.equal(expertPhaseStates({ phases: {} })[0].status, "pending");
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

function pathOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
}

test("refreshExpertPanel scopes the poll to the current session", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async input => {
    requests.push(pathOf(input));
    return jsonResponse({ expert_runs: [run({})] });
  }) as typeof fetch;
  const seen: ExpertRun[][] = [];
  try {
    await refreshExpertPanel({ sessionId: "s".repeat(32), signal: new AbortController().signal,
      isCurrent: () => true, onRuns: value => seen.push(value) });
    assert.deepEqual(requests, ["/api/workflows/expert?session=" + "s".repeat(32)]);
    await refreshExpertPanel({ sessionId: null, signal: new AbortController().signal,
      isCurrent: () => false, onRuns: value => seen.push(value) });
    assert.deepEqual(requests[1], "/api/workflows/expert");
    // A stale response is dropped instead of overwriting newer state.
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0].task, "修复登录超时");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the panel renders its fixed structure without a session", () => {
  const markup = renderToStaticMarkup(React.createElement(ExpertPanel, { sessionId: null }));
  assert.match(markup, /专家工作流/);
  assert.match(markup, /调研/);
  assert.match(markup, /选择会话后查看专家工作流。/);
});
