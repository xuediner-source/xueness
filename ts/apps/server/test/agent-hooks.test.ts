/** Lifecycle hooks on the TS front door: no Python fallback, Python's fire points and audit, ZCode tool names as matcher aliases. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SessionStore } from "@xueness/sessions";
import type { AgentProvider, Row } from "@xueness/agent";
import type { RunPolicy } from "@xueness/plugin-sessions";
import { createAgentService } from "../src/agent-service.ts";
import { configuredAgentFeatures } from "../src/agent-features.ts";

const call = (id: string, name: string, input: Row): Row => ({ id, type: "function", function: { name, arguments: JSON.stringify(input) } });
const policy = (request: Row = {}): RunPolicy => ({ mode: "build", permissionMode: "build", disallowed: [], selection: {}, request });
const enabled = (id: string): boolean => ["sessions", "providers", "files", "shell", "hooks"].includes(id);
function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xueness-hooks-ws-")));
  const state = realpathSync(mkdtempSync(join(tmpdir(), "xueness-hooks-state-")));
  const store = new SessionStore(join(state, "sessions"));
  const hook = (id: string, body: Row): void => { mkdirSync(join(state, "resources", "hooks"), { recursive: true }); writeFileSync(join(state, "resources", "hooks", `${id}.json`), JSON.stringify({ id, ...body })); };
  const capture = (name: string): Row => ({ command: "/bin/sh", args: ["-c", `cat >> "${join(state, name)}"; echo >> "${join(state, name)}"`] });
  return { root, state, store, hook, capture, close() { rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); } };
}
const lines = (path: string): Row[] => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row) : [];

describe("hooks on the TS agent service", { skip: process.platform === "win32" ? "POSIX hook commands" : false }, () => {
  it("fires the legacy events, vetoes a call with exit 2 and audits every firing", async () => {
    const local = scratch(); writeFileSync(join(local.root, "a.txt"), "hello\n");
    local.hook("start", { event: "SessionStart", ...local.capture("start.log") });
    local.hook("prompt", { event: "UserPromptSubmit", ...local.capture("prompt.log") });
    local.hook("veto", { event: "PreToolUse", matcher: "^Bash$", command: "/bin/sh", args: ["-c", "echo no shell here; exit 2"] });
    local.hook("post", { event: "PostToolUse", matcher: "read", ...local.capture("post.log") });
    local.hook("fail", { event: "PostToolUseFailure", ...local.capture("fail.log") });
    local.hook("stop", { event: "Stop", ...local.capture("stop.log") });
    const session = await local.store.new("Read a.txt then touch b", local.root);
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled });
    let requests = 0; const seen: Row[][] = [];
    const provider: AgentProvider = { async complete(messages) {
      seen.push(messages); requests += 1;
      return requests === 1 ? { tool_calls: [call("r1", "Read", { file_path: join(local.root, "a.txt") }), call("b1", "Bash", { command: "touch b", description: "touch" })] } : { content: "Done." };
    } };
    try {
      const request = { allow_hooks: true };
      assert.ok(configuredAgentFeatures(session, request, { stateDir: local.state, enabled, settings: {} }).includes("hooks.commands"));
      assert.equal(service.supports(session, request), true, "hooks run on the TS hooks plugin, not the Python executor");
      await service.createRunner(session, provider, policy(request)).run(session);
      assert.equal(session.status, "completed");
      assert.deepEqual(lines(join(local.state, "start.log")), [{ session_id: session.id, workspace: local.root, source: "startup", hook_event_name: "SessionStart" }]);
      assert.deepEqual(lines(join(local.state, "prompt.log")), [{ session_id: session.id, prompt: "Read a.txt then touch b", hook_event_name: "UserPromptSubmit" }]);
      assert.equal(existsSync(join(local.root, "b")), false, "the vetoed command never ran");
      const blocked = (session.results as Row).b1 as Row;
      assert.deepEqual({ ok: blocked.ok, error: blocked.error, hook_blocked: blocked.hook_blocked, hook_output_untrusted: blocked.hook_output_untrusted }, { ok: false, error: "blocked by hook veto", hook_blocked: true, hook_output_untrusted: "no shell here" });
      assert.deepEqual(lines(join(local.state, "post.log")), [{ session_id: session.id, tool: "read", tool_call_id: "r1", ok: true, hook_event_name: "PostToolUse" }]);
      assert.deepEqual(lines(join(local.state, "fail.log")), [{ session_id: session.id, tool: "exec", tool_call_id: "b1", ok: false, hook_event_name: "PostToolUseFailure" }]);
      assert.deepEqual(lines(join(local.state, "stop.log")), [{ session_id: session.id, status: "running", steps: session.steps, stop_hook_active: false, hook_event_name: "Stop" }]);
      const log = (await local.store.load(String(session.id))).hook_log as Row[];
      assert.deepEqual(log.map((row) => [row.event, row.id, row.exit_code, row.blocked]), [["SessionStart", "start", 0, false], ["UserPromptSubmit", "prompt", 0, false],
        ["PostToolUse", "post", 0, false], ["PreToolUse", "veto", 2, true], ["PostToolUseFailure", "fail", 0, false], ["Stop", "stop", 0, false]]);
      assert.ok(log.every((row) => !("output" in row)), "the audit never keeps hook output");
    } finally { await service.dispose(); local.close(); }
  });
  it("fires PermissionRequest after a denial, as observation only", async () => {
    const local = scratch();
    local.hook("perm", { event: "PermissionRequest", matcher: "Bash", ...local.capture("perm.log") });
    local.hook("grant", { event: "PermissionRequest", command: "/bin/sh", args: ["-c", "echo '{\"decision\":\"approve\"}'"] });
    const session = await local.store.new("touch b", local.root);
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled });
    let requests = 0;
    const provider: AgentProvider = { async complete() { return requests++ === 0 ? { tool_calls: [call("b1", "Bash", { command: "touch b", description: "touch" })] } : { content: "Denied." }; } };
    try {
      await service.createRunner(session, provider, { ...policy({ allow_hooks: true }), disallowed: ["exec"] }).run(session);
      assert.deepEqual(lines(join(local.state, "perm.log")), [{ session_id: session.id, tool_name: "exec", tool_call_id: "b1", hook_event_name: "PermissionRequest" }]);
      assert.equal(((session.results as Row).b1 as Row).ok, false, "a hook never grants");
      assert.equal(existsSync(join(local.root, "b")), false);
    } finally { await service.dispose(); local.close(); }
  });
  it("fires pipeline hooks without allow_hooks and leaves the other events alone", async () => {
    const local = scratch(); writeFileSync(join(local.root, "a.txt"), "hello\n");
    local.hook("piped", { event: "PostToolUse", pipeline: true, matcher: "Read", ...local.capture("piped.log") });
    local.hook("legacy", { event: "PostToolUse", ...local.capture("legacy.log") });
    local.hook("stop", { event: "Stop", ...local.capture("stop.log") });
    const session = await local.store.new("Read a.txt", local.root);
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled });
    let requests = 0;
    const provider: AgentProvider = { async complete() { return requests++ === 0 ? { tool_calls: [call("r1", "Read", { file_path: join(local.root, "a.txt") })] } : { content: "Read." }; } };
    try {
      assert.ok(configuredAgentFeatures(session, {}, { stateDir: local.state, enabled, settings: {} }).includes("hooks.commands"));
      assert.equal(service.supports(session, {}), true);
      await service.createRunner(session, provider, policy()).run(session);
      const piped = lines(join(local.state, "piped.log"));
      assert.equal(piped.length, 1);
      assert.deepEqual({ ...piped[0], result: undefined }, { session_id: session.id, tool: "read", tool_call_id: "r1", ok: true, result: undefined, hook_event_name: "PostToolUse" });
      assert.match(String((piped[0]!.result as Row).output), /hello/);
      assert.deepEqual(lines(join(local.state, "legacy.log")), []); assert.deepEqual(lines(join(local.state, "stop.log")), []);
      assert.equal((await local.store.load(String(session.id))).hook_log, undefined, "pipeline firings are not audited");
    } finally { await service.dispose(); local.close(); }
  });
  it("keeps untrusted workspace hooks pending and runs trusted ones", async () => {
    const local = scratch();
    mkdirSync(join(local.root, ".xueness"), { recursive: true });
    writeFileSync(join(local.root, ".xueness", "hooks.json"), JSON.stringify([{ id: "ws-start", event: "SessionStart", ...local.capture("ws.log") }]));
    writeFileSync(join(local.state, "workspace-hooks.json"), JSON.stringify({ enabled: true }));
    const session = await local.store.new("Hi", local.root);
    const service = createAgentService({ store: local.store, stateDir: local.state, enabled });
    try {
      await service.createRunner(session, { complete: async () => ({ content: "Hello." }) }, policy({ allow_hooks: true })).run(session);
      assert.deepEqual(lines(join(local.state, "ws.log")), [], "pending trust: not run");
      const diagnostics = session.hook_diagnostics as Row[];
      assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0]!.kind, "pending_trust");
      const { discover } = await import("@xueness/plugin-hooks");
      const found = discover(local.root);
      writeFileSync(join(local.state, "hook-trust.json"), JSON.stringify({ schemaVersion: 1, records: [{ workspace: found.workspace, digest: found.hooks[0]!.digest, decision: "trusted", grantedAt: "2026-10-19T00:00:00Z" }] }));
      const next = await local.store.new("Hi again", local.root);
      await service.createRunner(next, { complete: async () => ({ content: "Hello." }) }, policy({ allow_hooks: true })).run(next);
      assert.deepEqual(lines(join(local.state, "ws.log")), [{ session_id: next.id, workspace: local.root, source: "startup", hook_event_name: "SessionStart" }]);
    } finally { await service.dispose(); local.close(); }
  });
});
