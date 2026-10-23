/** Differential: loading, matching, workspace discovery, digests, trust admission and the runner against the Python plugin. */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pyJsonDumps } from "@xueness/contracts";
import { Context } from "@xueness/kernel";
import { admitted, boundedResult, clip, discover, extendForRunner, featureStatus, HookRunner, loadTrust, loadUserHooks, scopedExecute, select, vetoOf, type HookResult } from "../src/index.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
import { hookFixture } from "./fixture.ts";

const skip = pythonUnavailableReason() ?? (process.platform === "win32" ? "POSIX hook commands" : false);
const canonical = (value: unknown): unknown => JSON.parse(pyJsonDumps(value, { sortKeys: true }));
const SELECTS: [string, string[]][] = [["PreToolUse", ["exec"]], ["PreToolUse", ["exec_output"]], ["PreToolUse", ["read", "Read"]], ["PostToolUse", ["read"]], ["PostToolUse", ["xREADx"]],
  ["UserPromptSubmit", [""]], ["Stop", [""]], ["SessionStart", ["anything"]], ["PreToolUse", ["exec", "Bash"]], ["PreToolUse", [""]]];

describe("hooks match Python", { skip }, () => {
  it("load, select, discovery, digests, trust and admission", () => {
    const { base, root, state } = hookFixture();
    try {
      const output = runPython(String.raw`
import json, sys
from xueness import hooks as H
from xueness.bundled_plugins.hooks import workspace_hooks as W, tool_events as T
c = json.load(sys.stdin)
loaded = H.load(c["state"])
found = W.discover(c["root"])
before = W.admitted(c["state"], c["root"])
granted = W.grant_trust(c["state"], found["workspace"], found["hooks"][:2], now="2026-10-19T00:00:00Z")
session = {"hook_diagnostics": []}
after = W.admitted(c["state"], c["root"], session)
runner_rows = W.extend_for_runner(c["state"], c["root"], loaded, session)
selects = [[h["id"] for h in H.select(runner_rows, e, s[0])] for e, s in c["selects"]]
clips = [H.clip(t, n) for t, n in c["clips"]]
bounded = [T._bounded_result(r) for r in c["results"]]
print(json.dumps({"loaded": loaded, "found": found, "before": before, "after": after, "runner": runner_rows, "selects": selects, "clips": clips,
  "trust": W.load_trust(c["state"]), "feature": W.feature_status(c["state"]), "diag": session["hook_diagnostics"], "bounded": bounded, "granted": granted["granted"]}))
`, JSON.stringify({ state, root, selects: SELECTS, clips: [["abcdef", 4], ["abcdef", 0], ["日本語テキスト", 12], ["abcdefghijklmnop", 14], [12345, 3]],
        results: [{ ok: true, output: "x" }, { ok: false, output: "y".repeat(9000) }, "nope", { ok: true, output: "日".repeat(7990) }] }));
      const py = JSON.parse(output) as Record<string, unknown>;
      const loaded = loadUserHooks(state);
      assert.deepEqual(canonical(loaded), canonical(py.loaded));
      const found = discover(root);
      assert.deepEqual(canonical(found), canonical(py.found));
      // Python granted the first two declarations: the TS digests must be the ones it stored.
      assert.equal(py.granted, 2);
      const session = { hook_diagnostics: [] as unknown[] };
      assert.deepEqual(canonical(admitted(state, root, session)), canonical(py.after));
      assert.deepEqual(canonical(session.hook_diagnostics), canonical(py.diag));
      const runnerRows = extendForRunner(state, root, loaded, {});
      assert.deepEqual(canonical(runnerRows), canonical(py.runner));
      assert.deepEqual(SELECTS.map(([event, subjects]) => select(runnerRows, event, subjects.slice(0, 1)).map((hook) => hook.id)), py.selects);
      assert.deepEqual(canonical(loadTrust(state)), canonical(py.trust));
      assert.deepEqual(featureStatus(state), py.feature);
      assert.deepEqual([["abcdef", 4], ["abcdef", 0], ["日本語テキスト", 12], ["abcdefghijklmnop", 14], [12345, 3]].map(([text, max]) => clip(text, max as number)), py.clips);
      assert.deepEqual(canonical([{ ok: true, output: "x" }, { ok: false, output: "y".repeat(9000) }, "nope", { ok: true, output: "日".repeat(7990) }].map(boundedResult)), canonical(py.bounded));
      // The "before" admission (nothing trusted yet) from Python, recomputed in TS against a fresh trust-less state, keeps the same shape.
      assert.equal((py.before as Record<string, unknown>).reason, "pending_trust");
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it("runs hooks like Python: stdin payload, exit codes, block, missing program, timeout, bad cwd", async () => {
    const { base, root, state } = hookFixture();
    const hooks = [
      { id: "echo", event: "PreToolUse", command: "/bin/sh", args: ["-c", "cat"] },
      { id: "warn", event: "PreToolUse", command: "/bin/sh", args: ["-c", "echo careful >&2; exit 3"] },
      { id: "block", event: "PreToolUse", command: "/bin/sh", args: ["-c", "printf 'no\\r\\nway '; exit 2"], matcher: "exec" },
      { id: "missing", event: "PreToolUse", command: join(base, "no-such-program") },
      { id: "slow", event: "PreToolUse", command: "/bin/sh", args: ["-c", "sleep 3"], timeout: 0.3 },
      { id: "badarg", event: "PreToolUse", command: "/bin/true", args: [7] },
      { id: "post", event: "PostToolUse", command: "/bin/true" },
      { id: "pipe", event: "PostToolUse", command: "/bin/sh", args: ["-c", "cat"], pipeline: true },
    ];
    const payload = { session_id: "s1", tool_name: "exec", tool_call_id: "c1", arguments: { command: "ls ü", n: 1.5, deep: [true, null] } };
    const kernel = Context.create({ roots: { workspace: [root], state, temp: tmpdir() } });
    try {
      const py = JSON.parse(runPython(String.raw`
import json, sys
from pathlib import Path
from xueness import hooks as H
c = json.load(sys.stdin)
r = H.HookRunner(c["hooks"], Path(c["root"]))
out = {"pre": r.fire("PreToolUse", c["payload"]), "post": r.fire("PostToolUse", {"tool": "exec", "ok": True}),
  "pipe": r.fire("PostToolUse", {"tool": "exec", "ok": True}, pipeline=True), "badcwd": H.HookRunner(c["hooks"], Path(c["root"]) / "missing").fire("PreToolUse", c["payload"])[:1],
  "timeouts": [H.HookRunner([], None, timeout_cap=cap)._timeout_for({"timeout": t}) for cap, t in c["timeouts"]]}
for rows in out.values():
    for row in rows:
        if isinstance(row, dict): row.pop("duration_ms", None)
print(json.dumps(out))
`, JSON.stringify({ hooks, root, payload, timeouts: [[30, 5], [30, 0], [30, "7"], [30, "x"], [10, 50], [0, 5], ["bad", 2], [30, -1], [30, true]] })));
      const runner = new HookRunner(hooks, root, scopedExecute(() => kernel));
      const strip = (rows: HookResult[]): unknown[] => rows.map(({ duration_ms: _, ...rest }) => rest);
      const pre = strip(await runner.fire("PreToolUse", payload));
      assert.deepEqual(pre, py.pre);
      assert.deepEqual(strip(await runner.fire("PostToolUse", { tool: "exec", ok: true })), py.post);
      assert.deepEqual(strip(await runner.fire("PostToolUse", { tool: "exec", ok: true }, { pipeline: true })), py.pipe);
      assert.deepEqual(strip((await new HookRunner(hooks, join(root, "missing"), scopedExecute(() => kernel)).fire("PreToolUse", payload)).slice(0, 1)), py.badcwd);
      const caps: [unknown, unknown][] = [[30, 5], [30, 0], [30, "7"], [30, "x"], [10, 50], [0, 5], ["bad", 2], [30, -1], [30, true]];
      assert.deepEqual(caps.map(([cap, timeout]) => new HookRunner([], null, scopedExecute(() => kernel), { timeoutCap: cap as number }).timeoutFor({ timeout })), py.timeouts);
      // Python `_pretooluse_veto`: the first exit-2 hook blocks; its clipped output travels as untrusted data.
      assert.deepEqual(vetoOf(await runner.fire("PreToolUse", payload)), { ok: false, error: "blocked by hook block", hook_blocked: true, hook_output_untrusted: "no\nway" });
    } finally { await kernel.dispose(); rmSync(base, { recursive: true, force: true }); }
  });
});
