import test from "node:test";
import assert from "node:assert/strict";

import { UniformListWindowModel, type UniformListWindowHost } from "./ListVirtualWindow";

/** 假宿主：等高条目、固定 item0Top 与视口，模拟真实布局的测量结果。
 * 锚点遵循真实不变式：首个挂载子元素的位置 = item0Top + 当前窗口 start × 节距。 */
function fakeHost(options: {
  count: number;
  stride: () => number;
  item0Top: number;
  viewport: { top: number; bottom: number } | null;
  readStart?: () => number;
}): { host: UniformListWindowHost; setViewport(next: { top: number; bottom: number } | null): void } {
  let viewport = options.viewport;
  return {
    host: {
      readViewport: () => viewport,
      readAnchor: () => (options.count > 0
        ? { top: options.item0Top + (options.readStart?.() ?? 0) * options.stride(), stride: options.stride() }
        : null),
    },
    setViewport(next) {
      viewport = next;
    },
  };
}

test("初始快照只渲染首页，垫片补齐剩余高度", () => {
  const snapshot = UniformListWindowModel.initialSnapshot(1000, { pageSize: 48, estimateStridePx: 15 });
  assert.equal(snapshot.windowed, true);
  assert.equal(snapshot.start, 0);
  assert.equal(snapshot.end, 48);
  assert.equal(snapshot.topPad, 0);
  assert.equal(snapshot.bottomPad, (1000 - 48) * 15);
});

test("短列表完整渲染且不启用窗口化", () => {
  const snapshot = UniformListWindowModel.initialSnapshot(20, { pageSize: 48, estimateStridePx: 15 });
  assert.equal(snapshot.windowed, false);
  assert.deepEqual([snapshot.start, snapshot.end], [0, 20]);
  assert.equal(snapshot.topPad, 0);
  assert.equal(snapshot.bottomPad, 0);
});

test("sync 依据视口与测量节距重算窗口，垫片保持总高恒定", () => {
  const fake = fakeHost({ count: 1000, stride: () => 15, item0Top: 0, viewport: { top: 100, bottom: 320 } });
  const model = new UniformListWindowModel(fake.host, { pageSize: 48, overscanPx: 300, estimateStridePx: 33, initialCount: 1000 });
  model.sync();
  // 视口 220px + 上下各 300px 余量 ≈ 55 行，但窗口最少渲染一页 48 行。
  assert.equal(model.getSnapshot().start, 0);
  assert.equal(model.getSnapshot().end, 48);
  assert.equal(model.getSnapshot().topPad, 0);
  assert.equal(model.getSnapshot().bottomPad, (1000 - 48) * 15);

  // 滚到中部：item0 顶在视口上方 1500px 处，窗口平移且垫片互补。
  let mid: UniformListWindowModel;
  mid = new UniformListWindowModel(
    {
      readViewport: () => ({ top: 100, bottom: 320 }),
      readAnchor: () => ({ top: -1500 + mid.getSnapshot().start * 15, stride: 15 }),
    },
    { pageSize: 48, overscanPx: 300, initialCount: 1000 },
  );
  mid.sync();
  const snapshot = mid.getSnapshot();
  assert.equal(snapshot.start, 86);
  assert.equal(snapshot.end, 142);
  assert.equal(snapshot.topPad, 86 * 15);
  assert.equal(snapshot.bottomPad, (1000 - 142) * 15);
  assert.equal(snapshot.topPad + (snapshot.end - snapshot.start) * 15 + snapshot.bottomPad, 1000 * 15);
  // 锚点反馈回读后 item0Top 不漂移。
  mid.sync();
  assert.equal(mid.getSnapshot().start, 86);
});

test("列表与视口不相交时只保留一个测量锚点，滚回后窗口可恢复", () => {
  const fake = fakeHost({ count: 1000, stride: () => 15, item0Top: 5000, viewport: { top: 100, bottom: 700 } });
  const model = new UniformListWindowModel(fake.host, { pageSize: 48, overscanPx: 300, initialCount: 1000 });
  model.sync();
  let snapshot = model.getSnapshot();
  assert.deepEqual([snapshot.start, snapshot.end], [0, 1]);
  assert.equal(snapshot.topPad, 0);
  assert.equal(snapshot.bottomPad, (1000 - 1) * 15);

  // 列表整体滚到视口上方：锚点挂在最后一条上。
  const above = fakeHost({ count: 1000, stride: () => 15, item0Top: -50000, viewport: { top: 100, bottom: 700 } });
  const modelAbove = new UniformListWindowModel(above.host, { pageSize: 48, overscanPx: 300, initialCount: 1000 });
  modelAbove.sync();
  snapshot = modelAbove.getSnapshot();
  assert.deepEqual([snapshot.start, snapshot.end], [999, 1000]);
});

test("pinned 只做邻近合并：远离视口时忽略，绝不把窗口从可视区拽走", () => {
  const fake = fakeHost({ count: 1000, stride: () => 15, item0Top: 0, viewport: { top: 0, bottom: 220 } });
  const model = new UniformListWindowModel(fake.host, { pageSize: 48, overscanPx: 300, initialCount: 1000 });
  model.setPinned([500]);
  model.sync();
  const snapshot = model.getSnapshot();
  assert.equal(snapshot.start, 0);
  assert.equal(snapshot.end, 48, "远处的 pinned 行不应改变视口窗口");
});

test("用户滚动时窗口跟随视口：pinned 的光标行不会把可视区拖回顶部", () => {
  // 光标 pinned 在第 0 行，用户把列表滚到中部（item0 顶在视口上方 6627px 处）。
  const fake = fakeHost({ count: 1000, stride: () => 15, item0Top: -6627, viewport: { top: 0, bottom: 480 } });
  const model = new UniformListWindowModel(fake.host, { pageSize: 48, overscanPx: 300, initialCount: 1000 });
  model.sync();
  model.setPinned([0]);
  model.sync();
  const snapshot = model.getSnapshot();
  assert.ok(snapshot.start > 100, `窗口应跟随视口，实际 start=${snapshot.start}`);
  assert.ok(snapshot.end - snapshot.start >= 48);
  assert.equal(snapshot.topPad, snapshot.start * 15);
});

test("pinned 贴近窗口时只做最小扩展，不把窗口拽离视口", () => {
  const fake = fakeHost({ count: 1000, stride: () => 15, item0Top: 0, viewport: { top: 0, bottom: 220 } });
  const model = new UniformListWindowModel(fake.host, { pageSize: 48, overscanPx: 0, estimateStridePx: 15, initialCount: 1000 });
  model.setPinned([49]);
  model.sync();
  const snapshot = model.getSnapshot();
  assert.equal(snapshot.start, 0);
  assert.equal(snapshot.end, 50);
});

test("ensureIndex 开出跳转页并在提交测量时保持，直到滚动事件重新规划", () => {
  const fake = fakeHost({ count: 1000, stride: () => 15, item0Top: 0, viewport: { top: 0, bottom: 220 } });
  const model = new UniformListWindowModel(fake.host, { pageSize: 48, overscanPx: 300, initialCount: 1000 });
  model.sync();
  model.ensureIndex(900);
  assert.equal(model.getSnapshot().start, 876);
  assert.equal(model.getSnapshot().end, 924);
  // 提交后测量（此时视口还在别处）：跳转意图保持，窗口不被拉回。
  model.syncAfterCommit();
  assert.equal(model.getSnapshot().start, 876);
  // 已在窗口内时不再移动。
  model.ensureIndex(880);
  assert.equal(model.getSnapshot().start, 876);
  // 真正的滚动事件后按视口重新规划（模拟用户已滚到目标附近）。
  const scrolled: UniformListWindowModel = new UniformListWindowModel(
    {
      readViewport: () => ({ top: 0, bottom: 480 }),
      readAnchor: (): { top: number; stride: number } | null => ({ top: -12774 + scrolled.getSnapshot().start * 15, stride: 15 }),
    },
    { pageSize: 48, overscanPx: 300, initialCount: 1000 },
  );
  scrolled.ensureIndex(900);
  scrolled.sync();
  assert.ok(scrolled.getSnapshot().start <= 900 && 900 < scrolled.getSnapshot().end, "滚动后窗口应覆盖视口");
  void model;
});

test("setCount 收缩后夹取窗口，下一次 sync 按视口恢复；归零后重建从首页开始", () => {
  let model: UniformListWindowModel;
  const fake = fakeHost({
    count: 1000,
    stride: () => 15,
    item0Top: 0,
    viewport: { top: 0, bottom: 220 },
    readStart: () => model.getSnapshot().start,
  });
  model = new UniformListWindowModel(fake.host, { pageSize: 48, overscanPx: 300, initialCount: 1000 });
  model.sync();
  model.ensureIndex(900);
  model.setCount(500);
  let snapshot = model.getSnapshot();
  assert.equal(snapshot.count, 500);
  assert.equal(snapshot.start, 499);
  assert.equal(snapshot.end, 500);
  model.sync();
  snapshot = model.getSnapshot();
  assert.equal(snapshot.start, 0);
  assert.equal(snapshot.end, 48);

  model.setCount(0);
  snapshot = model.getSnapshot();
  assert.deepEqual([snapshot.start, snapshot.end, snapshot.topPad, snapshot.bottomPad], [0, 0, 0, 0]);

  model.setCount(30);
  snapshot = model.getSnapshot();
  assert.equal(snapshot.windowed, false);
  assert.deepEqual([snapshot.start, snapshot.end], [0, 30]);
});

test("实测节距变化（移动端等）会同步更新垫片", () => {
  let stride = 15;
  const fake = fakeHost({ count: 1000, stride: () => stride, item0Top: 0, viewport: { top: 0, bottom: 220 } });
  const model = new UniformListWindowModel(fake.host, { pageSize: 48, overscanPx: 300, initialCount: 1000 });
  model.sync();
  stride = 13;
  model.sync();
  const snapshot = model.getSnapshot();
  assert.equal(snapshot.stride, 13);
  assert.equal(snapshot.topPad + (snapshot.end - snapshot.start) * 13 + snapshot.bottomPad, 1000 * 13);
});

test("空列表与无测量信息时保持安全窗口", () => {
  const fake = fakeHost({ count: 0, stride: () => 15, item0Top: 0, viewport: null });
  const model = new UniformListWindowModel(fake.host, { pageSize: 48, initialCount: 0 });
  model.sync();
  const snapshot = model.getSnapshot();
  assert.deepEqual([snapshot.start, snapshot.end, snapshot.windowed], [0, 0, false]);

  const unmeasured = new UniformListWindowModel(
    { readViewport: () => ({ top: 0, bottom: 220 }), readAnchor: () => null },
    { pageSize: 48, initialCount: 1000 },
  );
  unmeasured.sync();
  const initial = unmeasured.getSnapshot();
  assert.deepEqual([initial.start, initial.end], [0, 48]);
});
