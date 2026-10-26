/** H02.01 gate runner (auto-verify) and H02.02 stack compression + self-repair loop. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compressOutput, compressStackTrace, createAutoVerify, describeError, normalizeOutput, runSelfRepairLoop,
  spawnGateRunner, type GateDefinition, type GateRun,
} from "../src/index.ts";

const ok = (exitCode = 0): GateRun => ({ exitCode, stdout: "", stderr: "", timedOut: false });
const fail = (stderr = "", stdout = "", exitCode = 1): GateRun => ({ exitCode, stdout, stderr, timedOut: false });

/** Fake runner with per-gate scripted results, recording call order. */
function scripted(results: Record<string, GateRun[]>): { run: (gate: GateDefinition, cwd: string, timeout: number) => Promise<GateRun>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async run(gate) {
      calls.push(gate.name);
      const queue = results[gate.name] ?? [];
      const result = queue.length > 1 ? queue.shift() : queue[0];
      if (!result) throw new Error(`no result scripted for gate ${gate.name}`);
      return result;
    },
  };
}

describe("auto-verify compression", () => {
  it("strips ANSI escapes and normalises line endings", () => {
    assert.equal(normalizeOutput("\u001b[31mfail\u001b[0m\r\nok  \n"), "fail\nok");
  });

  it("collapses repeated lines and keeps head and tail around an omission marker", () => {
    const noisy = ["start", ...Array.from({ length: 40 }, () => "same line"), "middle", ...Array.from({ length: 30 }, (_, i) => `tail ${i}`)].join("\n");
    const compressed = compressOutput(noisy, { headLines: 3, tailLines: 3, maxBytes: 4000 });
    const lines = compressed.split("\n");
    assert.equal(lines[0], "start");
    assert.ok(lines.includes("  … repeated 40 times"));
    assert.ok(compressed.includes("lines omitted"));
    assert.equal(lines.at(-1), "tail 29");
    assert.ok(!compressed.includes("middle"));
  });

  it("caps the byte length with a truncation marker and stays deterministic", () => {
    const big = Array.from({ length: 100 }, (_, i) => `line ${i} ${"x".repeat(100)}`).join("\n");
    const once = compressOutput(big, { headLines: 100, tailLines: 100, maxBytes: 500 });
    assert.equal(once, compressOutput(big, { headLines: 100, tailLines: 100, maxBytes: 500 }));
    assert.ok(Buffer.byteLength(once, "utf8") <= 500);
    assert.ok(once.endsWith("…") && once.includes("truncated"));
  });

  it("truncates on character boundaries so multi-byte text stays valid", () => {
    const cjk = Array.from({ length: 400 }, (_, i) => `行${i}：中文日志内容测试`).join("\n");
    const out = compressOutput(cjk, { headLines: 400, tailLines: 0, maxBytes: 300 });
    assert.ok(Buffer.byteLength(out, "utf8") <= 300);
    assert.ok(!out.includes("�"), "must not split a multi-byte code point");
    assert.ok(out.includes("truncated"));
  });

  it("returns empty text unchanged as empty", () => {
    assert.equal(compressOutput("  \n\u001b[0m \n"), "");
  });
});

describe("auto-verify runner", () => {
  const typecheck: GateDefinition = { name: "typecheck", command: ["tsc"], watch: ["ts/src"] };
  const tests: GateDefinition = { name: "test", command: ["bun", "test"] };

  it("rejects invalid gate definitions", () => {
    assert.throws(() => createAutoVerify({ gates: [{ name: " ", command: ["x"] }] }), /non-empty name/);
    assert.throws(() => createAutoVerify({ gates: [{ name: "g", command: [] }] }), /non-empty command/);
    assert.throws(() => createAutoVerify({ gates: [{ name: "g", command: ["x"], timeoutMs: 0 }] }), /timeoutMs/);
  });

  it("runs gates green and red, with compressed diagnostics only on failure", async () => {
    const fake = scripted({ typecheck: [ok()], test: [fail("boom\nboom\nboom\nboom\n")] });
    const verify = createAutoVerify({ gates: [typecheck, tests], run: fake.run, now: () => 0 });
    const summary = await verify.verify();
    assert.equal(summary.passed, false);
    assert.equal(summary.summary, "1/2 gates passed; failed: test");
    assert.equal(summary.outcomes[0]?.diagnostics, null);
    const diagnostics = summary.outcomes[1]?.diagnostics ?? "";
    assert.ok(diagnostics.includes("gate test failed (exit 1)"));
    assert.ok(diagnostics.includes("… repeated 4 times"));
    assert.ok(summary.outcomes.every((outcome) => outcome.durationMs === 0));
  });

  it("flags timeouts and reports a thrown runner as a failed gate", async () => {
    const timeoutGate: GateDefinition = { name: "hang", command: ["node", "-e", "0"] };
    const timedOut: GateRun = { exitCode: null, stdout: "", stderr: "", timedOut: true };
    const fake = scripted({ hang: [timedOut] });
    const verify = createAutoVerify({ gates: [timeoutGate], run: fake.run, now: () => 0 });
    const out = await verify.verify();
    assert.equal(out.summary, "0/1 gates passed; failed: hang");
    assert.match(out.outcomes[0]?.diagnostics ?? "", /timed out/);
    const throwing = createAutoVerify({ gates: [{ name: "crash", command: ["x"] }], run: async () => { throw new Error("spawn refused"); }, now: () => 0 });
    const crashed = await throwing.verify();
    assert.equal(crashed.passed, false);
    assert.ok(crashed.outcomes[0]?.diagnostics?.includes("spawn refused"));
  });

  it("selects gates by watched paths; unwatched gates always run", async () => {
    const fake = scripted({ typecheck: [ok()], test: [ok()] });
    const verify = createAutoVerify({ gates: [typecheck, tests], run: fake.run, now: () => 0 });
    const selected = await verify.verify(["ts/src/builtins/auto-verify.ts"]);
    assert.deepEqual(fake.calls, ["typecheck", "test"]);
    assert.equal(selected.summary, "2/2 gates passed");
    fake.calls.length = 0;
    const unrelated = await verify.verify(["docs/readme.md"]);
    assert.deepEqual(fake.calls, ["test"]);
    const allWatched = createAutoVerify({ gates: [{ name: "w", command: ["x"], watch: ["ts/src"] }], run: fake.run, now: () => 0 });
    const none = await allWatched.verify(["docs/readme.md"]);
    assert.deepEqual(none.outcomes, []);
    assert.equal(none.summary, "no gates selected");
  });

  it("can stop at the first failure", async () => {
    const fake = scripted({ typecheck: [fail("tsc errors")], test: [ok()] });
    const verify = createAutoVerify({ gates: [typecheck, tests], run: fake.run, stopOnFirstFailure: true, now: () => 0 });
    const out = await verify.verify(["ts/src"]);
    assert.deepEqual(fake.calls, ["typecheck"]);
    assert.equal(out.outcomes.length, 1);
  });

  it("spawns real commands: pass, fail with captured stderr, and timeout", async () => {
    const verify = createAutoVerify({ gates: [{ name: "exit0", command: [process.execPath, "-e", "process.exit(0)"] }], defaultTimeoutMs: 5000 });
    assert.equal((await verify.verify()).passed, true);
    const broken = createAutoVerify({ gates: [{ name: "exit3", command: [process.execPath, "-e", "console.error('kaputt'); process.exit(3)"] }] });
    const out = await broken.verify();
    assert.equal(out.outcomes[0]?.exitCode, 3);
    assert.ok(out.outcomes[0]?.diagnostics?.includes("kaputt"));
    const hung: GateDefinition = { name: "hang", command: [process.execPath, "-e", "setTimeout(() => {}, 10000)"], timeoutMs: 150 };
    const run = await spawnGateRunner(hung, ".", 150);
    assert.equal(run.timedOut, true);
    assert.equal(run.exitCode, null);
  });
});

describe("self-repair stack compression", () => {
  const stack = [
    "TypeError: Cannot read properties of undefined (reading 'map')",
    "    at collect (/w/repo/src/builtins/auto-verify.ts:42:19)",
    "    at node_modules/tslib/index.js:10:5",
    "    at node:internal/process/task_queues:95:5",
    "    at run (/w/repo/src/builtins/self-repair.ts:7:1)",
  ].join("\n");

  it("keeps the message, folds internal frames, and relativises paths", () => {
    const result = compressStackTrace(stack, { cwd: "/w/repo" });
    assert.equal(result.notAStack, false);
    assert.ok(result.compressed.startsWith("TypeError: Cannot read"));
    assert.ok(result.compressed.includes("… 2 internal frames omitted …"));
    assert.ok(result.compressed.includes("at collect (src/builtins/auto-verify.ts:42:19)"));
    assert.ok(!result.compressed.includes("node_modules"));
    assert.equal(result.internalFramesDropped, 2);
    assert.equal(result.userFramesKept, 2);
  });

  it("bounds user frames behind a more-frames marker", () => {
    const many = ["Error: x", ...Array.from({ length: 12 }, (_, i) => `    at fn${i} (src/file${i}.ts:1:1)`)].join("\n");
    const result = compressStackTrace(many, { maxFrames: 4 });
    assert.equal(result.userFramesKept, 4);
    assert.ok(result.compressed.includes("… 8 more frames …"));
    assert.ok(!result.compressed.includes("fn11"));
  });

  it("passes non-stack text through compressOutput with notAStack", () => {
    const result = compressStackTrace("just output\nand more");
    assert.equal(result.notAStack, true);
    assert.equal(result.compressed, "just output\nand more");
  });

  it("describes errors and non-errors safely", () => {
    const described = describeError(new Error("bad"));
    assert.equal(described.message, "Error: bad");
    assert.ok(described.stack);
    assert.equal(describeError("plain string").stack, null);
    assert.equal(describeError(42).message, "42");
  });
});

describe("self-repair loop", () => {
  it("repairs from compressed diagnostics and passes within the budget", async () => {
    let calls = 0;
    const repairs: string[] = [];
    const result = await runSelfRepairLoop({
      maxAttempts: 3,
      verify: async () => (calls++ < 2
        ? { passed: false, summary: "0/1 gates passed; failed: typecheck", diagnostics: "gate typecheck failed (exit 2)\nTS2322: bad type" }
        : { passed: true, summary: "1/1 gates passed", diagnostics: null }),
      repair: (feedback) => {
        assert.ok(feedback.diagnostics?.includes("TS2322"));
        repairs.push(`fix #${feedback.attempt}`);
        return `patch for ${feedback.summary}`;
      },
    });
    assert.equal(result.status, "passed");
    assert.equal(result.attempts, 3);
    assert.deepEqual(repairs, ["fix #1", "fix #2"]);
    assert.equal(result.history[2]?.passed, true);
    assert.equal(result.history[1]?.repair, "patch for 0/1 gates passed; failed: typecheck");
  });

  it("exhausts after max failed rounds and stops calling repair", async () => {
    let repairs = 0;
    const result = await runSelfRepairLoop({
      maxAttempts: 2,
      verify: async () => ({ passed: false, summary: "failed", diagnostics: "gate test failed (exit 1)" }),
      repair: () => { repairs += 1; return "try again"; },
    });
    assert.equal(result.status, "exhausted");
    assert.equal(result.attempts, 2);
    assert.equal(repairs, 1);
    assert.equal(result.history.length, 2);
  });

  it("gives up immediately when the repair callback declines", async () => {
    const result = await runSelfRepairLoop({
      verify: async () => ({ passed: false, summary: "failed", diagnostics: "gate lint failed (exit 1)" }),
      repair: () => null,
    });
    assert.equal(result.status, "gave_up");
    assert.equal(result.attempts, 1);
    assert.equal(result.history[0]?.repair, null);
  });

  it("records a thrown repair as a failed attempt and keeps terminating", async () => {
    const result = await runSelfRepairLoop({
      maxAttempts: 2,
      verify: async () => ({ passed: false, summary: "failed", diagnostics: "gate test failed (exit 1)" }),
      repair: () => { throw new Error("repair exploded"); },
    });
    assert.equal(result.status, "exhausted");
    assert.equal(result.history[0]?.error, "Error: repair exploded");
    assert.equal(result.history[0]?.repair, null);
  });

  it("refuses a non-positive or fractional attempt budget", async () => {
    const options = { verify: async () => ({ passed: true, summary: "", diagnostics: null }), repair: () => null } as const;
    await assert.rejects(runSelfRepairLoop({ ...options, maxAttempts: 0 }), /maxAttempts/);
    await assert.rejects(runSelfRepairLoop({ ...options, maxAttempts: 1.5 }), /maxAttempts/);
  });

  it("wires onto the auto-verify runner end to end", async () => {
    let broken = true;
    const fake = scripted({ test: [fail("assert failed"), ok()] });
    const verify = createAutoVerify({ gates: [{ name: "test", command: ["bun", "test"] }], run: fake.run, now: () => 0 });
    const result = await runSelfRepairLoop({
      maxAttempts: 3,
      verify: async () => {
        const round = await verify.verify();
        return { passed: round.passed, summary: round.summary, diagnostics: round.outcomes.find((outcome) => outcome.diagnostics)?.diagnostics ?? null };
      },
      repair: () => { broken = !broken; return "fixed the assertion"; },
    });
    assert.equal(result.status, "passed");
    assert.equal(broken, false);
    assert.ok(result.history[0]?.diagnostics?.includes("assert failed"));
  });
});
