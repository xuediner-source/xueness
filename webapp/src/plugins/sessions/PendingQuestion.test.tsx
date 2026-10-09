import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PendingQuestion, PendingQuestionModel, QuestionResume } from "./PendingQuestion";
import { evaluatePendingQuestionKey } from "../shared";
import { parseQuestionResponse } from "./questionApi";

const question = (id = "q1", sessionId = "s1") => ({ id: sessionId, enabled: true, question: { id, text: "Which folder?" } });
const accepted = (id = "q1", sessionId = "s1") => ({ id: sessionId, status: "paused", questionId: id, accepted: true as const, alreadyAnswered: false });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test("question response rejects wrong sessions and malformed question IDs", () => {
  assert.deepEqual(parseQuestionResponse(question(), "s1"), question());
  assert.throws(() => parseQuestionResponse(question(), "s2"));
  assert.throws(() => parseQuestionResponse({ ...question(), question: { id: "", text: "hello" } }, "s1"));
});

test("disabled question experiment never fetches or submits", async () => {
  let calls = 0;
  const model = new PendingQuestionModel({ load: async () => { calls++; return question(); }, answer: async () => { calls++; return accepted(); } });
  await model.activate("s1", false);
  model.setDraft("hello");
  assert.equal(await model.submit(), false);
  assert.equal(calls, 0);
  assert.equal(renderToStaticMarkup(<PendingQuestion sessionId="s1" pendingQuestion="Question?" enabled={false} onSubmitted={async () => {}} />), "");
});

test("late load after session switch and disabled in-flight answer cannot continue", async () => {
  const old = deferred<ReturnType<typeof question>>();
  const answer = deferred<ReturnType<typeof accepted>>();
  let calls = 0;
  const model = new PendingQuestionModel({ load: async id => id === "s1" ? old.promise : question("q2", id), answer: async () => { calls++; return answer.promise; } });
  const initial = model.activate("s1", true);
  await model.activate("s2", true);
  old.resolve(question()); await initial;
  assert.equal(model.snapshot().question?.id, "q2");
  model.setDraft("workspace");
  const sending = model.submit();
  assert.equal(await model.submit(), false);
  model.deactivate(); answer.resolve(accepted("q2", "s2"));
  assert.equal(await sending, false);
  assert.equal(calls, 1);
});

test("answer failures retain draft and exact stable ID for explicit retry", async () => {
  const calls: string[][] = [];
  const model = new PendingQuestionModel({ load: async () => question(), answer: async (sid, qid, text) => {
    calls.push([sid, qid, text]);
    if (calls.length === 1) throw new Error("HTTP 409: stale question");
    return accepted();
  } });
  await model.activate("s1", true); model.setDraft("  My answer  ");
  assert.equal(await model.submit(), false);
  assert.equal(model.snapshot().draft, "  My answer  ");
  assert.match(model.snapshot().error, /409/);
  assert.equal(await model.submit(), true);
  assert.deepEqual(calls, [["s1", "q1", "My answer"], ["s1", "q1", "My answer"]]);
  assert.equal(model.snapshot().question, null);
});

test("drafts are keyed by question and Unicode answer limits match backend code points", async () => {
  let id = "q1", calls = 0;
  const model = new PendingQuestionModel({ load: async () => question(id), answer: async () => { calls++; return accepted(id); } });
  await model.activate("s1", true); model.setDraft("old draft");
  id = "q2"; await model.activate("s1", true);
  assert.equal(model.snapshot().draft, "");
  id = "q1"; await model.activate("s1", true);
  assert.equal(model.snapshot().draft, "old draft");
  model.setDraft("😀".repeat(5001)); assert.equal(await model.submit(), false);
  model.setDraft("😀".repeat(5000)); assert.equal(await model.submit(), true);
  assert.equal(calls, 1);
});


test("saving without running exposes an explicit resume for paused conversations only", () => {
  const props = { enabled: true, status: "paused", pendingQuestion: null, disabled: false, onResume: async () => {} };
  assert.match(renderToStaticMarkup(<QuestionResume {...props} />), /<button/);
  for (const patch of [{ enabled: false }, { status: "running" }, { pendingQuestion: "still pending" }]) {
    assert.equal(renderToStaticMarkup(<QuestionResume {...props} {...patch} />), "");
  }
});

test("budget-paused turns expose continue without enabling structured questions", () => {
  for (const pauseCode of ["step_limit_reached", "wall_time_limit_reached"]) {
    const html = renderToStaticMarkup(<QuestionResume enabled={false} resumeBudgetEnabled pauseCode={pauseCode}
      status="paused" pendingQuestion={null} disabled={false} onResume={async () => {}} />);
    assert.match(html, /继续本轮/);
  }
  const unrelated = renderToStaticMarkup(<QuestionResume enabled={false} resumeBudgetEnabled pauseCode="unknown"
    status="paused" pendingQuestion={null} disabled={false} onResume={async () => {}} />);
  assert.equal(unrelated, "");
  const pending = renderToStaticMarkup(<QuestionResume enabled={false} resumeBudgetEnabled pauseCode="step_limit_reached"
    status="paused" pendingQuestion="Question" disabled={false} onResume={async () => {}} />);
  assert.equal(pending, "");
});

test("evaluatePendingQuestionKey: Enter+Mod submission obeys platform and rejects IME composition", () => {
  // Plain Enter does not submit (it creates newline in textarea)
  assert.equal(evaluatePendingQuestionKey({ key: "Enter" }), null);

  // Darwin (macOS): ⌘ (metaKey) submits; Ctrl does not
  assert.equal(evaluatePendingQuestionKey({ key: "Enter", metaKey: true }, { platform: "darwin" }), "submit");
  assert.equal(evaluatePendingQuestionKey({ key: "Enter", ctrlKey: true }, { platform: "darwin" }), null);

  // Win32 (Windows): Ctrl submits; ⌘ (metaKey) does not
  assert.equal(evaluatePendingQuestionKey({ key: "Enter", ctrlKey: true }, { platform: "win32" }), "submit");
  assert.equal(evaluatePendingQuestionKey({ key: "Enter", metaKey: true }, { platform: "win32" }), null);

  // Both Ctrl and Meta simultaneously is rejected
  assert.equal(evaluatePendingQuestionKey({ key: "Enter", ctrlKey: true, metaKey: true }, { platform: "darwin" }), null);
  assert.equal(evaluatePendingQuestionKey({ key: "Enter", ctrlKey: true, metaKey: true }, { platform: "win32" }), null);

  // Shift or Alt suppresses submission
  assert.equal(evaluatePendingQuestionKey({ key: "Enter", metaKey: true, shiftKey: true }, { platform: "darwin" }), null);
  assert.equal(evaluatePendingQuestionKey({ key: "Enter", ctrlKey: true, altKey: true }, { platform: "win32" }), null);

  // IME composition states must block submission
  assert.equal(evaluatePendingQuestionKey({ key: "Enter", metaKey: true, isComposing: true }, { platform: "darwin" }), null);
  assert.equal(evaluatePendingQuestionKey({ key: "Enter", ctrlKey: true, nativeEvent: { isComposing: true } }, { platform: "win32" }), null);
  assert.equal(evaluatePendingQuestionKey({ key: "Enter", ctrlKey: true, keyCode: 229 }, { platform: "win32" }), null);
  assert.equal(evaluatePendingQuestionKey({ key: "Enter", ctrlKey: true, nativeEvent: { keyCode: 229 } }, { platform: "win32" }), null);
  assert.equal(evaluatePendingQuestionKey({ key: "Enter", ctrlKey: true, compositionActive: true }, { platform: "win32" }), null);
  assert.equal(evaluatePendingQuestionKey({ key: "Process", ctrlKey: true }, { platform: "win32" }), null);
  assert.equal(evaluatePendingQuestionKey({ key: "Dead", metaKey: true }, { platform: "darwin" }), null);
});
