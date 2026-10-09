import React, { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, Folder, FolderOpen, LoaderCircle, X } from "lucide-react";
import { t as tr } from "../../i18n";
import { XuenessWorkspaceSettings } from "./XuenessWorkspaceSettings";
import { chooseNativeWorkspace, confirmWorkspaceRoot, loadNativeWorkspacePicker, loadWorkspaceCatalog, type WorkspaceCatalog } from "../../xuenessWorkspaces";
import { isImeComposingEvent } from "../../xuenessShortcutDisplay";
import "../../styles/workspace-picker-dialog.css";

export type XuenessWorkspacePickerDialogProps = {
  open: boolean;
  currentRoot?: string | null;
  returnFocusTo?: HTMLElement | null;
  onChoose: (root: string, isolated?: boolean) => void;
  onCancel: () => void;
  mode?: "workspace" | "project";
};

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function shouldDismissWorkspacePickerOnEscape(event: {
  key: string;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  keyCode?: number;
  isComposing?: boolean;
  compositionActive?: boolean;
}): boolean {
  return event.key === "Escape" && !isImeComposingEvent(event);
}

/** A compact project entry point with OS selection and a host-browser fallback. */
export function XuenessWorkspacePickerDialog({
  open,
  currentRoot,
  returnFocusTo,
  onChoose,
  onCancel,
  mode = "workspace",
}: XuenessWorkspacePickerDialogProps): React.ReactElement | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const selectionMade = useRef(false);
  const titleId = useId();
  const [catalog, setCatalog] = useState<WorkspaceCatalog | null>(null);
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const requestSequence = useRef(0);

  useEffect(() => {
    if (!open) return;
    const sequence = ++requestSequence.current;
    selectionMade.current = false;
    setLoading(true); setError(""); setBrowsing(false);
    void Promise.allSettled([loadWorkspaceCatalog(), loadNativeWorkspacePicker()]).then(([directories, native]) => {
      if (sequence !== requestSequence.current) return;
      setCatalog(directories.status === "fulfilled" ? directories.value : null);
      setNativeAvailable(native.status === "fulfilled" && native.value.available);
      if (directories.status === "rejected") setError(String(directories.reason instanceof Error ? directories.reason.message : directories.reason));
      setLoading(false);
    });
    return () => { requestSequence.current += 1; };
  }, [open]);

  const selectNative = async () => {
    if (busy) return;
    setBusy(true); setError("");
    const sequence = requestSequence.current;
    try {
      const result = await chooseNativeWorkspace(currentRoot);
      if (sequence === requestSequence.current && !result.cancelled) {
        selectionMade.current = true;
        onChoose(result.root, false);
      }
    } catch (reason) {
      if (sequence === requestSequence.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };
  const selectRecent = async (root: string) => {
    if (busy) return;
    setBusy(true); setError("");
    const sequence = requestSequence.current;
    try {
      const result = await confirmWorkspaceRoot(root);
      if (sequence === requestSequence.current) {
        selectionMade.current = true;
        onChoose(result.root, false);
      }
    } catch (reason) {
      if (sequence === requestSequence.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!open) return;
    openerRef.current = returnFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const dialog = dialogRef.current;
    const title = dialog?.querySelector<HTMLElement>("[data-workspace-picker-title]");
    const initialTarget = dialog?.querySelector<HTMLElement>('[data-workspace-picker-title]') ?? title;
    const frame = window.requestAnimationFrame(() => initialTarget?.focus({ preventScroll: true }));
    const keepFocusInside = (event: FocusEvent) => {
      if (!dialogRef.current?.contains(event.target as Node)) {
        const target = dialogRef.current?.querySelector<HTMLElement>("[data-workspace-picker-title]");
        target?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("focusin", keepFocusInside, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("focusin", keepFocusInside, true);
      const opener = openerRef.current;
      window.requestAnimationFrame(() => {
        const composer = selectionMade.current ? document.querySelector<HTMLElement>("textarea.xn-composer__input") : null;
        const usableOpener = opener?.isConnected && !opener.closest("[inert]") && opener.getClientRects().length ? opener : null;
        const target = composer ?? usableOpener ?? document.querySelector<HTMLElement>('[data-testid="xn-shell-sidebar-toggle"]');
        target?.focus({ preventScroll: true });
      });
    };
  }, [open, returnFocusTo]);

  if (!open) return null;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (shouldDismissWorkspacePickerOnEscape(event)) {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((item) => item.getAttribute("aria-hidden") !== "true" && item.getClientRects().length > 0);
    if (!items.length) {
      event.preventDefault();
      dialog.querySelector<HTMLElement>("[data-workspace-picker-title]")?.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const activeIndex = items.indexOf(active as HTMLElement);
    if (activeIndex < 0) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && activeIndex === 0) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && activeIndex === items.length - 1) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="xn-workspace-picker-dialog__backdrop"
      data-testid="workspace-picker-backdrop"
      onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onCancel(); }}
    >
      <div
        ref={dialogRef}
        className={`xn-workspace-picker-dialog__surface${browsing ? " is-browsing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="workspace-picker-dialog"
        onKeyDown={handleKeyDown}
      >
        <header className="xn-project-picker__header">
          <div>
            <h2 id={titleId} tabIndex={-1} data-workspace-picker-title="true">{tr(mode === "project" ? "添加项目" : "选择工作区")}</h2>
            <p>{tr("选择一个文件夹，开始在其中工作。")}</p>
          </div>
          <button type="button" aria-label={tr("关闭")} disabled={busy} onClick={onCancel}><X size={18} /></button>
        </header>
        {error && <p className="xn-project-picker__error" role="alert">{error}</p>}
        {!browsing ? <div className="xn-project-picker__body">
          <button type="button" className="xn-project-picker__native" disabled={loading || busy || !nativeAvailable} onClick={() => void selectNative()}>
            {busy ? <LoaderCircle size={21} className="is-spinning" /> : <FolderOpen size={21} />}
            <span><strong>{tr("在此电脑添加文件夹")}</strong><small>{tr(busy ? "请在系统窗口中选择文件夹…" : "打开系统文件夹选择窗口")}</small></span>
            <ArrowRight size={17} />
          </button>
          {!loading && !nativeAvailable && <p className="xn-project-picker__hint">{tr("此连接不支持系统窗口，请使用目录浏览。")}</p>}
          <div className="xn-project-picker__recent">
            <h3>{tr("最近的文件夹")}</h3>
            {loading ? <p role="status">{tr("正在加载目录…")}</p> : catalog?.recentDirectories.length ? <ul>
              {catalog.recentDirectories.map(item => <li key={item.path}><button type="button" disabled={busy} title={item.path} onClick={() => void selectRecent(item.path)}>
                <Folder size={18} /><span><strong>{item.label}</strong><small>{item.path}</small></span>{item.path === currentRoot && <small className="xn-project-picker__current">{tr("当前")}</small>}
              </button></li>)}
            </ul> : <p>{tr("选择的文件夹会显示在这里。")}</p>}
          </div>
          <button type="button" className="xn-project-picker__browse" disabled={busy || loading} onClick={() => setBrowsing(true)}>{tr("浏览目录或新建文件夹")}</button>
        </div> : <>
        <button type="button" className="xn-project-picker__back" onClick={() => setBrowsing(false)}>{tr("返回最近文件夹")}</button>
        <XuenessWorkspaceSettings
          picking
          currentRoot={currentRoot}
          onChoose={(root, isolated) => { selectionMade.current = true; onChoose(root, isolated); }}
        />
        </>}
      </div>
    </div>
  );
}
