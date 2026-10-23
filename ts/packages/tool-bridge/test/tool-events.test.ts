import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Context } from "@xueness/kernel";
import { TOOL_EVENT_DIAGNOSTICS_MAX, type ToolEventPayload } from "@xueness/tool-bridge";
import { setup, testPlugin } from "./support.ts";

type Handler = (payload: ToolEventPayload) => unknown;
const DECLARED = ["before_tool_execution", "before_tool_effect", "after_tool_execution", "after_tool_authorization"];

/** A declared policy plugin, an undeclared observer, and handlers each test swaps in. */
function plugins(handlers: Record<string, Handler | undefined>, seen: string[]) {
  const route = (name: string) => (payload: unknown) => {
    const event = (payload as ToolEventPayload).event;
    seen.push(`${name}:${event}:${(payload as ToolEventPayload).tool}`);
    return handlers[`${name}:${event}`]?.(payload as ToolEventPayload);
  };
  const subscribe = (name: string, events: string[]) => (ctx: Context) => {
    for (const event of events) ctx.toolEvent(event, route(name));
  };
  return [
    testPlugin("policy", { toolEvents: { events: DECLARED, priority: 100 } }, subscribe("policy", DECLARED)),
    testPlugin("watcher", {}, subscribe("watcher", ["before_tool_execution", "after_tool_execution"])),
  ];
}

const write = (id: string, path = "a.txt", content = "new\n") => ({ id, name: "write", input: { path, content } });

describe("tool events through the bridge", () => {
  it("honour a declared deny with its reason, ignore other denies, and let observers see refusals", async () => {
    const seen: string[] = [];
    const handlers: Record<string, Handler | undefined> = {
      "policy:before_tool_execution": (payload) => (payload.subject === "blocked.txt" ? { decision: "deny", reason: "  frozen file  " } : payload.subject === "bare.txt" ? { decision: "deny" } : undefined),
      "watcher:before_tool_execution": () => ({ decision: "deny", reason: "watchers cannot deny" }),
    };
    const results: unknown[] = [];
    handlers["watcher:after_tool_execution"] = (payload) => void results.push(payload.result?.error?.code ?? "ok");
    const s = await setup({ settings: { mode: "yolo" }, plugins: plugins(handlers, seen) });
    const denied = await s.bridge.call(write("c1", "blocked.txt"));
    assert.deepEqual([denied.error?.code, denied.output, denied.data], ["plugin_denied", "denied by plugin policy: frozen file", { plugin: "policy", userReason: "frozen file" }]);
    assert.equal(existsSync(join(s.workspace, "blocked.txt")), false);
    assert.equal((await s.bridge.call(write("c2", "bare.txt"))).ok, true, "a deny without a reason is only an observation");
    assert.deepEqual(results, ["plugin_denied", "ok"]);
    assert.deepEqual(s.bridge.diagnostics.map(({ event, plugin, kind, detail }) => [event, plugin, kind, detail]), [
      ["before_tool_execution", "policy", "deny", "frozen file"],
      ["before_tool_execution", "policy", "deny_ignored", "deny without a usable reason"],
      ["before_tool_execution", "watcher", "deny_ignored", "toolEvents does not declare this event"],
    ]);
    assert.deepEqual(seen.filter((entry) => entry.endsWith(":write")).slice(0, 4), [
      "policy:before_tool_execution:write", "policy:after_tool_execution:write", "watcher:after_tool_execution:write",
      "policy:before_tool_execution:write",
    ], "a denied call skips the effect seams; the higher priority dispatches first");
    await s.close();
  });

  it("isolate throwing and hanging observers", async () => {
    const handlers: Record<string, Handler | undefined> = {
      "watcher:before_tool_execution": () => {
        throw new RangeError("secret detail");
      },
      "watcher:after_tool_execution": () => new Promise(() => {}),
      "policy:after_tool_execution": (payload) => {
        (payload.result as { output: string }).output = "mutated";
      },
    };
    const s = await setup({ settings: { mode: "yolo" }, plugins: plugins(handlers, []), eventTimeoutMs: 50 });
    const result = await s.bridge.call(write("c1"));
    assert.deepEqual([result.ok, readFileSync(join(s.workspace, "a.txt"), "utf8")], [true, "new\n"]);
    assert.doesNotMatch(result.output, /mutated/, "payloads are frozen copies");
    assert.deepEqual(s.bridge.diagnostics.map(({ plugin, kind, detail }) => [plugin, kind, detail]), [
      ["watcher", "error", "RangeError"], ["policy", "error", "TypeError"], ["watcher", "timeout", "handler exceeded 0.05s"],
    ]);
    await s.close();
  });

  it("fail closed when a strict before_tool_effect policy throws, hangs or answers nonsense", async () => {
    let effect: Handler = () => undefined;
    const handlers: Record<string, Handler | undefined> = { "policy:before_tool_effect": (payload) => effect(payload) };
    const s = await setup({ settings: { mode: "yolo" }, plugins: plugins(handlers, []), eventTimeoutMs: 50 });
    const cases: [Handler, string][] = [
      [() => { throw new Error("db down"); }, "tool_policy_unavailable"],
      [() => new Promise(() => {}), "tool_policy_unavailable"],
      [() => 42, "tool_policy_unavailable"],
      [() => ({ decision: "deny", result: { ok: true, output: "fine" } }), "tool_policy_unavailable"],
      [() => ({ decision: "deny", result: { ok: false, output: "over quota", error: { code: "quota_exceeded", message: "over quota" } } }), "quota_exceeded"],
    ];
    for (const [index, [handler, code]] of cases.entries()) {
      effect = handler;
      const result = await s.bridge.call(write(`c${index}`));
      assert.equal(result.error?.code, code, `case ${index}`);
      assert.equal(existsSync(join(s.workspace, "a.txt")), false, `case ${index} had no effect`);
    }
    effect = async (payload) => (payload.subject === "a.txt" ? undefined : 1);
    assert.equal((await s.bridge.call(write("ok"))).ok, true);
    assert.deepEqual(s.bridge.diagnostics.map(({ kind }) => kind), ["error", "timeout", "invalid_result", "invalid_result", "deny"]);
    await s.close();
  });

  it("notify after_tool_authorization only for authorised calls, and run the tool after it settles", async () => {
    const seen: string[] = [];
    let snapshot: string | null = null;
    const handlers: Record<string, Handler | undefined> = {
      "policy:after_tool_authorization": async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        snapshot = readFileSync(join(workspace, "a.txt"), "utf8");
      },
    };
    const s = await setup({ plugins: plugins(handlers, seen) });
    const workspace = s.workspace;
    writeFileSync(join(workspace, "a.txt"), "old\n");
    await s.bridge.call({ id: "r", name: "read", input: { path: "a.txt" } });
    assert.equal((await s.bridge.call(write("pending"))).error?.code, "approval_required");
    assert.equal(seen.filter((entry) => entry.startsWith("policy:after_tool_authorization:write")).length, 0, "a pending approval authorises nothing");
    assert.equal(seen.filter((entry) => entry.startsWith("policy:before_tool_effect:write")).length, 0);
    s.permissions.grantOnce("pending", "write", "a.txt");
    assert.equal((await s.bridge.call(write("pending"))).ok, true);
    assert.equal(snapshot, "old\n", "the checkpoint saw the file before the write");
    assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "new\n");
    await s.close();
  });

  it("accept a declared rewrite that keeps ok and the result shape, and reject the rest", async () => {
    let rewrite: Handler = () => undefined;
    const observed: string[] = [];
    const handlers: Record<string, Handler | undefined> = {
      "policy:after_tool_execution": (payload) => rewrite(payload),
      "watcher:after_tool_execution": (payload) => {
        observed.push(payload.result?.output ?? "");
        return { decision: "rewrite", result: { ...payload.result, output: "watcher was here" } };
      },
    };
    const s = await setup({ settings: { mode: "yolo" }, plugins: plugins(handlers, []) });
    writeFileSync(join(s.workspace, "a.txt"), "hello\n");
    const read = () => s.bridge.call({ id: "r", name: "read", input: { path: "a.txt" } });
    rewrite = (payload) => ({ decision: "rewrite", result: { ...payload.result, output: "[redacted]" } });
    assert.equal((await read()).output, "[redacted]");
    assert.deepEqual(observed, ["[redacted]"], "later observers see the accepted rewrite");
    const rejected: [Handler, string][] = [
      [(payload) => ({ decision: "rewrite", result: { ...payload.result, ok: false } }), "ok must stay unchanged"],
      [() => ({ decision: "rewrite", result: "text" }), "rewritten result must be an object"],
      [(payload) => ({ decision: "rewrite", result: { ...payload.result, data: { at: new Date() } } }), "rewritten result must stay JSON-serialisable"],
      [(payload) => ({ decision: "rewrite", result: { ...payload.result, output: 7 } }), "output must be a string"],
      [(payload) => ({ decision: "rewrite", result: { ...payload.result, error: { code: "x", message: "y" } } }), "error must be {code, message} exactly when ok is false"],
    ];
    for (const [handler, problem] of rejected) {
      rewrite = handler;
      const result = await read();
      assert.match(result.output, /hello/, problem);
      assert.deepEqual(s.bridge.diagnostics.slice(-2).map(({ plugin, kind, detail }) => [plugin, kind, detail]), [
        ["policy", "rewrite_rejected", problem], ["watcher", "rewrite_rejected", "toolEvents does not declare this event"],
      ]);
    }
    await s.close();
  });

  it("keep at most the newest diagnostics", async () => {
    const handlers: Record<string, Handler | undefined> = { "watcher:before_tool_execution": () => ({ decision: "deny", reason: "no" }) };
    const s = await setup({ plugins: plugins(handlers, []) });
    for (let index = 0; index < TOOL_EVENT_DIAGNOSTICS_MAX + 5; index += 1) await s.bridge.call({ id: `l${index}`, name: "list", input: {} });
    const log = s.bridge.diagnostics;
    assert.equal(log.length, TOOL_EVENT_DIAGNOSTICS_MAX);
    assert.equal(log.at(-1)?.callId, `l${TOOL_EVENT_DIAGNOSTICS_MAX + 4}`);
    await s.close();
  });
});
