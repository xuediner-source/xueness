/** Differential: the memory loader against Python `bundled_plugins/memory/memory.py` and `catalog.load_run_memory`. */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { describe, it } from "node:test";
import { clip, loadMemory, loadRunMemory, memoryRootFromEnv, projectHash, pyResolve, renderTrack } from "../src/index.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
import { ENTRIES, memoryFixture, variantRoots } from "./fixture.ts";

const skip = pythonUnavailableReason() ?? (process.platform === "win32" ? "POSIX symlinks" : false);
const CLIPS: [string, number][] = [["  abc  ", 2], ["abcdefghijklmnopqrstu", 16], ["abcdefghijklmnopqrstu", 0], ["😀".repeat(30), 20], ["x  " + "y".repeat(20), 15], ["short", 10]];

describe("memory matches Python", { skip }, () => {
  it("project hash, clip, track rendering, loading and run memory", () => {
    const fixture = memoryFixture();
    try {
      const roots = variantRoots(fixture);
      const cwds = [fixture.workspace, fixture.workspace + "/", fixture.base + "/nowhere/../工作区 one", fixture.outside];
      const output = runPython(String.raw`
import json, os, sys
from pathlib import Path
from xueness.bundled_plugins.memory import memory as M, memory_api as A
c = json.load(sys.stdin)
loads = [[M.load(r, str(Path(cwd).resolve())) for cwd in c["cwds"]] for r in c["roots"]]
budgets = M.load(c["roots"][0], str(Path(c["cwds"][0]).resolve()), budgets={"memory": 40, "user": 0}, total_max_chars=300, label="label")
envs = []
for raw in c["envs"]:
    if raw is None: os.environ.pop("XUENESS_MEMORY_ROOT", None)
    else: os.environ["XUENESS_MEMORY_ROOT"] = raw
    root = A.memory_root()
    envs.append(None if root is None else str(root))
run = [(M.load(r.strip(), str(Path(c["cwds"][0]).resolve())) or None) for r in c["roots"]]
print(json.dumps({"hash": [M.project_hash(x) for x in c["cwds"]], "clip": [M.clip(t, n) for t, n in c["clips"]],
  "render": [M.render_track(e) for e in c["entries"]] + [M.render_track("\n§\n".join(c["entries"]))], "loads": loads, "budgets": budgets, "envs": envs, "run": run}))
`, JSON.stringify({ roots, cwds, clips: CLIPS, entries: ENTRIES, envs: [null, "", "   ", ` ${fixture.memoryRoot}\t`] }));
      const python = JSON.parse(output);
      assert.deepEqual(cwds.map(projectHash), python.hash);
      assert.deepEqual(CLIPS.map(([text, max]) => clip(text, max)), python.clip);
      assert.deepEqual([...ENTRIES.map(renderTrack), renderTrack(ENTRIES.join("\n§\n"))], python.render);
      const ts = roots.map((root) => cwds.map((cwd) => loadMemory(root, pyResolve(cwd))));
      assert.deepEqual(ts, python.loads);
      assert.deepEqual(loadMemory(roots[0]!, pyResolve(cwds[0]!), { budgets: { memory: 40, user: 0 }, totalMaxChars: 300, label: "label" }), python.budgets);
      assert.deepEqual([undefined, "", "   ", ` ${fixture.memoryRoot}\t`].map((raw) => memoryRootFromEnv(raw === undefined ? {} : { XUENESS_MEMORY_ROOT: raw })), python.envs);
      assert.deepEqual(roots.map((root) => loadRunMemory(root.trim(), cwds[0]!)), python.run);
      assert.ok(!JSON.stringify(ts).includes("leaked secret"));
      assert.ok(python.loads[0][0].includes("### Project key facts ("));
    } finally { rmSync(fixture.base, { recursive: true, force: true }); }
  });
});
