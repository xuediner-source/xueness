import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isDict, normalizeError } from "@xueness/contracts";
import { SessionStore } from "@xueness/sessions";
import { createSessionsApi } from "../src/http-api.ts";
import { createSessionLifecycleApi } from "../src/lifecycle-api.ts";
import { messageRevision } from "../src/journal-http.ts";
import { pythonUnavailableReason, runPythonAsync } from "../../../test-support/python-oracle.ts";
import type { LifecycleOptions } from "../src/lifecycle-types.ts";
type Row = Record<string, unknown>;
interface Request { method: string; path: string; data?: Row }
const oraclePath = join(import.meta.dirname, "../../../test-support/python/http_feature_oracle.py");
const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize) : isDict(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, ["at", "updatedAt", "trace_id"].includes(k) ? "(dynamic)" : normalize(v)])) : typeof value === "string" ? value.replace(/reference [0-9a-f]{16}/g, "reference (trace)") : value;
describe("sessions feature matches real Python HTTP", { skip: pythonUnavailableReason() ?? false }, () => {
  it("reads revision-bound pages/detail/events/export and preserves management contracts", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-sessions-http-")), stateDir = join(root, "ts"), pythonState = join(root, "python");
    mkdirSync(stateDir); const store = new SessionStore(stateDir);
    try {
      const session = await store.new("Hello", root, { sessionId: "a".repeat(32) });
      (session.messages as Row[]).push({ role: "assistant", content: "Hello", _message_id: "b".repeat(32), _turn_id: "turn-1" });
      session.status = "completed"; session.reasoning_history = [{ message_index: 2, text: "brief reasoning" }, { message_index: 1, text: "hidden" }];
      session.reasoning_timing = [{ message_index: 2, started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T00:00:01Z" }];
      await store.save(session);
      cpSync(stateDir, pythonState, { recursive: true });
      const sid = String(session.id), revision = messageRevision(session);
      const requests: Request[] = [
        { method: "GET", path: "/api/sessions" },
        { method: "GET", path: `/api/sessions/${sid}` },
        { method: "GET", path: `/api/sessions/${sid}/conversation` },
        { method: "GET", path: `/api/sessions/${sid}/conversation?tail=2` },
        { method: "GET", path: `/api/sessions/${sid}/conversation?before=2&limit=1` },
        { method: "GET", path: `/api/sessions/${sid}/conversation?before=200&limit=1` },
        { method: "GET", path: `/api/sessions/${sid}/conversation?tail=2&before=1` },
        { method: "GET", path: `/api/sessions/${sid}/conversation?tail=0` },
        { method: "GET", path: `/api/sessions/${sid}/conversation?revision=stale` },
        { method: "GET", path: `/api/sessions/${sid}/journal?limit=1` },
        { method: "GET", path: `/api/sessions/${sid}/journal?limit=` },
        { method: "GET", path: `/api/sessions/${sid}/journal?cursor=2&message_revision=${revision}&limit=1` },
        { method: "GET", path: `/api/sessions/${sid}/journal?cursor=2` },
        { method: "GET", path: `/api/sessions/${sid}/journal?cursor=2&message_revision=stale` },
        { method: "GET", path: `/api/sessions/${sid}/events.v1?cursor=-2&limit=2` },
        { method: "GET", path: `/api/sessions/${sid}/events.v1?cursor=invalid` },
        { method: "GET", path: `/api/sessions/${sid}/export` },
        { method: "PATCH", path: `/api/sessions/${sid}`, data: { title: " " } },
        { method: "PATCH", path: `/api/sessions/${sid}`, data: { title: "Renamed" } },
        { method: "POST", path: `/api/sessions/${sid}/pin`, data: { pinned: 1 } },
        { method: "POST", path: `/api/sessions/${sid}/pin`, data: { pinned: true } },
        { method: "GET", path: "/api/sessions/archived" },
      ];
      const expected = JSON.parse(await runPythonAsync(`import runpy; runpy.run_path(${JSON.stringify(oraclePath)},run_name='__main__')`, JSON.stringify({ stateDir: pythonState, workspace: root, requests })));
      const api = createSessionsApi({ store, stateDir, webRuns: join(root, "web-runs"), projectDir: root, enabled: () => true, publicOptions: { enabled: () => true, approvals: new Map() } });
      const actual: unknown[] = [];
      for (const r of requests) {
        const url = new URL(r.path, "http://127.0.0.1"), query: Row = {};
        for (const [k, v] of url.searchParams) (query[k] ??= [] as string[] as unknown) && (query[k] as string[]).push(v);
        const reply = await api.dispatch(r.method, url.pathname.split("/").filter(Boolean), query, r.data ?? {});
        assert.ok(reply, r.path); actual.push([reply[0], reply[0] >= 400 && isDict(reply[1]) ? normalizeError(reply[0], reply[1]) : reply[1]]);
      }
      assert.deepEqual(normalize(actual), normalize(expected));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("matches lifecycle validation/refusals without making model requests", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-lifecycle-http-")), stateDir = join(root, "ts"), pyState = join(root, "python"); mkdirSync(stateDir);
    const store = new SessionStore(stateDir);
    try {
      const session = await store.new("Hello", root, { sessionId: "a".repeat(32) }); cpSync(stateDir, pyState, { recursive: true });
      const options: LifecycleOptions = { store, stateDir, enabled: () => true, allowReal: false, running: new Set(), approvals: new Map(), activeContext: new Map(), resolveProvider: () => { throw new Error("must not resolve"); }, createRunner: () => { throw new Error("must not run"); } };
      const api = createSessionLifecycleApi(options), sid = String(session.id);
      const requests = [
        ...[{ steps: 0 }, { steps: true }, { max_chars: 100 }, { max_tokens: 0 }, { runtime_profile: "invalid" }, { max_wall_seconds: false }, { mode: "wrong" }, { disallow_tools: "not_a_tool" }, { permission_mode: "wrong" }, { acknowledge_yolo: true }, { allow_write: false }, { provider: "fake" }, { provider: "invalid" }, {}].map((data) => ({ method: "POST", path: `/api/sessions/${sid}/run`, data })),
        { method: "POST", path: `/api/sessions/${sid}/stop`, data: {} },
        { method: "POST", path: `/api/sessions/${sid}/messages`, data: { text: " " } },
        { method: "POST", path: `/api/sessions/${sid}/answer`, data: { answer: "yes" } },
        { method: "POST", path: `/api/sessions/${sid}/approvals`, data: { kind: "write", subject: "../escape", tool_call_id: "missing" } },
      ];
      const expected = JSON.parse(await runPythonAsync(`import runpy; runpy.run_path(${JSON.stringify(oraclePath)},run_name='__main__')`, JSON.stringify({ stateDir: pyState, workspace: root, requests })));
      const actual: unknown[] = [];
      for (const r of requests) { const reply = await api.dispatch(r.method, r.path.split("/").filter(Boolean), {}, r.data); assert.ok(reply); actual.push([reply[0], reply[0] >= 400 && isDict(reply[1]) ? normalizeError(reply[0], reply[1]) : reply[1]]); }
      assert.deepEqual(normalize(actual), normalize(expected));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
