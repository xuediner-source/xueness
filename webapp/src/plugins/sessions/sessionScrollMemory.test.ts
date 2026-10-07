import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSessionScrollMemoryKey,
  readSessionScrollMemoryState,
  resolveScrollRestoreTop,
  saveSessionScrollMemoryState,
  type SessionScrollMemoryState,
} from "./sessionScrollMemory";

function makeState(scrollTop: number, wasPinnedToBottom = false): SessionScrollMemoryState {
  return { scrollTop, scrollHeight: 2000, clientHeight: 500, wasPinnedToBottom, updatedAt: Date.now() };
}

test("memory key is simplified to the trimmed sessionId", () => {
  assert.equal(buildSessionScrollMemoryKey({ sessionId: "  s-1 " }), "s-1");
  assert.equal(buildSessionScrollMemoryKey({ sessionId: "" }), null);
  assert.equal(buildSessionScrollMemoryKey({ sessionId: "   " }), null);
  assert.equal(buildSessionScrollMemoryKey({}), null);
});

test("save then read returns the stored state", () => {
  const key = buildSessionScrollMemoryKey({ sessionId: "mem-roundtrip" });
  saveSessionScrollMemoryState(key, makeState(123, true));
  const read = readSessionScrollMemoryState(key);
  assert.equal(read?.scrollTop, 123);
  assert.equal(read?.wasPinnedToBottom, true);
  assert.equal(readSessionScrollMemoryState(buildSessionScrollMemoryKey({ sessionId: "mem-missing" })), null);
});

test("memory holds at most 200 entries (LRU)", () => {
  const keys: string[] = [];
  for (let i = 0; i < 210; i++) {
    const key = buildSessionScrollMemoryKey({ sessionId: `mem-lru-${i}` })!;
    keys.push(key);
    saveSessionScrollMemoryState(key, makeState(i));
  }
  // 最早写入的 10 条被淘汰。
  assert.equal(readSessionScrollMemoryState(keys[0]), null);
  assert.equal(readSessionScrollMemoryState(keys[9]), null);
  assert.equal(readSessionScrollMemoryState(keys[10])?.scrollTop, 10);
  // 读取会刷新 LRU：读 keys[10] 后再写入一条，被淘汰的是 keys[11]。
  saveSessionScrollMemoryState(buildSessionScrollMemoryKey({ sessionId: "mem-lru-new" }), makeState(999));
  assert.equal(readSessionScrollMemoryState(keys[10])?.scrollTop, 10);
  assert.equal(readSessionScrollMemoryState(keys[11]), null);
});

test("restore top is clamped into the valid scroll range", () => {
  const metrics = { scrollHeight: 1000, clientHeight: 400 }; // maxScrollTop = 600
  assert.equal(resolveScrollRestoreTop({ scrollTop: 250 }, metrics), 250);
  assert.equal(resolveScrollRestoreTop({ scrollTop: 900 }, metrics), 600);
  assert.equal(resolveScrollRestoreTop({ scrollTop: -50 }, metrics), 0);
  assert.equal(resolveScrollRestoreTop({ scrollTop: 100 }, { scrollHeight: 300, clientHeight: 500 }), 0);
});
