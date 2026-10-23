import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { isDict, normalizeError } from "@xueness/contracts";
import { SessionStore } from "@xueness/sessions";
import { createSessionsApi } from "../src/http-api.ts";
import { eventCursorPage, eventCursorSse } from "../src/legacy-events.ts";
import { resumePage, resumeSse } from "../src/event-resume.ts";
import { pythonUnavailableReason, runPythonAsync } from "../../../test-support/python-oracle.ts";
import type { LifecycleOptions } from "../src/lifecycle-types.ts";
type Row = Record<string, any>;
const oraclePath = join(import.meta.dirname, "../../../test-support/python/http_feature_oracle.py");
it("matches Python HTTP legacy events, opt-in cursors and immutable-prefix resume", { skip: pythonUnavailableReason() ?? false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "xueness-event-api-")), stateDir = join(root, "ts"), pyState = join(root, "python"); mkdirSync(stateDir);
  try {
    const store = new SessionStore(stateDir), s = await store.new("Initial", root, { sessionId: "a".repeat(32) });
    (s.messages as Row[]).push({ role: "assistant", content: "Inspecting", tool_calls: [{ id: "read-1", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } }] }, { role: "tool", tool_call_id: "read-1", content: "private content" }, { role: "assistant", content: "Answer" }, { role: "user", content: "Next" }); s.results = { "read-1": { ok: true, data: "private file" } }; s.status = "completed"; await store.save(s);
    const general = { sessionsEventsCursorEnabled: true, sessionsEventResumeEnabled: true }; writeFileSync(join(stateDir, "settings.json"), JSON.stringify({ general })); cpSync(stateDir, pyState, { recursive: true });
    const cursor = eventCursorPage(s, { position: 0, revision: null }, 2), resume = resumePage(s, null, 2, "replayable"), base = `/api/sessions/${s.id}`;
    const paths = [base + "/events", base + "/events?limit=garbage", base + "/events?cursor=0&limit=2", base + `/events?since=${cursor.next_cursor_token}&limit=1`, base + "/events?cursor=1", base + "/events?cursor=0&since=1", base + "/events?cursor=0&limit=bad", base + "/events.resume", base + "/events.resume?profile=continuous&limit=2", base + `/events.resume?seq=${resume.seq}&logEpoch=${resume.logEpoch}`, base + "/events.resume?seq=0&logEpoch=" + "0".repeat(64), base + "/events.resume?seq=0", base + "/events.resume?profile=bad", base + "/events.resume?seq=99999999999999999999999&logEpoch=" + "0".repeat(64)];
    const expected = JSON.parse(await runPythonAsync(`import runpy;runpy.run_path(${JSON.stringify(oraclePath)},run_name='__main__')`, JSON.stringify({ stateDir: pyState, workspace: root, requests: paths.map((path) => ({ method: "GET", path })) })));
    const lifecycle: LifecycleOptions = { store, stateDir, enabled: () => true, approvals: new Map(), activeContext: new Map(), running: new Set(), allowReal: false, resolveProvider: () => { throw new Error(); }, createRunner: () => { throw new Error(); }, settings: () => ({ general }) };
    const api = createSessionsApi({ store, stateDir, webRuns: join(root, "runs"), projectDir: root, enabled: () => true, lifecycle }), actual: unknown[] = [];
    for (const path of paths) { const url = new URL(path, "http://local"), query: Row = {}; for (const [k, v] of url.searchParams) (query[k] ??= []).push(v); const reply = await api.dispatch("GET", url.pathname.split("/").filter(Boolean), query, {}); assert.ok(reply); actual.push([reply[0], reply[0] >= 400 && isDict(reply[1]) ? normalizeError(reply[0], reply[1]) : reply[1]]); }
    assert.deepEqual(actual, expected);
    const sse = JSON.parse(await runPythonAsync(`import json,sys\nfrom xueness.bundled_plugins.sessions import events_cursor,event_resume\np=json.load(sys.stdin);s=p['s'];c=events_cursor.page(s,events_cursor.Cursor(0),2);r=event_resume.page(s,None,2,'replayable');print(json.dumps([events_cursor.sse_body(s,events_cursor.numbered_events(s),c['events']).decode(),event_resume.sse_body(s,r).decode()]))`, JSON.stringify({ s })));
    assert.deepEqual([eventCursorSse(s, cursor.events).toString("utf8"), resumeSse(s, resume).toString("utf8")], sse);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
