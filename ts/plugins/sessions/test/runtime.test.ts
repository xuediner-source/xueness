import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { compactNow, CompactError } from "../src/manual-compact.ts";
import { normalizeModelSwitch, parseModelTarget, planModelSelection, recordModelSwitch, switchableProvider } from "../src/model-switch.ts";
import { firstExchange, isChildSession, needsAutoTitle, titleFromModel, titlePrompt } from "../src/title-text.ts";
import type { AgentProvider, Row } from "@xueness/agent";
import { PROJECT_ROOT, pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
const oracle = (inputs: Row[]): unknown[] => JSON.parse(runPython(readFileSync(join(PROJECT_ROOT, "ts/test-support/python/session_runtime_oracle.py"), "utf8"), JSON.stringify(inputs)));
async function invoke(item: Row): Promise<unknown> {
  try {
    switch (item.op) {
      case "normalize": return normalizeModelSwitch(item.request as Row);
      case "target": return parseModelTarget(item.text as string);
      case "selection": return planModelSelection(item.previous as Row, item.fields as Row);
      case "record": { const session = structuredClone(item.session as Row); recordModelSwitch(session, item.previous as Row, item.selected as Row, "api", "immediate", "STAMP"); return session; }
      case "title": return titleFromModel(item.text);
      case "title_inputs": { const session = item.session as Row, exchange = firstExchange(session); return { needs: needsAutoTitle(session), child: isChildSession(session), exchange, prompt: exchange ? titlePrompt(session.task, ...exchange) : null }; }
      case "compact": {
        const session = item.session as Row, saves: Row[] = [];
        const result = await compactNow({ load: async () => structuredClone(session), save: async (s) => { saves.push(structuredClone(s)); } }, session.id as string, item.note, { enabled: () => item.disabled !== true, source: item.source as string ?? "http", budget: item.budget }); return { result, saves };
      }
    }
  } catch (e) { return e instanceof CompactError ? { error: e.payload() } : { error: (e as Error).name, message: (e as Error).message }; }
}
function session(count = 10): Row {
  return { id: "a".repeat(32), root: "/not-accessed", read_only: true, messages: [{ role: "system", content: "System" }, { role: "user", content: "Original human requirements", _message_id: "first-user" }, ...Array.from({ length: count }, (_, i) => ({ role: "assistant", content: `Earlier ${i} ` + "observed ".repeat(150) })), { role: "user", content: "Current human constraints", _message_id: "latest-user" }], results: {}, compactions: [], archived_messages: [] };
}
describe("session runtime Python differential", { skip: pythonUnavailableReason() ?? false }, () => {
  it("matches partial selections, shorthand, model histories and title text/inputs", async () => {
    const previous = { provider_id: "old", model: "old-model", reasoning_effort: "high" };
    const inputs: Row[] = [...[{}, { providerId: " next ", reasoningEffort: " low " }, { unknown: true }, { selection: "new/model", model: "bad" }, { model: 4 }, { save_default: 1 }, { save_default: "true" }, { runtimeProfile: " lightweight " }].map((request) => ({ op: "normalize", request })),
      ...["", "env", "env/model", "new/a/b", " / ", " saved ", "/model"].map((text) => ({ op: "target", text })),
      ...[{}, { model: "new" }, { reasoning_effort: "low" }, { selection: "env" }, { selection: "next/model", reasoning_effort: "max" }, { provider_id: "old" }].map((fields) => ({ op: "selection", previous, fields })),
      { op: "record", session: { messages: [{ role: "user", _message_id: "anchor" }] }, previous, selected: { provider_id: "new", model: null } },
      ...['{"title":" “标题” "}', "```json\n{\"title\":\"Short title\"}\n```", "A plain title", "'quoted'", "{bad", "First line\nSecond line", "x".repeat(121), '{"title":"' + "中".repeat(80) + '"}', "A\u0001title", "A\u001ctitle", "", null, "```\r\nPlain title\r\n```"].map((text) => ({ op: "title", text })),
      ...[{}, { task: "Task", messages: [{ role: "user", content: "Question" }, { role: "assistant", content: "Answer" }] }, { task: "Task", title: "Custom", title_source: "manual", parent: "p" }, { title_source: "generated", delegation: { parentSessionId: "p" } }, { fork_parent: { session: "root" }, task: "中".repeat(2500), messages: [{ role: "assistant", content: "First answer" }, { role: "user", content: "Question".repeat(700) }] }].map((s) => ({ op: "title_inputs", session: s }))];
    const expected = oracle(inputs); for (const [i, item] of inputs.entries()) assert.deepEqual(await invoke(item), expected[i], `runtime case ${i}`);
  });
  it("matches deterministic manual compaction, bounds, archive, no-op and refusal records", async () => {
    const inputs: Row[] = [{ op: "compact", session: session(), note: "Keep verified observations" }, { op: "compact", session: session(1) }, { op: "compact", session: { ...session(), runtime_profile: "lightweight", runtime_budget: { inputBudgetTokens: 500 } } }, { op: "compact", session: session(), note: "\n" }, { op: "compact", session: session(), note: "bad\ncontrol" }, { op: "compact", session: session(), note: "x".repeat(2001) }, { op: "compact", session: session(), budget: 100 }, { op: "compact", session: session(), budget: true }, { op: "compact", session: session(), disabled: true }, { op: "compact", session: { id: "bad", messages: [] } }, { op: "compact", session: session(), source: "unknown" }, { op: "compact", session: { id: "a".repeat(32), messages: null } }];
    const expected = oracle(inputs); for (const [i, item] of inputs.entries()) assert.deepEqual(await invoke(item), expected[i], `compact case ${i}`);
  });
});
it("retargets only the next request and carries the run deadline to the selected adapter", async () => {
  let release!: () => void; const hold = new Promise<void>((resolve) => { release = resolve; }); const calls: string[] = [];
  const first: AgentProvider = { model: "first", requestDeadline: 123, async complete() { calls.push("first"); await hold; return { content: "first answer" }; } };
  const second: AgentProvider = { model: "second", runtimeProfile: "standard", async complete() { calls.push("second"); return { content: "second answer" }; } };
  const live = session(0), provider = switchableProvider(first, live); const pending = provider.complete([], []);
  provider.switchTo({ provider_id: "new", model: "second" }, second); assert.equal(provider.model, "first"); release(); assert.equal((await pending).content, "first answer");
  assert.equal((await provider.complete([], [])).content, "second answer"); assert.deepEqual(calls, ["first", "second"]); assert.equal(second.requestDeadline, 123); assert.equal(live.tool_calling, "native"); assert.equal(provider.pendingSelection(), null);
});
