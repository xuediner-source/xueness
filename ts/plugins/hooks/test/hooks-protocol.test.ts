/**
 * F07.02 — the hook input/output protocol checked against the ZCode v3.15.1
 * reference samples (`packages/core/tests/hooks-seven-events.test.ts`): stdin
 * shape per event, matcher rules, exit-code table, timeout containment and
 * stdout control semantics. Xueness keeps its restrict-only boundary: a hook
 * can tighten a run, never loosen it, and never swallows a tool result.
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Context } from "@xueness/kernel";
import { HookRunner, parseHookStdout, processHookOutput, scopedExecute, vetoOf, type Completed, type Execute, type FireOptions, type HookResult, type HookRunResult } from "../src/index.ts";

const context = (event: string, text: string) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

interface Sample {
  event: string;
  hooks: Record<string, unknown>[];
  payload: Record<string, unknown>;
  fire?: FireOptions;
  expectedStdin: Record<string, unknown>;
  output: unknown;
  verify: (decision: HookRunResult, results: readonly HookResult[]) => void;
}

const samples: Sample[] = [
  {
    event: "SessionStart",
    hooks: [{ id: "session", event: "SessionStart", command: "hook-command", matcher: "startup" }],
    payload: { session_id: "s1", source: "startup", model: "anthropic/opus" },
    fire: { subjects: ["startup"] },
    expectedStdin: { hook_event_name: "SessionStart", session_id: "s1", source: "startup", model: "anthropic/opus" },
    output: context("SessionStart", "session-context"),
    verify: (decision) => assert.deepEqual(decision.additionalContexts, ["session-context"]),
  },
  {
    event: "UserPromptSubmit",
    hooks: [{ id: "prompt", event: "UserPromptSubmit", command: "hook-command", matcher: "matcher-is-not-applied-to-prompt" }],
    payload: { session_id: "s1", prompt: "ship hooks" },
    fire: { subjects: null },
    expectedStdin: { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "ship hooks" },
    output: context("UserPromptSubmit", "prompt-context"),
    verify: (decision) => assert.deepEqual(decision.additionalContexts, ["prompt-context"]),
  },
  {
    event: "PreToolUse",
    hooks: [{ id: "pre", event: "PreToolUse", command: "hook-command", matcher: "Write|Edit" }],
    payload: { session_id: "s1", tool_name: "Write", tool_call_id: "c1", arguments: { path: "a.ts" } },
    expectedStdin: { hook_event_name: "PreToolUse", tool_name: "Write", tool_call_id: "c1", arguments: { path: "a.ts" } },
    output: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { path: "b.ts" }, additionalContext: "pre-context" } },
    verify: (decision) => {
      assert.equal(decision.permissionBehavior, "allow");
      assert.deepEqual(decision.updatedInput, { path: "b.ts" });
      assert.deepEqual(decision.additionalContexts, ["pre-context"]);
    },
  },
  {
    event: "PermissionRequest",
    hooks: [{ id: "permission", event: "PermissionRequest", command: "hook-command", matcher: "Write" }],
    payload: { session_id: "s1", tool_name: "Write", tool_call_id: "c1", reason: "write requires approval" },
    expectedStdin: { hook_event_name: "PermissionRequest", tool_name: "Write", reason: "write requires approval" },
    output: { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedPermissions: [{ type: "addRules", behavior: "allow", rules: [{ toolName: "Write" }] }] } } },
    verify: (decision) => {
      assert.equal((decision.permissionRequestResult as { behavior: string }).behavior, "allow");
      assert.ok(Array.isArray((decision.permissionRequestResult as { updatedPermissions: unknown[] }).updatedPermissions));
    },
  },
  {
    event: "PostToolUse",
    hooks: [{ id: "post", event: "PostToolUse", command: "hook-command", matcher: "Write" }],
    payload: { session_id: "s1", tool: "Write", tool_call_id: "c1", ok: true, result: { ok: true } },
    expectedStdin: { hook_event_name: "PostToolUse", tool: "Write", ok: true },
    output: context("PostToolUse", "post-context"),
    verify: (decision) => assert.deepEqual(decision.additionalContexts, ["post-context"]),
  },
  {
    event: "PostToolUseFailure",
    hooks: [{ id: "failure", event: "PostToolUseFailure", command: "hook-command", matcher: "Write" }],
    payload: { session_id: "s1", tool: "Write", tool_call_id: "c1", ok: false, error: { message: "cancelled", type: "TOOL_CANCELLED" } },
    expectedStdin: { hook_event_name: "PostToolUseFailure", tool: "Write", ok: false },
    output: context("PostToolUseFailure", "failure-context"),
    verify: (decision) => assert.deepEqual(decision.additionalContexts, ["failure-context"]),
  },
  {
    event: "Stop",
    hooks: [{ id: "stop", event: "Stop", command: "hook-command", matcher: "matcher-is-not-applied-to-response" }],
    payload: { session_id: "s1", status: "completed", stop_hook_active: false },
    fire: { subjects: null },
    expectedStdin: { hook_event_name: "Stop", stop_hook_active: false },
    output: { decision: "block", reason: "revise" },
    verify: (decision) => {
      assert.equal(decision.stopShouldContinue, true);
      assert.deepEqual(decision.additionalContexts, ["revise"]);
    },
  },
];

describe("hook protocol against the reference samples", () => {
  it("runs each of the seven events with the sample stdin, matcher and stdout semantics", async () => {
    const base = mkdtempSync(join(tmpdir(), "xueness-hook-protocol-"));
    const root = realpathSync(base);
    try {
      for (const sample of samples) {
        const stdin: Record<string, unknown>[] = [];
        const execute: Execute = async (_argv, options) => {
          stdin.push(JSON.parse(options.input) as Record<string, unknown>);
          return { code: 0, stdout: Buffer.from(JSON.stringify(sample.output)), timedOut: false } satisfies Completed;
        };
        const runner = new HookRunner(sample.hooks, root, execute);
        const results = await runner.fire(sample.event, sample.payload, sample.fire);
        assert.equal(results.length, 1, `${sample.event}: the matcher selected the sample hook`);
        assert.equal(results[0]!.exit_code, 0);
        assert.deepEqual(Object.fromEntries(Object.entries(stdin[0]!).filter(([key]) => key in sample.expectedStdin || key === "hook_event_name")), sample.expectedStdin);
        sample.verify(processHookOutput(sample.event, parseHookStdout(results[0]!.output)), results);
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("applies matcher subjects per event: SessionStart matches its source, prompt and Stop ignore the matcher", async () => {
    const base = mkdtempSync(join(tmpdir(), "xueness-hook-protocol-"));
    const root = realpathSync(base);
    try {
      const counting = (event: string): { execute: Execute; calls: () => number } => {
        let calls = 0;
        return { calls: () => calls, execute: async () => { calls += 1; return { code: 0, stdout: Buffer.alloc(0), timedOut: false }; } };
      };
      const session = counting("SessionStart");
      const runner = new HookRunner([{ id: "s", event: "SessionStart", command: "h", matcher: "resume" }], root, session.execute);
      assert.equal((await runner.fire("SessionStart", { source: "startup" }, { subjects: ["startup"] })).length, 0, "a non-matching source skips the hook");
      assert.equal((await runner.fire("SessionStart", { source: "resume" }, { subjects: ["resume"] })).length, 1);
      assert.equal(session.calls(), 1);
      const prompt = counting("UserPromptSubmit");
      const promptRunner = new HookRunner([{ id: "p", event: "UserPromptSubmit", command: "h", matcher: "never-matches-any-prompt" }], root, prompt.execute);
      assert.equal((await promptRunner.fire("UserPromptSubmit", { prompt: "hello" }, { subjects: null })).length, 1, "the matcher is not applied to prompts");
      const stop = counting("Stop");
      const stopRunner = new HookRunner([{ id: "x", event: "Stop", command: "h", matcher: "never-matches-any-response" }], root, stop.execute);
      assert.equal((await stopRunner.fire("Stop", { stop_hook_active: true }, { subjects: null })).length, 1, "the matcher is not applied to responses");
      const tool = counting("PreToolUse");
      const toolRunner = new HookRunner([{ id: "t", event: "PreToolUse", command: "h", matcher: "Write|Edit" }], root, tool.execute);
      assert.equal((await toolRunner.fire("PreToolUse", { tool_name: "read" })).length, 0);
      assert.equal((await toolRunner.fire("PreToolUse", { tool_name: "Write" })).length, 1, "the default subjects still match the tool name");
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("keeps the exit-code table: 0 passes, 2 blocks only PreToolUse, warnings and timeouts never block", async () => {
    const base = mkdtempSync(join(tmpdir(), "xueness-hook-protocol-"));
    const root = realpathSync(base);
    try {
      const reply = (code: number, timedOut = false): Execute => async () => ({ code, stdout: Buffer.from(code === 2 ? "denied by policy" : "diagnostic text"), timedOut });
      const at = (event: string, execute: Execute, payload: Record<string, unknown> = { tool_name: "Write" }): Promise<HookResult[]> =>
        new HookRunner([{ id: "h", event, command: "hook-command" }], root, execute).fire(event, payload);
      const pass = await at("PreToolUse", reply(0));
      assert.equal(pass[0]!.blocked, false);
      assert.equal(vetoOf(pass), null, "exit 0 with diagnostic text never blocks");
      const blocked = await at("PreToolUse", reply(2));
      assert.equal(blocked[0]!.blocked, true);
      assert.deepEqual(vetoOf(blocked), { ok: false, error: "blocked by hook h", hook_blocked: true, hook_output_untrusted: "denied by policy" });
      const warning = await at("PreToolUse", reply(3));
      assert.equal(warning[0]!.blocked, false, "a warning exit code is recorded, not a block");
      assert.equal(vetoOf(warning), null);
      const postBlocked = await at("PostToolUse", reply(2), { tool: "Write", ok: true });
      assert.equal(vetoOf(postBlocked), null, "exit 2 after the call cannot swallow the tool result");
      const timedOut = await at("PreToolUse", async () => ({ code: -1, stdout: Buffer.from("partial"), timedOut: true }));
      assert.equal(timedOut[0]!.timeout, true);
      assert.equal(timedOut[0]!.blocked, false);
      assert.equal(vetoOf(timedOut), null, "a timed-out hook never blocks");
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("times a real hook out, kills it and keeps the failure inside that hook's own result", async () => {
    if (process.platform === "win32") return;
    const base = mkdtempSync(join(tmpdir(), "xueness-hook-protocol-"));
    const root = realpathSync(base);
    const kernel = Context.create({ roots: { workspace: [root], state: root, temp: tmpdir() } });
    try {
      const runner = new HookRunner([{ id: "slow", event: "PreToolUse", command: "/bin/sh", args: ["-c", "sleep 3"], timeout: 0.3 }], root, scopedExecute(() => kernel));
      const [result] = await runner.fire("PreToolUse", { tool_name: "Write" });
      assert.equal(result!.timeout, true);
      assert.equal(result!.exit_code, -1);
      assert.equal(result!.blocked, false);
      assert.ok(result!.duration_ms < 2500, `the child was killed at the cap, not left running (${result!.duration_ms}ms)`);
      assert.equal(kernel.scope.size, 0, "the process scope is disposed after the timeout");
    } finally { await kernel.dispose(); rmSync(base, { recursive: true, force: true }); }
  });
});
