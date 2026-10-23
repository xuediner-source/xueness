import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it } from "node:test";
import { isDict, normalizeError, pyEncodeUtf8 } from "@xueness/contracts";
import { SessionStore } from "@xueness/sessions";
import { createSessionsApi } from "../src/http-api.ts";
import { questionIdentity } from "../src/question-id.ts";
import { answerDigestSource, normalizeAnswers } from "../src/structured-questions.ts";
import type { LifecycleOptions } from "../src/lifecycle-types.ts";
import { pythonUnavailableReason, runPythonAsync } from "../../../test-support/python-oracle.ts";
type Row = Record<string, any>;
const oraclePath = join(import.meta.dirname, "../../../test-support/python/http_feature_oracle.py");
for (const structured of [false, true]) it(`matches Python HTTP ${structured ? "structured" : "free text"} question answers, replay and conflicts`, { skip: pythonUnavailableReason() ?? false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "xueness-questions-")), stateDir = join(root, "ts"), pyState = join(root, "python"); mkdirSync(stateDir);
  try {
    const store = new SessionStore(stateDir), s = await store.new("Initial", root, { sessionId: "a".repeat(32) }), question = "Which choice?", cards = [{ id: "choice", header: "Choice", question, options: [{ label: "One", description: "First" }, { label: "Two", description: "Second" }] }];
    (s.messages as Row[]).push({ role: "assistant", content: "", tool_calls: [{ id: "ask-1", type: "function", function: { name: "ask_user", arguments: JSON.stringify({ question, ...(structured ? { questions: cards } : {}) }) } }] }, { role: "tool", tool_call_id: "ask-1", content: "{}" });
    s.status = "awaiting_user"; s.pending_question = question; s.results = { "ask-1": { ok: true, awaiting_user: true, question, ...(structured ? { questions: cards } : {}) } }; await store.save(s);
    const general = { sessionsAnswerQuestionEnabled: !structured }; writeFileSync(join(stateDir, "settings.json"), JSON.stringify({ general })); cpSync(stateDir, pyState, { recursive: true });
    const id = questionIdentity(s, question), path = `/api/sessions/${s.id}`, answer = structured ? { answers: { choice: { selected: ["One"] } } } : { answer: "  A human answer  " }, conflict = structured ? { answers: { choice: { selected: ["Two"] } } } : { answer: "Different" };
    const requests = [{ method: "GET", path: path + "/question" }, { method: "POST", path: path + "/answer-question", data: { questionId: id } }, { method: "POST", path: path + "/answer-question", data: { questionId: id, ...(structured ? { answers: { choice: { selected: ["Missing"] } } } : { answer: " " }) } }, { method: "POST", path: path + "/answer-question", data: { questionId: id, ...answer } }, { method: "POST", path: path + "/answer-question", data: { questionId: id, ...answer } }, { method: "POST", path: path + "/answer-question", data: { questionId: id, ...conflict } }, { method: "GET", path: path + "/question" }];
    const expected = JSON.parse(await runPythonAsync(`import runpy;runpy.run_path(${JSON.stringify(oraclePath)},run_name='__main__')`, JSON.stringify({ stateDir: pyState, workspace: root, requests })));
    const lifecycle: LifecycleOptions = { store, stateDir, enabled: () => true, approvals: new Map(), activeContext: new Map(), running: new Set(), allowReal: false, resolveProvider: () => { throw new Error(); }, createRunner: () => { throw new Error(); }, settings: () => ({ general }) }, api = createSessionsApi({ store, stateDir, webRuns: join(root, "runs"), projectDir: root, enabled: () => true, lifecycle }), actual: unknown[] = [];
    for (const request of requests) { const result = await api.dispatch(request.method, request.path.split("/").filter(Boolean), {}, request.data ?? {}); assert.ok(result); actual.push([result[0], result[0] >= 400 && isDict(result[1]) ? normalizeError(result[0], result[1]) : result[1]]); }
    assert.deepEqual(actual, expected); const accepted = await store.load(String(s.id)); assert.equal(accepted.status, "paused"); assert.equal(accepted.pending_question, null); assert.equal((accepted.messages as Row[]).at(-1)!.content, structured ? "Operator answer: [choice] Choice: One" : "Operator answer: A human answer");
    const questionQuery = (sessionId: string, data: Row) => api.dispatch("POST", ["api", "sessions", sessionId, "question-query"], {}, data);
    const beforeQuery = JSON.stringify(await store.load(String(s.id)));
    const exact = await questionQuery(String(s.id), { questionId: id, ...answer });
    assert.deepEqual(exact, [200, { id: s.id, status: "paused", questionId: id, result: "accepted" }]);
    const changed = await questionQuery(String(s.id), { questionId: id, ...conflict });
    assert.deepEqual(changed, [200, { id: s.id, status: "paused", questionId: id, result: "unknown" }]);
    const missingId = "q-" + "0".repeat(64), missing = await questionQuery(String(s.id), { questionId: missingId, ...answer });
    assert.deepEqual(missing, [200, { id: s.id, status: "paused", questionId: missingId, result: "unknown" }]);
    const other = await store.new("Other session", root, { sessionId: "b".repeat(32) });
    const foreign = await questionQuery(String(other.id), { questionId: id, ...answer });
    assert.deepEqual(foreign, [200, { id: other.id, status: "pending", questionId: id, result: "unknown" }]);
    assert.equal(JSON.stringify(await store.load(String(s.id))), beforeQuery, "question query must not mutate or execute the session");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("queries saved question answers by exact text and structured fingerprints within one session", async () => {
  const root = mkdtempSync(join(tmpdir(), "xueness-question-query-")), stateDir = join(root, "state"); mkdirSync(stateDir);
  try {
    const store = new SessionStore(stateDir), sid = "a".repeat(32), s = await store.new("Initial", root, { sessionId: sid });
    const textId = "q-" + "b".repeat(64), cardsId = "q-" + "c".repeat(64), normalizedText = "A human answer";
    const cards = normalizeAnswers({ choice: { selected: ["One"] } });
    const hash = (value: string) => createHash("sha256").update(pyEncodeUtf8(value)).digest("hex");
    s.question_answer_records = { [textId]: hash(normalizedText), [cardsId]: hash(answerDigestSource(cards)) };
    await store.save(s);
    const api = createSessionsApi({ store, stateDir, webRuns: join(root, "runs"), projectDir: root, enabled: () => true });
    const query = (sessionId: string, data: Row) => api.dispatch("POST", ["api", "sessions", sessionId, "question-query"], {}, data);
    const before = JSON.stringify(await store.load(sid));
    assert.deepEqual(await query(sid, { questionId: textId, answer: "  A human answer  " }),
      [200, { id: sid, status: "pending", questionId: textId, result: "accepted" }]);
    assert.deepEqual(await query(sid, { questionId: cardsId, answers: { choice: { selected: ["One"] } } }),
      [200, { id: sid, status: "pending", questionId: cardsId, result: "accepted" }]);
    assert.deepEqual(await query(sid, { questionId: textId, answer: "A different answer" }),
      [200, { id: sid, status: "pending", questionId: textId, result: "unknown" }]);
    const unknownId = "q-" + "d".repeat(64);
    assert.deepEqual(await query(sid, { questionId: unknownId, answer: normalizedText }),
      [200, { id: sid, status: "pending", questionId: unknownId, result: "unknown" }]);
    const other = await store.new("Other", root, { sessionId: "e".repeat(32) });
    assert.deepEqual(await query(String(other.id), { questionId: textId, answer: normalizedText }),
      [200, { id: other.id, status: "pending", questionId: textId, result: "unknown" }]);
    assert.equal(JSON.stringify(await store.load(sid)), before, "query must not mutate or re-answer the session");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
