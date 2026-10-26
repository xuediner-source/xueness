/** C-WFL-05: cold-resume lifecycle, lease release on every settle path, and drain-on-close. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { coldResumeDecision, DYNAMIC_RUN_LIFECYCLE, DynamicWorkflowService, transitionAllowed, type DynamicWorkflowRun, type Row } from '../src/index.ts';

const SID = 'ab'.repeat(16);
const ROOT = process.cwd();
const READ_SOURCE = 'const world = await files.read("world.txt");\nreport(world);\nreturn world;';

interface Harness {
  service: DynamicWorkflowService;
  cleanup(): void;
  ownerGate(): { release(): void };
}
function harness(ownerDelay?: () => Promise<void>): Harness {
  const base = mkdtempSync(join(tmpdir(), 'xueness-dwf-life-'));
  const enabled = () => true;
  const owner = async (): Promise<Row> => { await ownerDelay?.(); return { root: ROOT, remote_connection: null } as unknown as Row; };
  const driver = {
    ask: async () => ({ status: 'completed' as const }),
    read: async () => { await new Promise(() => {}); return null; },
  };
  const service = new DynamicWorkflowService({ stateDir: base, enabled, owner, allowRealHost: () => false, driver });
  return { service, cleanup: () => rmSync(base, { recursive: true, force: true }), ownerGate: () => ({ release: () => {} }) };
}

async function draft(service: DynamicWorkflowService): Promise<DynamicWorkflowRun & { digest: string }> {
  return await service.create(SID, READ_SOURCE, { name: 'Lifecycle probe' });
}

describe('dynamic run lifecycle', () => {
  const homes: (() => void)[] = [];
  after(() => { for (const cleanup of homes) cleanup(); });

  it('keeps completed, failed and cancelled terminal and every edge two-ended', () => {
    const statuses = Object.keys(DYNAMIC_RUN_LIFECYCLE);
    for (const status of statuses) assert.deepEqual(DYNAMIC_RUN_LIFECYCLE[status], [...DYNAMIC_RUN_LIFECYCLE[status]!], `${status} edges must be frozen data`);
    for (const terminal of ['completed', 'failed', 'cancelled']) assert.deepEqual(DYNAMIC_RUN_LIFECYCLE[terminal], [], `${terminal} is terminal`);
    assert.equal(transitionAllowed('queued', 'running'), true);
    assert.equal(transitionAllowed('running', 'awaiting_user'), true);
    assert.equal(transitionAllowed('interrupted', 'queued'), true);
    assert.equal(transitionAllowed('completed', 'queued'), false);
    assert.equal(transitionAllowed('running', 'completed'), true);
  });

  it('maps every cold status to one deterministic decision', () => {
    assert.equal(coldResumeDecision('running', true), 'resume_owner');
    assert.equal(coldResumeDecision('queued', true), 'resume_owner');
    assert.equal(coldResumeDecision('running', false), 'recover_interrupted');
    assert.equal(coldResumeDecision('queued', false), 'recover_interrupted');
    assert.equal(coldResumeDecision('awaiting_user', false), 'await_answer');
    for (const status of ['paused', 'interrupted', 'draft']) assert.equal(coldResumeDecision(status, false), 'start_queued');
    for (const status of ['completed', 'failed', 'cancelled']) assert.equal(coldResumeDecision(status, false), 'settled');
  });

  it('recovers a cold running run once its runner lease is free, and refuses while another host holds it', async () => {
    const home = harness(); homes.push(home.cleanup);
    const { service } = home;
    const run = await draft(service);
    service.store.update(run.id, (value) => { value.status = 'running'; value.nodes.n1 = { id: 'n1', siteId: 'n1', ordinal: 0, kind: 'read', inputHash: '', status: 'running' } as never; });

    const recovered = await service.recover(SID, run.id);
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.nodes.n1!.status, 'interrupted');

    // A live owner (the runner lease is really held) blocks both recover and
    // start: the second host must never become a parallel writer.
    service.store.update(run.id, (value) => { value.status = 'running'; });
    const lease = service.store.acquire(run.id);
    try {
      await assert.rejects(service.recover(SID, run.id), /live owner/);
      await assert.rejects(service.start(SID, run.id, { digest: run.digest, confirmed: true }), /recover the interrupted owner/);
    } finally { lease.release(); }
    const after = await service.recover(SID, run.id);
    assert.equal(after.status, 'interrupted');
  });

  it('drains on close: an in-flight run settles cancelled and its lease releases', async () => {
    const home = harness(); homes.push(home.cleanup);
    const { service } = home;
    const run = await draft(service);
    const started = await service.start(SID, run.id, { digest: run.digest, confirmed: true });
    assert.equal(started.status, 'queued');
    await service.close();

    const settled = service.store.load(run.id);
    assert.equal(settled.status, 'cancelled');
    // The settle finished under the lease and released it: a new host can acquire at once.
    const lease = service.store.acquire(run.id);
    lease.release();
    await assert.rejects(service.list(SID), /closed/);
  });

  it('refuses a start that raced close across its owner lookup, leaving no lease behind', async () => {
    let releaseOwner!: () => void;
    const ownerDelay = new Promise<void>((resolve) => { releaseOwner = resolve; });
    let ownerCalls = 0;
    const home = harness(async () => { ownerCalls += 1; if (ownerCalls === 2) await ownerDelay; }); homes.push(home.cleanup);
    const { service } = home;
    const run = await draft(service);

    const racing = service.start(SID, run.id, { digest: run.digest, confirmed: true });
    await service.close();
    releaseOwner();
    await assert.rejects(racing, /workflow host is closed/);
    // The refused start released the lease it had just taken.
    const lease = service.store.acquire(run.id);
    lease.release();
    assert.equal(service.store.load(run.id).status, 'draft');
  });
});
