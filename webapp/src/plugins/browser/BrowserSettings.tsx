import React, { useEffect, useRef, useState } from "react";
import { get, post } from "../../xuenessApi";
import { t as tr } from "../../i18n";
import "../../styles/browser.css";
import { shouldDismissModalOnEscape, useModalFocusScope } from "../shared";

export type BrowserDataOperation = "cache" | "all";

export function dialogTabWrapTarget(activeIndex: number, count: number, shiftKey: boolean): number | null {
  if (count < 1) return null;
  if (activeIndex < 0) return shiftKey ? count - 1 : 0;
  if (shiftKey && activeIndex === 0) return count - 1;
  if (!shiftKey && activeIndex === count - 1) return 0;
  return null;
}

export async function readBrowserProfilePresent(): Promise<boolean> {
  const result = await get<{ profilePresent: boolean }>("/api/browser/data");
  if (typeof result.profilePresent !== "boolean") throw new Error("Invalid browser profile response");
  return result.profilePresent;
}

export async function clearBrowserData(operation: BrowserDataOperation): Promise<void> {
  const payload = operation === "all" ? { operation, confirmed: true } : { operation };
  const result = await post<{ ok: boolean }>("/api/browser/data", payload);
  if (result.ok !== true) throw new Error("Browser data operation did not complete");
}

export interface BrowserSettingsProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => Promise<void>;
  disabled?: boolean;
}

export function BrowserSettings({ enabled, onEnabledChange, disabled = false }: BrowserSettingsProps): React.JSX.Element {
  const [togglePending, setTogglePending] = useState(false);
  const [operationPending, setOperationPending] = useState<BrowserDataOperation | null>(null);
  const [profilePresent, setProfilePresent] = useState<boolean | null>(null);
  const [profileLoading, setProfileLoading] = useState(enabled);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const allDataButtonRef = useRef<HTMLButtonElement | null>(null);
  const focusReturnRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const profileRequestId = useRef(0);

  useEffect(() => {
    const requestId = ++profileRequestId.current;
    if (!enabled) {
      setProfilePresent(null);
      setProfileLoading(false);
      setError("");
      return;
    }
    let current = true;
    setProfileLoading(true);
    void readBrowserProfilePresent()
      .then((present) => { if (current && requestId === profileRequestId.current) setProfilePresent(present); })
      .catch((cause: unknown) => { if (current && requestId === profileRequestId.current) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (current && requestId === profileRequestId.current) setProfileLoading(false); });
    return () => { current = false; };
  }, [enabled]);

  useModalFocusScope({ open: confirmClearAll, dialogRef, initialFocusRef: cancelButtonRef, returnFocusTo: focusReturnRef.current });

  const changeEnabled = async () => {
    if (disabled || togglePending) return;
    setTogglePending(true);
    setError("");
    setNotice("");
    try {
      await onEnabledChange(!enabled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTogglePending(false);
    }
  };

  const runDataOperation = async (operation: BrowserDataOperation) => {
    if (!enabled || disabled || togglePending || operationPending !== null) return;
    setOperationPending(operation);
    setError("");
    setNotice("");
    try {
      await clearBrowserData(operation);
      if (operation === "all") {
        profileRequestId.current += 1;
        setProfilePresent(false);
      }
      setNotice(operation === "cache" ? tr("缓存已清理。") : tr("浏览器数据已清理。"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setOperationPending(null);
    }
  };

  const openClearAll = () => {
    if (!enabled || disabled || togglePending || operationPending !== null) return;
    focusReturnRef.current = allDataButtonRef.current;
    setConfirmClearAll(true);
  };

  const confirmAll = () => {
    setConfirmClearAll(false);
    void runDataOperation("all");
  };

  const profileLabel = !enabled
    ? tr("浏览器控制已关闭")
    : profileLoading
      ? tr("正在读取…")
      : profilePresent === true
        ? tr("已有浏览器资料")
        : profilePresent === false
          ? tr("尚无浏览器资料")
          : tr("浏览器资料状态未知");

  return (
    <section className="xn-browser-settings" data-testid="browser-settings">
      {error && <p className="xn-browser-settings__feedback is-error" role="alert">{tr("浏览器设置失败：")}{error}</p>}
      {notice && <p className="xn-browser-settings__feedback is-success" role="status">{notice}</p>}

      <section className="xn-browser-settings__group" aria-label={tr("浏览器控制")}>
        <div className="xn-browser-settings__card">
          <div className="xn-browser-settings__row">
            <div className="xn-browser-settings__row-copy">
              <h5>{tr("启用浏览器控制")}</h5>
              <p id="xn-browser-control-description">{tr("允许任务使用浏览器控制工具。")}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-label={tr("启用浏览器控制")}
              aria-describedby="xn-browser-control-description"
              aria-checked={enabled}
              aria-busy={togglePending}
              className={`xn-browser-settings__switch${enabled ? " is-on" : ""}`}
              disabled={disabled || togglePending}
              onClick={() => void changeEnabled()}
            ><span /></button>
          </div>
          <div className="xn-browser-settings__row is-import">
            <div className="xn-browser-settings__row-copy">
              <h5>{tr("导入 Chrome 浏览器资料")}</h5>
              <p>{tr("网页版本不支持导入个人 Chrome 资料；此功能仅在桌面应用中提供。")}</p>
            </div>
            <button type="button" disabled aria-disabled="true">{tr("桌面应用可用")}</button>
          </div>
        </div>
      </section>

      <section className="xn-browser-settings__group" aria-labelledby="xn-browser-data-title">
        <div className="xn-browser-settings__group-heading">
          <div>
            <h4 id="xn-browser-data-title">{tr("浏览器数据")}</h4>
            <p>{tr("管理此服务的受管理浏览器资料；不会访问个人 Chrome 资料。")}</p>
          </div>
          <span
            className={`xn-browser-settings__profile-state${profilePresent ? " is-present" : ""}`}
            data-testid="browser-profile-status"
            aria-live="polite"
          >{profileLabel}</span>
        </div>
        <div className="xn-browser-settings__card">
          <div className="xn-browser-settings__row">
            <div className="xn-browser-settings__row-copy">
              <h5>{tr("清理缓存")}</h5>
              <p>{tr("移除受管理浏览器的缓存；不会影响个人 Chrome 资料。")}</p>
            </div>
            <button
              type="button"
              data-testid="browser-clear-cache"
              disabled={disabled || !enabled || togglePending || operationPending !== null}
              aria-busy={operationPending === "cache"}
              onClick={() => void runDataOperation("cache")}
            >{operationPending === "cache" ? tr("正在清理…") : tr("清理缓存")}</button>
          </div>
          <div className="xn-browser-settings__row">
            <div className="xn-browser-settings__row-copy">
              <h5>{tr("清除所有浏览器数据")}</h5>
              <p>{tr("移除缓存和当前服务的受管理浏览器资料，不会更改个人 Chrome 资料。此操作无法撤销。")}</p>
            </div>
            <button
              ref={allDataButtonRef}
              type="button"
              data-testid="browser-clear-all"
              disabled={disabled || !enabled || togglePending}
              aria-disabled={operationPending !== null}
              aria-busy={operationPending === "all"}
              className="is-destructive"
              onClick={openClearAll}
            >{operationPending === "all" ? tr("正在清理…") : tr("清除所有数据")}</button>
          </div>
        </div>
      </section>

      {confirmClearAll && (
        <div className="xn-browser-settings__backdrop">
          <div
            ref={dialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="xn-browser-clear-title"
            aria-describedby="xn-browser-clear-description"
            tabIndex={-1}
            onKeyDown={event => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              if (shouldDismissModalOnEscape(event, operationPending !== null)) { event.preventDefault(); setConfirmClearAll(false); }
            }}
            className="xn-browser-settings__dialog"
          >
            <h4 id="xn-browser-clear-title">{tr("清除所有浏览器数据？")}</h4>
            <p id="xn-browser-clear-description">{tr("这会移除缓存和当前服务受管理浏览器中的所有资料，不会影响个人 Chrome 资料。此操作无法撤销。")}</p>
            <div className="xn-browser-settings__dialog-actions">
              <button ref={cancelButtonRef} type="button" disabled={operationPending !== null} onClick={() => setConfirmClearAll(false)}>{tr("取消")}</button>
              <button ref={confirmButtonRef} type="button" disabled={operationPending !== null} className="is-destructive" onClick={confirmAll}>{tr("清除所有数据")}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default BrowserSettings;
