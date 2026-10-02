import assert from 'node:assert/strict';
import test from 'node:test';
import { startRuntimeSampling } from './runtimeSampling';
import type { RuntimeMetrics } from './LocalRuntimeMonitor';

const metrics = { schema: 'xueness.runtime-metrics.v1' } as RuntimeMetrics;
const flush = () => new Promise(resolve => setImmediate(resolve));

test('collapsing a sampling panel aborts its active HTTP read and ignores a late response', async () => {
  let signal: AbortSignal | undefined;
  let resolve: (value: RuntimeMetrics) => void = () => {};
  const received: unknown[] = [];
  let schedules = 0;
  const stop = startRuntimeSampling({
    read: next => { signal = next; return new Promise(done => { resolve = done; }); },
    onMetrics: value => received.push(value), onError: value => received.push(value), onLoading: () => {},
    schedule: () => { schedules++; return 0 as unknown as ReturnType<typeof setTimeout>; },
  });
  assert.equal(signal?.aborted, false);
  stop();
  assert.equal(signal?.aborted, true);
  resolve(metrics);
  await flush();
  assert.deepEqual(received, []);
  assert.equal(schedules, 0);
});

test('unmount or collapse clears the next sample and even a late timer cannot issue another request', async () => {
  let tick = () => {};
  let reads = 0, cleared = 0;
  const stop = startRuntimeSampling({
    read: async () => { reads++; return metrics; },
    onMetrics: () => {}, onError: () => {}, onLoading: () => {},
    schedule: callback => { tick = callback; return 42 as unknown as ReturnType<typeof setTimeout>; },
    clear: () => { cleared++; },
  });
  await flush();
  assert.equal(reads, 1);
  stop(); tick();
  await flush();
  assert.equal(cleared, 1);
  assert.equal(reads, 1);
});

test('manual refresh while paused makes exactly one sample with no auto timer', async () => {
  let schedules = 0;
  const applied: RuntimeMetrics[] = [];
  const stop = startRuntimeSampling({
    repeat: false, read: async () => metrics, onMetrics: value => applied.push(value), onError: () => {}, onLoading: () => {},
    schedule: () => { schedules++; return 0 as unknown as ReturnType<typeof setTimeout>; },
  });
  await flush(); stop();
  assert.equal(applied.length, 1);
  assert.equal(schedules, 0);
});
