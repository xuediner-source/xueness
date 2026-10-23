import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { isDict, normalizeError } from "@xueness/contracts";
import { SessionStore } from "@xueness/sessions";
import { createSessionsApi } from "../src/http-api.ts";
import { messageRevision } from "../src/journal-http.ts";
import { pythonUnavailableReason, runPythonAsync } from "../../../test-support/python-oracle.ts";
type Row = Record<string, any>;
const oracle = `
import http.client,json,sys,threading
from pathlib import Path
from xueness import web
from xueness.bundled_plugins.sessions.message_actions import revision
p=json.load(sys.stdin);ctx=web.build_context(Path(p['state']),Path(p['root'])/'runs',Path(p['root']),csrf='fixture');server=web.create_server(0,ctx);threading.Thread(target=server.serve_forever,daemon=True).start();out=[]
try:
 for data in p['actions']:
  if data.get('revision')=='current': data['revision']=revision(ctx['store'].load(p['sid']))
  c=http.client.HTTPConnection('127.0.0.1',server.server_port);c.request('PATCH','/api/sessions/'+p['sid']+'/message-actions',json.dumps(data),{'Content-Type':'application/json','X-CSRF-Token':'fixture'});r=c.getresponse();out.append([r.status,json.loads(r.read())]);c.close()
 s=ctx['store'].load(p['sid']);final={k:s.get(k) for k in p['fields']}
finally:server.shutdown();server.server_close()
print(json.dumps({'responses':out,'session':final}))
`;
const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize) : isDict(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "revision" ? "(revision)" : normalize(x)])) : v;
it("matches actual Python HTTP edit/feedback CAS, suffix hiding and run state reset", { skip: pythonUnavailableReason() ?? false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "xueness-actions-")), stateDir = join(root, "ts"), pyState = join(root, "python"); mkdirSync(stateDir);
  try {
    const store = new SessionStore(stateDir), s = await store.new("Original", root, { sessionId: "a".repeat(32) });
    (s.messages as Row[]).push({ role: "assistant", content: "First answer" }, { role: "user", content: "Later user" }, { role: "assistant", content: "Later answer" }); s.status = "completed"; s.steps = 4; s.todos = [{ id: "old" }]; s.runtime_budget = { inputBudgetTokens: 1000 }; await store.save(s);
    s.archived_messages = [{ ...(s.messages as Row[])[4]!, content: "Archived later output" }]; await store.save(s); cpSync(stateDir, pyState, { recursive: true });
    const fields = ["task", "status", "steps", "messages", "history_hidden_message_ids", "message_annotations", "message_edit_history", "reasoning_history", "reasoning_timing", "completion_history", "completion", "todos", "pending_question", "pause_code", "pause_reason", "streaming", "runtime_activity", "runtime_activity_history", "results"];
    const actions: Row[] = [{}, { revision: "sha256:" + "0".repeat(64), messageIndex: 1, action: "edit", text: "Stale" }, { revision: "current", messageIndex: 1, action: "feedback", feedback: "like" }, { revision: "current", messageIndex: 2, action: "feedback", feedback: "like" }, { revision: "current", messageIndex: 2, action: "feedback", feedback: null }, { revision: "current", messageIndex: 1, action: "edit", text: "Replacement" }];
    const expected = JSON.parse(await runPythonAsync(oracle, JSON.stringify({ root, state: pyState, sid: s.id, actions, fields })));
    const api = createSessionsApi({ store, stateDir, webRuns: join(root, "runs"), projectDir: root, enabled: () => true }), responses: unknown[] = [];
    for (const action of actions) { const data = { ...action }; if (data.revision === "current") data.revision = messageRevision(await store.load(String(s.id))); const result = await api.dispatch("PATCH", ["api", "sessions", String(s.id), "message-actions"], {}, data); assert.ok(result); responses.push([result[0], result[0] >= 400 && isDict(result[1]) ? normalizeError(result[0], result[1]) : result[1]]); }
    const final = await store.load(String(s.id)); assert.deepEqual(normalize({ responses, session: Object.fromEntries(fields.map((key) => [key, final[key] ?? null])) }), normalize(expected));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
