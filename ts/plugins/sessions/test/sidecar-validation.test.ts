import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SessionStore } from "@xueness/sessions";
import { createSessionCommandsApi } from "../src/command-http.ts";
import { CommandReceipts } from "../src/command-receipts.ts";
import { MessageQueue } from "../src/queue.ts";
import { pythonUnavailableReason, runPythonAsync } from "../../../test-support/python-oracle.ts";
const sid = "a".repeat(32), commandId = `c_${Date.now()}_${"1".repeat(32)}`;
const invalidReceipts = [null, [], 0, "text", { schema: 1, commands: [], retiredBefore: null }];
const validQueue = { schema: 1, accepting: false, revision: 0, items: [] };
const invalidQueues = [null, [], 0, "text", ...["accepting", "revision", "withdrawals", "withdrawalClock"].map((key) => ({ ...validQueue, [key]: null }))];
describe("private sidecar validation", () => {
  it("never treats corrupt null records or counters as absent storage", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-sidecar-invalid-")), store = new SessionStore(join(root, "state"));
    try {
      await store.new("once", root, { sessionId: sid });
      let executions = 0;
      const options = { store, stateDir: store.directory, webRuns: root, projectDir: root, enabled: () => true,
        executeCommand: async (): Promise<[number, unknown]> => { executions++; return [200, {}]; } };
      const api = createSessionCommandsApi(options), receipts = new CommandReceipts(store.directory);
      await receipts.locked(sid, () => {});
      for (const value of invalidReceipts) {
        const bytes = JSON.stringify(value); writeFileSync(receipts.path(sid), bytes);
        assert.throws(() => receipts.readRecord(sid), { name: "ValueError" });
        const result = await api.dispatch("POST", ["api", "sessions", sid, "commands"], {}, { commandId, type: "send", payload: { text: "never replay" } });
        assert.equal(result?.[0], 503); assert.equal(readFileSync(receipts.path(sid), "utf8"), bytes);
      }
      assert.equal(executions, 0);
      const queue = new MessageQueue(store); await queue.locked(sid, () => {});
      for (const value of invalidQueues) {
        const bytes = JSON.stringify(value); writeFileSync(queue.path(sid), bytes);
        await assert.rejects(queue.setAccepting(sid, true), { name: "ValueError" });
        assert.equal(readFileSync(queue.path(sid), "utf8"), bytes);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("matches Python refusal of corrupt records and null persisted counters", { skip: pythonUnavailableReason() ?? false }, async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-sidecar-python-"));
    try {
      const result = JSON.parse(await runPythonAsync(`
import json,sys
from pathlib import Path
from xueness.core import Store
from xueness.bundled_plugins.sessions.command_ack import CommandReceipts
from xueness.bundled_plugins.sessions.queue import MessageQueue
d=json.load(sys.stdin); store=Store(Path(d['root'])); out=[]
for obj,values,read in [(CommandReceipts(store),d['receipts'],'read'),(MessageQueue(store),d['queues'],'_read')]:
 obj.directory.mkdir(parents=True,exist_ok=True)
 for value in values:
  obj._path(d['sid']).write_text(json.dumps(value),encoding='utf-8')
  try: getattr(obj,read)(d['sid']); out.append(True)
  except ValueError: out.append(False)
print(json.dumps(out))
`, JSON.stringify({ root, sid, receipts: invalidReceipts, queues: invalidQueues })));
      assert.deepEqual(result, Array(invalidReceipts.length + invalidQueues.length).fill(false));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("reads current plugin state before every HTTP operation without creating sidecars", async () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-sidecar-disabled-")), store = new SessionStore(join(root, "state"));
    try {
      await store.new("disabled", root, { sessionId: sid }); const before = readFileSync(store.pathFor(sid));
      let enabled = true, calls = 0;
      const api = createSessionCommandsApi({ store, stateDir: store.directory, projectDir: root, webRuns: root, enabled: () => enabled,
        consumePrepared: async () => { calls++; throw new Error("must not consume"); }, executeCommand: async () => { calls++; return [200, {}]; } });
      enabled = false;
      for (const suffix of [["queue"], ["steer"], ["queue", "1".repeat(32), "send-now"], ["queue-withdrawals"], ["commands"]]) {
        const result = await api.dispatch("POST", ["api", "sessions", sid, ...suffix], {}, { commandId, type: "send", payload: { text: "blocked", prepared_token: "1".repeat(32) } });
        assert.equal(result?.[0], 403);
      }
      assert.equal(calls, 0); assert.deepEqual(readFileSync(store.pathFor(sid)), before);
      for (const folder of ["session-command-receipts", "session-message-queues", "session-turn-inputs"]) assert.equal(existsSync(join(store.directory, folder)), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
