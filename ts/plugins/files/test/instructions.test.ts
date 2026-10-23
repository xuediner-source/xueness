import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { instructionCandidates, instructionSessionPaths, loadWorkspaceInstructions } from "../src/instructions.ts";
import { readRegularBeneath } from "@xueness/sessions";
import { PROJECT_ROOT, pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

const oracle = (inputs: unknown[]): unknown[] => JSON.parse(runPython(`
import json,sys
from xueness.bundled_plugins.files.instructions import load_workspace_instructions, _candidate_files, _session_paths
from pathlib import Path
out=[]
for data in json.load(sys.stdin):
 class Gate:
  def check(self, kind, subject):
   if subject in data.get('denied',[]): raise PermissionError('denied')
 session=data['session']; root=Path(data['root'])
 out.append({'paths':_session_paths(session),'candidates':_candidate_files(root,session),'loaded':load_workspace_instructions(root,session,Gate(),data.get('maxChars',6000))})
print(json.dumps(out,ensure_ascii=True))
`, JSON.stringify(inputs)));
describe("workspace instructions", () => {
  it("matches real Python selection, bounded UTF-8 reads, total caps and gate denials", { skip: pythonUnavailableReason() ?? false }, async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-instructions-"));
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "Root guidance 中文🕊️\n".repeat(800));
    writeFileSync(join(root, "src", "AGENTS.md"), "Source guidance\n");
    writeFileSync(join(root, "src", "nested", "AGENTS.md"), "Nested guidance\n");
    const call = (id: string, path: string, name = "read") => ({ id, function: { name, arguments: JSON.stringify({ path }) } });
    const session = { messages: [{ role: "assistant", tool_calls: [call("r1", "src/nested/a.ts"), call("w1", "src/b.ts", "write"), call("bad", "../outside")] }], results: { r1: { ok: true, path: "src/nested/a.ts" }, w1: { ok: true }, bad: { ok: true, path: "../outside" } } };
    const inputs = [6000, 300, 80, 0, 12000].map((maxChars, index) => ({ root, session, maxChars, denied: index % 2 ? ["AGENTS.md"] : [] }));
    try {
      const expected = oracle(inputs);
      for (const [index, input] of inputs.entries()) assert.deepEqual({ paths: instructionSessionPaths(session), candidates: instructionCandidates(root, session), loaded: await loadWorkspaceInstructions(root, session, (path) => !input.denied.includes(path), input.maxChars) }, expected[index]);
      writeFileSync(join(root, "AGENTS.md"), Buffer.from([0xff, 0xfe]));
      const [guidance, sources] = await loadWorkspaceInstructions(root, session, () => true);
      assert.deepEqual(sources, ["src/AGENTS.md", "src/nested/AGENTS.md"]); assert.ok(!guidance.includes("Root guidance"));
      writeFileSync(join(root, "AGENTS.md"), Buffer.concat([Buffer.alloc(12287, 97), Buffer.from("🕊️")]));
      const split = await loadWorkspaceInstructions(root, {}, () => true);
      assert.ok(split[0].endsWith("[内容已截断]"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("refuses symlink parents, including Windows directory junctions and aliases", async (context) => {
    const root = mkdtempSync(join(tmpdir(), "xueness-guidance-root-"));
    const outside = mkdtempSync(join(tmpdir(), "xueness-guidance-outside-"));
    writeFileSync(join(outside, "AGENTS.md"), "outside must never be read");
    try {
      try { symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir"); }
      catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { context.skip("host refused symlink creation"); return; } throw error; }
      assert.equal(readRegularBeneath(root, "linked/AGENTS.md", 12288), null);
      assert.equal(readRegularBeneath(root, "../AGENTS.md", 12288), null);
      if (process.platform === "win32") for (const path of ["NUL", "AGENTS.md.", "AGENTS.md ", "AGENTS.md:stream"]) assert.equal(readRegularBeneath(root, path, 12288), null);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });
  it("refuses a final-file symlink when the host permits creating one", (context) => {
    const root = mkdtempSync(join(tmpdir(), "xueness-guidance-link-"));
    const outside = mkdtempSync(join(tmpdir(), "xueness-guidance-target-"));
    writeFileSync(join(outside, "target.md"), "must not read through a link");
    try {
      try { symlinkSync(join(outside, "target.md"), join(root, "AGENTS.md"), "file"); }
      catch (error) { if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) { context.skip("host refused file symlink creation"); return; } throw error; }
      assert.equal(readRegularBeneath(root, "AGENTS.md", 12288), null);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });
  it("refuses FIFO input without waiting for a writer", { skip: process.platform === "win32" || pythonUnavailableReason() !== null }, () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-guidance-fifo-"));
    try {
      runPython("import os,sys; os.mkfifo(sys.stdin.read())", join(root, "AGENTS.md"));
      const code = "import {readRegularBeneath} from '@xueness/sessions';if(readRegularBeneath(" + JSON.stringify(root) + ",'AGENTS.md',12288)!==null)process.exit(2)";
      execFileSync(process.execPath, ["--input-type=module", "-e", code], { cwd: join(PROJECT_ROOT, "ts"), timeout: 2000, stdio: "pipe" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
