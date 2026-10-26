import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Context, type ToolDescriptor } from "@xueness/kernel";
import { kernelAgentHooks, type Row } from "../src/index.ts";
import { call, fixture, session } from "./fixtures.ts";

const run = async () => ({ ok: true, output: "observed" });
const tool = (name: string, extra: Partial<ToolDescriptor> = {}): ToolDescriptor =>
  ({ name, description: `${name} tool`, inputSchema: { type: "object", properties: {} }, gate: "read", mutating: false, concurrencySafe: true, requires: {}, ...extra }) as unknown as ToolDescriptor;

const kernelWith = (...tools: ToolDescriptor[]) => {
  const kernel = Context.create();
  for (const descriptor of tools) kernel.tool({ ...descriptor, run } as ToolDescriptor);
  return kernel;
};

const names = (hooks: ReturnType<typeof kernelAgentHooks>): string[] =>
  (hooks.tools({ session: session() } as never) as readonly Row[]).map((schema) => String((schema.function as Row).name)).sort();

describe("kernel agent hooks exposure rule", () => {
  it("keeps default and alwaysLoad tools in the request schema and holds shouldDefer tools in the catalog only", () => {
    const kernel = kernelWith(tool("plain_read"), tool("handoff_core", { alwaysLoad: true }), tool("heavy_report", { shouldDefer: true }));
    try {
      assert.deepEqual(names(kernelAgentHooks(kernel, { enabled: () => true })), ["handoff_core", "plain_read"]);
      assert.equal(kernel.tools.ownerOf("heavy_report"), "kernel", "a deferred tool stays registered: discovery and the Gate are unchanged");
    } finally { void kernel.dispose(); }
  });
  it("exposes every registered tool when none declares exposure metadata", () => {
    const kernel = kernelWith(tool("read"), tool("list"));
    try { assert.equal(names(kernelAgentHooks(kernel, { enabled: () => true })).length, 2); }
    finally { void kernel.dispose(); }
  });
  it("marks tool_search gate as concurrencySafe only when non-mutating and non-destructive, and forwards batchConcurrency", () => {
    const kernel = kernelWith(
      tool("tool_search", { gate: "tool_search", mutating: false, concurrencySafe: true }),
      tool("destructive_read", { gate: "read", mutating: false, concurrencySafe: true, destructive: true } as never),
    );
    try {
      const hooks = kernelAgentHooks(kernel, { enabled: () => true, batchConcurrency: 4 });
      assert.equal(hooks.concurrencySafe?.("tool_search"), true);
      assert.equal(hooks.concurrencySafe?.("destructive_read"), false);
      assert.equal(hooks.batchConcurrency, 4);
    } finally { void kernel.dispose(); }
  });
});

describe("executor-side exposure and disable removal", () => {
  it("refuses a disabled plugin's tool with plugin_disabled even while its schema was exposed", async () => {
    const local = fixture([{ tool_calls: [call("r1")] }, { content: "The files plugin is disabled." }]);
    local.hooks.enabled = (id) => id !== "files";
    try {
      await local.runner.run(local.session);
      assert.equal(local.effects(), 0);
      assert.equal(((local.session.results as Row).r1 as Row).error_code, "plugin_disabled");
      assert.equal(local.session.status, "completed");
    } finally { local.close(); }
  });
  it("refuses a tool that is owned and enabled but not part of the exposed request set", async () => {
    const local = fixture([{ tool_calls: [call("r1", "{}", "grep")] }, { content: "Not part of the tool view." }]);
    local.hooks.toolOwner = (name) => name === "grep" ? "files" : null;
    try {
      await local.runner.run(local.session);
      assert.equal(local.effects(), 0);
      assert.equal(((local.session.results as Row).r1 as Row).error, "tool not active; discover it with tool_search first");
      assert.equal(local.session.status, "completed");
    } finally { local.close(); }
  });
});
