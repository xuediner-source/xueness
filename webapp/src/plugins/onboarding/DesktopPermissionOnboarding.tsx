import React, { useCallback, useEffect, useRef, useState } from "react";
import { t as tr } from "../../i18n";
import { IconXuenessMark } from "../../ui/icons";
import { shouldDismissModalOnEscape, useModalFocusScope } from "../shared";
import {
  buildOnboardingSteps,
  canRequestDesktopPermission,
  completeDesktopPermissionOnboarding,
  desktopPermissionActionLabel,
  initialDesktopPermissionPlatform,
  isDesktopOnboardingAvailable,
  PERMISSION_IDS,
  REOPEN_EVENT,
  requestDesktopPermission,
  startDesktopOnboardingCheck,
  startDesktopPermissionStatusObserver,
  type DesktopPermission,
  type DesktopPermissionId,
  type DesktopPermissionStatus,
  type DesktopPermissionStatusObserver,
  type OnboardingStepArt,
} from "./permissionOnboardingModel";
import "./desktop-permission-onboarding.css";

export {
  isDesktopOnboardingAvailable,
  initialDesktopPermissionPlatform,
  desktopPermissionActionLabel,
  normalizeDesktopPermissionSnapshot,
  requestDesktopPermission,
  completeDesktopPermissionOnboarding,
  canRequestDesktopPermission,
  DESKTOP_PERMISSION_REFRESH_INTERVAL_MS,
  startDesktopOnboardingCheck,
  startDesktopPermissionStatusObserver,
  buildOnboardingSteps,
  type DesktopPermissionId,
  type DesktopPermissionStatus,
  type DesktopPermission,
  type DesktopPermissionSnapshot,
  type DesktopPermissionStatusObserver,
} from "./permissionOnboardingModel";

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
