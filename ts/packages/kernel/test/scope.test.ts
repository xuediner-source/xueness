import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventBus, Scope, ScopeInactiveError } from "../src/index.ts";

describe("scope", () => {
  it("disposes children first, then own disposers in reverse order", async () => {
    const order: string[] = [];
    const root = new Scope("root");
    root.add(() => void order.push("root-1"));
    const child = root.child("child");
    child.add(() => void order.push("child-1"));
    child.add(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); order.push("child-2"); });
    root.add(() => void order.push("root-2"));
    await root.dispose();
    assert.deepEqual(order, ["child-2", "child-1", "root-2", "root-1"]);
    assert.equal(root.state, "disposed");
    assert.equal(root.size, 0);
  });

  it("keeps disposing after a failure and reports every error", async () => {
    const root = new Scope("root");
    let ran = false;
    root.add(() => { ran = true; });
    root.add(() => { throw new Error("a"); });
    root.add(() => { throw new Error("b"); });
    await assert.rejects(root.dispose(), (error: unknown) => error instanceof AggregateError && error.errors.length === 2);
    assert.equal(ran, true);
  });

  it("is idempotent and refuses new work once disposed", async () => {
    const root = new Scope("root");
    let count = 0;
    root.add(() => { count += 1; });
    await Promise.all([root.dispose(), root.dispose()]);
    assert.equal(count, 1);
    assert.throws(() => root.add(() => {}), ScopeInactiveError);
    assert.throws(() => root.child("late"), ScopeInactiveError);
  });

  it("releases a disposer early exactly once", async () => {
    const root = new Scope("root");
    let count = 0;
    const release = root.add(() => { count += 1; });
    await release();
    await release();
    await root.dispose();
    assert.equal(count, 1);
  });
});

describe("event bus", () => {
  it("isolates throwing listeners and removes scoped ones on dispose", async () => {
    const errors: unknown[] = [];
    const bus = new EventBus((error) => errors.push(error));
    const scope = new Scope("plugin");
    const seen: number[] = [];
    bus.on("tick", () => { throw new Error("bad listener"); });
    bus.on("tick", (n: number) => void seen.push(n), scope);
    bus.emit("tick", 1);
    await scope.dispose();
    bus.emit("tick", 2);
    assert.deepEqual(seen, [1]);
    assert.equal(errors.length, 2);
  });

  it("supports serial, parallel, bail and once", async () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on("hook", async () => { await new Promise((resolve) => setTimeout(resolve, 5)); order.push("slow"); });
    bus.on("hook", () => void order.push("fast"));
    await bus.serial("hook");
    assert.deepEqual(order, ["slow", "fast"]);
    await bus.parallel("hook");
    assert.deepEqual(order.slice(2), ["fast", "slow"]);
    bus.on("resolve", () => undefined);
    bus.on("resolve", (x: number) => x * 2);
    bus.on("resolve", () => "never");
    assert.equal(await bus.bail("resolve", 21), 42);
    let hits = 0;
    bus.once("one", () => { hits += 1; });
    bus.emit("one");
    bus.emit("one");
    assert.equal(hits, 1);
    assert.equal(bus.listenerCount("one"), 0);
  });
});
