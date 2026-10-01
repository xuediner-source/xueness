/**
 * Git panel data layer tests: status / diff / log loaders over
 * `/api/sessions/<id>/git/<verb>` with `globalThis.fetch` stubbed.
 *
 * Contract under test: a success resolves to `{ok:true, value}` and any HTTP
 * or network failure resolves to `{ok:false, error}` — never a throw. The
 * backend's 404 body ("该工作区不是 git 仓库") must pass through verbatim so
 * the view can render an honest empty state.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { loadGitStatus, loadGitDiff, loadGitLog, stageGitPaths, restoreGitCheckpoint } from "./xuenessGit";

type Call = { url: string; method: string; headers: Record<string, unknown> };

type StubResult = { status: number; body?: unknown } | "network-error";

/** Install a fetch stub that records calls and replies via `handler`. */
function stubFetch(handler: (url: string, method: string) => StubResult): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, headers: (init?.headers ?? {}) as Record<string, unknown> });
    const result = handler(url, method);
    if (result === "network-error") throw new Error("network down");
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

const SID = "a".repeat(32);

/* ------------------------------------------------------------------ */
/* loadGitStatus → GET /api/sessions/<id>/git/status                    */
/* ------------------------------------------------------------------ */

test("loadGitStatus returns the status payload from the git route", async () => {
  const original = globalThis.fetch;
  try {
    const body = { branch: "main", entries: [{ code: "??", path: "new.txt" }], clean: false };
    const calls = stubFetch((url, method) => {
      assert.equal(url, `/api/sessions/${SID}/git/status`);
      assert.equal(method, "GET");
      return { status: 200, body };
    });
    const res = await loadGitStatus(SID);
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.value, body);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
  } finally {
    globalThis.fetch = original;
  }
});

test("loadGitStatus reports the not-a-repo 404 error verbatim", async () => {
  const original = globalThis.fetch;
  try {
    stubFetch(() => ({ status: 404, body: { error: "该工作区不是 git 仓库" } }));
    const res = await loadGitStatus(SID);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error, "该工作区不是 git 仓库");
  } finally {
    globalThis.fetch = original;
  }
});

/* ------------------------------------------------------------------ */
/* loadGitDiff → GET /api/sessions/<id>/git/diff                        */
/* ------------------------------------------------------------------ */

test("loadGitDiff returns stat, patch and the truncated flag", async () => {
  const original = globalThis.fetch;
  try {
    const body = { stat: " a.txt | 2 +-\n", patch: "diff --git a/a.txt b/a.txt\n", truncated: true };
    stubFetch((url) => {
      assert.equal(url, `/api/sessions/${SID}/git/diff`);
      return { status: 200, body };
    });
    const res = await loadGitDiff(SID);
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.value, body);
  } finally {
    globalThis.fetch = original;
  }
});

test("loadGitDiff reports an HTTP failure without throwing", async () => {
  const original = globalThis.fetch;
  try {
    stubFetch(() => ({ status: 500, body: { error: "git 命令失败" } }));
    const res = await loadGitDiff(SID);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /git 命令失败/);
  } finally {
    globalThis.fetch = original;
  }
});

/* ------------------------------------------------------------------ */
/* loadGitLog → GET /api/sessions/<id>/git/log                          */
/* ------------------------------------------------------------------ */

test("loadGitLog returns the commits array", async () => {
  const original = globalThis.fetch;
  try {
    const commits = [
      { hash: "h".repeat(40), short: "h".repeat(7), author: "Test", date: "2026-09-28T00:00:00+00:00", subject: "initial commit" },
    ];
    stubFetch((url) => {
      assert.equal(url, `/api/sessions/${SID}/git/log`);
      return { status: 200, body: { commits } };
    });
    const res = await loadGitLog(SID);
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.value, commits);
  } finally {
    globalThis.fetch = original;
  }
});

test("loadGitLog reports an HTTP failure without throwing", async () => {
  const original = globalThis.fetch;
  try {
    stubFetch(() => ({ status: 501, body: { error: "git 不可用：运行环境未安装 git" } }));
    const res = await loadGitLog(SID);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /git 不可用/);
  } finally {
    globalThis.fetch = original;
  }
});

/* ------------------------------------------------------------------ */
/* 共享失败路径：网络错误与非 JSON 响应                                   */
/* ------------------------------------------------------------------ */

test("all loaders report a network failure without throwing", async () => {
  const original = globalThis.fetch;
  try {
    for (const load of ([
      ["status", loadGitStatus],
      ["diff", loadGitDiff],
      ["log", loadGitLog],
    ] as const)) {
      stubFetch(() => "network-error");
      const res = await load[1]("b".repeat(32));
      assert.equal(res.ok, false, load[0]);
      if (!res.ok) assert.match(res.error, /network down/);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("Git mutations acquire CSRF and send explicit confirmation; restore targets the reviewed checkpoint", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; method: string; body?: unknown; headers: Headers }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(url === "/api/csrf" ? { csrfToken: "csrf-test" } : { restored: "checkpoint-7", recovery: { id: "recovery", hash: "abc", message: "recovery" } }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const staged = await stageGitPaths(SID, ["src/a.ts"]);
    assert.equal(staged.ok, true);
    const restored = await restoreGitCheckpoint(SID, "checkpoint-7");
    assert.equal(restored.ok, true);
    assert.deepEqual(calls.filter(call => call.method === "POST").map(call => [call.url, call.body]), [
      [`/api/sessions/${SID}/git/stage`, { paths: ["src/a.ts"], confirmed: true }],
      [`/api/sessions/${SID}/git/checkpoints/checkpoint-7/restore`, { confirmed: true }],
    ]);
    assert.equal(calls.filter(call => call.method === "POST").every(call => call.headers.get("X-CSRF-Token") === "csrf-test"), true);
  } finally { globalThis.fetch = original; }
});

test("a non-JSON 200 response is reported as invalid, not as success", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response("<html>gateway</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })) as typeof fetch;
    const res = await loadGitStatus(SID);
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /invalid JSON/);
  } finally {
    globalThis.fetch = original;
  }
});
