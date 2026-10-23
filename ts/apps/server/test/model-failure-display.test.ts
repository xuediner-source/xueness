import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderEvent } from "../src/cli/render.ts";
import { applyTuiEvent, hydrateTuiDocument } from "../../../plugins/sessions/src/tui-transcript.ts";

describe("terminal model failure display", () => {
  it("shows queue status in CLI and updates one TUI queue card across attempts", () => {
    const queued = { type: "model_request_queued", sessionId: "s1", requestId: "r1", attemptId: "a1" };
    let output = "";
    const file = { write: (text: string) => { output += text; } };
    renderEvent(queued, { file, language: "zh" });
    renderEvent(queued, { file, language: "en" });
    assert.match(output, /等待模型并发名额/);
    assert.match(output, /Waiting for model capacity/);
    const doc = hydrateTuiDocument("s1", [], [queued]);
    applyTuiEvent(doc, { ...queued, attemptId: "a2" });
    assert.deepEqual(doc.entries.map((entry) => entry.text), ["等待模型并发名额…"]);
    applyTuiEvent(doc, { ...queued, type: "model_request_admitted", queuedMs: 14 });
    assert.deepEqual(doc.entries.map((entry) => entry.text), ["已获模型并发名额"]);
    assert.equal(doc.network.length, 1);
    assert.equal(doc.network[0]?.queuedMs, 14);
    applyTuiEvent(doc, { ...queued, type: "model_request_failed", terminal: true, reason: "cancelled" });
    assert.deepEqual(doc.entries.map((entry) => entry.text), ["已获模型并发名额"]);
    applyTuiEvent(doc, { ...queued, requestId: "r2" });
    applyTuiEvent(doc, { ...queued, requestId: "r2", type: "model_request_failed", terminal: true, reason: "cancelled" });
    assert.deepEqual(doc.entries.map((entry) => entry.text), ["已获模型并发名额", "已取消排队"]);
  });
  it("renders fixed localized CLI messages and stays quiet for intermediate or cancelled failures", () => {
    let output = "";
    const file = { write: (text: string) => { output += text; } };
    const event = { type: "model_request_failed", terminal: true, reason: "network_error", messageZh: "无法连接模型服务，请检查网络后重试。", message: "Could not connect to the model service. Check the network and try again." };
    renderEvent(event, { file, language: "zh" });
    assert.equal(output, "无法连接模型服务，请检查网络后重试。\n");
    output = "";
    renderEvent(event, { file, language: "en" });
    assert.equal(output, "Could not connect to the model service. Check the network and try again.\n");
    output = "";
    renderEvent({ ...event, terminal: false, reason: "network_error" }, { file, language: "zh" });
    renderEvent({ ...event, reason: "cancelled" }, { file, language: "zh" });
    assert.equal(output, "");
  });

  it("adds one terminal TUI error card per request and skips intermediate and cancelled errors", () => {
    const terminal = { type: "model_request_failed", sessionId: "s1", requestId: "request-1", attemptId: "attempt-1", terminal: true, reason: "network_error", messageZh: "无法连接模型服务，请检查网络后重试。" };
    const doc = hydrateTuiDocument("s1", [], [terminal]);
    applyTuiEvent(doc, { ...terminal, attemptId: "attempt-2" });
    assert.deepEqual(doc.entries.filter((entry) => entry.kind === "error").map((entry) => entry.text), ["无法连接模型服务，请检查网络后重试。"]);
    assert.equal(doc.network.length, 1);
    applyTuiEvent(doc, { ...terminal, requestId: "request-2", terminal: false, attemptId: "attempt-1" });
    applyTuiEvent(doc, { ...terminal, requestId: "request-3", reason: "cancelled", attemptId: "attempt-1" });
    assert.equal(doc.entries.filter((entry) => entry.kind === "error").length, 1);
    const quiet = hydrateTuiDocument("s1", [], [
      { ...terminal, terminal: false },
      { ...terminal, requestId: "request-cancelled", reason: "cancelled" },
    ]);
    assert.equal(quiet.entries.some((entry) => entry.kind === "error"), false);
    assert.equal(quiet.network.length, 2);
  });
});
