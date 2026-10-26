import { mkdtempSync } from "../../../test-support/canonical-temp.ts";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { numericValue } from "@xueness/contracts";
import { Automations, bindPluginEnabled, Scheduler, type WorkflowBridge } from "../src/index.ts";

type Row = Record<string, any>;
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 100));

// The stored `nextRunAt` is a float the lossless reader keeps boxed; the daemon must still see it as due,
// on its first pass (Python's thread does not wait 15 seconds first), and only while the plugin is enabled.
it("fires a due approved schedule on the first pass, advances it, and stays idle while disabled", async () => {
  const base = mkdtempSync(join(tmpdir(), "xue-scheduler-")), root = join(base, "work");
  mkdirSync(root);
  const calls: string[] = [];
  const bridge: WorkflowBridge = {
    create: (_plan, at) => { calls.push(`create ${at}`); return { id: "a".repeat(32) }; },
    launch: (wid, approved, allowReal) => { calls.push(`launch ${wid.slice(0, 4)} ${approved} ${allowReal}`); return { id: wid, status: "queued" }; },
    control: () => ({}), load: () => ({}), list: () => [],
  };
  try {
    const store = new Automations(base, { bridge });
    const saved = store.save({ name: "Nightly", schedule: "*/5 * * * *", timezone: "UTC", enabled: true, workflow: { root, name: "x", nodes: [{ id: "a", argv: ["true"] }] } });
    store.approve(saved.id as string, false);
    const next = numericValue(saved.nextRunAt) as number;
    bindPluginEnabled(() => false);
    let scheduler = new Scheduler(base, { clock: () => next + 1, bridge });
    await settle(); scheduler.close();
    assert.deepEqual(calls, []);
    bindPluginEnabled(null);
    scheduler = new Scheduler(base, { clock: () => next + 1, bridge });
    await settle(); scheduler.close();
    assert.deepEqual(calls, [`create ${root}`, "launch aaaa true false"]);
    const [row] = new Automations(base).list() as Row[];
    assert.equal(row!.history.at(-1).status, "started");
    assert.ok((numericValue(row!.nextRunAt) as number) > next);
  } finally {
    bindPluginEnabled(null);
    rmSync(base, { recursive: true, force: true });
  }
});
