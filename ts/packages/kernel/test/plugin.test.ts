import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Context, ServiceConflictError, applyProfile, definePlugin, resolveProfile, type Profile } from "../src/index.ts";

declare module "../src/context.ts" {
  interface Services {
    clock: { now(): number };
    store: { items: string[] };
  }
}

const clockPlugin = definePlugin({
  name: "clock",
  apply(ctx) {
    ctx.provide("clock", { now: () => 42 });
  },
});

function storePlugin(log: string[]) {
  return definePlugin({
    name: "store",
    inject: ["clock"],
    apply(ctx) {
      log.push(`store up at ${ctx.get("clock").now()}`);
      ctx.provide("store", { items: [] });
      ctx.effect(() => () => void log.push("store down"));
    },
  });
}

describe("plugins", () => {
  it("waits for required services, stops when they go, restarts when they return", async () => {
    const ctx = Context.create();
    const log: string[] = [];
    const store = ctx.plugin(storePlugin(log));
    await store.ready();
    assert.equal(store.state, "pending");
    assert.deepEqual(store.missing(), ["clock"]);

    const clock = ctx.plugin(clockPlugin);
    await clock.ready();
    await store.ready();
    assert.equal(store.state, "active");
    assert.equal(ctx.has("store"), true);

    await clock.dispose();
    await store.ready();
    assert.equal(store.state, "pending");
    assert.equal(ctx.has("store"), false);

    const again = ctx.plugin(clockPlugin);
    await again.ready();
    await store.ready();
    assert.equal(store.state, "active");
    assert.equal(store.activations, 2);
    assert.deepEqual(log, ["store up at 42", "store down", "store up at 42"]);
    await ctx.dispose();
  });

  it("restarts a plugin when an optional service changes", async () => {
    const ctx = Context.create();
    const seen: boolean[] = [];
    const handle = ctx.plugin(definePlugin({
      name: "reporter",
      inject: { optional: ["clock"] },
      apply(inner) { seen.push(inner.has("clock")); },
    }));
    await handle.ready();
    const clock = ctx.plugin(clockPlugin);
    await clock.ready();
    await handle.ready();
    assert.deepEqual(seen, [false, true]);
    await ctx.dispose();
  });

  it("rolls back everything a failing apply acquired", async () => {
    const ctx = Context.create();
    const handle = ctx.plugin(definePlugin({
      name: "broken",
      async apply(inner) {
        inner.provide("store", { items: [] });
        inner.on("tick", () => {});
        inner.setInterval(() => {}, 1000);
        await Promise.resolve();
        throw new Error("boom");
      },
    }));
    await handle.ready();
    assert.equal(handle.state, "failed");
    assert.match(String(handle.error), /boom/);
    assert.equal(ctx.has("store"), false);
    assert.equal(ctx.listenerCount("tick"), 0);
    await ctx.dispose();
  });

  it("validates config before loading and reloads with new config", async () => {
    const ctx = Context.create();
    const values: number[] = [];
    const counter = definePlugin<{ step: number }>({
      name: "counter",
      validate(config) {
        const step = (config as { step?: unknown } | undefined)?.step ?? 1;
        if (typeof step !== "number" || step <= 0) throw new TypeError("step must be a positive number");
        return { step };
      },
      apply(_inner, config) { values.push(config.step); },
    });
    assert.throws(() => ctx.plugin(counter, { step: -1 }), /positive/);
    const handle = ctx.plugin(counter);
    await handle.ready();
    await handle.reload({ step: 5 });
    assert.deepEqual(values, [1, 5]);
    await ctx.dispose();
  });

  it("refuses two providers for one service", async () => {
    const ctx = Context.create();
    ctx.provide("clock", { now: () => 1 });
    assert.throws(() => ctx.provide("clock", { now: () => 2 }), ServiceConflictError);
    await ctx.dispose();
  });

  it("leaves nothing behind after the root is disposed", async () => {
    const ctx = Context.create();
    const log: string[] = [];
    await applyProfile(ctx, { name: "full", plugins: [{ plugin: storePlugin(log) }, { plugin: clockPlugin }] });
    let fired = 0;
    ctx.setTimeout(() => { fired += 1; }, 5);
    ctx.setInterval(() => { fired += 1; }, 5);
    await ctx.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fired, 0);
    assert.deepEqual(ctx.serviceNames(), []);
    assert.equal(ctx.listenerCount(), 0);
    assert.equal(ctx.scope.size, 0);
    assert.deepEqual(log, ["store up at 42", "store down"]);
  });
});

describe("profiles", () => {
  const a = definePlugin({ name: "a", apply() {} });
  const b = definePlugin({ name: "b", apply() {} });
  const c = definePlugin({ name: "c", apply() {} });

  it("flattens bases, overrides config in place and drops disabled plugins", () => {
    const full: Profile = { name: "full", plugins: [{ plugin: a, config: 1 }, { plugin: b }, { plugin: c }] };
    const lite: Profile = { name: "lite", extends: [full], plugins: [{ plugin: a, config: 2 }], disable: ["b"] };
    const resolved = resolveProfile(lite);
    assert.deepEqual(resolved.map((entry) => [entry.plugin.name, entry.config]), [["a", 2], ["c", undefined]]);
  });

  it("detects cycles", () => {
    const loop: Profile = { name: "loop" };
    (loop as { extends?: Profile[] }).extends = [loop];
    assert.throws(() => resolveProfile(loop), /cycle/);
  });
});
