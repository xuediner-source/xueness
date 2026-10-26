/**
 * F10.02 — the workflow VM harness. A real host launches the harness in
 * production and scripts reach the world only through explicitly registered
 * ports; wall-clock timeouts and abort signals terminate suspended runs;
 * budgets cap work; every failure comes back as a coded result instead of an
 * exception. These tests drive the harness exactly the way a host would.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ManualDynamicClock,
  defineDynamicWorldPort,
  runDynamicHarness,
  type DynamicHarnessResult,
  type DynamicWorldPort,
} from "../src/index.ts";

interface Call { port: string; op: string; args: readonly unknown[] }

/** A port that records every call it serves and replies with `reply`. */
function recordingPort(ops: readonly string[], reply: (call: Call) => unknown): DynamicWorldPort {
  return defineDynamicWorldPort(ops, async (op, args) => reply({ port: "", op, args }));
}

function fullWorld(calls: Call[]): {
  agents: DynamicWorldPort;
  files: DynamicWorldPort;
  events: DynamicWorldPort;
  holes: DynamicWorldPort;
} {
  const track = (port: string, ops: readonly string[], reply: (call: Call) => unknown): DynamicWorldPort =>
    defineDynamicWorldPort(ops, async (op, args) => {
      const call = { port, op, args };
      calls.push(call);
      return reply(call);
    });
  return {
    agents: track("agents", ["ask"], () => ({ answer: "scouted" })),
    files: track("files", ["read", "glob"], (call) => (call.op === "read" ? `content:${String((call.args[1] as readonly string[] | undefined)?.[0])}` : ["one.txt"])),
    events: track("events", ["report", "log", "phase"], () => undefined),
    holes: track("holes", ["ask"], (call) => `filled:${String(call.args[1])}`),
  };
}

describe("F10.02 harness production launch over world ports", () => {
  it("runs a full workflow where every capability is an explicit port call", async () => {
    const calls: Call[] = [];
    const world = fullWorld(calls);
    const result = await runDynamicHarness({
      source: `
        const scout = agent('scout');
        const answer = await ask(scout, 'inspect the repo');
        const file = await files.read('/tmp/report.md');
        log('collected');
        phase('gather');
        const gap = await hole('missing-input', 'what size?');
        report({ answer, file, gap });
        return { answer, file, gap };
      `,
      ports: { agents: world.agents, files: world.files, events: world.events, holes: world.holes },
    });
    assert.equal(result.ok, true, result.failure?.message);
    // Script object literals carry a null prototype by design; normalize for deepEqual.
    const value = JSON.parse(JSON.stringify(result.value)) as Record<string, unknown>;
    assert.deepEqual(value, { answer: { answer: "scouted" }, file: "content:/tmp/report.md", gap: "filled:missing-input" });
    assert.deepEqual(result.ports, ["agents", "events", "files", "holes"]);
    assert.deepEqual(calls.map((call) => `${call.port}.${call.op}`), [
      "agents.ask", "files.read", "events.log", "events.phase", "holes.ask", "events.report",
    ]);
    assert.equal(result.usage.portCalls, 6);
    assert.ok(result.usage.operations > 0);
  });

  it("withholds every capability until the host registers a port for it", async () => {
    const silent = await runDynamicHarness({ source: "return 1 + 1;" });
    assert.equal(silent.ok, true);
    assert.deepEqual(silent.ports, []);
    assert.equal(silent.usage.portCalls, 0);
    assert.equal(silent.usage.deadline, false);
    assert.ok(Number.isFinite(silent.usage.elapsedMs));

    const denied = await runDynamicHarness({
      source: "log('hello'); return 'done';",
      ports: { events: recordingPort(["phase"], () => undefined) },
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.failure?.code, "DYNAMIC_PORT");
    assert.match(denied.failure?.message ?? "", /world port 'events' does not expose operation 'log'/);
  });

  it("rejects the operation when the port omits it from its declared ops", async () => {
    const result = await runDynamicHarness({
      source: "const names = await files.glob('*.md'); return names;",
      ports: { files: recordingPort(["read"], () => "x") },
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure?.code, "DYNAMIC_PORT");
    assert.match(result.failure?.message ?? "", /does not expose operation 'glob'/);
  });
});

describe("F10.02 deadlines, cancellation and budgets", () => {
  /** A port call that never settles: only the harness can end the run. */
  const pendingPort: DynamicWorldPort = defineDynamicWorldPort(["ask"], () => new Promise(() => undefined));
  const pendingSource = "const a = agent('a'); const v = await ask(a, 'stuck'); return v;";

  it("terminates a suspended run when the wall-clock budget elapses", async () => {
    const clock = new ManualDynamicClock(0);
    const harness = runDynamicHarness({
      source: pendingSource,
      ports: { agents: pendingPort },
      clock,
      timeoutMs: 1_000,
    });
    const settled = harness.then((result): DynamicHarnessResult | Error => result, (error: unknown) => error as Error);
    await new Promise((resolve) => setImmediate(resolve));
    clock.advance(1_050);
    const outcome = await settled;
    assert.ok(!(outcome instanceof Error), String(outcome));
    const result: DynamicHarnessResult = outcome;
    assert.equal(result.ok, false);
    assert.equal(result.failure?.code, "DYNAMIC_TIMEOUT");
    assert.equal(result.usage.deadline, true);
    assert.ok(result.usage.elapsedMs >= 1_000, `elapsed ${result.usage.elapsedMs}ms`);
  });

  it("cancels a suspended run through the host abort signal", async () => {
    const controller = new AbortController();
    const harness = runDynamicHarness({
      source: pendingSource,
      ports: { agents: pendingPort },
      signal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    const result = await harness;
    assert.equal(result.ok, false);
    assert.equal(result.failure?.code, "DYNAMIC_CANCELLED");
    assert.equal(result.usage.deadline, false);
  });

  it("enforces the port-call budget across every registered port", async () => {
    const calls: Call[] = [];
    const result = await runDynamicHarness({
      source: `
        const a = agent('a');
        const first = await ask(a, 'one');
        const second = await ask(a, 'two');
        const third = await ask(a, 'three');
        return third;
      `,
      ports: { agents: fullWorld(calls).agents },
      budget: { portCalls: 2 },
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure?.code, "DYNAMIC_BUDGET");
    assert.match(result.failure?.message ?? "", /port-call budget exceeded \(2\)/);
    assert.equal(calls.length, 2);
  });

  it("enforces the operation budget on compute-only scripts", async () => {
    const result = await runDynamicHarness({
      source: "let i = 0; while (i < 1_000) { i += 1; } return i;",
      budget: { operations: 50 },
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure?.code, "DYNAMIC_BUDGET");
    assert.ok(result.usage.operations > 50);
  });
});

describe("F10.02 error propagation and host guarantees", () => {
  it("returns port failures as coded results instead of throwing", async () => {
    // An awaited capability whose port rejects surfaces the upstream error verbatim.
    const awaited = await runDynamicHarness({
      source: "const a = agent('a'); return await ask(a, 'boom');",
      ports: { agents: defineDynamicWorldPort(["ask"], async () => { throw new Error("upstream unavailable"); }) },
    });
    assert.equal(awaited.ok, false);
    assert.equal(awaited.failure?.code, "DYNAMIC_EVALUATION");
    assert.match(awaited.failure?.message ?? "", /upstream unavailable/);

    // A fired side effect whose port rejects fails the run with DYNAMIC_PORT.
    const sideEffect = await runDynamicHarness({
      source: "report({ done: true }); return 'done';",
      ports: { events: defineDynamicWorldPort(["report"], async () => { throw new Error("sink closed"); }) },
    });
    assert.equal(sideEffect.ok, false);
    assert.equal(sideEffect.failure?.code, "DYNAMIC_PORT");
    assert.match(sideEffect.failure?.message ?? "", /world port rejected the call: sink closed/);
  });

  it("reports compile diagnostics without running any host code", async () => {
    let served = false;
    const result = await runDynamicHarness({
      source: "const secret = process.env.HOME; return secret;",
      ports: { agents: defineDynamicWorldPort(["ask"], async () => { served = true; }) },
    });
    assert.equal(result.ok, false);
    assert.equal(result.failure?.code, "DYN_FORBIDDEN_GLOBAL");
    assert.equal(result.failure?.line, 1);
    assert.equal(served, false);
  });

  it("awaits fired side effects before resolving the run", async () => {
    const seen: string[] = [];
    const slowEvents = defineDynamicWorldPort(["report"], async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      seen.push("report-served");
    });
    const result = await runDynamicHarness({
      source: "report({ done: true }); return 'done';",
      ports: { events: slowEvents },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(seen, ["report-served"]);
  });

  it("never leaks an unhandled rejection when a fire-and-forget port fails after the run returns", async () => {
    // `report`/`log`/`phase` are not awaited by the script, so a rejected port
    // must be tracked by the harness instead of surfacing as an unhandled
    // rejection on the host process.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const result = await runDynamicHarness({
        source: "report({ partial: true }); return 'done';",
        ports: { events: defineDynamicWorldPort(["report"], async () => { throw new Error("sink closed"); }) },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(unhandled, []);
      assert.equal(result.ok, false);
      assert.equal(result.failure?.code, "DYNAMIC_PORT");
      assert.match(result.failure?.message ?? "", /sink closed/);
    } finally { process.off("unhandledRejection", onUnhandled); }
  });

  it("rejects invalid harness configuration", async () => {
    await assert.rejects(
      runDynamicHarness({ source: "return 1;", budget: { portCalls: 0 } }),
      /portCalls must be a positive safe integer/,
    );
    await assert.rejects(
      runDynamicHarness({ source: "return 1;", timeoutMs: -5 }),
      /timeoutMs must be a positive finite number/,
    );
  });
});
