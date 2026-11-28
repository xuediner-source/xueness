import { get, post } from "../../xuenessApi";
import { resolveHostPlatform } from "../../xuenessShortcutDisplay";

export type DesktopPermissionId = "accessibility" | "screen" | "fullDisk" | "microphone";
export type DesktopPermissionStatus = "granted" | "not-determined" | "denied" | "restricted" | "unknown" | "unsupported";
export type DesktopPermission = {
  id: DesktopPermissionId;
  status: DesktopPermissionStatus;
  canRequest: boolean;
  requiresRestart?: boolean;
};
export type DesktopPermissionSnapshot = { platform: string; permissions: DesktopPermission[] };

export const PERMISSION_IDS: DesktopPermissionId[] = ["accessibility", "screen", "fullDisk", "microphone"];
const KNOWN_STATUSES = new Set<DesktopPermissionStatus>(["granted", "not-determined", "denied", "restricted", "unknown", "unsupported"]);
export const DESKTOP_MARKER = "xuenessDesktop";
export const REOPEN_EVENT = "xueness:permissions-open";

export function isDesktopOnboardingAvailable(enabled: boolean, desktopEnabled: boolean, search: string): boolean {
  return enabled && desktopEnabled && new URLSearchParams(search).get(DESKTOP_MARKER) === "1";
}

export function initialDesktopPermissionPlatform(platform?: string): string {
  if (!platform) return "unknown";
  const host = resolveHostPlatform(platform);
  if (host === "windows") return "win32";
  if (host === "macos") return "darwin";
  // Unknown and non-macOS platforms should not briefly show macOS-only setup
  // while the native permission snapshot is still loading.
  return "unknown";
}

export function desktopPermissionActionLabel(platform: string, id: DesktopPermissionId, status: DesktopPermissionStatus): string {
  // Windows has no in-app microphone consent prompt; the native action opens
  // Windows Privacy settings, so make that destination clear on the button.
  return id === "microphone" && status === "not-determined" && platform !== "win32" ? "允许麦克风" : "打开系统设置";
}

export function normalizeDesktopPermissionSnapshot(value: unknown): DesktopPermissionSnapshot {
  if (!value || typeof value !== "object") throw new Error("invalid desktop permission snapshot");
  const input = value as { platform?: unknown; permissions?: unknown };
  if (typeof input.platform !== "string" || !Array.isArray(input.permissions)) throw new Error("invalid desktop permission snapshot");
  const byId = new Map<DesktopPermissionId, DesktopPermission>();
  for (const raw of input.permissions) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as { id?: unknown; status?: unknown; canRequest?: unknown; requiresRestart?: unknown };
    if (!PERMISSION_IDS.includes(row.id as DesktopPermissionId)) continue;
    const id = row.id as DesktopPermissionId;
    const status = KNOWN_STATUSES.has(row.status as DesktopPermissionStatus) ? row.status as DesktopPermissionStatus : "unknown";
    byId.set(id, {
      id,
      status,
      canRequest: row.canRequest === true,
      ...(row.requiresRestart === true ? { requiresRestart: true } : {}),
    });
  }
  // The native host can only open macOS Privacy & Security settings. The app
  // cannot inspect or grant Full Disk Access, so its status always stays unknown.
  const fullDiskRequest = byId.get("fullDisk");
  byId.set("fullDisk", { id: "fullDisk", status: input.platform === "darwin" ? "unknown" : "unsupported", canRequest: input.platform === "darwin" && fullDiskRequest?.canRequest === true });
  return {
    platform: input.platform,
    permissions: PERMISSION_IDS.map(id => byId.get(id) ?? { id, status: "unknown", canRequest: false }),
  };
}

type OnboardingRecord = { completed: boolean; version: 1 };
async function readOnboardingState(signal: AbortSignal): Promise<OnboardingRecord> {
  const value = await get<OnboardingRecord>("/api/onboarding/desktop", signal);
  if (!value || typeof value.completed !== "boolean" || value.version !== 1) throw new Error("invalid desktop onboarding state");
  return value;
}

async function readPermissionSnapshot(signal: AbortSignal): Promise<DesktopPermissionSnapshot> {
  return normalizeDesktopPermissionSnapshot(await get<unknown>("/api/desktop/permissions", signal));
}

export async function requestDesktopPermission(id: DesktopPermissionId, signal?: AbortSignal): Promise<DesktopPermissionSnapshot> {
  return normalizeDesktopPermissionSnapshot(await post<unknown>("/api/desktop/permissions/request", { permission: id }, signal));
}

export async function completeDesktopPermissionOnboarding(signal?: AbortSignal): Promise<void> {
  const value = await post<OnboardingRecord>("/api/onboarding/desktop", { completed: true }, signal);
  if (!value || value.completed !== true || value.version !== 1) throw new Error("desktop onboarding state was not saved");
}

export function canRequestDesktopPermission(available: boolean, open: boolean, id: DesktopPermissionId,
  permission: DesktopPermission | undefined, busy: boolean): boolean {
  return available && open && !busy && permission?.canRequest === true
    && permission.status !== "granted" && permission.status !== "unsupported";
}

type PermissionObserverTarget = Pick<Window, "addEventListener" | "removeEventListener">;
type PermissionVisibilityTarget = Pick<Document, "addEventListener" | "removeEventListener"> & { visibilityState: DocumentVisibilityState };
type PermissionObserverScheduler = { schedule: (callback: () => void, delayMs: number) => unknown; cancel: (handle: unknown) => void };
export const DESKTOP_PERMISSION_REFRESH_INTERVAL_MS = 2000;
export type DesktopPermissionStatusObserver = { refresh: () => void; stop: () => void };

export function startDesktopOnboardingCheck({ enabled, desktopEnabled, search, read = readOnboardingState, onIncomplete, onError }: {
  enabled: boolean;
  desktopEnabled: boolean;
  search: string;
  read?: (signal: AbortSignal) => Promise<OnboardingRecord>;
  onIncomplete: () => void;
  onError: () => void;
}): () => void {
  if (!isDesktopOnboardingAvailable(enabled, desktopEnabled, search)) return () => {};
  const controller = new AbortController();
  void read(controller.signal).then(record => {
    if (!controller.signal.aborted && !record.completed) onIncomplete();
  }).catch(() => {
    if (!controller.signal.aborted) onError();
  });
  return () => controller.abort();
}

export function startDesktopPermissionStatusObserver({ enabled, desktopEnabled, search, open, read = readPermissionSnapshot,
  onSnapshot, onError, onLoading, target, visibilityTarget, scheduler, intervalMs = DESKTOP_PERMISSION_REFRESH_INTERVAL_MS }: {
  enabled: boolean;
  desktopEnabled: boolean;
  search: string;
  open: boolean;
  read?: (signal: AbortSignal) => Promise<DesktopPermissionSnapshot>;
  onSnapshot: (snapshot: DesktopPermissionSnapshot) => void;
  onError: () => void;
  onLoading: (loading: boolean) => void;
  target?: PermissionObserverTarget;
  visibilityTarget?: PermissionVisibilityTarget;
  scheduler?: PermissionObserverScheduler;
  intervalMs?: number;
}): DesktopPermissionStatusObserver {
  if (!open || !isDesktopOnboardingAvailable(enabled, desktopEnabled, search)) return { refresh: () => {}, stop: () => {} };
  const eventTarget = target ?? window;
  const visibility = visibilityTarget ?? document;
  const timers = scheduler ?? { schedule: (callback: () => void, delay: number) => window.setTimeout(callback, delay), cancel: (handle: unknown) => window.clearTimeout(handle as number) };
  let disposed = false;
  let controller: AbortController | null = null;
  let inFlight = false;
  let refreshPending = false;
  let pendingShowsLoading = false;
  let currentShowsLoading = false;
  let timer: unknown = null;
  let requestGeneration = 0;
  const visible = () => visibility.visibilityState !== "hidden";
  const clearTimer = () => {
    if (timer === null) return;
    timers.cancel(timer);
    timer = null;
  };
  const abortCurrent = (updateLoading: boolean) => {
    requestGeneration += 1;
    const current = controller;
    controller = null;
    inFlight = false;
    current?.abort();
    if (updateLoading && current) onLoading(false);
  };
  let refresh: (showLoading?: boolean) => void;
  const scheduleNext = () => {
    if (disposed || !visible() || timer !== null) return;
    timer = timers.schedule(() => {
      timer = null;
      refresh(false);
    }, intervalMs);
  };
  refresh = (showLoading = true) => {
    if (disposed || !visible()) return;
    clearTimer();
    if (inFlight) {
      refreshPending = true;
      pendingShowsLoading ||= showLoading;
      return;
    }
    const current = new AbortController();
    const generation = ++requestGeneration;
    controller = current;
    inFlight = true;
    currentShowsLoading = showLoading;
    if (showLoading) onLoading(true);
    let request: Promise<DesktopPermissionSnapshot>;
    try { request = read(current.signal); }
    catch (error) { request = Promise.reject(error); }
    void request.then(snapshot => {
      if (!disposed && !current.signal.aborted && generation === requestGeneration) onSnapshot(snapshot);
    }).catch(() => {
      if (!disposed && !current.signal.aborted && generation === requestGeneration) onError();
    }).finally(() => {
      if (disposed || controller !== current || generation !== requestGeneration) return;
      controller = null;
      inFlight = false;
      if (currentShowsLoading) onLoading(false);
      currentShowsLoading = false;
      if (refreshPending) {
        refreshPending = false;
        const nextShowsLoading = pendingShowsLoading;
        pendingShowsLoading = false;
        refresh(nextShowsLoading);
      } else scheduleNext();
    });
  };
  const onFocus = () => refresh();
  const onVisibilityChange = () => {
    if (visible()) refresh();
    else {
      clearTimer();
      refreshPending = false;
      pendingShowsLoading = false;
      const wasLoading = currentShowsLoading;
      currentShowsLoading = false;
      abortCurrent(false);
      if (wasLoading) onLoading(false);
    }
  };
  eventTarget.addEventListener("focus", onFocus);
  visibility.addEventListener("visibilitychange", onVisibilityChange);
  if (visible()) refresh();
  const stop = () => {
    disposed = true;
    clearTimer();
    refreshPending = false;
    pendingShowsLoading = false;
    eventTarget.removeEventListener("focus", onFocus);
    visibility.removeEventListener("visibilitychange", onVisibilityChange);
    const wasLoading = currentShowsLoading;
    currentShowsLoading = false;
    abortCurrent(false);
    if (wasLoading) onLoading(false);
  };
  return { refresh, stop };
}

export type OnboardingStepBody = "accessibilityScreen" | "fullDisk" | "microphone";
export type OnboardingStepArt = "accessibility" | "fullDisk" | "microphone";
export type OnboardingStep = { title: string; description: string; art: OnboardingStepArt; body: OnboardingStepBody };

export function buildOnboardingSteps(platform: string): OnboardingStep[] {
  const microphoneStep: OnboardingStep = {
    title: "麦克风",
    // Windows has no system consent dialog: requesting opens the Settings page.
    description: platform === "win32"
      ? "在 Windows 设置 → 隐私和安全性 → 麦克风中，按需允许 Xueness 使用麦克风。此步骤不会开始录音。"
      : "只在你点击下方按钮后请求系统授权。此步骤不会开始录音。",
    art: "microphone",
    body: "microphone",
  };
  if (platform === "darwin") return [
    { title: "辅助功能与屏幕录制", description: "可选的系统权限。你可以分别查看状态，或在需要时打开系统授权流程。", art: "accessibility", body: "accessibilityScreen" },
    { title: "完全磁盘访问权限", description: "在 macOS 中，你可以打开系统设置后自行决定是否开启。Xueness 不会读取此权限状态。", art: "fullDisk", body: "fullDisk" },
    microphoneStep,
  ];
  // Accessibility, screen recording and Full Disk Access are unsupported outside
  // macOS. Showing their macOS-only instructions would mislead Windows users,
  // so the wizard is trimmed to the microphone step on other platforms.
  return [microphoneStep];
}
