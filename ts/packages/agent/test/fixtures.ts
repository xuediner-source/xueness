import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore, type Session } from "@xueness/sessions";
import { AgentRunner, type AgentProvider, type AgentPluginHooks, type AgentRunnerOptions, type Row } from "../src/index.ts";
import { PROJECT_ROOT, runPython } from "../../../test-support/python-oracle.ts";

export const schemas: Row[] = [{ type: "function", function: { name: "read", description: "Scripted test read", parameters: { type: "object", properties: {} } } }];
export const call = (id: string, args = "{}", name = "read"): Row => ({ id, type: "function", function: { name, arguments: args } });
export const session = (): Session => ({ id: "a".repeat(32), root: "", task: "task", status: "pending", steps: 0,
  messages: [{ role: "system", content: "System" }, { role: "user", content: "task" }], results: {}, compactions: [], archived_messages: [], completion: null });
export const oracle = (inputs: Row[]): unknown[] => JSON.parse(runPython(readFileSync(join(PROJECT_ROOT, "ts", "test-support", "python", "agent_oracle.py"), "utf8"), JSON.stringify(inputs)));
export function project(value: Session): Row {
  const result: Row = {};
  for (const key of ["status", "steps", "results", "completion", "completion_history", "pause_code", "pause_reason", "pending_question", "completion_reference_repair", "completion_reference_repairs"]) if (Object.hasOwn(value, key)) result[key] = value[key];
  result.messages = (value.messages as Row[]).map((message) => Object.fromEntries(Object.entries(message).filter(([key]) => !key.startsWith("_"))));
  return result;
}
export function fixture(responses: Row[], outcomes: Row[] = [], extra: Partial<AgentRunnerOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "xueness-agent-"));
  const store = new SessionStore(join(directory, "state"));
  const value = session(); value.root = directory;
  let requests = 0;
  let effects = 0;
  const provider: AgentProvider = { runtimeProfile: "standard", toolCalling: "native", async complete() {
    const result = responses[requests++]; if (!result) throw new Error("script exhausted"); return structuredClone(result);
  } };
  const hooks: AgentPluginHooks = { enabled: (id) => ["providers", "sessions", "files"].includes(id), toolOwner: (name) => name === "read" ? "files" : null, tools: () => schemas };
  const toolBridge = { async call() { const result = outcomes[effects++]; if (!result) throw new Error("tool script exhausted"); return structuredClone(result) as any; }, async callAll() { throw new Error("use declared batching"); } };
  const runner = new AgentRunner({ store, provider, hooks, toolBridge, root: directory, ...extra });
  return { directory, store, session: value, runner, provider, hooks, requests: () => requests, effects: () => effects, close: () => rmSync(directory, { recursive: true, force: true }) };
}
