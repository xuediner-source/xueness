import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseArgv, parsePlan, refreshWorkflowPanel, subagentTaskDisplayStatus, WorkflowPanel } from "./index";
import { OperationStatus } from "../shared";

test("parsePlan accepts valid JSON and rejects malformed text with a readable message", () => {
  assert.deepEqual(parsePlan('{"name":"check","nodes":[]}'), { name: "check", nodes: [] });
  assert.throws(() => parsePlan('{"name": '), /JSON/);
});

test("parseArgv requires a JSON array of strings", () => {
  assert.deepEqual(parseArgv('["python3","-c","print(1)"]'), ["python3", "-c", "print(1)"]);
  // Malformed JSON and a valid-JSON value of the wrong shape are both rejected.
  assert.throws(() => parseArgv('python3 -c'), /JSON/);
  assert.throws(() => parseArgv('{"argv":["x"]}'), /字符串数组/);
  assert.throws(() => parseArgv('[1,2]'), /字符串数组/);
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

function pathOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
}

test("workflow refresh continues while subagent progress is disabled", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const workflow = { id: "wf-1", status: "running", root: "/workspace", concurrency: 1,
    plan: { name: "check", nodes: [] }, nodes: {}, events: [] };
  globalThis.fetch = (async input => {
    const path = pathOf(input);
    requests.push(path);
    return jsonResponse(path === "/api/workflows" ? { workflows: [{ id: "wf-1", name: "check", status: "running" }] } : workflow);
  }) as typeof fetch;
  const items: unknown[] = [], records: unknown[] = [], tasks: unknown[] = [];
  try {
    await refreshWorkflowPanel({ active: "wf-1", sessionId: "session-1", subagentsEnabled: false,
      signal: new AbortController().signal, isCurrent: () => true,
      onWorkflows: value => items.push(value), onWorkflow: value => records.push(value), onTasks: value => tasks.push(value) });
    assert.deepEqual(requests, ["/api/workflows", "/api/workflows/wf-1"]);
    assert.equal(items.length, 1);
    assert.equal(records.length, 1);
    assert.deepEqual(tasks, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a stale workflow response starts no later workflow or subagent requests", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let resolveList!: (response: Response) => void;
  globalThis.fetch = (async input => {
    requests.push(pathOf(input));
    return await new Promise<Response>(resolve => { resolveList = resolve; });
  }) as typeof fetch;
  let current = true;
  const items: unknown[] = [], records: unknown[] = [], tasks: unknown[] = [];
  try {
    const refresh = refreshWorkflowPanel({ active: "wf-1", sessionId: "session-1", subagentsEnabled: true,
      signal: new AbortController().signal, isCurrent: () => current,
      onWorkflows: value => items.push(value), onWorkflow: value => records.push(value), onTasks: value => tasks.push(value) });
    current = false;
    resolveList(jsonResponse({ workflows: [] }));
    await refresh;
    assert.deepEqual(requests, ["/api/workflows"]);
    assert.deepEqual(items, []);
    assert.deepEqual(records, []);
    assert.deepEqual(tasks, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a subagent task response is discarded after its owner becomes ineffective", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let taskSignal: AbortSignal | null = null;
  let resolveTasks!: (response: Response) => void;
  globalThis.fetch = (async (input, init) => {
    const path = pathOf(input);
    requests.push(path);
    if (path === "/api/workflows") return jsonResponse({ workflows: [] });
    taskSignal = init?.signal ?? null;
    return await new Promise<Response>(resolve => { resolveTasks = resolve; });
  }) as typeof fetch;
  const controller = new AbortController();
  let current = true;
  const tasks: unknown[] = [];
  try {
    const refresh = refreshWorkflowPanel({ active: "", sessionId: "session-1", subagentsEnabled: true,
      signal: controller.signal, isCurrent: () => current && !controller.signal.aborted,
      onWorkflows: () => undefined, onWorkflow: () => undefined, onTasks: value => tasks.push(value) });
    while (!resolveTasks) await new Promise(resolve => setImmediate(resolve));
    current = false;
    controller.abort();
    resolveTasks(jsonResponse({ tasks: [{ id: "child-1", status: "completed", steps: 1, summary: "done" }] }));
    await refresh;
    assert.deepEqual(requests, ["/api/workflows", "/api/sessions/session-1/tasks"]);
    assert.equal(taskSignal, controller.signal);
    assert.equal(controller.signal.aborted, true);
    assert.deepEqual(tasks, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("workflow panel hides subagent progress when its plugin is ineffective", () => {
  const html = renderToStaticMarkup(React.createElement(WorkflowPanel, { sessionId: "session-1", subagentsEnabled: false }));
  assert.doesNotMatch(html, /xn-subtask-card/);
});

test("a cancelled task with a live worker is shown as cancelling", () => {
  const status = subagentTaskDisplayStatus({ status: "cancelled", workerActive: true });
  assert.equal(status, "stopping");
  const html = renderToStaticMarkup(React.createElement(OperationStatus, { status }));
  assert.match(html, /data-status="stopping"/);
  assert.match(html, /正在取消/);
  assert.equal(subagentTaskDisplayStatus({ status: "cancelled", workerActive: false }), "cancelled");
});
