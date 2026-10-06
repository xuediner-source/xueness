import test from "node:test";
import assert from "node:assert/strict";

import { TimelineWindowModel, type TimelineWindowHost, type TimelineWindowSnapshot } from "./TimelineVirtualWindow";

/** 确定性伪随机数，保证断言可复现。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildHeights(count: number, seed = 7): number[] {
  const random = mulberry32(seed);
  return Array.from({ length: count }, () => Math.round(40 + random() * 760));
}

type FakeScrollerOptions = { clientHeight?: number; gap?: number; padTop?: number; padBottom?: number };

/**
 * 假滚动容器：按模型发布的快照搭建“真实 DOM”（垫片 + 窗口内真实高度条目），
 * 几何全部由快照与真实高度独立推算，不依赖模型内部前缀，用作断言基准。
 */
class FakeTimelineScroller implements TimelineWindowHost {
  readonly heights: number[];
  clientHeight: number;
  readonly gap: number;
  readonly padTop: number;
  readonly padBottom: number;
  scrollWrites = 0;
  private view: { count: number; start: number; end: number; topPad: number; bottomPad: number } = { count: 0, start: 0, end: 0, topPad: 0, bottomPad: 0 };
  private scrollTopValue = 0;

  constructor(heights: number[], options: FakeScrollerOptions = {}) {
    this.heights = heights;
    this.clientHeight = options.clientHeight ?? 600;
    this.gap = options.gap ?? 20;
    this.padTop = options.padTop ?? 24;
    this.padBottom = options.padBottom ?? 28;
  }

  /** 与浏览器一致：scrollTop 写入后夹紧到 [0, scrollHeight - clientHeight]。 */
  get scrollTop(): number {
    return this.scrollTopValue;
  }

  set scrollTop(top: number) {
    this.scrollTopValue = Math.min(Math.max(0, top), Math.max(0, this.scrollHeight - this.clientHeight));
  }

  /** 把模型快照提交为当前 DOM 布局（等价于 React 提交）。 */
  render(snapshot: TimelineWindowSnapshot): void {
    this.view = { count: snapshot.count, start: snapshot.start, end: snapshot.end, topPad: snapshot.topPad, bottomPad: snapshot.bottomPad };
  }

  get scrollHeight(): number {
    const children: number[] = [];
    const { count, start, end, topPad, bottomPad } = this.view;
    if (start > 0 && topPad > 0) children.push(topPad);
    for (let index = start; index < Math.min(end, count); index += 1) children.push(this.heights[index]!);
    if (end < count && bottomPad > 0) children.push(bottomPad);
    const gaps = Math.max(0, children.length - 1) * this.gap;
    return this.padTop + this.padBottom + children.reduce((sum, height) => sum + height, 0) + gaps;
  }

  readViewport(): { scrollTop: number; clientHeight: number; scrollHeight: number } {
    return { scrollTop: this.scrollTop, clientHeight: this.clientHeight, scrollHeight: this.scrollHeight };
  }

  setScrollTop(top: number): void {
    this.scrollWrites += 1;
    this.scrollTop = Math.min(Math.max(0, top), Math.max(0, this.scrollHeight - this.clientHeight));
  }

  measureEntry(index: number): number | null {
    return index >= this.view.start && index < this.view.end ? this.heights[index]! : null;
  }

  readRowGap(): number {
    return this.gap;
  }

  /** 渲染条目的 DOM 顶部（内容坐标，含容器 padding）。 */
  itemDomTop(index: number): number | null {
    const { start, end, topPad, bottomPad } = this.view;
    if (index < start || index >= end) return null;
    let top = this.padTop + topPad + (start > 0 && topPad > 0 ? this.gap : 0);
    for (let cursor = start; cursor < index; cursor += 1) top += this.heights[cursor]! + this.gap;
    return top;
  }

  /** 视口顶部当前压住的条目与条目内偏移；视口落在垫片里时返回 null。 */
  viewportTopAnchor(): { index: number; offset: number } | null {
    let anchor: { index: number; offset: number } | null = null;
    for (let index = this.view.start; index < this.view.end; index += 1) {
      const top = this.itemDomTop(index)!;
      if (top <= this.scrollTop) anchor = { index, offset: this.scrollTop - top };
      else break;
    }
    return anchor;
  }
}

/** 模拟一次渲染提交：快照 → DOM → 布局阶段测量/补偿。 */
function commit(model: TimelineWindowModel, fake: FakeTimelineScroller): void {
  fake.render(model.getSnapshot());
  model.syncAfterCommit();
  fake.render(model.getSnapshot());
}

/** 模拟用户滚动：原生滚动 → scroll 事件 → 重渲染提交。 */
function scrollBy(model: TimelineWindowModel, fake: FakeTimelineScroller, delta: number): void {
  fake.scrollTop += delta;
  model.onScrolled();
  commit(model, fake);
}

/** 建立贴尾状态：设定条目数、尾部开窗 + 自动滚动到底。 */
function attachAtTail(model: TimelineWindowModel, fake: FakeTimelineScroller, count: number): void {
  model.setCount(count);
  commit(model, fake);
  fake.scrollTop = fake.scrollHeight;
  model.onScrolled();
  commit(model, fake);
}

test("短会话完整渲染，不产生窗口垫片", () => {
  const model = new TimelineWindowModel({ readViewport: () => null, setScrollTop: () => {}, measureEntry: () => null, readRowGap: () => 0 });
  model.setCount(40);
  const snapshot = model.getSnapshot();
  assert.equal(snapshot.windowed, false);
  assert.deepEqual([snapshot.start, snapshot.end, snapshot.topPad, snapshot.bottomPad], [0, 40, 0, 0]);
});

test("长会话初始按尾部开窗，垫片用估计高度补齐", () => {
  const snapshot = TimelineWindowModel.initialSnapshot(200, { initialTail: true, estimatePx: 140 });
  assert.equal(snapshot.windowed, true);
  assert.equal(snapshot.start, 200 - 32);
  assert.equal(snapshot.end, 200);
  assert.equal(snapshot.topPad, 168 * 140);
  assert.equal(snapshot.bottomPad, 0);
});

test("长会话初始按头部开窗（自动滚动关闭时）", () => {
  const snapshot = TimelineWindowModel.initialSnapshot(200, { initialTail: false, estimatePx: 140 });
  assert.deepEqual([snapshot.start, snapshot.end], [0, 32]);
  assert.equal(snapshot.topPad, 0);
  assert.equal(snapshot.bottomPad, 168 * 140);
});

test("向上滚动时窗口上移，视口锚点内容保持不动", () => {
  const heights = buildHeights(200);
  const fake = new FakeTimelineScroller(heights, { clientHeight: 600, gap: 20 });
  const model = new TimelineWindowModel(fake, { initialTail: true, pageSize: 32, overscanPx: 800 });
  attachAtTail(model, fake, 200);
  const startInitial = model.getSnapshot().start;
  let steps = 0;

  // 逐屏上滚直到窗口真正上移；每一步都校验锚点内容不跳动。
  while (model.getSnapshot().start >= startInitial && steps < 60) {
    const targetScrollTop = fake.scrollTop - 600;
    const layoutBefore = new Map<number, number>();
    for (let index = model.getSnapshot().start; index < model.getSnapshot().end; index += 1) {
      layoutBefore.set(index, fake.itemDomTop(index)!);
    }
    let expected: { index: number; offset: number } | null = null;
    for (const [index, top] of layoutBefore) {
      if (top <= targetScrollTop) expected = { index, offset: targetScrollTop - top };
      else break;
    }
    assert.ok(expected, "目标锚点必须来自滚动前已渲染条目");

    scrollBy(model, fake, -600);
    const actual = fake.viewportTopAnchor();
    assert.ok(actual, `第 ${steps} 步后视口内应仍有条目`);
    assert.equal(actual.index, expected.index, `第 ${steps} 步：同一条目应仍在视口顶部`);
    assert.ok(
      Math.abs(actual.offset - expected.offset) <= 1.5,
      `第 ${steps} 步条目内偏移应保持：${actual.offset} vs ${expected.offset}`,
    );
    steps += 1;
  }
  assert.ok(steps < 60, "窗口应在有限步内上移");
  assert.ok(model.getSnapshot().start < startInitial, "窗口应向上移动");
  assert.ok(fake.scrollWrites >= 1, "应发生锚点补偿写入");
});

test("向下滚动到末尾时窗口包含尾部条目", () => {
  const heights = buildHeights(200);
  const fake = new FakeTimelineScroller(heights);
  const model = new TimelineWindowModel(fake, { initialTail: false, pageSize: 32 });
  model.setCount(200);
  commit(model, fake);
  assert.equal(model.getSnapshot().end, 32);

  fake.scrollTop = fake.scrollHeight;
  model.onScrolled();
  commit(model, fake);
  const snapshot = model.getSnapshot();
  assert.equal(snapshot.end, 200);
  assert.equal(snapshot.bottomPad, 0);
  const lastAnchor = fake.viewportTopAnchor();
  assert.ok(lastAnchor && lastAnchor.index >= 200 - 40);
});

test("贴尾流式追加：窗口扩展到新末尾并保持贴底", () => {
  const heights = buildHeights(200);
  const fake = new FakeTimelineScroller(heights);
  const model = new TimelineWindowModel(fake, { initialTail: true, pageSize: 32 });
  attachAtTail(model, fake, 200);

  heights.push(260, 180, 340);
  model.setCount(203);
  commit(model, fake);
  assert.equal(model.getSnapshot().end, 203, "追加后窗口应立即带住新尾部");

  // 会话视口在 rowsVersion 变化后自动滚到底部。
  fake.scrollTop = fake.scrollHeight;
  model.onScrolled();
  commit(model, fake);

  assert.equal(fake.scrollTop + fake.clientHeight, fake.scrollHeight);
  assert.ok(fake.itemDomTop(202) !== null, "最后一条应已渲染");
});

test("轻微离尾（阈值内）时追加仍贴合底部", () => {
  const heights = buildHeights(200);
  const fake = new FakeTimelineScroller(heights, { clientHeight: 600 });
  const model = new TimelineWindowModel(fake, { initialTail: true, pageSize: 32, tailThresholdPx: 80 });
  attachAtTail(model, fake, 200);
  const bottom = fake.scrollHeight - fake.clientHeight;

  fake.scrollTop = bottom - 50;
  model.onScrolled();
  commit(model, fake);

  heights.push(300, 220);
  model.setCount(202);
  commit(model, fake);
  // 会话视口在 rowsVersion 变化后自动滚到底部。
  fake.scrollTop = fake.scrollHeight;
  model.onScrolled();
  commit(model, fake);
  assert.equal(fake.scrollTop + fake.clientHeight, fake.scrollHeight, "阈值内应跟随到底");
  assert.equal(model.getSnapshot().end, 202);
});

test("离尾阅读时流式追加不改变视口内容", () => {
  const heights = buildHeights(200);
  const fake = new FakeTimelineScroller(heights);
  const model = new TimelineWindowModel(fake, { initialTail: true, pageSize: 32 });
  attachAtTail(model, fake, 200);

  scrollBy(model, fake, -12000);
  const anchorBefore = fake.viewportTopAnchor();
  assert.ok(anchorBefore, "阅读位置应有锚点条目");

  heights.push(240, 200, 280);
  model.setCount(203);
  commit(model, fake);

  // 锚点补偿可能改写 scrollTop（估计更新），但视口内容必须不动。
  const anchorAfter = fake.viewportTopAnchor();
  assert.ok(anchorAfter);
  assert.equal(anchorAfter.index, anchorBefore.index);
  assert.ok(Math.abs(anchorAfter.offset - anchorBefore.offset) <= 0.5);
  assert.ok(
    fake.scrollHeight - fake.scrollTop - fake.clientHeight > 80,
    "离尾阅读时不应被拉回底部",
  );
});

test("reveal 把窗口移到目标附近，跳转后锚点条目贴住视口顶部", () => {
  const heights = buildHeights(200);
  const fake = new FakeTimelineScroller(heights);
  const model = new TimelineWindowModel(fake, { initialTail: true, pageSize: 32 });
  attachAtTail(model, fake, 200);

  // 历史轨道请求展开窗口（flushSync 内完成重渲染与测量）。
  model.reveal(40);
  const snapshot = model.getSnapshot();
  fake.render(snapshot);
  assert.ok(snapshot.start <= 40 && 40 < snapshot.end, "目标条目必须在窗口内");
  assert.ok(snapshot.topPad > 0);
  commit(model, fake);

  // 轨道随后按真实 DOM 位置滚动到目标条目。
  fake.scrollTop = Math.max(0, fake.itemDomTop(40)! - 16);
  model.onScrolled();
  commit(model, fake);
  const anchor = fake.viewportTopAnchor();
  assert.ok(anchor && Math.abs(anchor.index - 40) <= 1, `目标条目应停留在视口顶部附近，实际 ${anchor?.index}`);
});

test("滚动测量后高度估计收敛到真实均值", () => {
  const heights = buildHeights(200, 11);
  const fake = new FakeTimelineScroller(heights, { clientHeight: 600 });
  const model = new TimelineWindowModel(fake, { initialTail: false, pageSize: 32 });
  model.setCount(200);
  commit(model, fake);
  const average = heights.slice(0, 32).reduce((sum, height) => sum + height, 0) / 32;
  const estimate = model.getSnapshot().estimate;
  assert.ok(Math.abs(estimate - average) < 5, `估计 ${estimate} 应接近均值 ${average}`);
});

test("列表收缩后重置测量并完整渲染", () => {
  const heights = buildHeights(200);
  const fake = new FakeTimelineScroller(heights);
  const model = new TimelineWindowModel(fake, { initialTail: true, pageSize: 32 });
  attachAtTail(model, fake, 200);
  assert.ok(Math.abs(model.getSnapshot().estimate - 140) > 1, "贴尾测量应更新估计");

  heights.length = 50;
  model.setCount(50);
  const snapshot = model.getSnapshot();
  assert.equal(snapshot.windowed, false);
  assert.deepEqual([snapshot.start, snapshot.end, snapshot.topPad, snapshot.bottomPad], [0, 50, 0, 0]);
  assert.equal(snapshot.estimate, 140, "收缩后估计重置");
});

test("窗口垫片与真实内容总高一致（含 flex gap）", () => {
  const heights = buildHeights(200, 23);
  const fake = new FakeTimelineScroller(heights, { clientHeight: 600, gap: 20, padTop: 24, padBottom: 28 });
  const model = new TimelineWindowModel(fake, { initialTail: false, pageSize: 32 });
  model.setCount(200);
  commit(model, fake);
  const expectedTotal = 24 + 28 + heights.reduce((sum, height) => sum + height + 20, 0) - 20;
  // 初始窗口只有估计：总高允许估计误差，但窗口移动、测量收敛后必须吻合。
  scrollBy(model, fake, 800);
  // 逐屏滚到底，让全部条目都测量过。
  while (fake.scrollTop + fake.clientHeight < fake.scrollHeight - 1) {
    scrollBy(model, fake, 1200);
  }
  scrollBy(model, fake, 1200);
  const measuredTotal = 24 + 28 + heights.reduce((sum, height) => sum + height + 20, 0) - 20;
  assert.equal(fake.scrollHeight, measuredTotal);
  assert.ok(Math.abs(expectedTotal - measuredTotal) < 1e-6);
  assert.equal(model.getSnapshot().bottomPad, 0, "滚动到末尾后底部垫片应为 0");
});
