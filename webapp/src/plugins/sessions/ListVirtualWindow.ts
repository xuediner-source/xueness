import React from "react";
import { flushSync } from "react-dom";

/**
 * 等高列表窗口化（虚拟列表）规划器。
 *
 * 会话侧栏的会话行与历史轨道的停靠点都是等高条目：窗口外的条目用列表容器
 * 上的 padding（历史轨道用停靠区的外边距）补齐。等高保证垫片是精确值，滚动
 * 总高恒定、条目落在各自真实位置上，因此窗口移动不需要滚动位置补偿。
 * 与 TimelineWindowModel 一样，布局依赖通过 host 注入，便于用假宿主做单元测试。
 */

export type UniformListWindowSnapshot = {
  count: number;
  /** 首个挂载条目的下标（含）。 */
  start: number;
  /** 末个挂载条目的下标（不含）。 */
  end: number;
  /** 列表容器顶部需要补齐的像素（未渲染条目的高度）。 */
  topPad: number;
  /** 列表容器底部需要补齐的像素。 */
  bottomPad: number;
  windowed: boolean;
  /** 条目节距（高度 + 间隔），实测优先，未测量时用估计值。 */
  stride: number;
};

export type UniformListWindowHost = {
  /** 滚动视口在视口坐标中的范围；不可测量时返回 null。 */
  readViewport(): { top: number; bottom: number } | null;
  /** 测量列表容器的首个挂载子元素（它对应当前窗口的 start 下标）；全部未挂载时返回 null。 */
  readAnchor(): { top: number; stride: number } | null;
};

export type UniformListWindowOptions = {
  /** 窗口最少渲染的条数。 */
  pageSize?: number;
  /** 视口上下额外渲染的像素。 */
  overscanPx?: number;
  /** 未测量条目的节距估计。 */
  estimateStridePx?: number;
  /** 构造时已知的条目数，用于渲染首帧（含 SSR）的初始窗口。 */
  initialCount?: number;
};

const DEFAULT_PAGE_SIZE = 48;
const DEFAULT_OVERSCAN_PX = 600;
const DEFAULT_ESTIMATE_STRIDE_PX = 33;
/** 条数低于该倍数时完整渲染，短列表保持原有行为。 */
const FULL_RENDER_LIMIT_FACTOR = 2;

const NULL_HOST: UniformListWindowHost = {
  readViewport: () => null,
  readAnchor: () => null,
};

function clampIndex(value: number, count: number): number {
  return Math.min(Math.max(0, Math.floor(value)), count);
}

type WindowRange = { start: number; end: number };

export class UniformListWindowModel {
  private host: UniformListWindowHost;
  private pageSize: number;
  private overscanPx: number;
  private defaultStride: number;

  private count = 0;
  private start = 0;
  private end = 0;
  private stride: number;
  /** 虚拟第 0 条的视口坐标，来自最近一次成功测量；null 表示还没有任何布局信息。 */
  private item0Top: number | null = null;
  private pinned: number[] = [];
  /** ensureIndex 的跳转意图：窗口保持在这页，直到真正的滚动事件重新规划。 */
  private revealHold = false;
  private snapshot: UniformListWindowSnapshot;
  private listeners = new Set<() => void>();

  constructor(host: UniformListWindowHost, options: UniformListWindowOptions = {}) {
    this.host = host;
    this.pageSize = Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE));
    this.overscanPx = Math.max(0, options.overscanPx ?? DEFAULT_OVERSCAN_PX);
    this.defaultStride = Math.max(1, options.estimateStridePx ?? DEFAULT_ESTIMATE_STRIDE_PX);
    this.stride = this.defaultStride;
    this.snapshot = this.buildSnapshot();
    if (options.initialCount !== undefined && options.initialCount > 0) this.setCount(options.initialCount);
  }

  /** 用空宿主推演首帧快照，供 useState 初始化与 SSR 使用。 */
  static initialSnapshot(count: number, options: UniformListWindowOptions = {}): UniformListWindowSnapshot {
    const model = new UniformListWindowModel(NULL_HOST, options);
    if (count > 0) model.setCount(count);
    return model.getSnapshot();
  }

  getSnapshot(): UniformListWindowSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setCount(next: number): void {
    const nextCount = Math.max(0, Math.floor(next));
    if (nextCount === this.count) return;
    const previousCount = this.count;
    this.count = nextCount;
    this.revealHold = false;
    this.pinned = this.pinned.filter((index) => index < nextCount);
    if (nextCount === 0) {
      this.commit(0, 0);
      return;
    }
    if (previousCount === 0) {
      this.commit(0, this.windowed ? Math.min(nextCount, this.pageSize) : nextCount);
      return;
    }
    if (!this.windowed) {
      this.commit(0, nextCount);
      return;
    }
    const start = clampIndex(this.start, nextCount - 1);
    const end = Math.min(nextCount, Math.max(start + 1, this.end));
    this.commit(start, end);
  }

  /** 必须保持挂载的条目下标（键盘焦点等）。只做邻近合并，绝不把窗口从可视区拽走。 */
  setPinned(indices: ReadonlyArray<number>): void {
    const next = indices.filter((index) => Number.isInteger(index) && index >= 0 && index < this.count);
    const same = next.length === this.pinned.length && next.every((index, position) => index === this.pinned[position]);
    if (same) return;
    this.pinned = [...next];
  }

  /** 把窗口移到能盖住目标下标的一页并同步完成重渲染（键盘导航、跳转用）。
   * 窗口保持在这页直到真正的滚动事件到来（随后由调用方把目标行滚动到可见）。 */
  ensureIndex(index: number): void {
    if (!this.windowed || this.count === 0) return;
    const target = Math.min(Math.max(0, Math.floor(index)), this.count - 1);
    if (target >= this.start && target < this.end) return;
    const half = Math.floor(this.pageSize / 2);
    const start = Math.max(0, Math.min(target - half, this.count - this.pageSize));
    const end = Math.min(this.count, Math.max(start + this.pageSize, target + 1));
    this.revealHold = true;
    this.commit(start, end);
  }

  /** 滚动事件后重算窗口：跳转意图由真实滚动消费。 */
  sync(): void {
    this.revealHold = false;
    this.plan("sync");
  }

  /** 提交布局后测量节距并校正锚点；跳转意图保持期间不按视口重规划。 */
  syncAfterCommit(): void {
    this.plan("commit");
  }

  private plan(phase: "sync" | "commit"): void {
    if (this.count === 0) {
      this.commit(0, 0);
      return;
    }
    const anchor = this.host.readAnchor();
    if (anchor && Number.isFinite(anchor.top) && Number.isFinite(anchor.stride) && anchor.stride > 0) {
      this.stride = anchor.stride;
      // 首个挂载子元素对应当前窗口的 start 下标；由此反推虚拟第 0 条的位置。
      this.item0Top = anchor.top - this.start * this.stride;
    }
    if (!this.windowed) {
      this.commit(0, this.count);
      return;
    }
    if (this.item0Top === null) return;
    if (phase === "commit" && this.revealHold) return;
    const viewport = this.host.readViewport();
    if (!viewport) return;
    const { start, end } = this.planRange(viewport);
    this.commit(start, end);
  }

  private get windowed(): boolean {
    return this.count >= this.pageSize * FULL_RENDER_LIMIT_FACTOR;
  }

  private planRange(viewport: { top: number; bottom: number }): WindowRange {
    const top = viewport.top - this.overscanPx;
    const bottom = viewport.bottom + this.overscanPx;
    const first = clampIndex(Math.floor((top - this.item0Top!) / this.stride), this.count);
    const last = clampIndex(Math.ceil((bottom - this.item0Top!) / this.stride), this.count);
    let range: WindowRange;
    if (last <= first) {
      // 视口与列表不相交：只保留最靠近视口的一个条目作为测量锚点，
      // 滚回来时它仍然在 DOM 里，窗口可以立刻恢复。
      const start = bottom <= this.item0Top! ? 0 : Math.min(this.count - 1, first);
      range = { start, end: start + 1 };
    } else {
      range = { start: first, end: last };
      if (range.end - range.start < this.pageSize) {
        range.end = Math.min(this.count, Math.max(range.end, range.start + this.pageSize));
        range.start = Math.max(0, range.end - this.pageSize);
      }
    }
    return this.mergePinned(range.start, range.end);
  }

  /** pinned 贴近窗口时只做最小扩展；远离视口时忽略——鼠标滚动不被键盘光标拽走，
   * 远处的 pinned 行由 ensureIndex 按需挂载。 */
  private mergePinned(start: number, end: number): WindowRange {
    if (!this.pinned.length) return { start, end };
    const pinnedMin = Math.min(...this.pinned);
    const pinnedMax = Math.max(...this.pinned);
    if (pinnedMax < start - this.pageSize || pinnedMin >= end + this.pageSize) {
      return { start, end };
    }
    return { start: Math.min(start, pinnedMin), end: Math.max(end, pinnedMax + 1) };
  }

  private buildSnapshot(): UniformListWindowSnapshot {
    const windowed = this.count > 0 && this.windowed;
    const start = windowed ? this.start : 0;
    const end = windowed ? this.end : this.count;
    return {
      count: this.count,
      start,
      end,
      topPad: windowed ? start * this.stride : 0,
      bottomPad: windowed ? (this.count - end) * this.stride : 0,
      windowed,
      stride: this.stride,
    };
  }

  private commit(start: number, end: number): void {
    this.start = start;
    this.end = end;
    const next = this.buildSnapshot();
    const current = this.snapshot;
    const same = next.count === current.count && next.start === current.start && next.end === current.end
      && next.topPad === current.topPad && next.bottomPad === current.bottomPad
      && next.windowed === current.windowed && next.stride === current.stride;
    if (same) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

function rowGapOf(element: HTMLElement): number {
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return 0;
  const gap = Number.parseFloat(window.getComputedStyle(element).rowGap);
  return Number.isFinite(gap) ? gap : 0;
}

export type UseUniformListWindowProps = {
  count: number;
  /** 列表条目容器：它的首个子元素必须是当前窗口的第一条。 */
  listRef: React.RefObject<HTMLElement | null>;
  /** 由列表元素找到滚动容器；找不到时窗口保持初始值（键盘跳转仍可用）。 */
  findScroller: (list: HTMLElement) => HTMLElement | null;
  pageSize?: number;
  overscanPx?: number;
  estimateStridePx?: number;
  /** 必须保持挂载的条目下标（键盘光标、当前选中等）。 */
  pinned?: ReadonlyArray<number>;
};

export type UniformListWindowController = {
  snapshot: UniformListWindowSnapshot;
  /** 把窗口扩大到包含目标下标并同步完成重渲染（事件处理器内可用）。 */
  ensureIndex: (index: number) => void;
};

/** 把等高列表窗口规划器接到列表容器上：滚动监听、尺寸变化重测与提交后同步。 */
export function useUniformListWindow({
  count,
  listRef,
  findScroller,
  pageSize,
  overscanPx,
  estimateStridePx,
  pinned = [],
}: UseUniformListWindowProps): UniformListWindowController {
  const [model] = React.useState(() => new UniformListWindowModel({
    readViewport: () => {
      const list = listRef.current;
      if (!list) return null;
      const scroller = findScroller(list);
      if (!scroller) return null;
      const rect = scroller.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    },
    readAnchor: () => {
      const list = listRef.current;
      if (!list) return null;
      const node = list.firstElementChild as HTMLElement | null;
      if (!node) return null;
      const stride = node.offsetHeight + rowGapOf(list);
      if (!(stride > 0)) return null;
      return { top: node.getBoundingClientRect().top, stride };
    },
  }, { pageSize, overscanPx, estimateStridePx, initialCount: count }));

  const subscribe = React.useCallback((listener: () => void) => model.subscribe(listener), [model]);
  const getSnapshot = React.useCallback(() => model.getSnapshot(), [model]);
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  React.useLayoutEffect(() => {
    model.setCount(count);
    model.setPinned(pinned);
    model.syncAfterCommit();
  });

  React.useEffect(() => {
    const list = listRef.current;
    const scroller = list ? findScroller(list) : null;
    if (!scroller) return;
    const onScroll = () => model.sync();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [model, listRef, findScroller]);

  React.useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const scroller = findScroller(list);
    const observer = new ResizeObserver(() => model.syncAfterCommit());
    observer.observe(list);
    if (scroller) observer.observe(scroller);
    return () => observer.disconnect();
  }, [model, listRef, findScroller]);

  const ensureIndex = React.useCallback((index: number) => {
    flushSync(() => model.ensureIndex(index));
  }, [model]);

  return { snapshot, ensureIndex };
}
