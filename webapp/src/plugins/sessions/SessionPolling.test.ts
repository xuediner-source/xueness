import test from "node:test";
import assert from "node:assert/strict";
import { createSingleFlightRefresh, startSessionPolling } from "./SessionPolling";

type TimerTask = { id: number; delay: number; callback: () => void };
function fakeScheduler() {
  let nextId = 1;
  const tasks = new Map<number, TimerTask>();
  return {
    setTimeout(callback: () => void, delay: number): number {
      const id = nextId++;
      tasks.set(id, { id, delay, callback });
      return id;
    },
    clearTimeout(handle: unknown): void { tasks.delete(handle as number); },
    get delays(): number[] { return [...tasks.values()].map(task => task.delay); },
    runNext(): void {
      const task = [...tasks.values()].sort((left, right) => left.delay - right.delay || left.id - right.id)[0];
      if (!task) throw new Error("no scheduled timer");
      tasks.delete(task.id);
      task.callback();
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("session polling waits for each request before scheduling the next one", async () => {
  const clock = fakeScheduler();
  let calls = 0;
  const current = deferred();
  const stop = startSessionPolling({ refresh: () => { calls += 1; return current.promise; }, schedule: clock, subscribeVisibility: () => () => undefined });
  assert.deepEqual(clock.delays, [1000]);
  clock.runNext();
  assert.equal(calls, 1);
  assert.deepEqual(clock.delays, [], "no second poll runs while a refresh is in flight");
  current.resolve();
  await flush();
  assert.deepEqual(clock.delays, [1000]);
  stop();
  assert.deepEqual(clock.delays, []);
});

test("hidden tabs poll every five seconds and returning to a visible tab refreshes promptly", async () => {
  const clock = fakeScheduler();
  let visible = false;
  let changed: () => void = () => undefined;
  let calls = 0;
  const current = deferred();
  const stop = startSessionPolling({
    refresh: () => { calls += 1; return current.promise; },
    isVisible: () => visible,
    subscribeVisibility: listener => { changed = listener; return () => { changed = () => undefined; }; },
    schedule: clock,
  });
  assert.deepEqual(clock.delays, [5000]);
  visible = true;
  changed();
  assert.deepEqual(clock.delays, [0]);
  clock.runNext();
  assert.equal(calls, 1);
  visible = false;
  changed();
  visible = true;
  changed();
  current.resolve();
  await flush();
  assert.deepEqual(clock.delays, [0], "visibility returning during a request queues an immediate follow-up");
  stop();
  assert.deepEqual(clock.delays, []);
});

test("teardown cancels timers and prevents an in-flight request from scheduling another poll", async () => {
  const clock = fakeScheduler();
  let calls = 0;
  let subscribed = true;
  const current = deferred();
  const stop = startSessionPolling({
    refresh: () => { calls += 1; return current.promise; },
    schedule: clock,
    subscribeVisibility: () => () => { subscribed = false; },
  });
  clock.runNext();
  stop();
  current.resolve();
  await flush();
  assert.equal(calls, 1);
  assert.equal(subscribed, false);
  assert.deepEqual(clock.delays, []);
});

test("single-flight active refreshes serialize and repeat once for newer callers", async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const refresh = createSingleFlightRefresh(async (sessionId: string) => {
    calls += 1;
    assert.equal(sessionId, "session-a");
    return calls === 1 ? first.promise : second.promise;
  });
  const one = refresh("session-a");
  const two = refresh("session-a");
  assert.equal(calls, 1);
  first.resolve();
  await flush();
  assert.equal(calls, 2, "a request that arrived during the flight receives a fresh snapshot");
  second.resolve();
  await Promise.all([one, two]);
  assert.equal(calls, 2);
});
