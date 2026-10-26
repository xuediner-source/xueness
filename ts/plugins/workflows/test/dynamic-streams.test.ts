import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PyValueError } from "@xueness/contracts";
import { DynamicStreamBroker, STREAM_MAX_PAYLOAD_CHARS, STREAM_READ_MAX_EVENTS } from "../src/dynamic-streams.ts";

const RUN = "c".repeat(32);

function broker(): { streams: DynamicStreamBroker; state: string; cleanup(): void } {
  const state = mkdtempSync(join(tmpdir(), "xue-dynamic-streams-"));
  return { streams: new DynamicStreamBroker(state), state, cleanup: () => rmSync(state, { recursive: true, force: true }) };
}

describe("dynamic stream broker", () => {
  it("publishes durable events with monotone seqs and replays after a restart", () => {
    const f = broker();
    try {
      const first = f.streams.publish(RUN, "progress", { step: "compile" });
      const second = f.streams.publish(RUN, "progress", { step: "run" });
      assert.equal(first.seq, 1);
      assert.equal(second.seq, 2);

      // A brand-new broker over the same state sees the whole log: the log,
      // not the process, is the source of truth.
      const restarted = new DynamicStreamBroker(f.state);
      const all = restarted.read(RUN, "progress", 0);
      assert.deepEqual(all.events.map((event) => event.seq), [1, 2]);
      assert.deepEqual(all.events.at(-1)!.payload, { step: "run" });
      assert.equal(all.lastSeq, 2);
      assert.deepEqual(restarted.read(RUN, "progress", 1).events.map((event) => event.seq), [2]);
      assert.deepEqual(restarted.read(RUN, "other").events, []);
    } finally { f.cleanup(); }
  });

  it("subscribes with durable replay then live delivery, and stops on unsubscribe", () => {
    const f = broker();
    try {
      f.streams.publish(RUN, "feed", "seed-1");
      const seen: string[] = [];
      const subscription = f.streams.subscribe(RUN, "feed", 0, (event) => seen.push(event.payload as string));
      assert.deepEqual(seen, ["seed-1"], "subscribe replays the durable tail synchronously");
      f.streams.publish(RUN, "feed", "live-2");
      f.streams.publish(RUN, "feed", "live-3");
      assert.deepEqual(seen, ["seed-1", "live-2", "live-3"]);
      subscription.unsubscribe();
      f.streams.publish(RUN, "feed", "after-unsubscribe");
      assert.deepEqual(seen, ["seed-1", "live-2", "live-3"]);
      assert.equal(subscription.lastSeq, 4);

      // A late subscriber resumes from its own checkpoint without re-reading.
      const late: string[] = [];
      const resumed = f.streams.subscribe(RUN, "feed", 2, (event) => late.push(event.payload as string));
      assert.deepEqual(late, ["live-3", "after-unsubscribe"], "only events past afterSeq are replayed");
      assert.deepEqual(resumed.events.map((event) => event.seq), [3, 4]);
      resumed.unsubscribe();
    } finally { f.cleanup(); }
  });

  it("skips torn tail lines, enforces the payload cap, and reports retention gaps", () => {
    const f = broker();
    try {
      f.streams.publish(RUN, "torn", { ok: true });
      appendFileSync(join(f.state, "dynamic-workflows", "streams", RUN, "torn.jsonl"), '{"seq": 2, "at": "x', "utf8");
      const read = f.streams.read(RUN, "torn", 0);
      assert.deepEqual(read.events.map((event) => event.seq), [1]);

      assert.throws(() => f.streams.publish(RUN, "cap", "p".repeat(STREAM_MAX_PAYLOAD_CHARS + 1)), PyValueError);
      assert.throws(() => f.streams.publish(RUN, "bad name", "x"), PyValueError);
      assert.throws(() => f.streams.publish("nope", "feed", "x"), PyValueError);

      for (let index = 0; index < STREAM_READ_MAX_EVENTS + 2; index += 1) f.streams.publish(RUN, "long", index);
      const tail = f.streams.read(RUN, "long", 0);
      assert.equal(tail.events.length, STREAM_READ_MAX_EVENTS);
      assert.equal(tail.oldestSeq, 3);
      const gapped = f.streams.read(RUN, "long", 1);
      assert.equal(gapped.gap, true, "asking before the retained tail is a visible gap");
      assert.equal(f.streams.read(RUN, "long", 0).gap, false);
    } finally { f.cleanup(); }
  });

  it("appends after a torn tail instead of swallowing the next event", () => {
    const f = broker();
    try {
      f.streams.publish(RUN, "log", { n: 1 });
      const path = join(f.state, "dynamic-workflows", "streams", RUN, "log.jsonl");
      // A write that died mid-line leaves a partial record without a newline.
      appendFileSync(path, '{"seq":2,"at":"x","pay', "utf8");
      const next = f.streams.publish(RUN, "log", { n: 2 });
      assert.equal(next.seq, 2);
      const read = f.streams.read(RUN, "log", 0);
      assert.deepEqual(read.events.map((event) => event.seq), [1, 2]);
      assert.deepEqual(read.events.at(-1)!.payload, { n: 2 });
    } finally { f.cleanup(); }
  });

  it("settles futures idempotently and refuses a different value", () => {
    const f = broker();
    try {
      const settled = f.streams.settleFuture(RUN, "verdict", { ok: true });
      const again = f.streams.settleFuture(RUN, "verdict", { ok: true });
      assert.deepEqual(again, settled);
      assert.throws(() => f.streams.settleFuture(RUN, "verdict", { ok: false }), PyValueError);

      // Restart semantics: a fresh broker resolves the settled future from disk.
      const restarted = new DynamicStreamBroker(f.state);
      assert.deepEqual(restarted.future(RUN, "verdict"), settled);
      assert.equal(restarted.future(RUN, "pending"), null);
      assert.deepEqual(restarted.names(RUN), ["verdict"]);
    } finally { f.cleanup(); }
  });

  it("awaits futures from disk when already settled, live when pending, and honors abort", async () => {
    const f = broker();
    try {
      const settled = f.streams.settleFuture(RUN, "done", { from: "disk" });
      const fromDisk = await f.streams.awaitFuture(RUN, "done");
      assert.deepEqual(fromDisk, settled);

      const waiting = f.streams.awaitFuture(RUN, "later");
      const live = f.streams.awaitFuture(RUN, "live");
      f.streams.settleFuture(RUN, "live", 42);
      assert.equal((await live).value, 42);
      const controller = new AbortController();
      const aborted = f.streams.awaitFuture(RUN, "never", controller.signal);
      controller.abort();
      await assert.rejects(aborted, PyValueError);
      f.streams.settleFuture(RUN, "later", "ready");
      assert.equal((await waiting).value, "ready");

      const freshBroker = new DynamicStreamBroker(f.state);
      const settledNow = freshBroker.awaitFuture(RUN, "later");
      assert.equal((await settledNow).value, "ready");
    } finally { f.cleanup(); }
  });
});
