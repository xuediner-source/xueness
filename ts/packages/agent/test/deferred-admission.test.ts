/**
 * DeferredToolCall admission (C-TOOL-04, F02.03): the model calls the
 * `deferred_tool_call` envelope; `runTools` admits it and unwraps it into a
 * real call to the registered target, which then takes the exact direct-call
 * path — one owner/enabled check, one active rule, one ToolBridge (lease,
 * schema validation, gate, permission session), one result association.
 * Cancellation, unknown targets, disabled plugins and non-deferred misuse
 * fail exactly like a direct call, never as a silent success.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentContext, AgentExtension, AgentPluginHooks, AgentProvider, AgentRunnerOptions, Row } from "../src/types.ts";
import { AgentRunner, kernelAgentHooks } from "../src/index.ts";
import { runTools } from "../src/tools.ts";
import { createToolEnv, type ToolDefinition } from "@xueness/engine-tools";
import { Context, PluginHost } from "@xueness/kernel";
import { PermissionSession } from "@xueness/permissions";
import { SessionStore } from "@xueness/sessions";
import { ToolBridge, type Approver } from "@xueness/tool-bridge";
import { DEFERRED_TOOL_CALL } from "@xueness/providers";
import { createProviderResultTools } from "@xueness/plugin-providers";

interface TargetOptions {
  name?: string;
  shouldDefer?: boolean;
  gate?: string;
  schema?: Row;
  run?(input: Row): Promise<Row>;
}

interface HarnessOptions {
  /** null registers no target at all (an unknown-name case). */
  target?: TargetOptions | null;
  /** Enabled plugin ids behind the hooks; `kernel` covers kernel.tool registrations. */
  enabled?: string[];
  mode?: "build" | "plan";
  approver?: Approver;
  extensions?: AgentExtension[];
}

const wrapperCall = (id: string, tool: string, input?: Row): Row =>
  ({ id, type: "function", function: { name: DEFERRED_TOOL_CALL, arguments: JSON.stringify(input === undefined ? { tool } : { tool, input }) } });

async function harness(options: HarnessOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "xueness-deferred-"));
  const workspace = join(directory, "workspace");
  const stateDir = join(directory, "state");
  const store = new SessionStore(stateDir);
  const value = { id: "b".repeat(32), root: workspace, task: "task", status: "pending", steps: 0,
    messages: [{ role: "system", content: "System" }, { role: "user", content: "task" }], results: {}, compactions: [], archived_messages: [], completion: null } as unknown as Row;
  const kernel = Context.create({ roots: { workspace: [workspace], state: stateDir, temp: join(directory, "temp") } });
  const target = options.target === undefined ? { name: "alpha_two", shouldDefer: true } : options.target;
  let targetRuns = 0;
  if (target) {
    const name = target.name ?? "alpha_two";
    const gate = target.gate ?? "read";
    kernel.tool({
      name, description: `The ${name} tool`, inputSchema: target.schema ?? { type: "object", properties: {} },
      gate, mutating: gate !== "read", concurrencySafe: false, requires: {},
      ...(target.shouldDefer ? { shouldDefer: true } : {}),
      async run(input: Row) { targetRuns += 1; return target.run ? target.run(input) : { ok: true, output: `${name}-ran` }; },
    } as never);
  }
  const enabled = new Set([...options.enabled ?? ["providers", "kernel", "sessions", "files"], ...(options.extensions ?? []).map((extension) => extension.id)]);
  const host = new PluginHost(kernel, [createProviderResultTools(() => value as never, {
    catalog: () => kernel.tools.list<ToolDefinition>().map(({ name, description, alwaysLoad, shouldDefer }) => ({ name, description, alwaysLoad, shouldDefer })),
  })], { enabled: { providers: enabled.has("providers") } });
  const statuses = await host.start();
  assert.equal(statuses[0]?.state, enabled.has("providers") ? "active" : "disabled", String(statuses[0]?.error ?? "providers state"));
  const env = createToolEnv({ cwd: workspace, roots: [workspace], artifactsDir: join(directory, "artifacts"), owner: String(value.id) });
  env.currentSession = () => value as never;
  const extensions = options.extensions ?? [];
  const hooks: AgentPluginHooks = kernelAgentHooks(kernel, { enabled: (id) => enabled.has(id), extensions });
  const bridge = new ToolBridge({ kernel, permissions: new PermissionSession({ mode: options.mode ?? "build" }), env, ...(options.approver ? { approver: options.approver } : {}) });
  const bridgeCalls: string[] = [];
  const realCall = bridge.call.bind(bridge);
  (bridge as { call: unknown }).call = (call: Parameters<typeof bridge.call>[0], callOptions?: Parameters<typeof bridge.call>[1]) => {
    bridgeCalls.push(call.name);
    return realCall(call, callOptions);
  };
  return {
    value, store, stateDir, hooks, bridge, extensions,
    targetRuns: () => targetRuns, bridgeCalls,
    results: (): Row => value.results as Row,
    messages: (): Row[] => value.messages as Row[],
    /** One full run: the scripted call(s), then a final answer — like a real turn. */
    run: async (calls: Row | readonly Row[], runHooks: AgentPluginHooks = hooks): Promise<void> => {
      let step = 0;
      const script: Row[] = [{ tool_calls: Array.isArray(calls) ? [...calls] : [calls] }, { content: "done" }];
      const provider: AgentProvider = { runtimeProfile: "standard", toolCalling: "native", async complete() {
        const response = script[step++]; if (!response) throw new Error("script exhausted"); return structuredClone(response);
      } };
      const runner = new AgentRunner({ root: workspace, store, stateDir, provider, hooks: runHooks, toolBridge: bridge });
      await runner.run(value as never, { maxSteps: 6 });
    },
    close: async () => { await host.dispose(); await kernel.dispose(); rmSync(directory, { recursive: true, force: true }); },
  };
}

/** A minimal AgentContext over the harness session, for direct runTools contract tests. */
function directContext(h: Awaited<ReturnType<typeof harness>>, signal: AbortSignal): AgentContext {
  return {
    session: h.value as never, store: h.store, provider: {} as never, stateDir: h.stateDir, root: String(h.value.root), signal,
    deadline: Infinity, options: {}, save: async () => {}, enabled: (id) => h.hooks.enabled(id), emit: () => {},
  };
}

const runnerOptions = (h: Awaited<ReturnType<typeof harness>>): AgentRunnerOptions => ({
  store: h.store, provider: { runtimeProfile: "standard", toolCalling: "native", async complete() { throw new Error("runTools never completes a model turn"); } },
  hooks: h.hooks, toolBridge: h.bridge, root: String(h.value.root),
});

describe("DeferredToolCall admission: the same-turn path", () => {
  it("unwraps a same-turn deferred reference and executes the real tool through the ordinary bridge", async () => {
    const h = await harness();
    try {
      await h.run(wrapperCall("c1", "alpha_two"));
      assert.equal(h.targetRuns(), 1, "the wrapped target executed for real");
      assert.deepEqual(h.bridgeCalls, ["alpha_two"], "the bridge saw the unwrapped target, not the envelope");
      const stored = h.results().c1 as Row;
      assert.equal(stored.ok, true);
      assert.equal(String(stored.output), "alpha_two-ran", "the model's call id holds the target's result");
      const toolMessage = h.messages().find((message) => message.role === "tool" && message.tool_call_id === "c1");
      assert.ok(toolMessage, "the result is journaled under the model's tool_call_id like a direct call");
      assert.equal(h.value.status, "completed");
    } finally { await h.close(); }
  });

  it("keeps the envelope in the journal: the assistant message records what the model emitted", async () => {
    const h = await harness();
    try {
      await h.run(wrapperCall("c1", "alpha_two", { marker: 1 }));
      const assistant = h.messages().find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
      const fn = (assistant!.tool_calls as Row[])[0]!.function as Row;
      assert.equal(fn.name, DEFERRED_TOOL_CALL);
      assert.deepEqual(JSON.parse(String(fn.arguments)), { tool: "alpha_two", input: { marker: 1 } });
    } finally { await h.close(); }
  });

  it("passes the wrapped input through the bridge's own schema validation, worded like a direct call", async () => {
    const h = await harness({ target: { name: "alpha_two", shouldDefer: true, schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } });
    try {
      await h.run(wrapperCall("c1", "alpha_two", { path: 5 }));
      const stored = h.results().c1 as Row;
      assert.equal(stored.ok, false);
      const error = stored.error as Row;
      assert.equal(error.code, "invalid_argument");
      assert.match(String(error.message), /invalid alpha_two input/, "the bridge validated the target's inputSchema (the direct-call entry)");
      assert.equal(h.targetRuns(), 0, "invalid parameters never reach the tool");
    } finally { await h.close(); }
  });

  it("uses one permission path: a target whose gate asks waits for approval exactly like a direct call", async () => {
    const h = await harness({ target: { name: "heavy_write", shouldDefer: true, gate: "write" }, mode: "build" });
    try {
      await h.run(wrapperCall("c1", "heavy_write"));
      const stored = h.results().c1 as Row;
      assert.equal(stored.ok, false);
      assert.equal((stored.error as Row).code, "approval_required", "the unwrapped target went through the bridge's permission flow");
      assert.equal(h.targetRuns(), 0, "nothing executed before approval");
      assert.equal(h.value.status, "paused");
    } finally { await h.close(); }
  });

  it("an approved deferred target executes, and extensions observe the unwrapped call", async () => {
    const seen: Row[] = [];
    const h = await harness({
      target: { name: "heavy_write", shouldDefer: true, gate: "write" },
      approver: () => ({ behavior: "allow" }),
      extensions: [{ id: "test", beforeTool: (context, call) => { seen.push({ name: call.name, input: call.input as Row }); return null; } }],
    });
    try {
      await h.run(wrapperCall("c1", "heavy_write"));
      assert.equal(h.targetRuns(), 1);
      assert.deepEqual(h.bridgeCalls, ["heavy_write"]);
      assert.deepEqual(seen.map((row) => row.name), ["heavy_write"], "beforeTool sees the unwrapped call, same as a direct one");
      assert.equal((h.results().c1 as Row).ok, true);
    } finally { await h.close(); }
  });
});

describe("DeferredToolCall admission: stable failure contracts", () => {
  it("fails plugin_disabled for a target outside the live catalog (unknown name)", async () => {
    const h = await harness({ target: null });
    try {
      await h.run(wrapperCall("c1", "ghost_tool"));
      const stored = h.results().c1 as Row;
      assert.equal(stored.ok, false);
      assert.equal(stored.error_code, "plugin_disabled");
      assert.equal(h.targetRuns(), 0);
      assert.equal(h.value.status, "completed", "a stable failure result, not a broken run");
    } finally { await h.close(); }
  });

  it("fails plugin_disabled when the target's owner is disabled, even though the name is still wrapped", async () => {
    const h = await harness({ enabled: ["providers", "sessions"], target: { name: "alpha_two", shouldDefer: true } });
    try {
      await h.run(wrapperCall("c1", "alpha_two"));
      const stored = h.results().c1 as Row;
      assert.equal(stored.ok, false);
      assert.equal(stored.error_code, "plugin_disabled", "the kernel-owned target's owner is not enabled");
      assert.equal(h.targetRuns(), 0);
    } finally { await h.close(); }
  });

  it("fails plugin_disabled when the providers plugin (the envelope's owner) is disabled", async () => {
    const h = await harness({ enabled: ["kernel", "sessions"], target: { name: "alpha_two", shouldDefer: true } });
    try {
      // A run whose providers plugin is disabled pauses before any tool, so the
      // contract is exercised at the runTools level: no live envelope is registered.
      const context = directContext(h, new AbortController().signal);
      await runTools(context, runnerOptions(h), [wrapperCall("c1", "alpha_two")], []);
      const stored = h.results().c1 as Row;
      assert.equal(stored.ok, false);
      assert.equal(stored.error_code, "plugin_disabled", "no live envelope, no deferred path");
      assert.equal(h.targetRuns(), 0);
    } finally { await h.close(); }
  });

  it("fails not_deferred_tool when the envelope wraps a non-deferred tool: no discovery bypass", async () => {
    const h = await harness({ target: { name: "plain_tool", shouldDefer: false } });
    try {
      await h.run(wrapperCall("c1", "plain_tool"));
      const stored = h.results().c1 as Row;
      assert.equal(stored.ok, false);
      assert.equal(stored.error_code, "not_deferred_tool");
      assert.match(String(stored.error), /call it directly/);
      assert.equal(h.targetRuns(), 0);
    } finally { await h.close(); }
  });

  it("rejects a malformed envelope with invalid_tool_arguments and never executes anything", async () => {
    const h = await harness();
    try {
      const bad: Array<[string, string]> = [
        ["broken", "{broken"],
        ["missing-tool", JSON.stringify({})],
        ["non-object-input", JSON.stringify({ tool: "alpha_two", input: "x" })],
        ["unknown-field", JSON.stringify({ tool: "alpha_two", extra: 1 })],
      ];
      await h.run(bad.map(([id, args]) => ({ id, type: "function", function: { name: DEFERRED_TOOL_CALL, arguments: args } })));
      for (const [id] of bad) {
        const stored = h.results()[id] as Row;
        assert.equal(stored.ok, false, id);
        assert.equal(stored.error_code, "invalid_tool_arguments", id);
      }
      assert.equal(h.targetRuns(), 0);
    } finally { await h.close(); }
  });

  it("refuses a nested envelope: the wrapper itself is not a deferred tool", async () => {
    const h = await harness();
    try {
      await h.run(wrapperCall("c1", DEFERRED_TOOL_CALL, { tool: "alpha_two" }));
      const stored = h.results().c1 as Row;
      assert.equal(stored.ok, false);
      assert.equal(stored.error_code, "not_deferred_tool");
      assert.equal(h.targetRuns(), 0);
    } finally { await h.close(); }
  });

  it("stays honest without a toolDefinition hook: a direct bridge execution of the envelope fails stably", async () => {
    const h = await harness();
    try {
      const custom: AgentPluginHooks = { ...h.hooks, toolDefinition: undefined };
      await h.run(wrapperCall("c1", "alpha_two"), custom);
      const stored = h.results().c1 as Row;
      assert.equal(stored.ok, false);
      assert.equal((stored.error as Row).code, "deferred_call_unavailable", "no silent success on an unadmitted envelope");
      assert.equal(h.targetRuns(), 0);
    } finally { await h.close(); }
  });
});

describe("DeferredToolCall admission: cancellation and scheduling", () => {
  it("stops like a direct call: an aborted run leaves run_paused and never executes the target", async () => {
    const h = await harness();
    try {
      const context = directContext(h, AbortSignal.abort());
      await runTools(context, runnerOptions(h), [wrapperCall("c1", "alpha_two")], []);
      const stored = h.results().c1 as Row;
      assert.equal(stored.ok, false);
      assert.equal(stored.error_code, "run_paused");
      assert.equal(h.targetRuns(), 0);
    } finally { await h.close(); }
  });

  it("an abort during execution settles as cancelled under the model's call id — no half success", async () => {
    const controller = new AbortController();
    const h = await harness({ target: { name: "slow_two", shouldDefer: true, run: async (_input) => {
      controller.abort();
      await new Promise((resolve) => setImmediate(resolve));
      if (controller.signal.aborted) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
      return { ok: true, output: "should-not-happen" };
    } } });
    try {
      await runTools(directContext(h, controller.signal), runnerOptions(h), [wrapperCall("c1", "slow_two")], []);
      const stored = h.results().c1 as Row;
      assert.equal(stored.ok, false, "the cancelled call records its real outcome");
      assert.equal((stored.error as Row).code, "cancelled");
      assert.equal(h.targetRuns(), 1, "the tool body ran but its result settled as cancelled");
      assert.equal(String(stored.output ?? "").includes("should-not-happen"), false, "no fake success survives");
    } finally { await h.close(); }
  });

  it("envelope calls never batch: two deferred calls run one after the other even when the targets are reads", async () => {
    let concurrent = 0;
    let peak = 0;
    const h = await harness({ target: { name: "batch_read", shouldDefer: true, run: async () => {
      concurrent += 1; peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setImmediate(resolve));
      concurrent -= 1;
      return { ok: true, output: "batch_read-ran" };
    } } });
    try {
      await runTools(directContext(h, new AbortController().signal), runnerOptions(h),
        [wrapperCall("c1", "batch_read"), wrapperCall("c2", "batch_read")], []);
      assert.equal(peak, 1, "the envelope's unknown target class keeps deferred calls sequential");
      assert.equal(h.targetRuns(), 2);
      assert.equal((h.results().c1 as Row).ok, true);
      assert.equal((h.results().c2 as Row).ok, true);
    } finally { await h.close(); }
  });
});
