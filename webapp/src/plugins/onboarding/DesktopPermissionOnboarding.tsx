import React, { useCallback, useEffect, useRef, useState } from "react";
import { get, post } from "../../xuenessApi";
import { t as tr } from "../../i18n";
import { IconXuenessMark } from "../../ui/icons";
import { shouldDismissModalOnEscape, useModalFocusScope } from "../shared";
import { resolveHostPlatform } from "../../xuenessShortcutDisplay";
import "./desktop-permission-onboarding.css";

export type DesktopPermissionId = "accessibility" | "screen" | "fullDisk" | "microphone";
export type DesktopPermissionStatus = "granted" | "not-determined" | "denied" | "restricted" | "unknown" | "unsupported";
export type DesktopPermission = {
  id: DesktopPermissionId;
  status: DesktopPermissionStatus;
  canRequest: boolean;
  requiresRestart?: boolean;
};
export type DesktopPermissionSnapshot = { platform: string; permissions: DesktopPermission[] };

const PERMISSION_IDS: DesktopPermissionId[] = ["accessibility", "screen", "fullDisk", "microphone"];
const KNOWN_STATUSES = new Set<DesktopPermissionStatus>(["granted", "not-determined", "denied", "restricted", "unknown", "unsupported"]);
const DESKTOP_MARKER = "xuenessDesktop";
const REOPEN_EVENT = "xueness:permissions-open";

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

type OnboardingStepBody = "accessibilityScreen" | "fullDisk" | "microphone";
type OnboardingStepArt = "accessibility" | "fullDisk" | "microphone";
type OnboardingStep = { title: string; description: string; art: OnboardingStepArt; body: OnboardingStepBody };

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

function StatusLabel({ permission }: { permission: DesktopPermission }): React.JSX.Element {
  const manual = permission.id === "fullDisk" && permission.status === "unknown";
  const label = manual ? tr("需在系统设置中手动确认") : ({
    granted: tr("已允许"),
    "not-determined": tr("尚未询问"),
    denied: tr("未允许"),
    restricted: tr("由系统限制"),
    unknown: tr("状态未知"),
    unsupported: tr("此平台不可用"),
  } satisfies Record<DesktopPermissionStatus, string>)[permission.status];
  return <span className={`xn-desktop-permission__status is-${manual ? "manual" : permission.status}`} data-permission-status={permission.status}>
    <span className="xn-desktop-permission__status-dot" aria-hidden="true" />{label}
  </span>;
}

function StepIllustration({ art }: { art: OnboardingStepArt }): React.JSX.Element {
  if (art === "accessibility") return <svg className="xn-desktop-permission__illustration" viewBox="0 0 360 188" role="img" aria-label={tr("辅助功能与屏幕录制设置示意图")}>
    <defs><linearGradient id="xn-onboard-disk" x1="0" x2="1" y1="0" y2="1"><stop stopColor="#9db5ff" /><stop offset="1" stopColor="#6478d6" /></linearGradient></defs>
    <rect x="47" y="17" width="266" height="154" rx="19" fill="var(--bg-subtle)" stroke="var(--border-strong)" />
    <rect x="47" y="17" width="266" height="28" rx="19" fill="var(--bg-card)" />
    <path d="M47 36v9h266v-9" fill="var(--bg-card)" />
    <circle cx="65" cy="31" r="3" fill="#e48787" /><circle cx="76" cy="31" r="3" fill="#e6ba6a" /><circle cx="87" cy="31" r="3" fill="#79b892" />
    <rect x="61" y="58" width="86" height="96" rx="10" fill="var(--bg-card)" stroke="var(--border)" />
    <rect x="72" y="69" width="63" height="7" rx="3.5" fill="var(--border-strong)" />
    <rect x="72" y="85" width="52" height="7" rx="3.5" fill="var(--border)" />
    <rect x="72" y="101" width="59" height="7" rx="3.5" fill="var(--border)" />
    <rect x="72" y="117" width="47" height="7" rx="3.5" fill="var(--border)" />
    <rect x="72" y="133" width="54" height="7" rx="3.5" fill="var(--border)" />
    <rect x="160" y="58" width="137" height="42" rx="10" fill="var(--bg-card)" stroke="var(--border)" />
    <circle cx="179" cy="79" r="10" fill="#e8ebfa" /><path d="M179 72v14m-7-7h14" stroke="#6579d4" strokeWidth="1.8" strokeLinecap="round" />
    <rect x="197" y="71" width="63" height="6" rx="3" fill="var(--fg-subtle)" /><rect x="197" y="82" width="83" height="5" rx="2.5" fill="var(--border)" />
    <rect x="160" y="110" width="137" height="43" rx="10" fill="var(--bg-card)" stroke="var(--border)" />
    <rect x="174" y="121" width="29" height="19" rx="5" fill="#e8ebfa" /><path d="m184 127 10 4-10 4z" fill="#6579d4" />
    <rect x="212" y="121" width="60" height="6" rx="3" fill="var(--fg-subtle)" /><rect x="212" y="132" width="70" height="5" rx="2.5" fill="var(--border)" />
    <circle cx="291" cy="145" r="13" fill="url(#xn-onboard-disk)" /><path d="m285 145 4 4 8-9" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
  if (art === "fullDisk") return <svg className="xn-desktop-permission__illustration" viewBox="0 0 360 188" role="img" aria-label={tr("完全磁盘访问权限手动设置示意图")}>
    <rect x="70" y="18" width="220" height="153" rx="18" fill="var(--bg-subtle)" stroke="var(--border-strong)" />
    <rect x="70" y="18" width="220" height="28" rx="18" fill="var(--bg-card)" /><path d="M70 36v10h220V36" fill="var(--bg-card)" />
    <circle cx="87" cy="32" r="3" fill="#e48787" /><circle cx="98" cy="32" r="3" fill="#e6ba6a" /><circle cx="109" cy="32" r="3" fill="#79b892" />
    <circle cx="119" cy="93" r="33" fill="#e8ebfa" /><circle cx="119" cy="93" r="20" fill="none" stroke="#7589df" strokeWidth="4" />
    <circle cx="119" cy="93" r="6" fill="#7589df" /><path d="M119 67v7m0 38v7m26-26h-7m-38 0h-7m44-19-5 5m-27 27-5 5m0-37 5 5m27 27 5 5" stroke="#7589df" strokeWidth="2" strokeLinecap="round" />
    <rect x="169" y="70" width="89" height="7" rx="3.5" fill="var(--fg-subtle)" /><rect x="169" y="84" width="70" height="6" rx="3" fill="var(--border-strong)" />
    <rect x="169" y="105" width="101" height="30" rx="9" fill="var(--bg-card)" stroke="var(--border)" />
    <path d="M186 115v10m-5-5h10" stroke="#6579d4" strokeWidth="2" strokeLinecap="round" />
    <rect x="201" y="116" width="51" height="6" rx="3" fill="var(--border-strong)" />
    <path d="m274 119 23 11v22l-23 11-23-11v-22z" fill="var(--bg-card)" stroke="var(--border-strong)" />
    <path d="M274 128v13m0 0 8-5m-8 5-8-5" fill="none" stroke="#7488dc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
  return <svg className="xn-desktop-permission__illustration" viewBox="0 0 360 188" role="img" aria-label={tr("麦克风授权示意图")}>
    <rect x="91" y="20" width="178" height="148" rx="24" fill="var(--bg-subtle)" stroke="var(--border-strong)" />
    <rect x="106" y="35" width="148" height="118" rx="17" fill="var(--bg-card)" stroke="var(--border)" />
    <circle cx="180" cy="87" r="39" fill="#edf0ff" />
    <rect x="171" y="58" width="18" height="48" rx="9" fill="#7185dc" />
    <path d="M160 85v5a20 20 0 0 0 40 0v-5m-20 25v12m-13 0h26" fill="none" stroke="#7185dc" strokeWidth="4" strokeLinecap="round" />
    <path d="M125 70h11m-11 11h8m91-11h11m-11 11h8M128 120h13m78 0h13" stroke="var(--border-strong)" strokeWidth="3" strokeLinecap="round" />
    <circle cx="274" cy="135" r="17" fill="#e8ebfa" /><path d="m267 135 5 5 9-11" fill="none" stroke="#6579d4" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

export function DesktopPermissionOnboarding({ enabled, desktopEnabled, reopenSignal }: {
  enabled: boolean;
  desktopEnabled: boolean;
  reopenSignal?: number;
}): React.JSX.Element | null {
  const desktopMarker = typeof window !== "undefined" && isDesktopOnboardingAvailable(enabled, desktopEnabled, window.location.search);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [platform, setPlatform] = useState(() => initialDesktopPermissionPlatform(typeof navigator === "undefined" ? undefined : navigator.platform));
  const [permissions, setPermissions] = useState<Record<DesktopPermissionId, DesktopPermission>>(() => Object.fromEntries(
    PERMISSION_IDS.map(id => [id, { id, status: "unknown", canRequest: false }]),
  ) as Record<DesktopPermissionId, DesktopPermission>);
  const [readingPermissions, setReadingPermissions] = useState(false);
  const [permissionError, setPermissionError] = useState("");
  const [completionError, setCompletionError] = useState("");
  const [saving, setSaving] = useState(false);
  const [requesting, setRequesting] = useState<DesktopPermissionId | null>(null);
  const [openRefreshSequence, setOpenRefreshSequence] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const laterRef = useRef<HTMLButtonElement>(null);
  const savingRef = useRef(false);
  const activeRef = useRef(desktopMarker);
  const mountedRef = useRef(false);
  const lifecycleGeneration = useRef(0);
  const postController = useRef<AbortController | null>(null);
  const statusObserver = useRef<DesktopPermissionStatusObserver | null>(null);
  activeRef.current = desktopMarker;
  const previousReopenSignal = useRef(reopenSignal);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      lifecycleGeneration.current += 1;
      postController.current?.abort();
      postController.current = null;
    };
  }, []);
  useEffect(() => {
    if (desktopMarker) return;
    lifecycleGeneration.current += 1;
    postController.current?.abort();
    postController.current = null;
    savingRef.current = false;
    setSaving(false);
    setRequesting(null);
    setReadingPermissions(false);
  }, [desktopMarker]);
  useEffect(() => {
    if (open && desktopMarker) return;
    if (savingRef.current) return;
    postController.current?.abort();
    postController.current = null;
  }, [open, desktopMarker]);

  useModalFocusScope({ open: open && desktopMarker, dialogRef, initialFocusRef: laterRef });

  useEffect(() => {
    if (!desktopMarker) {
      setOpen(false);
      setPermissions(Object.fromEntries(PERMISSION_IDS.map(id => [id, { id, status: "unknown", canRequest: false }])) as Record<DesktopPermissionId, DesktopPermission>);
      setPermissionError("");
      setCompletionError("");
      return;
    }
    return startDesktopOnboardingCheck({
      enabled,
      desktopEnabled,
      search: window.location.search,
      onIncomplete: () => { if (activeRef.current) { setStep(0); setOpen(true); } },
      onError: () => {
        if (!activeRef.current) return;
        setCompletionError(tr("无法读取首次设置状态；你仍可继续，完成时会再次保存。"));
        setStep(0);
        setOpen(true);
      },
    });
  }, [desktopMarker, enabled, desktopEnabled]);

  useEffect(() => {
    if (!desktopMarker) return;
    const reopen = () => {
      if (!activeRef.current) return;
      setStep(0);
      setPermissionError("");
      setCompletionError("");
      setOpen(true);
      setOpenRefreshSequence(value => value + 1);
    };
    window.addEventListener(REOPEN_EVENT, reopen);
    return () => window.removeEventListener(REOPEN_EVENT, reopen);
  }, [desktopMarker]);

  useEffect(() => {
    if (!desktopMarker || reopenSignal === undefined) { previousReopenSignal.current = reopenSignal; return; }
    if (previousReopenSignal.current !== reopenSignal) {
      previousReopenSignal.current = reopenSignal;
      setStep(0);
      setPermissionError("");
      setCompletionError("");
      setOpen(true);
      setOpenRefreshSequence(value => value + 1);
    }
  }, [desktopMarker, reopenSignal]);

  useEffect(() => {
    if (!open || !desktopMarker || saving || requesting) {
      statusObserver.current = null;
      return;
    }
    const observer = startDesktopPermissionStatusObserver({
      enabled,
      desktopEnabled,
      search: window.location.search,
      open,
      onSnapshot: snapshot => {
        if (!activeRef.current) return;
        setPermissions(Object.fromEntries(snapshot.permissions.map(row => [row.id, row])) as Record<DesktopPermissionId, DesktopPermission>);
        setPlatform(snapshot.platform);
        setPermissionError("");
      },
      onError: () => { if (activeRef.current) setPermissionError(tr("无法读取系统权限状态。你可以稍后刷新，或跳过此设置。")); },
      onLoading: loading => { if (mountedRef.current && activeRef.current) setReadingPermissions(loading); },
    });
    statusObserver.current = observer;
    return () => {
      if (statusObserver.current === observer) statusObserver.current = null;
      observer.stop();
    };
  }, [open, desktopMarker, openRefreshSequence, enabled, desktopEnabled, saving, requesting]);

  const dismiss = useCallback(() => {
    if (savingRef.current) return;
    setOpen(false);
  }, []);

  const finish = useCallback(async () => {
    if (!desktopMarker || savingRef.current) return;
    const generation = lifecycleGeneration.current;
    const isCurrent = () => mountedRef.current && activeRef.current && generation === lifecycleGeneration.current;
    const controller = new AbortController();
    postController.current?.abort();
    postController.current = controller;
    savingRef.current = true;
    setSaving(true);
    setCompletionError("");
    try {
      await completeDesktopPermissionOnboarding(controller.signal);
      if (isCurrent()) setOpen(false);
    } catch {
      if (!controller.signal.aborted && isCurrent()) setCompletionError(tr("无法保存设置状态。请检查连接后重试；此窗口会保持打开。"));
    } finally {
      savingRef.current = false;
      if (postController.current === controller) postController.current = null;
      if (isCurrent()) setSaving(false);
    }
  }, [desktopMarker]);

  const requestSystemPermission = useCallback(async (id: DesktopPermissionId) => {
    if (!canRequestDesktopPermission(desktopMarker, open, id, permissions[id], Boolean(requesting))) return;
    const generation = lifecycleGeneration.current;
    const isCurrent = () => mountedRef.current && activeRef.current && generation === lifecycleGeneration.current;
    const controller = new AbortController();
    postController.current?.abort();
    postController.current = controller;
    setRequesting(id);
    setPermissionError("");
    try {
      const snapshot = await requestDesktopPermission(id, controller.signal);
      if (isCurrent()) setPermissions(Object.fromEntries(snapshot.permissions.map(row => [row.id, row])) as Record<DesktopPermissionId, DesktopPermission>);
    } catch {
      if (!controller.signal.aborted && isCurrent()) setPermissionError(tr("无法打开系统授权流程，请稍后重试。"));
    } finally {
      if (postController.current === controller) postController.current = null;
      if (isCurrent()) setRequesting(null);
    }
  }, [desktopMarker, open, permissions, requesting]);

  if (!desktopMarker || !open) return null;
  const steps = buildOnboardingSteps(platform);
  const safeStep = Math.min(step, steps.length - 1);
  const currentStep = steps[safeStep];
  const eyebrow = `${String(safeStep + 1).padStart(2, "0")} / ${String(steps.length).padStart(2, "0")}`;
  const allGranted = platform === "darwin"
    ? permissions.accessibility.status === "granted" && permissions.screen.status === "granted"
    : permissions.microphone.status === "granted";
  const statusDescription = readingPermissions ? tr("正在读取系统状态…") : allGranted
    ? tr("已读取到当前状态") : tr("状态仅供参考；最终权限由操作系统决定。");
  const renderPermission = (id: DesktopPermissionId, title: string, detail: string) => {
    const permission = permissions[id];
    const isRequesting = requesting === id;
    const requestable = permission.canRequest && permission.status !== "granted" && permission.status !== "unsupported";
    return <article className="xn-desktop-permission__row" key={id} data-permission={id}>
      <div className="xn-desktop-permission__row-copy"><div className="xn-desktop-permission__row-title"><h3>{tr(title)}</h3><StatusLabel permission={permission} /></div><p>{tr(detail)}</p>
        {permission.requiresRestart && <small>{tr(permission.id === "screen"
          ? "若已在系统设置中开启屏幕录制，请先刷新状态；仍未生效时完全退出并重新打开 Xueness。"
          : "更改后可能需要重新启动应用。")}</small>}
      </div>
      {requestable && <button className="xn-desktop-permission__request" type="button" disabled={Boolean(requesting) || saving} onClick={() => void requestSystemPermission(id)}>
        {tr(isRequesting ? "正在打开…" : desktopPermissionActionLabel(platform, id, permission.status))}
      </button>}
    </article>;
  };

  return <div className="xn-desktop-permission__backdrop" data-testid="desktop-permission-onboarding">
    <div ref={dialogRef} className="xn-desktop-permission" role="dialog" aria-modal="true" aria-labelledby="xn-desktop-permission-title" aria-describedby="xn-desktop-permission-description" tabIndex={-1}
      onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); if (shouldDismissModalOnEscape(event, saving)) { event.preventDefault(); dismiss(); } } }}>
      <header className="xn-desktop-permission__header">
        <div className="xn-desktop-permission__brand"><IconXuenessMark size={23} /><span>Xueness <span className="xn-desktop-permission__brand-divider">/</span> {tr("桌面设置")}</span></div>
        <button ref={laterRef} className="xn-desktop-permission__later" type="button" disabled={saving} onClick={dismiss}>{tr("稍后再说")}</button>
      </header>
      <div className="xn-desktop-permission__content">
        <div className="xn-desktop-permission__hero">
          <div className="xn-desktop-permission__step-line"><span>{eyebrow}</span><span>{tr("可选设置")}</span></div>
          <h2 id="xn-desktop-permission-title">{tr(currentStep.title)}</h2>
          <p id="xn-desktop-permission-description">{tr(currentStep.description)}</p>
          <StepIllustration art={currentStep.art} />
        </div>
        <div className="xn-desktop-permission__details">
          {currentStep.body === "accessibilityScreen" && <>
            {renderPermission("accessibility", "辅助功能", "用于需要系统辅助功能授权的兼容操作。")}
            {renderPermission("screen", "屏幕录制", "用于需要系统屏幕捕获授权的兼容操作。")}
          </>}
          {currentStep.body === "fullDisk" && <>
            {renderPermission("fullDisk", "完全磁盘访问权限", "在 macOS 系统设置 → 隐私与安全性 → 完全磁盘访问权限中，按需添加或开启 Xueness。Xueness 不读取此权限状态。")}
            <div className="xn-desktop-permission__manual-note"><span aria-hidden="true">i</span><p>{tr("此设置为可选项；打开系统设置不会自动开启权限。没有开启时，应用仍可继续使用。")}</p></div>
          </>}
          {currentStep.body === "microphone" && <>
            {renderPermission("microphone", "麦克风", "此按钮只请求系统授权，不会开始录音或启动音频任务。")}
            <div className="xn-desktop-permission__manual-note"><span aria-hidden="true">i</span><p>{tr("此设置为可选项；仅在你主动点击授权按钮时才会请求权限。")}</p></div>
          </>}
          {permissionError && <p className="xn-desktop-permission__error" role="alert">{permissionError}</p>}
          {completionError && <p className="xn-desktop-permission__error" role="alert">{completionError}</p>}
          <div className="xn-desktop-permission__status-line">
            <p className="xn-desktop-permission__status-note" role="status">{statusDescription}</p>
            <button data-testid="desktop-permission-onboarding-refresh" type="button" disabled={saving || Boolean(requesting)} onClick={() => statusObserver.current?.refresh()}>
              <span aria-hidden="true">↻</span>{tr("刷新权限状态")}
            </button>
          </div>
        </div>
      </div>
      <footer className="xn-desktop-permission__footer">
        <button data-testid="desktop-permission-onboarding-skip-all" className="xn-desktop-permission__skip" type="button" disabled={saving} onClick={() => void finish()}>{tr(saving ? "正在保存…" : "跳过全部")}</button>
        <div className="xn-desktop-permission__progress" aria-label={tr("设置步骤")}>
          {steps.map((item, index) => <span key={item.title} data-current={index === safeStep} aria-hidden="true" />)}
        </div>
        <button data-testid={safeStep < steps.length - 1 ? "desktop-permission-onboarding-continue" : "desktop-permission-onboarding-finish"} className="xn-desktop-permission__next" type="button" disabled={saving} onClick={() => safeStep < steps.length - 1 ? setStep(safeStep + 1) : void finish()}>
          {tr(saving ? "正在保存…" : safeStep < steps.length - 1 ? "继续设置" : "完成")}
          {safeStep < steps.length - 1 && <span aria-hidden="true">→</span>}
        </button>
      </footer>
    </div>
  </div>;
}
