import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentContext, AgentExtension, ModelRequest, Row } from "@xueness/agent";
import { Context } from "@xueness/kernel";
import { discover, grantTrust, hooksBinding, hooksExtension, processHookOutput, revokeTrust, scopedExecute, setFeature, type Completed, type Execute } from "../src/index.ts";

interface Fixture { base: string; root: string; state: string }
function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "xueness-hooks-z5-"));
  const root = join(base, "workspace"), state = join(base, "state");
  mkdirSync(root, { recursive: true }); mkdirSync(state, { recursive: true });
  return { base, root, state };
}
function put(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}
function workspaceHooks(root: string, hooks: unknown[]): void { put(join(root, ".xueness", "hooks.json"), hooks); }
function userHooks(state: string, hooks: unknown[]): void {
  const directory = join(state, "resources", "hooks"); mkdirSync(directory, { recursive: true });
  for (let index = 0; index < hooks.length; index += 1) put(join(directory, `${index}.json`), hooks[index]);
}
function trustAll(state: string, root: string): void {
  const found = discover(root); assert.ok(found.workspace); assert.equal(grantTrust(state, found.workspace!, found.hooks, "2026-10-23T00:00:00Z").ok, true);
}
function done(value: unknown = "", code = 0, timedOut = false): Completed {
  return { code, stdout: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)), timedOut };
}
function ctx(f: Fixture, enabled: { hooks: boolean } = { hooks: true }, signal = new AbortController().signal): { context: AgentContext; session: Row } {
  const session: Row = { id: "s1", messages: [{ role: "user", content: "human request" }], status: "running", steps: 1 };
  const context = { session, root: f.root, stateDir: f.state, signal, provider: {}, options: {}, enabled: (id: string) => id === "hooks" ? enabled.hooks : true,
    async save() {}, emit() {} } as unknown as AgentContext;
  return { context, session };
}
function ext(f: Fixture, execute: Execute): AgentExtension { return hooksExtension({ stateDir: f.state, binding: hooksBinding(), legacy: true, execute }); }
function request(): ModelRequest { return { messages: [{ role: "system", content: "system" }, { role: "user", content: "human request" }], tools: [], options: {}, hostInstructions: [] }; }

describe("Z5 hook lifecycle consumption", () => {
  it("re-admits each workspace declaration after edits and revocation", async () => {
    for (const change of ["file", "revoke"] as const) {
      const f = fixture();
      try {
        setFeature(f.state, true);
        workspaceHooks(f.root, [{ id: "first", event: "PreToolUse", command: "first" }, { id: "second", event: "PreToolUse", command: "second" }]);
        trustAll(f.state, f.root);
        const calls: string[] = [];
        const execute: Execute = async ([command]) => {
          calls.push(String(command));
          if (command === "first" && change === "file") workspaceHooks(f.root, [{ id: "first", event: "PreToolUse", command: "first" }, { id: "second", event: "PreToolUse", command: "changed" }]);
          if (command === "first" && change === "revoke") {
            const rows = discover(f.root).hooks; revokeTrust(f.state, discover(f.root).workspace!, [String(rows.find((row) => row.id === "second")?.digest)]);
          }
          return done();
        };
        const { context } = ctx(f); await ext(f, execute).beforeRun?.(context);
        await ext(f, execute).beforeTool?.(context, { id: "c1", name: "exec", input: {} });
        assert.deepEqual(calls, ["first"], `${change} must stop the stale second declaration before dispatch`);
      } finally { rmSync(f.base, { recursive: true, force: true }); }
    }
  });

  it("keeps old source digests stable and refuses untrusted nested config hooks", async () => {
    const f = fixture();
    try {
      setFeature(f.state, true);
      workspaceHooks(f.root, [{ id: "native", event: "SessionStart", command: "native" }]);
      put(join(f.root, ".zcode", "config.json"), { hooks: { events: { SessionStart: [{ hooks: [{ type: "process", command: "zcode" }] }] } } });
      const before = discover(f.root).hooks;
      put(join(f.root, ".xueness", "config.json"), { hooks: { events: { SessionStart: [{ hooks: [{ type: "process", command: "nested" }] }] } } });
      const after = discover(f.root).hooks;
      for (const id of ["native", "workspace-hook-1-0"]) assert.equal(after.find((row) => row.id === id)?.digest, before.find((row) => row.id === id)?.digest);
      assert.equal(after.find((row) => row.command === "nested")?.id, "workspace-hook-2-0");
      assert.equal(after.find((row) => row.command === "nested")?.sourceIndex, 2);
      const calls: string[] = [], { context } = ctx(f);
      await ext(f, async ([command]) => { calls.push(String(command)); return done(); }).beforeRun?.(context);
      assert.deepEqual(calls, [], "workspace hooks without digest trust must not run");
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  it("keeps user hooks active when workspace hooks are off and stops dispatch on plugin close", async () => {
    const f = fixture();
    try {
      setFeature(f.state, true); workspaceHooks(f.root, [{ id: "workspace", event: "SessionStart", command: "workspace" }]); trustAll(f.state, f.root);
      userHooks(f.state, [{ id: "user", event: "SessionStart", command: "user" }]); setFeature(f.state, false);
      const calls: string[] = [], { context } = ctx(f);
      await ext(f, async ([command]) => { calls.push(String(command)); return done(); }).beforeRun?.(context);
      assert.deepEqual(calls, ["user"]);

      userHooks(f.state, [{ id: "a", event: "SessionStart", command: "first" }, { id: "b", event: "SessionStart", command: "second" }]);
      const enabled = { hooks: true }, next = ctx(f, enabled);
      await ext(f, async ([command]) => { calls.push(String(command)); enabled.hooks = false; return done(); }).beforeRun?.(next.context);
      assert.deepEqual(calls, ["user", "first"], "closing the plugin during dispatch prevents subsequent commands");
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  it("injects bounded untrusted contexts into the next request without editing human messages", async () => {
    const f = fixture();
    try {
      userHooks(f.state, [
        ...Array.from({ length: 3 }, (_, index) => ({ id: `session-${index}`, event: "SessionStart", command: `s${index}` })),
        ...Array.from({ length: 3 }, (_, index) => ({ id: `prompt-${index}`, event: "UserPromptSubmit", command: `p${index}` })),
      ]);
      const execute: Execute = async ([command]) => done({ hookSpecificOutput: { hookEventName: String(command).startsWith("s") ? "SessionStart" : "UserPromptSubmit", additionalContext: String(command).startsWith("s") ? "s".repeat(1800) : "p".repeat(1800) } });
      const extension = ext(f, execute), { context, session } = ctx(f), original = structuredClone(session.messages);
      await extension.beforeRun?.(context);
      const prepared = await extension.prepareRequest?.(context, request()) as ModelRequest;
      const injected = prepared.hostInstructions?.find((item) => item.startsWith("UNTRUSTED hook context"));
      assert.ok(injected); assert.ok(injected.includes("s".repeat(100))); assert.ok(injected.includes("p".repeat(100)));
      assert.ok(Array.from(injected).length <= 8000);
      assert.deepEqual(session.messages, original);
      extension.modelRequestCompleted?.(context, {});
      assert.equal((await extension.prepareRequest?.(context, request()) as ModelRequest).hostInstructions?.some((item) => item.startsWith("UNTRUSTED hook context")), false);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  it("applies object updatedInput while preserving deny precedence and the existing gate", async () => {
    const f = fixture();
    try {
      userHooks(f.state, [
        { id: "a-update", event: "PreToolUse", command: "update" },
        { id: "z-deny", event: "PreToolUse", command: "deny" },
      ]);
      let deny = false;
      const execute: Execute = async ([command]) => String(command) === "deny" && deny
        ? done({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "blocked", updatedInput: { path: "replaced" } } })
        : done({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { path: "replaced" } } });
      const extension = ext(f, execute), { context } = ctx(f); await extension.beforeRun?.(context);
      const call = { id: "c1", name: "read", input: { path: "original" } };
      assert.equal(await extension.beforeTool?.(context, call), null);
      assert.deepEqual(call.input, { path: "replaced" }, "allow leaves authorization to the bridge after input replacement");
      deny = true; call.input = { path: "original" };
      const refusal = await extension.beforeTool?.(context, call);
      assert.equal((refusal as Row).hook_blocked, true); assert.deepEqual(call.input, { path: "original" });
      assert.equal(processHookOutput("PreToolUse", { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: ["bad"] } }).updatedInput, undefined);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  it("runs Stop once, permits one guided continuation, and does not repeat on close", async () => {
    const f = fixture();
    try {
      userHooks(f.state, [{ id: "stop", event: "Stop", command: "stop" }]);
      let calls = 0;
      const extension = ext(f, async () => { calls += 1; return done({ decision: "block", reason: "revise the answer" }); });
      const { context } = ctx(f); await extension.beforeRun?.(context);
      assert.equal(await extension.beforeFinalResponse?.(context, {}), true);
      const prepared = await extension.prepareRequest?.(context, request()) as ModelRequest;
      assert.ok(prepared.hostInstructions?.some((item) => item.includes("revise the answer")));
      assert.equal(await extension.beforeFinalResponse?.(context, {}), false);
      await extension.close?.(context);
      assert.equal(calls, 1);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  it("pauses beforeRun with the UserPromptSubmit reason", async () => {
    const f = fixture();
    try {
      userHooks(f.state, [{ id: "pause", event: "UserPromptSubmit", command: "pause" }]);
      const { context, session } = ctx(f), original = structuredClone(session.messages);
      const extension = ext(f, async () => done({ continue: false, reason: "operator requested a pause" }));
      assert.deepEqual(await extension.beforeRun?.(context), { stop: true });
      assert.equal(session.status, "paused"); assert.equal(session.pause_reason, "operator requested a pause");
      assert.deepEqual(session.messages, original);
    } finally { rmSync(f.base, { recursive: true, force: true }); }
  });

  it("cancels the process scope and records no successful control result", async () => {
    const f = fixture(); const kernel = Context.create({ roots: { workspace: [f.root] } });
    const controller = new AbortController();
    try {
      const execute = scopedExecute(() => kernel);
      const pending = execute([process.execPath, "-e", "setTimeout(() => {}, 10000)"], { cwd: f.root, input: "{}", timeoutMs: 20000, signal: controller.signal });
      setTimeout(() => controller.abort(), 80);
      const outcome = await pending;
      assert.notEqual(outcome.code, 0); assert.equal(outcome.timedOut, false); assert.equal(kernel.scope.size, 0);
    } finally { await kernel.dispose(); rmSync(f.base, { recursive: true, force: true }); }
  });
});
