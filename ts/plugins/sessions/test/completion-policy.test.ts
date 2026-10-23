import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recordCompletionHistory } from "@xueness/agent";
import { requiresEvidence } from "../src/completion-policy.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
describe("sessions completion policy", { skip: pythonUnavailableReason() ?? false }, () => {
  it("matches real Python for ordinary chat, workspace/network work and settled checklist follow-ups", () => {
    const texts = ["hello", "Hello, explain a binary tree", "你好世界", "你好，解释归并排序", "Write a short poem", "Write code that sorts this supplied array", "Read this file", "Fix this project", "Review src/main.ts", "运行测试", "检查当前工作区", "Search the web for current prices", "hello, search the web", "研究最新新闻", "Explain this supplied code", "你好，查看当前项目"];
    const sessions = texts.map((text) => ({ messages: [{ role: "system", content: "s" }, { role: "user", content: text }] }));
    const plan = { messages: [{ role: "user", content: "initial" }, { role: "assistant", content: "done" }, { role: "user", content: "thanks" }], delivery_requirements: [{ id: "one", description: "report" }], completion_history: [] };
    recordCompletionHistory(plan, { turn_id: "turn-1", delivery_status: "passed", status: "verified" });
    const inputs = [...sessions, plan, { ...plan, delivery_requirements: [{ id: "changed" }] }];
    const expected = JSON.parse(runPython("import json,sys; from xueness.bundled_plugins.sessions.completion_policy import requires_evidence; print(json.dumps([requires_evidence(x) for x in json.load(sys.stdin)]))", JSON.stringify(inputs)));
    assert.deepEqual(inputs.map((session) => requiresEvidence(session)), expected);
  });
});
