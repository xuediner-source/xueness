/** F10.04: world.run and world reads — nesting, ownership, input-versioned cache, shared context. */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { inputFingerprint, WorkflowWorld, type WorldRunRecord } from '../src/index.ts';

/** Records are audited by position; indexing is total in every test below. */
function recordAt(world: WorkflowWorld, index: number): WorldRunRecord {
  const record = world.records()[index];
  assert.ok(record, `expected record ${index}`);
  return record;
}

describe('WorkflowWorld.register', () => {
  it('rejects blank names and non-function executors', () => {
    const world = new WorkflowWorld();
    assert.throws(() => world.register('  ', { executor: async () => 1 }), /non-empty/);
    assert.throws(() => world.register('wf', { executor: 'nope' as never }), /executor/);
  });

  it('refuses to run an unregistered workflow', async () => {
    await assert.rejects(new WorkflowWorld().run('ghost', {}), /'ghost' is not registered/);
  });
});

describe('world.run basics', () => {
  it('executes the workflow, records the run and returns the result', async () => {
    const world = new WorkflowWorld();
    world.register('double', { executor: async (args: unknown) => (args as { n: number }).n * 2 });
    const result = await world.run('double', { n: 21 });
    assert.equal(result, 42);
    const record = recordAt(world, 0);
    assert.equal(record.name, 'double');
    assert.equal(record.status, 'completed');
    assert.equal(record.parentRunId, null);
    assert.equal(record.rootRunId, record.runId);
    assert.equal(record.cached, false);
    assert.equal(record.result, 42);
    assert.ok(record.finishedAt);
    assert.equal(record.inputFingerprint, inputFingerprint('double', { n: 21 }));
  });

  it('marks a throwing executor as failed with the error message', async () => {
    const world = new WorkflowWorld();
    world.register('boom', { executor: async () => { throw new Error('kaput'); } });
    await assert.rejects(world.run('boom', {}), /kaput/);
    const record = recordAt(world, 0);
    assert.equal(record.status, 'failed');
    assert.equal(record.error, 'kaput');
  });
});

describe('nested runs and ownership', () => {
  it('attributes child runs to their parent, root and owning actor', async () => {
    const world = new WorkflowWorld();
    let childCtx: { runId: string; parentRunId: string | null; rootRunId: string; ownerActorId?: string } | undefined;
    world.register('leaf', { executor: async (_args: unknown, ctx) => { childCtx = { runId: ctx.runId, parentRunId: ctx.parentRunId, rootRunId: ctx.rootRunId, ownerActorId: ctx.ownerActorId }; return 'leaf'; } });
    world.register('root', { executor: async (_args: unknown, ctx) => ctx.run('leaf', {}, { actorId: 'act-7' }) });
    assert.equal(await world.run('root', {}), 'leaf');
    const rootRecord = recordAt(world, 0);
    const childRecord = recordAt(world, 1);
    assert.equal(childRecord.parentRunId, rootRecord.runId);
    assert.equal(childRecord.rootRunId, rootRecord.runId);
    assert.equal(childRecord.ownerActorId, 'act-7');
    assert.equal(childCtx!.parentRunId, rootRecord.runId);
    assert.equal(childCtx!.ownerActorId, 'act-7');
    assert.deepEqual(world.children(rootRecord.runId).map((child) => child.runId), [childRecord.runId]);
    assert.deepEqual(world.children(childRecord.runId), []);
    assert.equal(rootRecord.usage.subruns, 1);
  });

  it('supports data dependencies: a parent feeds child results onward', async () => {
    const world = new WorkflowWorld();
    world.register('inc', { executor: async (n: unknown) => (n as number) + 1 });
    world.register('chain', {
      executor: async (start: unknown, ctx) => {
        const first = await ctx.run('inc', start) as number;
        const second = await ctx.run('inc', first) as number;
        return second * 10;
      },
    });
    assert.equal(await world.run('chain', 5), 70);
    assert.equal(world.records().length, 3);
  });

  it('guards nesting depth', async () => {
    const world = new WorkflowWorld({ maxDepth: 1 });
    world.register('recurse', { executor: async (n: unknown, ctx) => ctx.run('recurse', (n as number) + 1) });
    await assert.rejects(world.run('recurse', 0), /maxDepth 1/);
  });
});

describe('input-versioned cache', () => {
  it('replays identical inputs without re-executing; new inputs miss and re-execute', async () => {
    let executions = 0;
    const world = new WorkflowWorld();
    world.register('sum', { executor: async (args: unknown) => { executions += 1; const { a, b } = args as { a: number; b: number }; return a + b; } });
    assert.equal(await world.run('sum', { a: 1, b: 2 }), 3);
    assert.equal(await world.run('sum', { a: 1, b: 2 }), 3);
    assert.equal(executions, 1);
    const first = recordAt(world, 0), second = recordAt(world, 1);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(second.usage.cacheHits, 1);
    assert.equal(first.usage.cacheMisses, 1);
    assert.equal(await world.run('sum', { a: 2, b: 2 }), 4);
    assert.equal(executions, 2);
  });

  it('distinguishes key order: the fingerprint follows the input version, not object identity', async () => {
    let executions = 0;
    const world = new WorkflowWorld();
    world.register('id', { executor: async (args: unknown) => { executions += 1; return args; } });
    await world.run('id', { a: 1, b: 2 });
    await world.run('id', { b: 2, a: 1 });
    assert.equal(executions, 1);
    assert.equal(recordAt(world, 1).cached, true);
    assert.equal(inputFingerprint('id', { a: 1 }), inputFingerprint('id', { a: 1 }));
    assert.notEqual(inputFingerprint('id', { a: 1 }), inputFingerprint('id', { a: 2 }));
    assert.notEqual(inputFingerprint('a', { x: 1 }), inputFingerprint('b', { x: 1 }));
  });

  it('honors cache:false specs and a zero cacheLimit', async () => {
    // Two independent ways to disable caching: per-spec `cache: false`, and a global `cacheLimit: 0`.
    for (const [worldOptions, specCache] of [[{}, false], [{ cacheLimit: 0 }, true]] as const) {
      let executions = 0;
      const world = new WorkflowWorld(worldOptions);
      world.register('fresh', { cache: specCache, executor: async () => { executions += 1; return 'v'; } });
      await world.run('fresh', {});
      await world.run('fresh', {});
      assert.equal(executions, 2);
      assert.equal(recordAt(world, 1).cached, false);
    }
  });

  it('evicts the oldest entry beyond cacheLimit, so the same input re-executes', async () => {
    const world = new WorkflowWorld({ cacheLimit: 1 });
    world.register('echo', { executor: async (v: unknown) => v });
    assert.equal(await world.run('echo', 'one'), 'one');
    assert.equal(await world.run('echo', 'two'), 'two');
    // 'one' was evicted by 'two'; the repeated 'two' is the one entry still cached.
    assert.equal(await world.run('echo', 'two'), 'two');
    const records = world.records();
    assert.equal(records.filter((entry) => entry.cached).length, 1);
    assert.equal(records.filter((entry) => !entry.cached).length, 2);
    assert.equal(recordAt(world, 2).cached, true);
  });
});

describe('world reads', () => {
  it('delegates to the backing reader and logs an attributed entry', async () => {
    const world = new WorkflowWorld({ read: async (key) => `body of ${key}` });
    let seen: unknown;
    world.register('reader', { cache: false, executor: async (_args: unknown, ctx) => { seen = await ctx.read('docs/a.md'); return ctx.read('docs/b.md'); } });
    await world.run('reader', {}, { actorId: 'act-r' });
    assert.equal(seen, 'body of docs/a.md');
    const record = recordAt(world, 0);
    assert.equal(record.usage.reads, 2);
    const log = world.readLog();
    assert.equal(log.length, 2);
    assert.deepEqual(log.map((entry) => entry.key), ['docs/a.md', 'docs/b.md']);
    for (const entry of log) {
      assert.equal(entry.runId, record.runId);
      assert.equal(entry.rootRunId, record.runId);
      assert.equal(entry.actorId, 'act-r');
    }
  });

  it('fails closed when no read function is configured', async () => {
    const world = new WorkflowWorld();
    world.register('reader', { executor: async (_args: unknown, ctx) => ctx.read('secret') });
    await assert.rejects(world.run('reader', {}), /no read function/);
  });
});

describe('cross-actor context', () => {
  it('shares values within one root run and isolates them across roots', async () => {
    const world = new WorkflowWorld();
    world.register('worker', { cache: false, executor: async (role: unknown, ctx) => {
      if (role === 'sharer') { ctx.share('plan', 'plan-v1'); return null; }
      return ctx.shared('plan') ?? 'nothing shared';
    } });
    // One root run: the sharer publishes, the reader inside the same root sees it.
    world.register('orchestrate', { cache: false, executor: async (_args: unknown, ctx) => {
      await ctx.run('worker', 'sharer');
      return ctx.run('worker', 'reader');
    } });
    assert.equal(await world.run('orchestrate', {}), 'plan-v1');
    // A separate root run that only reads must not inherit the earlier root's shared scope.
    world.register('read-only', { cache: false, executor: async (_args: unknown, ctx) => ctx.run('worker', 'reader') });
    assert.equal(await world.run('read-only', {}), 'nothing shared');
    const isolated = new WorkflowWorld();
    isolated.register('worker', { cache: false, executor: async (_args: unknown, ctx) => ctx.shared('plan') ?? 'nothing shared' });
    isolated.register('orchestrate', { cache: false, executor: async (_args: unknown, ctx) => ctx.run('worker', 'reader') });
    assert.equal(await isolated.run('orchestrate', {}), 'nothing shared');
  });
});
