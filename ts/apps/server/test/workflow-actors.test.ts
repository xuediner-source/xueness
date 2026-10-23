import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { AgentProvider } from "@xueness/agent";
import { localLauncher, nodeExecutor, WorkflowStore } from "@xueness/plugin-workflows";
import { answerWorkflowActor, createActorHost } from "../src/workflow-actors.ts";

type Row = Record<string, any>;
const call = (id: string, name: string, input: Row): Row => ({ id, type: "function", function: { name, arguments: JSON.stringify(input) } });

async function until(store: WorkflowStore, wid: string, status: string): Promise<Row> {
  for (const started = Date.now(); Date.now() - started < 15_000; await new Promise((done) => setTimeout(done, 25))) {
    const record = store.load(wid);
    if (record.status === status) return record;
  }
  throw new Error(`workflow never reached ${status}: ${JSON.stringify(store.load(wid).status)}`);
}

// An actor node runs in its own transcript with the dependency results as untrusted memory, waits on
// `ask_user`, takes the operator's answer through `answer_actor`, and completes when the run resumes.
it("runs an actor node, pauses it on a question, answers it and completes on resume", async () => {
  const base = mkdtempSync(join(tmpdir(), "xue-actor-")), state = join(base, "state"), root = join(base, "work");
  mkdirSync(root); writeFileSync(join(root, "a.txt"), "alpha\n");
  const seen: { messages: Row[]; tools: string[] }[] = [];
  const provider: AgentProvider = { async complete(messages, tools) {
    seen.push({ messages, tools: tools.map((tool: Row) => String(tool.function?.name ?? tool.name)) });
    if (seen.length === 1) return { tool_calls: [call("r1", "read", { path: "a.txt" })] };
    if (seen.length === 2) return { tool_calls: [call("q1", "ask_user", { question: "Which section?" })] };
    return { content: "Summarised the intro.\nEvidence: E1" };
  } };
  const enabled = (id: string): boolean => ["sessions", "providers", "files", "shell", "planning", "workflows", "memory"].includes(id);
  const host = createActorHost({ stateDir: state, enabled, resolveProvider: () => provider });
  const store = new WorkflowStore(state, { launcher: localLauncher({ execute: nodeExecutor(host), enabled }) });
  try {
    const plan = { name: "Actor", nodes: [{ id: "prep", argv: [process.execPath, "-e", "console.log('context line')"] }, { id: "ask", kind: "agent", prompt: "Summarise a.txt", needs: ["prep"] }] };
    const wid = String(store.create(plan, root).id);
    store.launch(wid, true, true);
    const waiting = await until(store, wid, "awaiting_user");
    assert.equal(waiting.nodes.ask.status, "awaiting_user");
    assert.equal(waiting.nodes.ask.question, "Which section?");
    assert.ok(seen[0]!.tools.includes("Read") && seen[0]!.tools.includes("AskUserQuestion"), seen[0]!.tools.join(","));
    assert.ok(seen[0]!.messages.some((message) => message.role === "user" && String(message.content).includes("context line")), "dependency results reach the actor");
    await assert.rejects(answerWorkflowActor(store, wid, "prep", "x"));
    const answered = await answerWorkflowActor(store, wid, "ask", "The intro");
    assert.equal(answered.status, "paused");
    store.launch(wid, true, true);
    const done = await until(store, wid, "completed");
    assert.equal(done.nodes.ask.status, "completed");
    assert.match(String(done.nodes.ask.summary ?? ""), /Summarised the intro/);
    assert.ok(seen[2]!.messages.some((message) => String(message.content).includes("The intro")), "the answer is in the actor transcript");
  } finally { rmSync(base, { recursive: true, force: true }); }
});
