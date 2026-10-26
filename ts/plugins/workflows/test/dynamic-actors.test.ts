/** F10.03: typed actors — validation, attribution, budgeted repair, transcripts, idempotent side effects. */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  ActorRepairError, SideEffectLedger, classifyThrown, createRepairDriver, defineTypedActor,
  memoryTranscriptStore, type ActorAttempt, type DynamicAskRequest, type DynamicAskResult, type DynamicWorkflowDriver,
} from '../src/index.ts';
import { PyValueError } from '@xueness/contracts';

const RUN_ID = 'a'.repeat(32);

/** Attempts are audited by position; indexing is total in every test below. */
function attemptAt(attempts: ActorAttempt[], index: number): ActorAttempt {
  const attempt = attempts[index];
  assert.ok(attempt, `expected attempt ${index}`);
  return attempt;
}

function request(overrides: Partial<DynamicAskRequest> = {}): DynamicAskRequest {
  return {
    run: { id: RUN_ID } as DynamicAskRequest['run'],
    actor: { id: 'act-1', name: 'writer', persona: {}, asks: 0 },
    node: { id: 'n1', siteId: 's1', ordinal: 0, kind: 'ask', inputHash: 'h1', status: 'running' },
    instructions: 'Return {"answer": string}.',
    signal: new AbortController().signal,
    rememberSession: () => {},
    ...overrides,
  } as DynamicAskRequest;
}

/** A base driver scripted per attempt; every call is recorded. */
function scriptedDriver(answers: (DynamicAskResult | Error)[]): { driver: DynamicWorkflowDriver; calls: DynamicAskRequest[] } {
  const calls: DynamicAskRequest[] = [];
  const queue = [...answers];
  return {
    calls,
    driver: {
      ask: async (req) => {
        calls.push(req);
        const next = queue.shift();
        if (next === undefined) throw new Error('scripted driver ran out of answers');
        if (next instanceof Error) throw next;
        return next;
      },
      read: async () => { throw new Error('unused'); },
    },
  };
}

const OUTPUT_SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } as const;

describe('defineTypedActor', () => {
  it('freezes a valid spec with a default repair budget of 0', () => {
    const actor = defineTypedActor({ name: 'writer', output: OUTPUT_SCHEMA });
    assert.equal(actor.name, 'writer');
    assert.equal(actor.repairBudget, 0);
    assert.deepEqual(actor.output, OUTPUT_SCHEMA);
  });

  it('keeps an explicit budget, persona and input schema', () => {
    const actor = defineTypedActor({ name: 'fixer', persona: { model: 'm1' }, input: { type: 'object' }, output: OUTPUT_SCHEMA, repairBudget: 3 });
    assert.equal(actor.repairBudget, 3);
    assert.equal(actor.persona!.model, 'm1');
  });

  it('rejects bad names, missing output schemas and out-of-range budgets', () => {
    assert.throws(() => defineTypedActor({ name: 'has space', output: OUTPUT_SCHEMA }), PyValueError);
    assert.throws(() => defineTypedActor({ name: 'x', output: undefined as never }), PyValueError);
    assert.throws(() => defineTypedActor({ name: 'x', output: OUTPUT_SCHEMA, repairBudget: -1 }), PyValueError);
    assert.throws(() => defineTypedActor({ name: 'x', output: OUTPUT_SCHEMA, repairBudget: 9 }), PyValueError);
    assert.throws(() => defineTypedActor({ name: 'x', output: OUTPUT_SCHEMA, repairBudget: 1.5 }), PyValueError);
  });
});

describe('classifyThrown', () => {
  it('maps aborts, driver contract errors and actor errors', () => {
    assert.equal(classifyThrown(new Error('stop'), true), 'aborted');
    assert.equal(classifyThrown(Object.assign(new Error('stop'), { name: 'AbortError' }), false), 'aborted');
    assert.equal(classifyThrown(new PyValueError('bad request shape'), false), 'driver_error');
    assert.equal(classifyThrown(new Error('provider 500'), false), 'actor_error');
  });
});

describe('createRepairDriver', () => {
  it('passes a valid answer through and transcripts it as valid', async () => {
    const base = scriptedDriver([{ status: 'completed', value: { answer: 'ok' } }]);
    const transcript = memoryTranscriptStore();
    const driver = createRepairDriver(base.driver, { actors: { writer: defineTypedActor({ name: 'writer', output: OUTPUT_SCHEMA }) }, transcript });
    const result = await driver.ask(request());
    assert.deepEqual(result.value, { answer: 'ok' });
    const attempts = transcript.load(RUN_ID, 'n1')!;
    assert.equal(attempts.length, 1);
    assert.equal(attemptAt(attempts, 0).classification, 'valid');
    assert.deepEqual(attemptAt(attempts, 0).output, { answer: 'ok' });
  });

  it('repairs a schema violation within budget: the re-ask names the issues and prior answer', async () => {
    const base = scriptedDriver([
      { status: 'completed', value: { answer: 42 } },
      { status: 'completed', value: { answer: 'fixed' } },
    ]);
    const transcript = memoryTranscriptStore();
    const driver = createRepairDriver(base.driver, { actors: { writer: defineTypedActor({ name: 'writer', output: OUTPUT_SCHEMA, repairBudget: 2 }) }, transcript });
    const result = await driver.ask(request());
    assert.deepEqual(result.value, { answer: 'fixed' });
    assert.equal(base.calls.length, 2);
    assert.equal(base.calls[0]!.instructions, 'Return {"answer": string}.');
    assert.match(base.calls[1]!.instructions, /attempt 1/);
    assert.match(base.calls[1]!.instructions, /answer/);
    assert.match(base.calls[1]!.instructions, /42/);
    const attempts = transcript.load(RUN_ID, 'n1')!;
    assert.deepEqual(attempts.map((entry) => entry.classification), ['schema_violation', 'valid']);
    assert.ok(attemptAt(attempts, 0).issues!.length > 0);
    assert.equal(attemptAt(attempts, 1).repairOf, undefined);
  });

  it('spends the budget and throws an attributable ActorRepairError', async () => {
    const base = scriptedDriver([
      { status: 'completed', value: {} },
      { status: 'completed', value: { answer: 1 } },
    ]);
    const transcript = memoryTranscriptStore();
    const driver = createRepairDriver(base.driver, { actors: { writer: defineTypedActor({ name: 'writer', output: OUTPUT_SCHEMA, repairBudget: 1 }) }, transcript });
    await assert.rejects(driver.ask(request()), (error: unknown) => {
      assert.ok(error instanceof ActorRepairError);
      const failure = error.failure;
      assert.equal(failure.kind, 'budget_exhausted');
      assert.equal(failure.actorId, 'act-1');
      assert.equal(failure.nodeId, 'n1');
      assert.equal(failure.siteId, 's1');
      assert.equal(failure.runId, RUN_ID);
      assert.equal(failure.attempt, 2);
      assert.match(error.message, /act-1/);
      assert.match(error.message, /budget_exhausted/);
      assert.deepEqual(error.attempts.map((entry) => entry.classification), ['schema_violation', 'schema_violation', 'budget_exhausted']);
      return true;
    });
    assert.equal(base.calls.length, 2);
  });

  it('never repairs when the budget is 0: one bad answer fails fast', async () => {
    const base = scriptedDriver([{ status: 'completed', value: { nope: true } }]);
    const driver = createRepairDriver(base.driver, { actors: { writer: defineTypedActor({ name: 'writer', output: OUTPUT_SCHEMA }) } });
    await assert.rejects(driver.ask(request()), (error: unknown) => {
      assert.ok(error instanceof ActorRepairError);
      assert.equal(error.failure.kind, 'budget_exhausted');
      assert.equal(error.failure.attempt, 1);
      return true;
    });
    assert.equal(base.calls.length, 1);
  });

  it('forwards untyped actors to the base driver untouched', async () => {
    const base = scriptedDriver([{ status: 'completed', value: 'anything at all' }]);
    const driver = createRepairDriver(base.driver, { actors: {} });
    const result = await driver.ask(request());
    assert.equal(result.value, 'anything at all');
    assert.equal(base.calls.length, 1);
  });

  it('returns holds instead of validating them, recorded in the transcript', async () => {
    for (const [status, kind] of [['awaiting_user', 'hold_awaiting_user'], ['paused', 'hold_paused']] as const) {
      const base = scriptedDriver([{ status, question: 'which?' } as DynamicAskResult]);
      const transcript = memoryTranscriptStore();
      const driver = createRepairDriver(base.driver, { actors: { writer: defineTypedActor({ name: 'writer', output: OUTPUT_SCHEMA, repairBudget: 2 }) }, transcript });
      const result = await driver.ask(request());
      assert.equal(result.status, status);
      assert.equal(attemptAt(transcript.load(RUN_ID, 'n1')!, 0).classification, kind);
    }
  });

  it('rethrows base failures classified in the transcript, without repair', async () => {
    const base = scriptedDriver([new Error('provider offline')]);
    const transcript = memoryTranscriptStore();
    const driver = createRepairDriver(base.driver, { actors: { writer: defineTypedActor({ name: 'writer', output: OUTPUT_SCHEMA, repairBudget: 2 }) }, transcript });
    await assert.rejects(driver.ask(request()), /provider offline/);
    assert.equal(attemptAt(transcript.load(RUN_ID, 'n1')!, 0).classification, 'actor_error');
    assert.equal(base.calls.length, 1);
  });

  it('does not re-submit a settled ask: the ledger replays the completed value', async () => {
    let submissions = 0;
    const base: DynamicWorkflowDriver = {
      ask: async () => { submissions += 1; return { status: 'completed', value: { answer: 'once' } }; },
      read: async () => { throw new Error('unused'); },
    };
    const ledger = new SideEffectLedger();
    const driver = createRepairDriver(base, { actors: { writer: defineTypedActor({ name: 'writer', output: OUTPUT_SCHEMA }) }, ledger });
    const first = await driver.ask(request());
    const replayed = await driver.ask(request());
    assert.deepEqual(first.value, replayed.value);
    assert.equal(submissions, 1);
    assert.ok(ledger.has(`ask:${RUN_ID}:n1:h1`));
  });

  it('reads delegate to the base driver; a missing read fails closed', async () => {
    const base: DynamicWorkflowDriver = {
      ask: async () => { throw new Error('unused'); },
      read: async () => 'file body',
    };
    const withRead = createRepairDriver(base, {});
    assert.equal(await withRead.read({ id: RUN_ID } as never, 'files.read', [], new AbortController().signal), 'file body');
    const withoutRead = createRepairDriver({ ask: base.ask }, {});
    await assert.rejects(withoutRead.read({ id: RUN_ID } as never, 'files.read', [], new AbortController().signal), PyValueError);
  });
});

describe('SideEffectLedger', () => {
  it('runs an effect once per key and replays its value', async () => {
    const ledger = new SideEffectLedger();
    let ran = 0;
    const value = await ledger.commit('deploy', async () => { ran += 1; return { id: 7 }; });
    assert.deepEqual(value, { id: 7 });
    assert.deepEqual(await ledger.commit('deploy', async () => { ran += 1; return { id: 8 }; }), { id: 7 });
    assert.equal(ran, 1);
    assert.deepEqual(ledger.snapshot(), { deploy: { status: 'completed', value: { id: 7 } } });
  });

  it('records failures and replays them as throws without re-running', async () => {
    const ledger = new SideEffectLedger();
    let ran = 0;
    await assert.rejects(ledger.commit('flaky', async () => { ran += 1; throw new Error('boom'); }), /boom/);
    await assert.rejects(ledger.commit('flaky', async () => { ran += 1; return 1; }), PyValueError);
    assert.equal(ran, 1);
    assert.equal(ledger.snapshot().flaky!.status, 'failed');
    assert.equal(ledger.snapshot().flaky!.error, 'boom');
  });
});
