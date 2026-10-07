// 会话滚动记忆：按 sessionId 记住用户上次的滚动位置，会话切换回来时恢复。
//
// 纯内存 Map（不持久化到磁盘），上限 200 条 LRU——最早写入/读取的条目先被淘汰。

export interface SessionScrollMemoryState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** 上次离开时是否贴底（pinned → 恢复时直接贴底）。 */
  wasPinnedToBottom?: boolean;
  updatedAt: number;
}

const SESSION_SCROLL_MEMORY_MAX_ENTRIES = 200;

const sessionScrollMemory = new Map<string, SessionScrollMemoryState>();

function normalizeKeyPart(value?: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function touchSessionScrollMemoryEntry(
  key: string,
  state: SessionScrollMemoryState,
): SessionScrollMemoryState {
  sessionScrollMemory.delete(key);
  sessionScrollMemory.set(key, state);
  return state;
}

function pruneSessionScrollMemory(): void {
  while (sessionScrollMemory.size > SESSION_SCROLL_MEMORY_MAX_ENTRIES) {
    const oldestKey = sessionScrollMemory.keys().next().value;
    if (!oldestKey) {
      return;
    }

    sessionScrollMemory.delete(oldestKey);
  }
}

/**
 * 按 xueness sessionId 简化的记忆 key。
 * sessionId 为空时返回 null（调用方应跳过读写）。
 */
export function buildSessionScrollMemoryKey({
  sessionId,
}: {
  sessionId?: string | null;
}): string | null {
  return normalizeKeyPart(sessionId);
}

export function readSessionScrollMemoryState(
  key: string | null,
): SessionScrollMemoryState | null {
  if (!key) {
    return null;
  }

  const state = sessionScrollMemory.get(key);
  return state ? touchSessionScrollMemoryEntry(key, state) : null;
}

export function saveSessionScrollMemoryState(
  key: string | null,
  state: SessionScrollMemoryState,
): void {
  if (!key) {
    return;
  }

  touchSessionScrollMemoryEntry(key, state);
  pruneSessionScrollMemory();
}

/**
 * 恢复时的 scrollTop 钳制：恢复值落在 [0, maxScrollTop] 内，
 * 内容高度变化（新行追加/窗口 resize）后不会滚到无效位置。
 */
export function resolveScrollRestoreTop(
  state: Pick<SessionScrollMemoryState, "scrollTop">,
  metrics: Pick<HTMLElement, "clientHeight" | "scrollHeight">,
): number {
  const maxScrollTop = Math.max(metrics.scrollHeight - metrics.clientHeight, 0);
  return Math.min(Math.max(state.scrollTop, 0), maxScrollTop);
}
