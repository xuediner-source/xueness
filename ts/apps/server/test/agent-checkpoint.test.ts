import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { appendUserTurn, type Row } from "@xueness/agent";
import { gitCommand, listCheckpoints } from "@xueness/plugin-git";
import type { RunPolicy } from "@xueness/plugin-sessions";
import { SessionStore } from "@xueness/sessions";
import { createAgentService } from "../src/agent-service.ts";
import { answerWaits } from "./approval-support.ts";
const tool = (id: string, path: string): Row => ({ id, type: "function", function: { name: "write", arguments: JSON.stringify({ path, content: "updated\n" }) } });
it("checkpoints an approved call before effect, once per human turn, and honors Git disable", async () => {
  const root = mkdtempSync(join(tmpdir(), "xue-agent-git-")), state = mkdtempSync(join(tmpdir(), "xue-agent-state-")); const store = new SessionStore(state);
  await gitCommand(root, ["init"]); writeFileSync(join(root, "base.txt"), "original\n"); await gitCommand(root, ["add", "base.txt"]);
  await gitCommand(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local", "commit", "-m", "Fixture baseline"]);
  const session = await store.new("Apply the changes", root), policy: RunPolicy = { mode: "build", permissionMode: "build", disallowed: [], selection: {}, request: {} };
  let gitEnabled = true; const service = createAgentService({ store, stateDir: state, enabled: (id) => ["sessions", "providers", "files", "shell"].includes(id) || id === "git" && gitEnabled });
  try {
    // In-process approvals: both writes wait, are approved and run in the same turn.
    let requests = 0;
    const running = service.createRunner(session, { complete: async () => {
      requests += 1;
      if (requests === 1) { assert.equal((await listCheckpoints(root)).length, 0); assert.equal(existsSync(join(root, "first.txt")), false); return { tool_calls: [tool("first", "first.txt")] }; }
      if (requests === 2) {
        const snapshots = await listCheckpoints(root); assert.equal(snapshots.length, 1); assert.equal(readFileSync(join(root, "first.txt"), "utf8"), "updated\n");
        assert.equal(await gitCommand(root, ["show", snapshots[0]!.hash + ":base.txt"]), "original");
        assert.equal((await gitCommand(root, ["ls-tree", "-r", "--name-only", snapshots[0]!.hash])).includes("first.txt"), false);
        return { tool_calls: [tool("second", "second.txt")] };
      }
      return { content: "Changes applied.\nEvidence: E1, E2" };
    } }, policy).run(session);
    await answerWaits(service.liveApprovals, running, "approve");
    assert.equal(session.status, "completed"); assert.equal(requests, 3); assert.equal((await listCheckpoints(root)).length, 1);
    gitEnabled = false; await appendUserTurn(session, store, "Apply one more change"); let calls = 0;
    await service.createRunner(session, { complete: async () => calls++ ? { content: "Applied.\nEvidence: E3" } : { tool_calls: [tool("third", "third.txt")] } }, { ...policy, permissionMode: "yolo" }).run(session);
    assert.equal((await listCheckpoints(root)).length, 1); assert.equal(readFileSync(join(root, "third.txt"), "utf8"), "updated\n");
  } finally { await service.dispose(); rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); }
});
