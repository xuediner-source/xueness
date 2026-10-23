import test from 'node:test';
import assert from 'node:assert/strict';
import { startPaneResize } from './paneResize';

function scheduler() {
  let id = 0;
  const pending = new Map<number, () => void>();
  const scheduled: (() => void)[] = [];
  const cancelled: number[] = [];
  return {
    scheduled, cancelled,
    scheduleFrame(callback: () => void) {
      scheduled.push(callback);
      pending.set(++id, callback);
      return id;
    },
    cancelFrame(handle: number) { cancelled.push(handle); pending.delete(handle); },
    get pending() { return pending.size; },
    run() {
      const first = pending.entries().next().value;
      assert.ok(first, 'a frame must be queued');
      pending.delete(first[0]);
      first[1]();
    },
  };
}

function drag(options: { ratio?: number; startClient?: number; extent?: number; isEnabled?: () => boolean } = {}) {
  const frames = scheduler();
  const previews: number[] = [];
  const commits: number[] = [];
  const resize = startPaneResize({ ratio: 0.5, startClient: 100, extent: 400,
    ...options, preview: value => previews.push(value), commit: value => commits.push(value),
    scheduleFrame: frames.scheduleFrame, cancelFrame: frames.cancelFrame });
  return { resize, frames, previews, commits };
}

test('moves combine per frame and preview without committing layout', () => {
  const { resize, frames, previews, commits } = drag();
  resize.move(120);
  resize.move(140);
  resize.move(160);
  assert.equal(frames.pending, 1);
  assert.equal(frames.scheduled.length, 1);
  assert.deepEqual(previews, []);
  assert.deepEqual(commits, []);
  frames.run();
  assert.deepEqual(previews, [0.65]);
  assert.deepEqual(commits, []);
  resize.move(180);
  frames.run();
  assert.deepEqual(previews, [0.65, 0.7]);
  assert.deepEqual(commits, []);
});

test('finish uses its final coordinate, cancels the pending frame and commits exactly once', () => {
  const { resize, frames, previews, commits } = drag();
  resize.move(120);
  resize.finish(180);
  assert.equal(frames.pending, 0);
  assert.deepEqual(frames.cancelled, [1]);
  assert.deepEqual(previews, [0.7]);
  assert.deepEqual(commits, [0.7]);
  frames.scheduled[0]();
  resize.finish(140);
  resize.move(160);
  resize.cancel();
  assert.deepEqual(previews, [0.7], 'late callbacks and repeated events cannot change completed layout');
  assert.deepEqual(commits, [0.7]);
  const withoutMove = drag();
  withoutMove.resize.finish(60);
  assert.deepEqual(withoutMove.commits, [0.4], 'pointerup needs no preceding move event');
});

test('drag ratios normalize the start and stay within both pane bounds', () => {
  const lower = drag({ ratio: -2 });
  lower.resize.move(-1000);
  lower.frames.run();
  lower.resize.finish(-1000);
  assert.deepEqual(lower.previews, [0.25, 0.25]);
  assert.deepEqual(lower.commits, [0.25]);
  const upper = drag({ ratio: 9 });
  upper.resize.finish(1000);
  assert.deepEqual(upper.commits, [0.75]);
  for (const ratio of [NaN, Infinity, -Infinity]) {
    const invalid = drag({ ratio });
    invalid.resize.finish(100);
    assert.deepEqual(invalid.commits, [0.5]);
  }
});

test('pointer cancellation or lost capture restores the committed ratio without a write', () => {
  for (const painted of [false, true]) {
    const { resize, frames, previews, commits } = drag({ ratio: 0.6 });
    resize.move(140);
    if (painted) frames.run();
    resize.cancel();
    assert.equal(frames.pending, 0);
    assert.deepEqual(previews, painted ? [0.7, 0.6] : [0.6]);
    assert.deepEqual(commits, []);
    frames.scheduled[0]();
    resize.finish(180);
    resize.cancel();
    assert.deepEqual(previews, painted ? [0.7, 0.6] : [0.6]);
    assert.deepEqual(commits, []);
  }
});

test('lifecycle cancellation clears queued work without touching an unmounted pane', () => {
  const { resize, frames, previews, commits } = drag();
  resize.move(160);
  resize.cancel(false);
  assert.equal(frames.pending, 0);
  assert.deepEqual(frames.cancelled, [1]);
  frames.scheduled[0]();
  resize.finish(200);
  resize.move(180);
  assert.deepEqual(previews, []);
  assert.deepEqual(commits, []);
});

test('feature disable before movement, scheduled preview or finish stops all new effects', () => {
  for (const stage of ['move', 'frame', 'finish'] as const) {
    let enabled = true;
    const { resize, frames, previews, commits } = drag({ isEnabled: () => enabled });
    resize.move(160);
    enabled = false;
    if (stage === 'move') resize.move(180);
    else if (stage === 'frame') frames.run();
    else resize.finish(180);
    frames.scheduled[0]();
    enabled = true;
    resize.finish(180);
    resize.move(140);
    assert.equal(frames.pending, 0);
    assert.deepEqual(previews, []);
    assert.deepEqual(commits, []);
  }
});

test('invalid geometry is inert, nonfinite moves are ignored and invalid finish cannot commit', () => {
  for (const options of [{ extent: 0 }, { extent: -1 }, { extent: NaN }, { extent: Infinity },
    { startClient: NaN }, { startClient: Infinity }]) {
    const { resize, frames, previews, commits } = drag(options);
    resize.move(160);
    resize.finish(180);
    resize.cancel();
    assert.equal(frames.scheduled.length, 0);
    assert.deepEqual(previews, []);
    assert.deepEqual(commits, []);
  }
  for (const coordinate of [NaN, Infinity, -Infinity]) {
    const { resize, frames, previews, commits } = drag();
    resize.move(coordinate);
    assert.equal(frames.pending, 0);
    resize.move(140);
    resize.move(coordinate);
    frames.run();
    assert.deepEqual(previews, [0.6]);
    resize.finish(coordinate);
    assert.deepEqual(previews, [0.6, 0.5]);
    assert.deepEqual(commits, []);
  }
});
