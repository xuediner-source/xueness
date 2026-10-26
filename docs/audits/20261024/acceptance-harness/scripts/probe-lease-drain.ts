/**
 * F00.04 acceptance harness · S-WFL-05A (offline).
 *
 * Cross-process session-lease probe for the lease-exclusion clauses of C-WFL-05:
 * a concurrent publisher during lease acquisition rejects the stale run without
 * any model request / tool effect / close hook, and no cleanup runs while
 * another process holds the lease. Mirrors the shapes already proven by
 * ts/packages/agent/test/runner-lease.test.ts; this script makes the boundary
 * reproducible from the harness directly.
 *
 * The "finalizing host vs concurrent assembly + crash recovery" half of the
 * invariant is S-WFL-05B (probe design, blocked this round) — not claimed here.
 *
 * Exit code 0 means "all boundary checks matched" — for this sample that means
 * the probed lease clauses HOLD.
 */
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeFileLocks, SessionStore } from "../../../../../ts/packages/sessions/src/index.ts";
import { AgentRunner } from "../../../../../ts/packages/agent/src/index.ts";
import type { AgentProvider } from "../../../../../ts/packages/agent/src/index.ts";

const failures: string[] = [];
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${detail}`);
  if (!ok) failures.push(label);
};
async function rejectsBlocking(promise: Promise<unknown>): Promise<void> {
  await promise.then(() => { throw new Error("expected rejection"); }, (error: unknown) => {
    if ((error as { name?: string }).name !== "BlockingIOError") throw new Error(`unexpected rejection: ${String(error)}`);
  });
}

function makeFixture() {
  const directory = mkdtempSync(join(tmpdir(), "xueness-harness-lease-"));
  const store = new SessionStore(join(directory, "state"));
  const session = { id: "c".repeat(32), root: directory, task: "task", status: "pending", steps: 0,
    messages: [{ role: "system", content: "System" }, { role: "user", content: "must not run" }], results: {}, compactions: [], archived_messages: [], completion: null } as never;
  let requests = 0, effects = 0, before = 0, closed = 0;
  const provider: AgentProvider = { runtimeProfile: "standard", toolCalling: "native",
    async complete() { requests += 1; return { content: "should never be reached" }; } };
  const hooks = { enabled: (id: string) => ["providers", "sessions", "files"].includes(id), toolOwner: () => null, tools: () => [],
    extensions: [{ id: "sessions", beforeRun() { before += 1; }, async close(context: { session: Record<string, unknown>; save(): Promise<void> }) { closed += 1; context.session.cleanup_wrote = true; await context.save(); } }] };
  const runner = new AgentRunner({ store, provider, hooks, root: directory,
    toolBridge: { call: async () => { effects += 1; throw new Error("no effects in harness"); }, callAll: async () => [] } } as never);
  return { directory, store, session, runner, other: new NativeFileLocks(),
    counts: () => ({ requests, effects, before, closed }), close: () => rmSync(directory, { recursive: true, force: true }) };
}

// ---- Probe 1: another process publishes a revision while our lease is being acquired.
{
  const local = makeFixture();
  try {
    await local.store.save(local.session);
    const writer = new SessionStore(local.store.directory, { locks: local.other });
    const acquire = local.store.lease.bind(local.store);
    local.store.lease = async (sid: string) => {
      const held = await writer.lease(sid);                    // "other process" grabs the lease first
      try {
        const current = await writer.load(sid);
        (current as Record<string, unknown>).concurrent_writer = "other process";
        (current as { messages: Array<{ role: string; content: string }> }).messages.push({ role: "assistant", content: "Published by the other process" });
        await writer.save(current);
      } finally { await held.release(); }
      const published = readFileSync(local.store.pathFor(sid));
      const ours = await acquire(sid);
      void published;                                          // captured for the byte comparison below
      (local as { published?: Buffer }).published = published;
      return ours;
    };
    await rejectsBlocking(local.runner.run(local.session));
    const counts = local.counts();
    check("P1 stale run rejected with BlockingIOError", true, "rejected");
    check("P2 no model request, no tool effect, no lifecycle hooks", counts.requests === 0 && counts.effects === 0 && counts.before === 0 && counts.closed === 0, JSON.stringify(counts));
    const onDisk = readFileSync(local.store.pathFor(local.session.id as string));
    check("P3 on-disk bytes equal the concurrent publisher's version (stale run did not overwrite)", onDisk.equals((local as { published?: Buffer }).published), `${onDisk.length} bytes`);
    const reloaded = await local.store.load(local.session.id as string);
    check("P4 stored session carries the other writer's marker", (reloaded as Record<string, unknown>).concurrent_writer === "other process", String((reloaded as Record<string, unknown>).concurrent_writer));
    check("P5 runner does not consider the session running", local.runner.isRunning(local.session.id as string) === false, "isRunning");
    const lease = await acquire(local.session.id as string); await lease.release();
    check("P6 lease acquirable again after the rejected run", true, "lease acquired+released");
  } finally { await local.other.close(); local.close(); }
}

// ---- Probe 2: run attempt while another process holds the lease — no cleanup without ownership.
{
  const local = makeFixture();
  try {
    await local.store.save(local.session);
    const snapshot = readFileSync(local.store.pathFor(local.session.id as string));
    const held = await local.other.tryAcquire(local.store.lockDirectory, (local.session.id as string) + ".lock");
    try { await rejectsBlocking(local.runner.run(local.session)); }
    finally { await held.release(); }
    const counts = local.counts();
    check("Q1 run rejected with BlockingIOError while lease held elsewhere", true, "rejected");
    check("Q2 close hook never ran (no cleanup write without owning the lease)", counts.closed === 0 && counts.requests === 0 && counts.effects === 0, JSON.stringify(counts));
    check("Q3 session file unchanged byte-for-byte", readFileSync(local.store.pathFor(local.session.id as string)).equals(snapshot), `${snapshot.length} bytes`);
    check("Q4 runner does not consider the session running", local.runner.isRunning(local.session.id as string) === false, "isRunning");
  } finally { await local.other.close(); local.close(); }
}

console.log("");
console.log("[HARNESS] S-WFL-05A " + (failures.length === 0 ? "all boundary checks matched." : "UNEXPECTED: " + failures.join(", ")));
console.log("[CONTRACT] C-WFL-05 invariant verdict today: pass, limited to the probed clauses (跨进程租约排他 + 无租约不收尾写回). 收尾期竞态与宿主崩溃恢复 = S-WFL-05B（blocked，F03.06）；drain 的 workflows 侧覆盖见 dynamic-runs.test.ts 与 engine-z6.md。");
process.exit(failures.length === 0 ? 0 : 1);
