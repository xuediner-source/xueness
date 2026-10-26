/** C-WFL-04: live dynamic runs paused on a question push one deduped reminder. */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  BlockedReminderTracker, blockedProgressSummary, blockedReminderFor, blockedReminderKey, blockedReminders,
  DEFAULT_IDLE_BOUNDARIES_MS, DynamicWorkflowService, type DynamicWorkflowRun, type Row,
} from '../src/index.ts';

const SID = 'ab'.repeat(16);
const ROOT = process.cwd();
const ID = 'a'.repeat(32);

function run(overrides: Partial<DynamicWorkflowRun> = {}): DynamicWorkflowRun {
  return {
    id: ID, parentSessionId: SID, root: ROOT, name: 'Reminder probe', source: 'workflow main {}', sourceHash: '0'.repeat(64),
    status: 'running', maxConcurrency: 2, writable: false, createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z',
    actors: {}, nodes: {}, events: [], reports: [], allowReal: false, workspaceFingerprint: null,
    ...overrides,
  } as DynamicWorkflowRun;
}

function node(id: string, kind: 'ask' | 'hole', status: DynamicWorkflowRun['nodes'][string]['status'] = 'awaiting_user') {
  return { id, siteId: id, ordinal: 0, kind, inputHash: '', status, question: 'What next?' };
}

function blockedRun(overrides: Partial<DynamicWorkflowRun> = {}): DynamicWorkflowRun {
  return run({ status: 'awaiting_user', nodes: { ask1: node('ask1', 'ask') }, ...overrides });
}

describe('dynamic blocked reminders', () => {
  const base = mkdtempSync(join(tmpdir(), 'xueness-dwf-remind-'));
  after(() => { rmSync(base, { recursive: true, force: true }); });

  it('reminds once per blocked run and node, with a namespaced stable key', () => {
    const blocked = run({ status: 'awaiting_user', nodes: { ask1: node('ask1', 'ask') } });
    const reminder = blockedReminderFor(blocked)!;
    assert.equal(reminder.key, blockedReminderKey(blocked.id, 'ask1'));
    assert.equal(reminder.kind, 'ask');
    assert.match(reminder.message, /paused awaiting an actor question on node ask1/);
    assert.match(reminder.message, /workflow_script_resolve/);

    const hole = run({ id: 'b'.repeat(32), status: 'awaiting_user', nodes: { hole1: node('hole1', 'hole') } });
    assert.equal(blockedReminderFor(hole)!.kind, 'hole');
    assert.match(blockedReminderFor(hole)!.message, /JSON hole/);
  });

  it('never reminds for running, settled or count-only-changing runs', () => {
    assert.equal(blockedReminderFor(run({ status: 'running', nodes: { ask1: node('ask1', 'ask', 'pending') } })), null);
    assert.equal(blockedReminderFor(run({ status: 'running', nodes: { ask1: node('ask1', 'ask') } })), null);
    for (const status of ['completed', 'failed', 'cancelled', 'paused', 'interrupted', 'queued', 'draft'] as const) {
      assert.equal(blockedReminderFor(run({ status, nodes: { ask1: node('ask1', 'ask') } })), null);
    }
    // Event growth alone (a longer audit log) is a count-only change.
    assert.equal(blockedReminderFor(run({ status: 'awaiting_user', nodes: { ask1: node('ask1', 'ask', 'completed') }, events: new Array(50).fill({ seq: 1, type: 'actor_step', at: '2026-10-25T00:00:00Z' }) })), null);
  });

  it('caps and dedups the reminder batch for the session', () => {
    const runs = Array.from({ length: 10 }, (_, index) => run({
      id: index.toString(16).padStart(32, '0'), status: 'awaiting_user', nodes: { n1: node('n1', 'ask') },
    }));
    const reminders = blockedReminders(runs);
    assert.equal(reminders.length, 8);
    assert.equal(new Set(reminders.map((reminder) => reminder.key)).size, 8);
    const quiet = blockedReminders([run(), run({ status: 'awaiting_user' })]);
    assert.deepEqual(quiet, []);
  });

  it('exposes session-scoped reminders through the service', async () => {
    const enabled = () => true;
    const owner = async () => ({ root: ROOT, remote_connection: null }) as unknown as Row;
    const driver = { ask: async () => ({ status: 'awaiting_user' as const }), read: async () => null };
    const service = new DynamicWorkflowService({ stateDir: base, enabled, owner, allowRealHost: () => false, driver });
    const source = 'const actor = agent("writer");\nconst answer = await actor.ask("write");\nreport(answer);\nreturn answer;';
    const created = await service.create(SID, source, { name: 'Service probe' });
    service.store.update(created.id, (value) => { value.status = 'awaiting_user'; value.nodes = { q1: { ...node('q1', 'hole') } as never }; });
    const reminders = await service.blockedReminders(SID);
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0]!.runId, created.id);
    assert.equal(reminders[0]!.nodeId, 'q1');
    assert.match(reminders[0]!.message, /JSON hole/);
  });
});

describe('blocked reminder scheduler (F10.07)', () => {
  const T0 = 1_800_000_000_000; // fixed epoch base
  const [B1, B2, B3] = DEFAULT_IDLE_BOUNDARIES_MS as [number, number, number];

  it('stays silent before the first idle boundary, then reminds once per boundary stage', () => {
    const tracker = new BlockedReminderTracker();
    const blocked = blockedRun();
    assert.deepEqual(tracker.poll([blocked], T0), []);

    const first = tracker.poll([blocked], T0 + B1);
    assert.equal(first.length, 1);
    assert.equal(first[0]!.stage, 0);
    assert.equal(first[0]!.hidden, true);
    assert.equal(first[0]!.key, `${blockedReminderKey(blocked.id, 'ask1')}:stage0`);

    // Re-polls inside the same stage and far beyond it never repeat stage 0.
    assert.deepEqual(tracker.poll([blocked], T0 + B1 + 1_000), []);
    const second = tracker.poll([blocked], T0 + B2);
    assert.equal(second.length, 1);
    assert.equal(second[0]!.stage, 1);
    assert.deepEqual(tracker.poll([blocked], T0 + B3 - 1), []);
    const third = tracker.poll([blocked], T0 + B3 + 1);
    assert.equal(third.length, 1);
    assert.equal(third[0]!.stage, 2);
    // Past the last boundary, no further stages exist.
    assert.deepEqual(tracker.poll([blocked], T0 + B3 * 10), []);
  });

  it('re-arms the ladder after user steering or run progress, not after silent polls', () => {
    const tracker = new BlockedReminderTracker();
    const blocked = blockedRun();
    tracker.poll([blocked], T0 + B1); // stage 0 delivered

    tracker.noteSessionActivity(T0 + B1 + 5_000); // steering
    assert.deepEqual(tracker.poll([blocked], T0 + B1 + 6_000), []);
    const rearmed = tracker.poll([blocked], T0 + B1 + 5_000 + B1);
    assert.equal(rearmed.length, 1);
    assert.equal(rearmed[0]!.stage, 0);

    tracker.noteRunProgress(blocked.id, T0 + 2 * B1); // progress on the same run
    const progressed = tracker.poll([blocked], T0 + 2 * B1 + B1);
    assert.equal(progressed.length, 1);
    assert.equal(progressed[0]!.stage, 0);

    // Progress on an unrelated run re-arms nothing here.
    const other = new BlockedReminderTracker();
    other.poll([blocked], T0 + B1);
    other.noteRunProgress('f'.repeat(32), T0 + B1 + 1);
    assert.deepEqual(other.poll([blocked], T0 + B1 + 2), []);
  });

  it('does not duplicate reminders across compaction and resume', () => {
    const tracker = new BlockedReminderTracker();
    const blocked = blockedRun();
    tracker.noteSessionActivity(T0);
    tracker.poll([blocked], T0);
    const before = tracker.poll([blocked], T0 + B2);
    assert.equal(before.length, 1);

    // Compaction/resume round-trip: restored state replays, never repeats.
    const restored = BlockedReminderTracker.fromJSON(JSON.parse(JSON.stringify(tracker.toJSON())));
    assert.deepEqual(restored.poll([blocked], T0 + B2 + 60_000), []);
    assert.deepEqual(restored.poll([blocked], T0 + B3 + 60_000).map((reminder) => reminder.stage), [2]);

    const legacy = new BlockedReminderTracker();
    legacy.poll([blockedRun()], T0);
    legacy.poll([blockedRun()], T0 + B1);
    const reloaded = BlockedReminderTracker.fromJSON(legacy.toJSON());
    assert.deepEqual(reloaded.poll([blockedRun()], T0 + B1 + 30_000), []);

    // Malformed snapshots start fresh rather than guessing.
    for (const bad of [null, 7, {}, { version: 2 }, { version: 1, sessionLastActiveAt: 'x', entries: {} }]) {
      const fresh = BlockedReminderTracker.fromJSON(bad);
      fresh.poll([blocked], T0);
      assert.deepEqual(fresh.poll([blocked], T0 + B1).map((reminder) => reminder.stage), [0]);
    }
  });

  it('drops ledger entries once a node settles and re-registers on the next block', () => {
    const tracker = new BlockedReminderTracker();
    const blocked = blockedRun();
    tracker.poll([blocked], T0 + B1);
    const resumed = run({ nodes: { ask1: node('ask1', 'ask', 'completed') } });
    assert.deepEqual(tracker.poll([resumed], T0 + B1 + 1), []);
    assert.deepEqual(tracker.toJSON().entries, {});

    const reblocked = blockedRun();
    tracker.poll([reblocked], T0 + B1 + 2);
    const again = tracker.poll([reblocked], T0 + B1 + 2 + B1);
    assert.equal(again.length, 1);
    assert.equal(again[0]!.stage, 0);
  });

  it('respects the batch limit and custom boundaries', () => {
    const many = Array.from({ length: 12 }, (_, index) => blockedRun({
      id: (index + 16).toString(16).padStart(32, '0'), nodes: { n1: node('n1', 'hole') },
    }));
    const capped = new BlockedReminderTracker();
    capped.poll(many, T0);
    assert.equal(capped.poll(many, T0 + B1).length, 8);

    const quick = new BlockedReminderTracker({ boundaries: [1_000], limit: 2 });
    quick.poll(many, T0);
    const due = quick.poll(many, T0 + 5_000);
    assert.equal(due.length, 2);
    // The capped nodes were not stamped as delivered: repeated polls drain the
    // backlog at the batch limit instead of silencing them forever.
    const drained = many.length - 2;
    const rest: number[] = [];
    for (let poll = 0; poll < drained / 2; poll += 1) rest.push(quick.poll(many, T0 + 60_000).length);
    assert.deepEqual(rest, [2, 2, 2, 2, 2]);
    assert.deepEqual(quick.poll(many, T0 + 90_000), []);
  });

  it('summarizes blocked progress with settled-node counts and idle age', () => {
    assert.equal(blockedProgressSummary([run()]), '');
    const blocked = blockedRun({
      nodes: { done: node('done', 'ask', 'completed'), ask1: node('ask1', 'ask') },
      updatedAt: new Date(T0 - 5 * 60_000).toISOString(),
    });
    const summary = blockedProgressSummary([run(), blocked], T0);
    assert.match(summary, /^1 dynamic workflow is blocked awaiting you:$/m);
    assert.match(summary, /- Reminder probe \(run a{32}\) paused on actor question ask1 for 5m/);
    assert.match(summary, /1\/2 nodes settled/);
    const two = blockedProgressSummary([blocked, blockedRun({ id: 'c'.repeat(32), name: 'Second' })], T0);
    assert.match(two, /^2 dynamic workflows are blocked awaiting you:$/m);
  });
});
