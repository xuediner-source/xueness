/**
 * H08.02 — deepseek_harness × hooks E2E.
 *
 * One edit story end to end, with real child processes on both sides: the
 * H01 loader mounts a harness whose manifest declares an
 * `after_tool_execution` hook and a `signal-gate` verifier; the host maps
 * that declaration onto a hooks-plugin plugin contribution (F07.03 boundary
 * gating included); the hooks extension fires it as a PostToolUse hook after
 * an edit through the scoped process executor; and the failing gate feeds
 * H02.01 auto-verify (compressed diagnostics) and the H02.02 bounded
 * self-repair loop, which repairs the workspace and goes green on the
 * re-verify. The hook fires green once the signal file is fixed, proving the
 * two plugins observe the same gate.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { AgentContext, AgentExtension } from "@xueness/agent";
import { Context } from "@xueness/kernel";
import {
  hooksBinding, hooksExtension, loadBoundary, pluginHookRows, registerPluginHooks, scopedExecute, setFeature,
  type HooksBinding, type PluginHookContribution,
} from "../../hooks/src/index.ts";
import {
  createAutoVerify, createHarnessApi, harnessHookContribution, HARNESS_EVENT_MAP, HARNESS_MANIFEST_FILE, HARNESS_SDK_API_VERSION,
  runSelfRepairLoop, spawnGateRunner, type VerifySummary,
} from "../src/index.ts";

const base = mkdtempSync(join(tmpdir(), "xueness-e2e-hooks-"));
const root = join(base, "workspace");
const state = join(base, "state");
const harnessDir = join(base, "verify-harness");
const gateJs = join(root, "gate.js");
const signal = join(root, "signal.txt");
after(() => rmSync(base, { recursive: true, force: true }));

/** The gate command both sides run: exit 0 once signal.txt says `ok`, else 60 noisy lines and exit 1. */
const GATE_SCRIPT = `const { readFileSync } = require("fs");
try { if (readFileSync("signal.txt", "utf8").trim() === "ok") process.exit(0); } catch {}
for (let index = 0; index < 60; index += 1) console.error("noise line " + index + " with repeated detail");
process.exit(1);
`;

const manifest = {
  sdkApiVersion: HARNESS_SDK_API_VERSION,
  id: "verify-harness",
  version: "1.0.0",
  tools: [],
  hooks: [{ event: "after_tool_execution", handler: "auto-verify" }],
  verifiers: [{ name: "signal-gate", command: "node gate.js" }],
  skills: [],
  promptTemplates: [],
};

let binding: HooksBinding;
let api: ReturnType<typeof createHarnessApi>;

/** The host resolver: the harness names a handler, the host owns the command. */
const resolveHandler = (handler: string): { command: string; args: string[]; matcher: string } | null =>
  handler === "auto-verify" ? { command: process.execPath, args: [gateJs], matcher: "edit" } : null;

/** Production bridge: the mounted manifest's declarations become the contribution. */
const contributionOf = (): PluginHookContribution => {
  const contribution = harnessHookContribution(api.registry, resolveHandler);
  assert.ok(contribution, "the mounted harness must contribute runnable hook rows");
  return contribution;
};

const makeContext = (): { context: AgentContext; session: Record<string, unknown> } => {
  const session: Record<string, unknown> = { id: "s1", messages: [{ role: "user", content: "fix the gate" }], status: "running", steps: 1 };
  return {
    session,
    context: {
      session, root, stateDir: state, signal: new AbortController().signal, provider: {}, options: {},
      enabled: (id: string) => id === "hooks", async save() {}, emit() {},
    } as unknown as AgentContext,
  };
};

const extension = (): AgentExtension => hooksExtension({ stateDir: state, binding, legacy: true, execute: scopedExecute(() => kernel) });
let kernel: Context;

const verifyPass = async (): Promise<VerifySummary> => autoVerify.verify(["gate.js"]);
let autoVerify: ReturnType<typeof createAutoVerify>;

const summaryOf = async (): Promise<{ passed: boolean; summary: string; diagnostics: string | null }> => {
  const pass = await verifyPass();
  return { passed: pass.passed, summary: pass.summary, diagnostics: pass.outcomes.find((outcome) => !outcome.passed)?.diagnostics ?? null };
};

before(async () => {
  mkdirSync(root, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(join(harnessDir, HARNESS_MANIFEST_FILE), JSON.stringify(manifest));
  writeFileSync(gateJs, GATE_SCRIPT);
  setFeature(state, true);
  api = createHarnessApi();
  const loaded = await api.dispatch("deepseek_harness/load", { source: harnessDir });
  assert.equal(loaded.ok, true, "the hook-declaring harness must mount");
  const mounted = api.registry.get("verify-harness");
  assert.deepEqual(mounted?.manifest.hooks, [{ event: "after_tool_execution", handler: "auto-verify" }]);
  assert.deepEqual(mounted?.manifest.verifiers, [{ name: "signal-gate", command: "node gate.js" }]);
  binding = hooksBinding();
  registerPluginHooks(binding, "deepseek_harness", contributionOf().rows);
  autoVerify = createAutoVerify({
    gates: [{ name: "signal-gate", command: [process.execPath, gateJs], watch: ["gate.js"] }],
    cwd: root,
    run: spawnGateRunner,
    now: () => 0,
  });
});

describe("H08.02 deepseek_harness × hooks E2E", () => {
  it("admits the mounted hook declaration through the plugin trust boundary", () => {
    const boundary = loadBoundary(state);
    assert.equal(boundary.status, "absent", "no boundary file means every bundled plugin is trusted");
    const admittedRows = pluginHookRows(binding.contributions, boundary);
    assert.deepEqual(admittedRows.views, [{ plugin: "deepseek_harness", id: "after_tool_execution:auto-verify", event: "PostToolUse", admitted: true, reason: "plugin_trusted" }]);
    assert.deepEqual(admittedRows.hooks, [{ id: "plugin:deepseek_harness:after_tool_execution:auto-verify", event: "PostToolUse", command: process.execPath, args: [gateJs], matcher: "edit", source: "plugin", plugin: "deepseek_harness" }]);
  });

  it("bridges the manifest declaration onto a hook row without letting it pick a command", () => {
    // The manifest carries only `{event, handler}`; the host resolver owns the
    // command, so a harness source can never name the program it runs.
    const mapping = harnessHookContribution(api.registry, resolveHandler);
    assert.ok(mapping);
    assert.deepEqual(mapping.rows.map((row) => [row.id, row.event, row.command]), [
      ["after_tool_execution:auto-verify", "PostToolUse", process.execPath],
    ]);
    const unresolved = harnessHookContribution(api.registry, () => null);
    assert.equal(unresolved, null, "a declaration the host cannot resolve yields no runnable row");
    assert.equal(HARNESS_EVENT_MAP.before_tool_execution, undefined, "PreToolUse (the only vetoing event) is deliberately not mapped");
  });

  it("refuses the same declaration when the boundary withholds trust", () => {
    writeFileSync(join(state, "hook-boundary.json"), JSON.stringify({ schemaVersion: 1, trustedPlugins: ["sessions"] }));
    const boundary = loadBoundary(state);
    assert.equal(boundary.status, "ok");
    const refused = pluginHookRows(binding.contributions, boundary);
    assert.equal(refused.hooks.length, 0);
    assert.deepEqual(refused.views.map((view) => [view.admitted, view.reason]), [[false, "plugin_not_trusted"]]);
    rmSync(join(state, "hook-boundary.json"));
  });

  it("fires the gate as a PostToolUse hook after an edit and records the failure", async () => {
    kernel = Context.create({ roots: { workspace: [root] } });
    try {
      writeFileSync(signal, "broken\n");
      const { context, session } = makeContext();
      await extension().afterTool?.(context, { id: "c1", name: "edit", input: {} }, { ok: true });
      const log = session.hook_log as { event: string; id: string; exit_code: number; blocked: boolean }[];
      assert.equal(log.length, 1, "exactly the harness hook fired");
      assert.deepEqual({ event: log[0]?.event, id: log[0]?.id, exit_code: log[0]?.exit_code, blocked: log[0]?.blocked },
        { event: "PostToolUse", id: "plugin:deepseek_harness:after_tool_execution:auto-verify", exit_code: 1, blocked: false });
      assert.equal(kernel.scope.size, 0, "the hook's process scope closed with the run");
    } finally {
      await kernel.dispose();
    }
  });

  it("auto-verify compresses the same gate's diagnostics", async () => {
    const pass = await verifyPass();
    assert.equal(pass.passed, false);
    assert.equal(pass.summary, "0/1 gates passed; failed: signal-gate");
    const outcome = pass.outcomes[0]!;
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.timedOut, false);
    assert.ok(outcome.diagnostics?.includes("gate signal-gate failed (exit 1)"));
    assert.ok(outcome.diagnostics?.includes("lines omitted"), "60 noise lines collapse behind the omission marker");
    assert.ok(outcome.diagnostics!.length <= 4000, "diagnostics stay under the byte cap");
  });

  it("the bounded self-repair loop repairs the signal and re-verifies green", async () => {
    writeFileSync(signal, "broken\n");
    const result = await runSelfRepairLoop({
      verify: summaryOf,
      repair: async (feedback) => {
        assert.equal(feedback.attempt, 1);
        assert.ok(feedback.summary.includes("signal-gate"));
        assert.ok(feedback.diagnostics?.includes("gate signal-gate failed (exit 1)"), "the repair sees the compressed gate diagnostics");
        writeFileSync(signal, "ok\n");
        return "rewrote signal.txt to ok";
      },
    });
    assert.equal(result.status, "passed");
    assert.equal(result.attempts, 2);
    assert.deepEqual(result.history.map((attempt) => [attempt.attempt, attempt.passed, attempt.repair]),
      [[1, false, "rewrote signal.txt to ok"], [2, true, null]]);
  });

  it("the same hook fires green once the signal is repaired", async () => {
    kernel = Context.create({ roots: { workspace: [root] } });
    try {
      assert.equal(readFileSync(signal, "utf8").trim(), "ok", "the repair round left the workspace green");
      const { context, session } = makeContext();
      await extension().afterTool?.(context, { id: "c2", name: "edit", input: {} }, { ok: true });
      const log = session.hook_log as { event: string; exit_code: number }[];
      assert.deepEqual(log.map((entry) => [entry.event, entry.exit_code]), [["PostToolUse", 0]], "hooks and auto-verify agree on the repaired gate");
    } finally {
      await kernel.dispose();
    }
  });

  it("ends as gave_up when the repair declines instead of looping", async () => {
    writeFileSync(signal, "broken\n");
    const result = await runSelfRepairLoop({ verify: summaryOf, repair: async () => null, maxAttempts: 3 });
    assert.equal(result.status, "gave_up");
    assert.equal(result.attempts, 1, "a declined repair terminates the loop immediately");
    assert.equal(result.history[0]?.passed, false);
  });
});
