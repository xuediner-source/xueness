import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ProviderCancelled } from "@xueness/providers";
import { SessionStore } from "@xueness/sessions";
import type { AgentProvider, Row } from "@xueness/agent";
import type { RunPolicy } from "@xueness/plugin-sessions";
import { createAgentService } from "../src/agent-service.ts";
import { answerWaits } from "./approval-support.ts";

const call = (id: string, name: string, input: Row): Row => ({ id, type: "function", function: { name, arguments: JSON.stringify(input) } });
const policy = (request: Row = {}): RunPolicy => ({ mode: "build", permissionMode: "build", disallowed: [], selection: {}, request });
const enabled = (id: string): boolean => ["sessions", "providers", "files", "shell"].includes(id);
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "xueness-service-ws-"));
  const state = mkdtempSync(join(tmpdir(), "xueness-service-state-"));
  const store = new SessionStore(join(state, "sessions"));
  return { root, state, store, close() { rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); } };
}
describe("production agent service", () => {
  it("uses actual file tools and flags workspace answers without evidence as unverified", async () => {
    const local = scratch(); writeFileSync(join(local.root, "a.txt"), "hello\n");
    const session = await local.store.new("Read this file a.txt", local.root);
    let requests = 0;
    const provider: AgentProvider = { async complete() { return requests++ === 0 ? { tool_calls: [call("r1", "read", { path: "a.txt" })] } : { content: "Read the file.\nEvidence: E1" }; } };
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled });
    try {
      assert.equal(service.supports(session, {}), true);
      await service.createRunner(session, provider, policy()).run(session);
      assert.equal(session.status, "completed"); assert.equal((session.completion as Row).verified, true);
      assert.match(((session.results as Row).r1 as Row).output as string, /hello/);
      const missing = await local.store.new("Fix this project", local.root);
      await service.createRunner(missing, { complete: async () => ({ content: "I fixed it" }) }, policy()).run(missing);
      // ZCode-style: an unverified answer is flagged on the completion record, not turned into a review stop.
      assert.equal(missing.status, "completed"); assert.equal((missing.completion as Row).status, "unverified");
    } finally { await service.dispose(); local.close(); }
  });
  // Fallback path: a wait nobody answers before a restart is deferred, then replayed.
  it("replays exactly the approved original denied call once before asking the model again", async () => {
    const local = scratch(); const session = await local.store.new("Write this file a.txt", local.root);
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled });
    let requests = 0;
    const provider: AgentProvider = { async complete() {
      requests += 1;
      if (requests === 1) return { tool_calls: [call("w1", "write", { path: "./a.txt", content: "approved\n" })] };
      assert.equal(readFileSync(join(local.root, "a.txt"), "utf8"), "approved\n");
      return { content: "Written.\nEvidence: E1" };
    } };
    try {
      await answerWaits(service.liveApprovals, service.createRunner(session, provider, policy()).run(session), "defer");
      assert.equal(session.status, "paused"); assert.equal(existsSync(join(local.root, "a.txt")), false);
      const refusal = (session.results as Row).w1 as Row; const data = refusal.data as Row;
      assert.equal(data.subject, "a.txt");
      service.approvals.set(String(session.id), new Map([[String(data.kind), new Map([["w1", String(data.subject)]])]]));
      await service.createRunner(session, provider, policy()).run(session);
      assert.equal(session.status, "completed"); assert.equal(requests, 2);
      assert.equal(service.approvals.get(String(session.id))?.get("write")?.size, 0);
      assert.equal((session.messages as Row[]).filter((message) => message.role === "tool").length, 1);
      assert.equal(((session.results as Row).w1 as Row).ok, true);
    } finally { await service.dispose(); local.close(); }
  });
  it("does not spend a stale approval for a different subject or disabled owner", async () => {
    const local = scratch(); const session = await local.store.new("Write a.txt", local.root);
    let files = true;
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled: (id) => enabled(id) && (id !== "files" || files) });
    const provider: AgentProvider = { complete: async () => ({ tool_calls: [call("w1", "write", { path: "a.txt", content: "x" })] }) };
    try {
      await answerWaits(service.liveApprovals, service.createRunner(session, provider, policy()).run(session), "defer");
      service.approvals.set(String(session.id), new Map([["write", new Map([["w1", "other.txt"]])]]));
      files = false;
      await service.createRunner(session, { complete: async () => ({ content: "Cannot write" }) }, policy()).run(session);
      assert.equal(existsSync(join(local.root, "a.txt")), false);
      assert.equal(service.approvals.get(String(session.id))?.get("write")?.get("w1"), "other.txt");
    } finally { await service.dispose(); local.close(); }
  });
  it("supports every configured capability on TS without model calls", async () => {
    const local = scratch(); const session = await local.store.new("hello", local.root);
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled: () => true });
    try {
      assert.equal(service.supports(session, { allow_hooks: true, allow_mcp: true }), true, "empty opt-in resources do not force backend fallback");
      mkdirSync(join(local.state, "resources", "hooks"), { recursive: true }); mkdirSync(join(local.state, "resources", "mcp"), { recursive: true });
      writeFileSync(join(local.state, "resources", "hooks", "hook.json"), JSON.stringify({ id: "hook", event: "PreToolUse", command: "configured-hook" }));
      writeFileSync(join(local.state, "resources", "mcp", "server.json"), JSON.stringify({ id: "server", command: "configured-mcp" }));
      assert.equal(service.supports(session, { allow_hooks: true }), true, "configured hooks run on the TS hooks plugin");
      assert.equal(service.supports(session, { allow_mcp: true }), true, "a stdio MCP server runs on the TS mcp plugin");
      writeFileSync(join(local.state, "resources", "mcp", "server.json"), JSON.stringify({ id: "server", transport: "http", url: "https://example.com/mcp", oauth: { clientId: "c" } }));
      assert.equal(service.supports(session, { allow_mcp: true }), true, "OAuth bearer is attached by the TS HTTP transport");
      assert.equal(service.supports(session, { allow_subagents: true }), true, "foreground delegation runs on the TS subagents plugin");
      session.subagent_coordination = { "task-x": { call_id: "c", collected: false } }; assert.equal(service.supports(session, {}), true, "background tasks left by the removed Python backend do not pin the session"); delete session.subagent_coordination;
      session.delivery_requirements = [{ id: "verify", label: "verify artifact", contains: ["required"] }]; assert.equal(service.supports(session, {}), true);
      delete session.delivery_requirements;
      session.goal = { text: "Finish requested work", status: "active" }; assert.equal(service.supports(session, {}), true, "goal continuation has a concrete driver"); delete session.goal;
      writeFileSync(join(local.root, "AGENTS.md"), "workspace-specific guidance"); assert.equal(service.supports(session, {}), true);
      await service.createRunner(session, { complete: async (messages) => {
        assert.ok(messages.some((row) => row.role === "user" && String(row.content).includes("workspace-specific guidance")));
        return { content: "hello" };
      } }, policy()).run(session);
      assert.ok(!(session.messages as Row[]).some((row) => String(row.content).includes("workspace-specific guidance")), "workspace context is never persisted as a user turn");
    } finally { await service.dispose(); local.close(); }
  });
  it("connects configured MCP servers for the run, asks before each call and closes them afterwards", async () => {
    const local = scratch(); const session = await local.store.new("Use the echo tool", local.root);
    mkdirSync(join(local.state, "resources", "mcp"), { recursive: true });
    writeFileSync(join(local.state, "resources", "mcp", "fake.json"), JSON.stringify({ id: "fake", command: process.execPath, args: [join(import.meta.dirname, "..", "..", "..", "plugins", "mcp", "test", "fake-server.mjs")] }));
    const mcpEnabled = (id: string): boolean => enabled(id) || id === "mcp";
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled: mcpEnabled });
    const seen: Row[][] = []; const toolNames: string[][] = [];
    const provider: AgentProvider = { async complete(messages, tools) {
      seen.push(messages); toolNames.push((tools ?? []).map((tool) => String((tool.function as Row).name)));
      return seen.length === 1 ? { tool_calls: [call("m1", "mcp__fake__echo", { text: "hi" })] } : { content: "The tool said echo: hi" };
    } };
    try {
      assert.equal(service.supports(session, { allow_mcp: true }), true);
      await answerWaits(service.liveApprovals, service.createRunner(session, provider, policy({ allow_mcp: true })).run(session), "approve");
      assert.ok(toolNames[0]!.includes("mcp__fake__echo") && toolNames[0]!.includes("mcp__fake__Weird_Name_"), toolNames[0]!.join(","));
      const result = (session.results as Row).m1 as Row;
      assert.equal(result.ok, true); assert.equal(result.output, "echo: hi");
      const toolMessage = seen[1]!.find((message) => message.role === "tool");
      assert.equal(toolMessage?.content, "echo: hi", "the model reads the MCP text, ZCode formatMcpToolResult");
      // Without allow_mcp the next run has no MCP tools: the connection was per run.
      seen.length = 0; toolNames.length = 0; const second = await local.store.new("again", local.root);
      await service.createRunner(second, { async complete(_messages, tools) { toolNames.push((tools ?? []).map((tool) => String((tool.function as Row).name))); return { content: "ok" }; } }, policy()).run(second);
      assert.equal(toolNames.length, 1); assert.ok(!toolNames[0]!.some((name) => name.startsWith("mcp__")));
    } finally { await service.dispose(); local.close(); }
  });
  it("lists workspace skills to the model and loads one through the ZCode Skill tool", async () => {
    const local = scratch(); const session = await local.store.new("Use the deploy skill", local.root);
    mkdirSync(join(local.root, ".xueness", "skills", "deploy"), { recursive: true });
    writeFileSync(join(local.root, ".xueness", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Ship the build\n---\nRun ${ZCODE_SKILL_DIR}/ship.sh first.\n");
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled: (id) => enabled(id) || id === "skills" });
    const seen: Row[][] = []; const toolNames: string[][] = [];
    const provider: AgentProvider = { async complete(messages, tools) {
      seen.push(messages); toolNames.push((tools ?? []).map((tool) => String((tool.function as Row).name)));
      return seen.length === 1 ? { tool_calls: [call("s1", "Skill", { skill: "deploy" })] } : { content: "Loaded." };
    } };
    try {
      assert.equal(service.supports(session, {}), true, "skills run on the TS skills plugin");
      await service.createRunner(session, provider, policy()).run(session);
      assert.ok(toolNames[0]!.includes("Skill") && toolNames[0]!.includes("skill_validate"), toolNames[0]!.join(","));
      const listing = seen[0]!.find((message) => message.role === "user" && String(message.content).includes("The following skills are available for use with the Skill tool"));
      assert.ok(listing && String(listing.content).includes("- deploy: Ship the build ("), "ZCode skills_listing reminder");
      const result = (session.results as Row).s1 as Row;
      assert.equal(result.ok, true);
      const toolMessage = seen[1]!.find((message) => message.role === "tool");
      assert.match(String(toolMessage?.content), /^<skill_content name="deploy">\n# Skill: deploy\nRun .*deploy\/ship\.sh first\./);
      assert.deepEqual((session.skill_context_references as Row[]).map((row) => row.id), ["file:project:deploy"]);
      assert.ok(!(session.messages as Row[]).some((message) => String(message.content).includes("The following skills are available")), "the listing is never persisted");
    } finally { await service.dispose(); local.close(); }
  });
  it("allows only the session plan draft to be written in permission plan mode", async () => {
    const local = scratch(); const session = await local.store.new("Plan the work", local.root);
    const draft = join(local.state, "plan-drafts", String(session.id) + ".md");
    let requests = 0;
    const provider: AgentProvider = { async complete() { return requests++ === 0 ? { tool_calls: [call("p1", "write", { path: draft, content: "# Plan\n" })] } : { content: "Plan saved.\nEvidence: E1" }; } };
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled });
    try {
      await service.createRunner(session, provider, { ...policy(), permissionMode: "plan" }).run(session);
      assert.equal(readFileSync(draft, "utf8"), "# Plan\n");
      assert.equal(((session.file_history as Row[] | undefined) ?? []).some((row) => Array.isArray(row.paths) && row.paths.includes(draft)), false);
      assert.equal(session.mode, "build");
    } finally { await service.dispose(); local.close(); }
  });
  // Step 4 (ZCode compaction): the standard runtime no longer runs the JSON handoff; past the
  // ZCode threshold it asks the session model for the ZCode summary and keeps the latest round.
  it("compacts past the ZCode threshold through the real plugin hook before the main request", async () => {
    const local = scratch(); const session = await local.store.new("Original human requirement", local.root);
    const messages = session.messages as Row[];
    for (let index = 0; index < 12; index += 1) messages.push({ role: "assistant", content: `Observation ${index}: ` + "Observed prior text ".repeat(600) });
    messages.push({ role: "user", content: "Explain the previous discussion" });
    await local.store.save(session);
    let summaries = 0; let requests = 0;
    const provider: AgentProvider = { contextWindow: 60_000, maxOutputTokens: 1_000, async complete(prompt, tools) {
      if (String(prompt.at(-1)?.content).startsWith("CRITICAL: Respond with TEXT ONLY")) {
        summaries += 1; assert.ok(tools.length > 0, "the summary request keeps the tool definitions");
        assert.ok(prompt.some((row) => row.role === "user" && row.content === "Original human requirement"));
        assert.ok(!prompt.some((row) => row.content === "Explain the previous discussion"), "the latest round stays verbatim");
        return { content: "<analysis>notes</analysis>\n<summary>1. Primary Request and Intent: Original human requirement</summary>" };
      }
      requests += 1;
      const summary = prompt.find((row) => row.role === "user" && String(row.content).startsWith("This session is being continued from a previous conversation"));
      assert.ok(summary && String(summary.content).includes("Summary:\n1. Primary Request and Intent: Original human requirement"));
      assert.ok(!prompt.some((row) => row.role === "system" && row._compact_summary));
      assert.ok(prompt.some((row) => row.role === "user" && row.content === "Explain the previous discussion"));
      return { content: "A concise explanation" };
    } };
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled });
    try {
      assert.equal(service.supports(session, {}), true);
      await service.createRunner(session, provider, policy()).run(session);
      assert.equal(summaries, 1); assert.equal(requests, 1); assert.equal((session.context_checkpoints as Row[]).length, 1);
      const record = (session.compactions as Row[]).at(-1)!;
      assert.equal(record.kind, "zcode"); assert.equal(record.trigger, "auto"); assert.equal(record.kept, 2);
      assert.equal((session.messages as Row[])[1]!._compact_summary, true);
      assert.equal(session.status, "completed");
      const reloaded = await local.store.load(String(session.id));
      assert.ok((reloaded.archived_messages as Row[]).some((row) => row.content === "Original human requirement"));
    } finally { await service.dispose(); local.close(); }
  });
  it("drains an active request on host shutdown even with experimental cancel propagation disabled", async () => {
    const local = scratch(); const session = await local.store.new("hello", local.root);
    let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    const provider: AgentProvider = { complete: async (_messages, _tools, options) => {
      started(); return new Promise((_resolve, reject) => { options?.signal?.addEventListener("abort", () => reject(new ProviderCancelled()), { once: true }); });
    } };
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled });
    try {
      const running = service.createRunner(session, provider, policy()).run(session);
      await ready; await service.dispose(); await running;
      assert.equal(session.status, "stopped");
      const lease = await local.store.lease(String(session.id)); await lease.release();
    } finally { await service.dispose(); local.close(); }
  });
});
