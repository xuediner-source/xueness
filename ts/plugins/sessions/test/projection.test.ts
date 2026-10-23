import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { statWorkspaceReference } from "@xueness/plugin-files";
import { projectReferences } from "../src/reference-rows.ts";
import { projectSubagents } from "../src/subagent-rows.ts";
import { displayRows } from "../src/snapshot-rows.ts";
import { observeToolActivity, publicToolActivity } from "../src/tool-activity.ts";
import { pythonUnavailableReason, runPythonAsync } from "../../../test-support/python-oracle.ts";
type Row = Record<string, any>;
const oracle = `
import json,sys
from pathlib import Path
from xueness import web
from xueness.bundled_plugins.sessions.reference_rows import project_journal_references
from xueness.bundled_plugins.sessions.subagent_rows import project_journal_subagents
from xueness.bundled_plugins.sessions.conversation_snapshot import _display_messages
from xueness.bundled_plugins.sessions.tool_activity import observe,public_activity
p=json.load(sys.stdin);root=Path(p['root']);ctx=web.build_context(root/'state',root/'runs',root,csrf='fixture')
if p['action']=='references': out=[project_journal_references(p['messages'],root=root,files_effective=flag) for flag in [True,False]]
elif p['action']=='subagents':out=[project_journal_subagents(p['s'],p['s']['messages'],subagents_effective=flag,live_tasks=p['live'] if flag else None) for flag in [True,False]]
elif p['action']=='rows':out=_display_messages(p['s'],include_interrupted_partials=True)
else:
 s=p['s'];out=[]
 for fact in p['facts']:out.append([observe(s,p['stream'],fact,state_dir=ctx['state_dir']),public_activity(s,state_dir=ctx['state_dir'])])
print(json.dumps(out))
`;
it("matches Python bounded reference/subagent and interrupted transcript projections", { skip: pythonUnavailableReason() ?? false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "xueness-projections-"));
  try {
    writeFileSync(join(root, "notes.txt"), "One\nTwo\nThree");
    const call = async (action: string, p: Row) => JSON.parse(await runPythonAsync(oracle, JSON.stringify({ root, action, ...p })));
    const messages = [{ role: "assistant", content: '😀 :xueness-file{path="notes.txt" lines="1-3" purpose="My note"}\n```\n:xueness-file{path="notes.txt"}\n```\n:xueness-artifact{path="missing.pdf" name="Output"}\n:xueness-file{path="../escape"}', _message_id: "a".repeat(32) }];
    assert.deepEqual([projectReferences(messages, { root, filesEffective: true, stat: statWorkspaceReference }), projectReferences(messages, { root, filesEffective: false, stat: () => { throw new Error("must not stat disabled files"); } })], await call("references", { messages }));
    const s: Row = { id: "a".repeat(32), task_runs: [{ id: "task-one", parent: "a".repeat(32), agent: "worker", status: "running", summary: "Saved summary", childSessionId: "b".repeat(32), steps: 2 }], subagent_coordination: { "task-one": { call_id: "call-1" } }, messages: [{ role: "assistant", tool_calls: [{ id: "call-1", function: { name: "task" } }] }], results: {} };
    const live = [{ id: "task-one", parent: s.id, status: "completed", summary: "Fresh\u0000summary", steps: 5 }];
    assert.deepEqual([projectSubagents(s, s.messages, true, live), projectSubagents(s, s.messages, false)], await call("subagents", { s, live }));
    const source: Row = { id: s.id, messages: [{ role: "system", content: "System" }, { role: "system", content: "Summary", _semantic_summary: true }, { role: "tool", content: "[truncated in context]", _message_id: "c".repeat(32), _turn_id: "turn-1" }, { role: "user", content: "New turn", _message_id: "d".repeat(32), _turn_id: "turn-2" }], archived_messages: [{ role: "user", content: "Original", _message_id: "e".repeat(32), _turn_id: "turn-1" }, { role: "tool", content: "Original full tool output", _message_id: "c".repeat(32), _turn_id: "turn-1" }], stream_history: [{ id: "f".repeat(32), status: "interrupted", interrupted: true, transcript_partial: true, transcript_turn_id: "turn-2", after_message_id: "d".repeat(32), text: "Partial answer", reasoning: "Partial reasoning" }] };
    assert.deepEqual(displayRows(source), await call("rows", { s: source }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("matches Python tool input display bounds and rejects stale observer updates", { skip: pythonUnavailableReason() ?? false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "xueness-tool-activity-"));
  try {
    const stream = "a".repeat(32), s: Row = { status: "running", streaming: { id: stream, status: "streaming" }, active_turn_id: "turn-1", messages: [], results: {} }, facts = [{ index: 0, call_id: "read-1", name: "read", partial_input: "x".repeat(5000), input_chars: 5000, truncated: false }, { index: 0, call_id: "read-1", name: "read", partial_input: "stale", input_chars: 5 }, { index: 1, call_id: "write-1", name: "write", partial_input: "private file contents", input_chars: 21 }, { index: true, call_id: "bad", name: "read", partial_input: "bad", input_chars: 3 }];
    const expected = JSON.parse(await runPythonAsync(oracle, JSON.stringify({ action: "activity", root, s, facts, stream }))), actual: unknown[] = [];
    for (const fact of facts) actual.push([observeToolActivity(s, stream, fact, { enabled: () => true }), publicToolActivity(s, { enabled: () => true })]);
    assert.deepEqual(actual, expected);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
