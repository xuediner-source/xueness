import React from "react";
import { flushSync } from "react-dom";

/**
 * 时间线窗口化（虚拟列表）规划器。
 *
 * 长会话只渲染可视区附近的条目，其余高度由上下垫片补齐；垫片高度来自
 * 前缀和（已渲染条目用实测高度，未渲染条目用已测平均高度估计）。滚动、
 * 追加或窗口移动后以视口顶部的条目为锚点：重算前缀和后把 scrollTop 平移
 * 相同的差值，保证画面内容不跳动；贴着尾部时则改为直接贴合底部。
 * 所有布局依赖通过 TimelineWindowHost 注入，便于用假宿主做单元测试。
 */

export type TimelineViewportMeasure = {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
};

/** 滚动容器的最小接口。 */
export type TimelineWindowHost = {
  readViewport(): TimelineViewportMeasure | null;
  setScrollTop(top: number): void;
  /** 实测某个条目的渲染高度；未渲染或无法测量时返回 null。 */
  measureEntry(index: number): number | null;
  readRowGap(): number;
};

export type TimelineWindowSnapshot = {
  count: number;
  start: number;
  end: number;
  topPad: number;
  bottomPad: number;
  windowed: boolean;
  estimate: number;
};

export type TimelineWindowOptions = {
  /** 是否启用窗口化；关闭时完整渲染（短会话与未启用的调用方）。 */
  enabled?: boolean;
  /** 打开会话时窗口是否定位在末尾（自动滚动开启的会话从底部呈现）。 */
  initialTail?: boolean;
  /** 窗口最少渲染的条数。 */
  pageSize?: number;
  /** 视口上下额外渲染的像素。 */
  overscanPx?: number;
  /** 未测量条目的默认高度估计。 */
  estimatePx?: number;
  /** 距底部小于该像素视为“贴着尾部”。 */
  tailThresholdPx?: number;
  /** 构造时已知的条目数，用于渲染首帧（含 SSR）的初始窗口。 */
  initialCount?: number;
};

const DEFAULT_PAGE_SIZE = 32;
const DEFAULT_OVERSCAN_PX = 800;
const DEFAULT_ESTIMATE_PX = 140;
const DEFAULT_TAIL_THRESHOLD_PX = 80;
/** 条数低于该倍数时完整渲染，短会话保持原有行为。 */
const FULL_RENDER_LIMIT_FACTOR = 2;

const NULL_HOST: TimelineWindowHost = {
  readViewport: () => null,
  setScrollTop: () => {},
  measureEntry: () => null,
  readRowGap: () => 0,
};

type WindowRange = { start: number; end: number };

function isAwayFromTail(scrollHeight: number, scrollTop: number, clientHeight: number, thresholdPx: number): boolean {
  return Math.max(0, scrollHeight - scrollTop - clientHeight) >= thresholdPx;
}

/** 在前缀和数组中找最后一个 prefix[i] <= offset 的下标。 */
function indexAtOffset(prefix: readonly number[], offset: number): number {
  const lastIndex = prefix.length - 1;
  if (lastIndex < 0 || offset < prefix[0]!) return 0;
  if (offset >= prefix[lastIndex]!) return lastIndex;
  let low = 0;
  let high = lastIndex;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (prefix[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

export class TimelineWindowModel {
  private host: TimelineWindowHost;
  private initialTail: boolean;
  private pageSize: number;
  private overscanPx: number;
  private defaultEstimate: number;
  private tailThresholdPx: number;

  private enabled: boolean;
  private count = 0;
  private range: WindowRange = { start: 0, end: 0 };
  private heights = new Map<number, number>();
  private measuredSum = 0;
  private measuredCount = 0;
  private estimate: number;
  private gap = 0;
  private prefix: number[] = [0];
  private prefixDirty = true;
  private revealPending = false;
  /** 跟随尾部的意图：只由滚动事件更新，条目增长（估计→实测）不改写它。 */
  private tailSticky: boolean;
  private snapshot: TimelineWindowSnapshot;
  private listeners = new Set<() => void>();

  constructor(host: TimelineWindowHost, options: TimelineWindowOptions = {}) {
    this.host = host;
    this.enabled = options.enabled !== false;
    this.initialTail = options.initialTail === true;
    this.tailSticky = this.initialTail;
    this.pageSize = Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE));
    this.overscanPx = Math.max(0, options.overscanPx ?? DEFAULT_OVERSCAN_PX);
    this.defaultEstimate = Math.max(1, options.estimatePx ?? DEFAULT_ESTIMATE_PX);
    this.estimate = this.defaultEstimate;
    this.tailThresholdPx = Math.max(1, options.tailThresholdPx ?? DEFAULT_TAIL_THRESHOLD_PX);
    this.snapshot = this.buildSnapshot();
    if (options.initialCount !== undefined && options.initialCount > 0) this.setCount(options.initialCount);
  }

  /** 用空宿主推演首帧快照，供 useState 初始化与 SSR 使用。 */
  static initialSnapshot(count: number, options: TimelineWindowOptions = {}): TimelineWindowSnapshot {
    const model = new TimelineWindowModel(NULL_HOST, options);
    if (count > 0) model.setCount(count);
    return model.getSnapshot();
  }

  getSnapshot(): TimelineWindowSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.prefixDirty = true;
    this.range = this.enabled
      ? this.planRangeAfterCountChange(this.count, this.range.end)
      : { start: 0, end: this.count };
    this.notify();
  }

  setCount(next: number): void {
    const nextCount = Math.max(0, Math.floor(next));
    if (nextCount === this.count) return;
    const previousCount = this.count;
    const previousEnd = this.range.end;
    if (nextCount < previousCount) {
      // 列表收缩（会话切换、历史截断）后旧测量不再可信。
      this.heights.clear();
      this.measuredSum = 0;
      this.measuredCount = 0;
      this.estimate = this.defaultEstimate;
    }
    this.count = nextCount;
    this.prefixDirty = true;
    this.range = this.planRangeAfterCountChange(previousCount, previousEnd);
    this.notify();
  }

  /** 滚动事件：按最新滚动位置平移窗口，并更新跟随尾部的意图。 */
  onScrolled(): void {
    if (!this.windowed || this.count === 0) return;
    const viewport = this.host.readViewport();
    if (!viewport) return;
    this.tailSticky = !isAwayFromTail(viewport.scrollHeight, viewport.scrollTop, viewport.clientHeight, this.tailThresholdPx);
    const next = this.computeWindow(viewport.scrollTop, viewport.clientHeight, this.ensurePrefix());
    if (next.start !== this.range.start || next.end !== this.range.end) {
      this.range = next;
      this.notify();
    }
  }

  /** 提交后（布局阶段）执行：测量窗口条目、补偿锚点或贴合尾部。 */
  syncAfterCommit(): void {
    if (!this.enabled || this.count === 0) return;
    const gap = this.host.readRowGap();
    if (Number.isFinite(gap) && gap >= 0 && gap !== this.gap) {
      this.gap = gap;
      this.prefixDirty = true;
    }
    if (!this.windowed) return;
    const viewport = this.host.readViewport();
    if (!viewport) return;

    this.measureWindow();
    // 距底部是否足够近只用于“重新粘住”；离开尾部必须由滚动事件判定，
    // 否则追加条目导致的高度增长会被误读为用户离开。
    if (!isAwayFromTail(viewport.scrollHeight, viewport.scrollTop, viewport.clientHeight, this.tailThresholdPx)) {
      this.tailSticky = true;
    }
    const atTail = this.tailSticky;
    // reveal 跳转后的首次提交只做测量：旧 scrollTop 可能超出新布局高度，
    // 此时锚点补偿与贴底跟随都会把窗口拉回原处，撤销跳转意图。
    if (this.revealPending) {
      this.revealPending = false;
      this.refreshSnapshotIfChanged();
      return;
    }
    let followedTail = false;
    if (this.prefixDirty) {
      const previousPrefix = this.prefix;
      this.ensurePrefix();
      if (atTail) {
        this.host.setScrollTop(viewport.scrollHeight);
        followedTail = true;
      } else if (previousPrefix.length >= 2) {
        this.compensateAnchor(previousPrefix, viewport);
      }
    } else if (atTail && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 1) {
      this.host.setScrollTop(viewport.scrollHeight);
      followedTail = true;
    }
    // 贴底写入后窗口必须同步覆盖尾部，不能等下一次 scroll 事件。
    if (followedTail) {
      const next = this.computeWindow(viewport.scrollHeight, viewport.clientHeight, this.ensurePrefix());
      if (next.start !== this.range.start || next.end !== this.range.end) this.range = next;
    }
    // 测量会更新估计与垫片高度；窗口未变时也要把新快照同步给订阅者。
    this.refreshSnapshotIfChanged();
  }

  /** 跳转到指定条目：把窗口直接移到目标附近（由调用方决定随后如何滚动）。 */
  reveal(index: number): void {
    if (!this.windowed || this.count === 0) return;
    const target = Math.min(Math.max(0, Math.floor(index)), this.count - 1);
    const half = Math.ceil(this.pageSize / 2);
    const start = Math.max(0, Math.min(target - half, this.count - this.pageSize));
    const end = Math.min(this.count, Math.max(start + this.pageSize, target + 1));
    if (start === this.range.start && end === this.range.end) return;
    this.range = { start, end };
    this.revealPending = true;
    // 跳转是明确的用户意图：挂起贴底跟随，直到滚动事件重新判定位置。
    this.tailSticky = false;
    this.notify();
  }

  private get windowed(): boolean {
    return this.enabled && this.count >= this.pageSize * FULL_RENDER_LIMIT_FACTOR;
  }

  private planRangeAfterCountChange(previousCount: number, previousEnd: number): WindowRange {
    if (!this.enabled || this.count === 0) return { start: 0, end: this.count };
    if (this.count < this.pageSize * FULL_RENDER_LIMIT_FACTOR) return { start: 0, end: this.count };
    if (previousCount === 0) {
      return this.initialTail
        ? { start: Math.max(0, this.count - this.pageSize), end: this.count }
        : { start: 0, end: Math.min(this.count, this.pageSize) };
    }
    if (previousEnd >= previousCount) {
      // 之前已渲染到末尾（含流式追加）：继续带住新的尾部。
      return { start: Math.max(0, this.count - this.pageSize), end: this.count };
    }
    const start = Math.min(Math.max(0, this.range.start), this.count - 1);
    return { start, end: Math.min(Math.max(start + 1, this.range.end), this.count) };
  }

  private computeWindow(scrollTop: number, clientHeight: number, prefix: number[]): WindowRange {
    const top = Math.max(0, scrollTop - this.overscanPx);
    const bottom = scrollTop + clientHeight + this.overscanPx;
    let start = indexAtOffset(prefix, top);
    let end = Math.min(this.count, indexAtOffset(prefix, bottom) + 1);
    if (end - start < this.pageSize) {
      end = Math.min(this.count, start + this.pageSize);
      if (end - start < this.pageSize) start = Math.max(0, end - this.pageSize);
    }
    return { start: Math.min(start, Math.max(0, this.count - 1)), end: Math.max(end, Math.min(this.count, start + 1)) };
  }

  private compensateAnchor(previousPrefix: readonly number[], viewport: TimelineViewportMeasure): void {
    const anchor = indexAtOffset(previousPrefix, viewport.scrollTop);
    if (anchor >= this.count) return;
    const slot = Math.max(0, this.prefix[anchor + 1]! - this.prefix[anchor]!);
    const offset = Math.min(Math.max(0, viewport.scrollTop - previousPrefix[anchor]!), slot);
    const nextTop = this.prefix[anchor]! + offset;
    if (Math.abs(nextTop - viewport.scrollTop) >= 1) this.host.setScrollTop(nextTop);
  }

  private measureWindow(): void {
    let changed = false;
    for (let index = this.range.start; index < this.range.end; index += 1) {
      const height = this.host.measureEntry(index);
      if (height == null || !Number.isFinite(height) || height <= 0) continue;
      const previous = this.heights.get(index);
      if (previous !== undefined && Math.abs(previous - height) <= 0.5) continue;
      if (previous === undefined) {
        this.measuredCount += 1;
        this.measuredSum += height;
      } else {
        this.measuredSum += height - previous;
      }
      this.heights.set(index, height);
      changed = true;
    }
    if (changed) {
      this.estimate = this.measuredCount > 0 ? this.measuredSum / this.measuredCount : this.defaultEstimate;
      this.prefixDirty = true;
    }
  }

  private heightOf(index: number): number {
    return this.heights.get(index) ?? this.estimate;
  }

  private ensurePrefix(): number[] {
    if (!this.prefixDirty) return this.prefix;
    const prefix = new Array<number>(this.count + 1);
    prefix[0] = 0;
    for (let index = 0; index < this.count; index += 1) {
      prefix[index + 1] = prefix[index]! + this.heightOf(index) + this.gap;
    }
    this.prefix = prefix;
    this.prefixDirty = false;
    return prefix;
  }

  private buildSnapshot(): TimelineWindowSnapshot {
    const windowed = this.windowed;
    const start = windowed ? this.range.start : 0;
    const end = windowed ? this.range.end : this.count;
    let topPad = 0;
    let bottomPad = 0;
    if (windowed && this.count > 0) {
      const prefix = this.ensurePrefix();
      if (start > 0) topPad = Math.max(0, prefix[start]! - this.gap);
      if (end < this.count) bottomPad = Math.max(0, prefix[this.count]! - prefix[end]! - this.gap);
    }
    return { count: this.count, start, end, topPad, bottomPad, windowed, estimate: this.estimate };
  }

  private notify(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  private refreshSnapshotIfChanged(): void {
    const next = this.buildSnapshot();
    const current = this.snapshot;
    const same = next.count === current.count && next.start === current.start && next.end === current.end
      && next.topPad === current.topPad && next.bottomPad === current.bottomPad
      && next.windowed === current.windowed && next.estimate === current.estimate;
    if (same) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

function findTimelineScroller(stream: HTMLElement | null): HTMLElement | null {
  return stream?.closest<HTMLElement>(".xn-conversation__stream") ?? null;
}

type UseTimelineVirtualWindowProps = {
  count: number;
  enabled: boolean;
  initialTail: boolean;
};

export type TimelineVirtualWindowController = {
  snapshot: TimelineWindowSnapshot;
  streamRef: React.RefObject<HTMLDivElement | null>;
  /** 窗口移动到目标条目附近并同步完成重渲染（供历史轨道跳转使用）。 */
  reveal: (index: number) => void;
};

/** 把窗口规划器接到时间线流容器上：滚动监听、提交后测量与尺寸变化重测。 */
export function useTimelineVirtualWindow({ count, enabled, initialTail }: UseTimelineVirtualWindowProps): TimelineVirtualWindowController {
  const streamRef = React.useRef<HTMLDivElement | null>(null);
  const [model] = React.useState(() => new TimelineWindowModel({
    readViewport: () => {
      const scroller = findTimelineScroller(streamRef.current);
      return scroller
        ? { scrollTop: scroller.scrollTop, clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight }
        : null;
    },
    setScrollTop: (top) => {
      const scroller = findTimelineScroller(streamRef.current);
      if (scroller) scroller.scrollTop = top;
    },
    measureEntry: (index) => {
      const stream = streamRef.current;
      if (!stream) return null;
      const node = stream.querySelector<HTMLElement>(`[data-window-index="${index}"]`);
      return node ? node.getBoundingClientRect().height : null;
    },
    readRowGap: () => {
      const stream = streamRef.current;
      if (!stream || typeof window === "undefined" || typeof window.getComputedStyle !== "function") return 0;
      const gapValue = Number.parseFloat(window.getComputedStyle(stream).rowGap);
      return Number.isFinite(gapValue) ? gapValue : 0;
    },
  }, { enabled, initialTail, initialCount: count }));

  const subscribe = React.useCallback((listener: () => void) => model.subscribe(listener), [model]);
  const getSnapshot = React.useCallback(() => model.getSnapshot(), [model]);
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  React.useLayoutEffect(() => {
    model.setEnabled(enabled);
    model.setCount(count);
  });

  React.useLayoutEffect(() => {
    model.syncAfterCommit();
  });

  React.useEffect(() => {
    const scroller = findTimelineScroller(streamRef.current);
    if (!scroller) return;
    const onScroll = () => model.onScrolled();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [model]);

  React.useEffect(() => {
    const stream = streamRef.current;
    if (!stream || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => model.syncAfterCommit());
    observer.observe(stream);
    return () => observer.disconnect();
  }, [model]);

  const reveal = React.useCallback((index: number) => {
    flushSync(() => model.reveal(index));
  }, [model]);

  return { snapshot, streamRef, reveal };
}
