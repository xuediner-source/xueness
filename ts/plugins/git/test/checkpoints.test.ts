import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SessionStore } from "@xueness/sessions";
import { isDict, normalizeError } from "@xueness/contracts";
import { checkpoint, gitCommand, listCheckpoints, restoreCheckpoint } from "../src/actions.ts";
import { createGitApi } from "../src/http-api.ts";
import { recordTurn } from "../src/turn-checkpoints.ts";
import { pythonUnavailableReason, runPythonAsync } from "../../../test-support/python-oracle.ts";
const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
const sid = "a".repeat(32);
async function commit(root: string, text: string) { await gitCommand(root, [...identity, "add", "--all"]); await gitCommand(root, [...identity, "commit", "-qm", text]); }
async function init(root: string) { await gitCommand(root, ["init", "-q"]); await gitCommand(root, ["config", "core.autocrlf", "false"]); }
describe("recoverable Git checkpoints", () => {
  it("preserves the real index and restores only a nested workspace after a recovery snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-checkpoint-scope-")), nested = join(root, "nested"); mkdirSync(nested);
    try {
      await init(root); writeFileSync(join(nested, "a.txt"), "one\n"); writeFileSync(join(root, "outside.txt"), "outside one\n"); await commit(root, "initial");
      writeFileSync(join(root, "outside.txt"), "staged outside\n"); await gitCommand(root, ["add", "outside.txt"]);
      const index = readFileSync(join(root, ".git", "index")), saved = await checkpoint(nested, "before change"); assert.deepEqual(readFileSync(join(root, ".git", "index")), index);
      writeFileSync(join(nested, "a.txt"), "two\n"); writeFileSync(join(nested, "keep.txt"), "new untracked must remain\n");
      const restored = await restoreCheckpoint(nested, saved.id);
      assert.equal(readFileSync(join(nested, "a.txt"), "utf8"), "one\n"); assert.equal(readFileSync(join(nested, "keep.txt"), "utf8"), "new untracked must remain\n");
      assert.equal(readFileSync(join(root, "outside.txt"), "utf8"), "staged outside\n"); assert.deepEqual(readFileSync(join(root, ".git", "index")), index);
      assert.equal(await gitCommand(root, ["show", restored.recovery.hash + ":nested/a.txt"]), "two");
      assert.equal(await gitCommand(root, ["show", restored.recovery.hash + ":nested/keep.txt"]), "new untracked must remain");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("refuses ignored private files before changing refs or workspace data", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-checkpoint-ignored-"));
    try {
      await init(root); writeFileSync(join(root, "private.txt"), "old tracked\n"); await commit(root, "initial"); const saved = await checkpoint(root);
      await gitCommand(root, ["rm", "--cached", "private.txt"]); writeFileSync(join(root, ".gitignore"), "private.txt\n"); await commit(root, "ignore private data");
      writeFileSync(join(root, "private.txt"), "private ignored new value\n"); const before = await listCheckpoints(root);
      await assert.rejects(restoreCheckpoint(root, saved.id), /Ignored files overlap/);
      assert.equal(readFileSync(join(root, "private.txt"), "utf8"), "private ignored new value\n"); assert.deepEqual(await listCheckpoints(root), before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("matches actual Python HTTP checkpoint metadata and rewind validation", { skip: pythonUnavailableReason() ?? false }, async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-checkpoint-http-")), repo = join(root, "repo"), store = new SessionStore(join(root, "state")); mkdirSync(repo);
    try {
      await init(repo); writeFileSync(join(repo, "a.txt"), "one\n"); await commit(repo, "initial");
      const session = await store.new("checkpoint fixture", repo, { sessionId: sid }); await recordTurn(store, session, () => true, "write", "write");
      const target = (session.turn_checkpoints as Record<string, any>[])[0]!.checkpointId, base = `/api/sessions/${sid}/git`;
      const requests = [{ method: "GET", path: base + "/checkpoints" }, { method: "GET", path: base + "/turn-checkpoints" },
        ...[{}, { confirmed: true }, { confirmed: true, checkpoint: target, latest: true }, { confirmed: true, checkpoint: target, latest: null }, { confirmed: false, checkpoint: target }, { confirmed: true, checkpoint: target, root }, { confirmed: true, checkpoint: "0".repeat(32) }].map((data) => ({ method: "POST", path: base + "/turn-checkpoints/rewind", data }))];
      const pyState = join(root, "python"); cpSync(store.directory, pyState, { recursive: true });
      const api = createGitApi({ store, stateDir: store.directory, enabled: () => true }), actual: unknown[] = [];
      for (const r of requests) { const result = (await api.dispatch(r.method, r.path.split("/").filter(Boolean), {}, "data" in r ? r.data : {}))!; actual.push([result[0], result[0] >= 400 && isDict(result[1]) ? normalizeError(result[0], result[1]) : result[1]]); }
      const oracle = join(import.meta.dirname, "../../../test-support/python/http_feature_oracle.py");
      const expected = JSON.parse(await runPythonAsync(`import runpy;runpy.run_path(${JSON.stringify(oracle)},run_name='__main__')`, JSON.stringify({ stateDir: pyState, workspace: root, requests })));
      assert.deepEqual(actual, expected);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
