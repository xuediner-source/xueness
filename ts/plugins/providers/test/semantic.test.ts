import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pyJsonLoads } from "@xueness/contracts";
import { OpenAICompatible } from "@xueness/providers";
import type { Row } from "@xueness/agent";
import { HANDOFF_SECTIONS, handoffModelJson, safeHistoryGroups, semanticBeforeModelRequest, validateHandoff } from "../src/semantic.ts";
import { PROJECT_ROOT, pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

function history(exchanges = 12): Row {
  const messages: Row[] = [{ role: "system", content: "System" }, { role: "user", content: "Original human requirements", _turn_id: "turn-1", _message_id: "a".repeat(32) }];
  for (let index = 0; index < exchanges; index += 1) messages.push({ role: "assistant", content: "Earlier observation " + "observed text ".repeat(35), _turn_id: "turn-1" });
  messages.push({ role: "user", content: "Latest human requirement must remain verbatim", _turn_id: "turn-2", _message_id: "c".repeat(32) });
  return { id: "d".repeat(32), messages, results: {}, compactions: [], archived_messages: [], message_annotations: { "0": "system", "1": "old", [messages.length - 1]: "latest" }, reasoning_history: [{ message_index: 2, text: "old reasoning" }, { message_index: messages.length - 1, text: "latest" }] };
}
describe("semantic compaction Python differential", { skip: pythonUnavailableReason() ?? false }, () => {
  it("matches transactional staging, multi-batch prompts, validation failure, mutation, cancellation and save failure", async () => {
    const inputs: Row[] = [
      ...["normal", "invalid", "mutate", "cancel", "save_error"].map((mode) => ({ session: history(), mode, maxChars: 4096 })),
      { session: history(1), mode: "normal", maxChars: 4096 },
      { session: history(30), mode: "normal", maxChars: 1800 },
      { session: { ...history(), semantic_compaction: { enabled: false } }, mode: "normal", maxChars: 4096 },
      { session: history(), enabled: false, mode: "normal", maxChars: 4096 },
      { session: history(), mode: "normal", maxChars: 200 },
    ];
    const expected = JSON.parse(runPython(readFileSync(join(PROJECT_ROOT, "ts", "test-support", "python", "semantic_oracle.py"), "utf8"), JSON.stringify(inputs))) as unknown[];
    for (const [index, input] of inputs.entries()) {
      const session = structuredClone(input.session as Row); const requests: Row[][] = []; const saves: Row[] = []; let stopped = false;
      let result: Row;
      try { result = await semanticBeforeModelRequest(session, { complete: async () => { throw new Error("scripted modelJson owns the request"); } }, { enabled: () => input.enabled !== false, maxChars: input.maxChars as number,
        stamp: () => "2026-10-18T00:00:00.000+00:00", uuid: () => "b".repeat(32), shouldStop: () => stopped,
        store: { async save(staged) { if (input.mode === "save_error") throw new Error("save failed"); saves.push(structuredClone(staged)); } },
        async modelJson(_provider, prompt) {
          requests.push(structuredClone(prompt)); const payload = pyJsonLoads(prompt[1]!.content as string) as Row;
          const raw: Row = Object.fromEntries(HANDOFF_SECTIONS.map((section) => [section, []]));
          raw.requirements = ["Preserved human requirements"]; raw.verification = ["Only observed tool records are verification facts"]; raw.coveredMessageIds = payload.requiredCoverage;
          if (input.mode === "invalid") raw.coveredMessageIds = [];
          if (input.mode === "mutate") (session.messages as Row[])[1]!.content += " changed by callback";
          if (input.mode === "cancel") stopped = true;
          return [raw, { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }];
        } });
      } catch (error) { result = { error: (error as Error).name, message: (error as Error).message }; }
      assert.deepEqual({ result, session, requests, saves }, expected[index], `transaction ${index}`);
    }
  });
  it("refuses orphaned/unresolved exchanges and handoffs without exact human coverage", () => {
    assert.throws(() => safeHistoryGroups([{ role: "tool", tool_call_id: "orphan" }]), /orphan/);
    assert.throws(() => safeHistoryGroups([{ role: "assistant", tool_calls: [{ id: "pending" }] }, { role: "user", content: "interrupt" }]), /unresolved/);
    const raw = Object.fromEntries(HANDOFF_SECTIONS.map((section) => [section, []]));
    assert.throws(() => validateHandoff({ ...raw, coveredMessageIds: [] }, ["human"], 4000), /coverage/);
    assert.throws(() => validateHandoff({ ...raw, coveredMessageIds: ["human"] }, ["human"], 4000), /human requirements/);
  });
});
describe("semantic model transport", () => {
  it("clones the real adapter into a bounded tool-free request without changing main-turn options", async () => {
    let captured: Row = {};
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []; req.on("data", (chunk: Buffer) => chunks.push(chunk)); req.on("end", () => {
        captured = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const payload = { choices: [{ index: 0, delta: { content: '{"requirements":["keep requirement"]}' }, finish_reason: "stop" }] };
        res.end("data: " + JSON.stringify(payload) + "\n\ndata: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const provider = new OpenAICompatible({ base: `http://127.0.0.1:${port}/v1`, model: "local", key: "", allowLoopbackHttp: true, allowEmptyKey: true,
      maxOutputTokens: 2048, compatibility: { toolChoice: "required", parallelToolCalls: true } });
    try {
      const [value] = await handoffModelJson(provider, [{ role: "user", content: "history" }], { outputTokens: 256 });
      assert.deepEqual(value, { requirements: ["keep requirement"] });
      assert.equal(captured.max_tokens, 256); assert.equal(captured.tool_choice, undefined); assert.equal(captured.parallel_tool_calls, undefined);
      assert.equal(provider.maxOutputTokens, 2048); assert.equal(provider.compatibility.toolChoice, "required"); assert.equal(provider.requestDeadline, null);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
