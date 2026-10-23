import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CapabilityDeniedError, Context, EventBus, PluginHost, Scope, ToolRegistry, ToolUnloadedError, UndeclaredToolEventError,
  type ToolDescriptor,
} from "@xueness/kernel";
import { bundle } from "./support/manifests.ts";

const PEEK = { name: "peek", gate: "read", mutating: false, concurrencySafe: true };
const observe = () => undefined;

describe("tool events", () => {
  it("dispatch after dependencies, then by priority, and end with the plugin", async () => {
    const kernel = Context.create();
    const subscribe = (event: string) => (ctx: Context) => void ctx.toolEvent(event, observe);
    const host = new PluginHost(kernel, [
      bundle("app", { dependencies: ["base"], toolEvents: { events: ["before_tool_effect"], priority: 100 } }, (ctx) => {
        ctx.toolEvent("before_tool_effect", observe);
        ctx.toolEvent("before_tool_execution", observe);
      }),
      bundle("base", { toolEvents: { events: ["before_tool_effect", "before_tool_execution"] } }, (ctx) => {
        ctx.toolEvent("before_tool_effect", observe);
        ctx.toolEvent("before_tool_execution", observe);
      }),
      bundle("policy", { toolEvents: { events: ["before_tool_effect"], priority: 50 } }, subscribe("before_tool_effect")),
      bundle("watcher", {}, subscribe("before_tool_execution")),
    ]);
    await host.start();
    const order = (event: "before_tool_effect" | "before_tool_execution") =>
      kernel.toolEventParticipants(event).map(({ plugin, declared, priority }) => [plugin, declared, priority]);
    assert.deepEqual(order("before_tool_effect"), [["policy", true, 50], ["base", true, 0], ["app", true, 100]]);
    // Observers need no declaration; the flag tells the bridge who may deny. Once base ran, app outranks watcher.
    assert.deepEqual(order("before_tool_execution"), [["base", true, 0], ["app", false, 100], ["watcher", false, 0]]);
    await host.disable("base");
    assert.deepEqual(order("before_tool_effect"), [["policy", true, 50]], "app goes down with its dependency");
    await host.dispose();
    assert.deepEqual(kernel.toolEventParticipants("before_tool_execution"), []);
    await kernel.dispose();
  });

  it("refuse declared-only events without a declaration, unknown events and dispatch by plugins", async () => {
    const kernel = Context.create();
    const plugin = kernel.restrict("plugin:quiet", { owner: "quiet", toolEvents: null });
    assert.throws(() => plugin.toolEvent("before_tool_effect", observe), UndeclaredToolEventError);
    assert.throws(() => plugin.toolEvent("after_tool_authorization", observe), UndeclaredToolEventError);
    assert.throws(() => plugin.toolEvent("before_tool_run", observe), TypeError);
    assert.throws(() => plugin.toolEvent("after_tool_execution", "nope" as never), TypeError);
    assert.throws(() => plugin.toolEventParticipants("after_tool_execution"), CapabilityDeniedError);
    // A nested restriction cannot widen what its parent declares.
    const declared = kernel.restrict("plugin:loud", { owner: "loud", toolEvents: { events: ["before_tool_effect"], priority: 7 } });
    const nested = declared.restrict("nested", { owner: "loud", toolEvents: { events: ["before_tool_effect", "after_tool_authorization"] } });
    assert.throws(() => nested.toolEvent("after_tool_authorization", observe), UndeclaredToolEventError);
    nested.toolEvent("before_tool_effect", observe);
    kernel.toolEvent("after_tool_authorization", observe);
    assert.deepEqual(kernel.toolEventParticipants("before_tool_effect").map((item) => [item.plugin, item.priority]), [["loud", 0]]);
    assert.deepEqual(kernel.toolEventParticipants("after_tool_authorization").map((item) => [item.plugin, item.declared]), [["kernel", true]]);
    await kernel.dispose();
    assert.throws(() => plugin.toolEvent("after_tool_execution", observe));
  });
});

describe("tool leases", () => {
  it("give plugins declarations only and the kernel whole tools", async () => {
    const kernel = Context.create();
    const plugin = kernel.restrict("plugin:files", { owner: "files", tools: [PEEK] });
    const run = async () => ({ ok: true });
    plugin.tool({ ...PEEK, run } as ToolDescriptor);
    assert.deepEqual(plugin.tools.get("peek"), PEEK);
    assert.deepEqual(plugin.tools.list(), [PEEK]);
    assert.equal(plugin.tools.lease("peek"), null);
    assert.equal(plugin.tools.size, 1);
    const lease = kernel.tools.lease<ToolDescriptor & { run: typeof run }>("peek");
    assert.equal(lease?.tool.run, run);
    assert.equal(lease?.owner, "files");
    lease?.release();
    assert.equal(kernel.tools.lease("missing"), null);
    await kernel.dispose();
  });

  it("abort a running call when its plugin unloads and wait for it to settle", async () => {
    const kernel = Context.create();
    const host = new PluginHost(kernel, [bundle("shellish", { tools: [PEEK] }, (ctx) => void ctx.tool(PEEK))]);
    await host.start();
    const lease = kernel.tools.lease("peek");
    assert.ok(lease);
    const steps: string[] = [];
    const call = new Promise<void>((resolve) => {
      lease.signal.addEventListener("abort", () => {
        steps.push("aborted");
        setTimeout(() => {
          steps.push("settled");
          lease.release();
          resolve();
        }, 20);
      });
    });
    await host.disable("shellish");
    steps.push("unloaded");
    await call;
    assert.deepEqual(steps, ["aborted", "settled", "unloaded"]);
    assert.ok(lease.signal.reason instanceof ToolUnloadedError);
    assert.equal(kernel.tools.lease("peek"), null);
    // A released lease no longer holds anything up.
    await host.enable("shellish");
    kernel.tools.lease("peek")?.release();
    const started = Date.now();
    await host.disable("shellish");
    assert.ok(Date.now() - started < 1000);
    await host.dispose();
    await kernel.dispose();
  });

  it("stop waiting for a call that ignores its signal", async () => {
    const registry = new ToolRegistry(new EventBus(() => {}), 30);
    const scope = new Scope("plugin");
    registry.register(PEEK, "stubborn", scope);
    const lease = registry.lease("peek");
    const started = Date.now();
    await scope.dispose();
    assert.ok(lease?.signal.aborted);
    assert.ok(Date.now() - started < 1000, "drain is bounded");
    assert.equal(registry.lease("peek"), null);
    lease?.release();
    lease?.release();
  });
});
