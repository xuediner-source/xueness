/** F11.04: canonical command replay over durable receipts. */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { outcomeUnknown, replayCommand, settledReceipt } from '../src/command-replay.ts';
import { TransportError } from '../src/client.ts';

const commandId = 'c_20260101000000_' + 'a'.repeat(32);
const accepted = { commandId, status: 'accepted', result: { turnId: 't1' } };

function clockFixture(): { nowMs(): number; sleep(ms: number): Promise<void> } {
  let at = 0;
  return { nowMs: () => at, sleep: async (ms) => { at += ms; } };
}

it('settledReceipt reads both the acknowledgement and its receipt envelope', () => {
  assert.deepEqual(settledReceipt(accepted), accepted);
  assert.deepEqual(settledReceipt({ result: accepted }), accepted);
  assert.equal(settledReceipt({ result: 'unknown' }), null);
  assert.equal(settledReceipt({ status: 'pending' }), null);
  assert.equal(settledReceipt(null), null);
});

it('outcomeUnknown separates replayable transport loss from definitive refusals', () => {
  assert.equal(outcomeUnknown(new TransportError('request timed out; outcome may be unknown')), true);
  assert.equal(outcomeUnknown(new TransportError('remote connection unavailable')), true);
  const refused = Object.assign(new Error('remote request refused'), { error: { code: -32602, data: { reasonCode: 'invalid_input' } } });
  assert.equal(outcomeUnknown(refused), false);
  const unsettled = Object.assign(new Error('remote request refused'), { error: { code: -32000, data: { reasonCode: 'command_unknown' } } });
  assert.equal(outcomeUnknown(unsettled), true);
  assert.equal(outcomeUnknown(new Error('command_unknown: query without resubmitting')), true);
});

it('returns the committed acknowledgement without probing when execute settles', async () => {
  const clock = clockFixture();
  let sends = 0, queries = 0;
  const outcome = await replayCommand({
    commandId, ...clock,
    execute: async () => { sends += 1; return accepted; },
    query: async () => { queries += 1; return { result: 'unknown' }; },
  });
  assert.equal(outcome.disposition, 'committed');
  assert.deepEqual(outcome.ack, accepted);
  assert.equal(sends, 1);
  assert.equal(queries, 0);
});

it('a timeout returns the same committed receipt after probing, without resending', async () => {
  const clock = clockFixture();
  let sends = 0;
  const outcome = await replayCommand({
    commandId, ...clock,
    execute: async () => { sends += 1; throw new TransportError('request timed out; outcome may be unknown'); },
    query: async () => ({ result: accepted }),
  });
  assert.equal(outcome.disposition, 'committed');
  assert.deepEqual(outcome.ack, accepted);
  assert.equal(sends, 1, 'the settled receipt must answer the resend instead of a second execution');
});

it('an unsettled receipt is resent under the same commandId and yields the duplicate ack', async () => {
  const clock = clockFixture();
  const sendIds: string[] = [];
  let sends = 0;
  const outcome = await replayCommand({
    commandId, ...clock, pollMs: 10,
    execute: async () => {
      sends += 1; sendIds.push(commandId);
      if (sends === 1) throw new TransportError('connection superseded; outcome may be unknown');
      return { commandId, status: 'duplicate', originalStatus: 'accepted', result: { turnId: 't1' } };
    },
    query: async () => ({ result: 'unknown' }),
  });
  assert.equal(outcome.disposition, 'committed');
  assert.equal(outcome.ack.status, 'duplicate');
  assert.equal((outcome.ack as { originalStatus?: string }).originalStatus, 'accepted');
  assert.deepEqual(sendIds, [commandId, commandId], 'the resend must reuse the identical commandId');
  assert.ok(sends === 2);
});

it('a settled failed receipt is a committed failure, not an unknown outcome', async () => {
  const clock = clockFixture();
  let sends = 0, queries = 0;
  const outcome = await replayCommand({
    commandId, ...clock,
    execute: async () => { sends += 1; return { commandId, status: 'failed', reasonCode: 'write_failed' }; },
    query: async () => { queries += 1; return { result: 'unknown' }; },
  });
  assert.equal(outcome.disposition, 'committed');
  assert.equal(outcome.ack.status, 'failed');
  assert.equal(sends, 1);
  assert.equal(queries, 0);
});

it('an outcome that never settles is reported unknown before the deadline, distinct from failed', async () => {
  const clock = clockFixture();
  const outcome = await replayCommand({
    commandId, ...clock, deadlineSeconds: 0.05, pollMs: 10,
    execute: async () => { throw new TransportError('request timed out; outcome may be unknown'); },
    query: async () => ({ result: 'unknown' }),
  });
  assert.equal(outcome.disposition, 'unknown');
  assert.notEqual(outcome.disposition === 'unknown' ? outcome.reason : '', '');
});

it('definitive protocol refusals propagate instead of replaying', async () => {
  const clock = clockFixture();
  const refused = Object.assign(new Error('remote request refused'), { error: { code: -32602, data: { reasonCode: 'command_id_conflict' } } });
  await assert.rejects(replayCommand({
    commandId, ...clock,
    execute: async () => { throw refused; },
    query: async () => ({ result: 'unknown' }),
  }), (error: unknown) => error === refused);
});
