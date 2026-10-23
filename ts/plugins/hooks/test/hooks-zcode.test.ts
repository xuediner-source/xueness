/** ZCode v3.15.1 hook output contract (tests/hooks-seven-events.test.ts) and the restrict-only subset Xueness applies. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchesHookMatcher, mergeHookRunResult, parseHookStdout, preToolDenial, processHookOutput, vetoOf, type HookResult, type HookRunResult } from "../src/index.ts";

const context = (event: string, text: string) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
const result = (output: string, exit = 0, id = "h"): HookResult => ({ id, event: "PreToolUse", exit_code: exit, blocked: exit === 2, timeout: false, duration_ms: 1, output });

describe("ZCode hook output", () => {
  it("parses the seven events like ZCode", () => {
    assert.deepEqual(processHookOutput("SessionStart", context("SessionStart", "session-context")).additionalContexts, ["session-context"]);
    assert.deepEqual(processHookOutput("UserPromptSubmit", context("UserPromptSubmit", "prompt-context")).additionalContexts, ["prompt-context"]);
    const pre = processHookOutput("PreToolUse", { hookSpecificOutput: { additionalContext: "pre-context", hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { path: "b.ts" } } });
    assert.equal(pre.permissionBehavior, "allow"); assert.deepEqual(pre.updatedInput, { path: "b.ts" });
    const permission = processHookOutput("PermissionRequest", { hookSpecificOutput: { decision: { behavior: "allow", updatedPermissions: [] }, hookEventName: "PermissionRequest" } });
    assert.equal((permission.permissionRequestResult as { behavior: string }).behavior, "allow");
    assert.deepEqual(processHookOutput("PostToolUse", context("PostToolUse", "post-context")).additionalContexts, ["post-context"]);
    assert.deepEqual(processHookOutput("PostToolUseFailure", context("PostToolUseFailure", "failure-context")).additionalContexts, ["failure-context"]);
    const stop = processHookOutput("Stop", { decision: "block", reason: "revise" });
    assert.equal(stop.stopShouldContinue, true); assert.deepEqual(stop.additionalContexts, ["revise"]);
    assert.throws(() => processHookOutput("Stop", context("PreToolUse", "x")), /wrong event name/);
  });
  it("uses exact, pipe, wildcard, and regex hook matcher rules", () => {
    assert.equal(matchesHookMatcher("Write", "Write"), true);
    assert.equal(matchesHookMatcher("WriteFile", "Write"), false);
    assert.equal(matchesHookMatcher("Edit", "Write|Edit"), true);
    assert.equal(matchesHookMatcher("anything", "*"), true);
    assert.equal(matchesHookMatcher("mcp__docs__read", "^mcp__.*__read$"), true);
    assert.equal(matchesHookMatcher("Write", "["), false);
  });
  it("treats diagnostic or forward-compatible stdout as no decision", () => {
    assert.equal(parseHookStdout("plain diagnostic"), undefined);
    assert.deepEqual(processHookOutput("SessionStart", parseHookStdout(JSON.stringify({ futureField: true }))).additionalContexts, []);
    assert.equal(parseHookStdout("{ not json"), undefined);
  });
  it("merges decisions: deny beats ask beats allow", () => {
    const target: HookRunResult = { additionalContexts: [] };
    mergeHookRunResult(target, { additionalContexts: ["a"], permissionBehavior: "allow" });
    mergeHookRunResult(target, { additionalContexts: [], permissionBehavior: "ask" });
    assert.equal(target.permissionBehavior, "ask");
    mergeHookRunResult(target, { additionalContexts: ["b"], permissionBehavior: "deny", blockRequested: true, stopReason: "no" });
    mergeHookRunResult(target, { additionalContexts: [], permissionBehavior: "allow" });
    assert.equal(target.permissionBehavior, "deny"); assert.equal(target.stopReason, "no"); assert.deepEqual(target.additionalContexts, ["a", "b"]);
  });
  it("applies only tightening PreToolUse decisions", () => {
    assert.equal(preToolDenial(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "not here" } })), "not here");
    assert.equal(preToolDenial(JSON.stringify({ continue: false, stopReason: "halt" })), "halt");
    assert.equal(preToolDenial(JSON.stringify({ decision: "block", reason: "nope" })), "nope");
    assert.equal(preToolDenial(JSON.stringify({ decision: "approve" })), null, "a hook never grants");
    assert.equal(preToolDenial(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } })), null);
    assert.equal(preToolDenial(JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop" } })), null, "a malformed decision is ignored");
    assert.equal(vetoOf([result("fine")]), null);
    assert.deepEqual(vetoOf([result("ok"), result(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "policy" } }), 0, "json")]),
      { ok: false, error: "blocked by hook json", hook_blocked: true, hook_output_untrusted: "policy" });
    assert.deepEqual(vetoOf([result(JSON.stringify({ decision: "block" }), 0, "j"), result("x".repeat(600), 2, "exit")]),
      { ok: false, error: "blocked by hook exit", hook_blocked: true, hook_output_untrusted: "x".repeat(500) + "\n…(truncated)" }, "exit 2 wins and keeps Python's clip");
    assert.deepEqual(vetoOf([{ ...result("", 2), timeout: true, exit_code: -1 }]), null, "a timeout never blocks");
  });
});
