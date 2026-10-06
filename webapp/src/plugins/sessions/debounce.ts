/** 尾沿防抖句柄：waitMs 内重复 push 只保留最后一次，cancel 丢弃未触发的回调。 */
export type Debouncer = {
  push(): void;
  cancel(): void;
  readonly pending: boolean;
};

/** 尾沿防抖。调度与取消可注入，便于用假计时器做单元测试。 */
export function createDebouncer(
  waitMs: number,
  run: () => void,
  schedule: (callback: () => void, ms: number) => unknown = (callback, ms) => setTimeout(callback, ms),
  cancelScheduled: (handle: unknown) => void = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
): Debouncer {
  let handle: unknown = undefined;
  const fire = () => {
    handle = undefined;
    run();
  };
  return {
    push() {
      if (handle !== undefined) cancelScheduled(handle);
      handle = schedule(fire, waitMs);
    },
    cancel() {
      if (handle === undefined) return;
      cancelScheduled(handle);
      handle = undefined;
    },
    get pending() {
      return handle !== undefined;
    },
  };
}
