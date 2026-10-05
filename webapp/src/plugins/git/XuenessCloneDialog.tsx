/**
 * 克隆仓库对话框（git 插件功能 git.clone）。
 *
 * 只负责收集远程地址与目标目录，真正的校验（协议白名单、目录授权、确认）全部
 * 在 `POST /api/git/clone` 的服务端完成；这里只把返回的 `error` 原样呈现。
 * 目录选择复用 settings 已有的本机文件夹选择器，不可用时退回手工输入。
 */
import React, { useEffect, useRef, useState } from "react";
import { FolderOpen, GitBranch, LoaderCircle } from "lucide-react";
import { t as tr } from "../../i18n";
import { chooseNativeWorkspace, loadNativeWorkspacePicker } from "../../xuenessWorkspaces";
import { cloneGitRepository } from "../../xuenessGit";
import { shouldDismissModalOnEscape, useModalFocusScope } from "../shared";
import "../../styles/git-clone-dialog.css";

export type XuenessCloneDialogProps = {
  open: boolean;
  /** Parent directory offered as the default clone location, when one is known. */
  defaultParent?: string | null;
  returnFocusTo?: HTMLElement | null;
  onCancel(): void;
  onCloned(root: string): void;
};

/**
 * Repository basename for a remote, offered as the default destination. The
 * server re-validates both the URL and the destination, so a wrong guess here
 * can never widen what the clone accepts.
 */
export function repositoryNameFromUrl(url: string): string {
  const value = url.trim().split(/[?#]/)[0].replace(/\/+$/, "");
  if (!value || /[\s\0]/.test(value)) return "";
  const path = value.includes("://") ? value.slice(value.indexOf("://") + 3) : value;
  const tail = (path.includes(":") && !path.includes("/") ? path.slice(path.indexOf(":") + 1) : path)
    .split(/[/?#]/).filter(Boolean).pop() ?? "";
  const name = tail.endsWith(".git") ? tail.slice(0, -4) : tail;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(name) ? name : "";
}

/** `<parent>/<repo>` in the parent's own separator style. */
export function joinWorkspacePath(parent: string, name: string): string {
  if (!parent) return name;
  const trimmed = parent.replace(/[/\\]+$/, "");
  const separator = trimmed.includes("\\") && !trimmed.includes("/") ? "\\" : "/";
  return `${trimmed}${separator}${name}`;
}

export function cloneDestination(defaultParent: string | null | undefined, url: string): string {
  const name = repositoryNameFromUrl(url);
  if (!defaultParent || !name) return "";
  return joinWorkspacePath(defaultParent, name);
}

export function canSubmitClone(input: { url: string; dest: string; confirmed: boolean; busy: boolean }): boolean {
  return !input.busy && input.confirmed
    && input.url.trim().length > 0 && input.dest.trim().length > 0;
}

export function XuenessCloneDialog({
  open,
  defaultParent,
  returnFocusTo,
  onCancel,
  onCloned,
}: XuenessCloneDialogProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const urlRef = useRef<HTMLInputElement | null>(null);
  const [url, setUrl] = useState("");
  const [dest, setDest] = useState("");
  const [pinnedDest, setPinnedDest] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pickerAvailable, setPickerAvailable] = useState(false);
  const lifecycle = useRef({ mounted: true, generation: 0 });

  useModalFocusScope({ open, dialogRef, initialFocusRef: urlRef, returnFocusTo });

  useEffect(() => {
    const current = lifecycle.current;
    current.mounted = true;
    const generation = ++current.generation;
    if (!open) return () => { current.mounted = false; current.generation += 1; };
    setUrl(""); setDest(""); setPinnedDest(false); setConfirmed(false);
    setBusy(false); setError(""); setPickerAvailable(false);
    void loadNativeWorkspacePicker().then(capability => {
      if (current.mounted && current.generation === generation) setPickerAvailable(capability.available);
    }).catch(() => undefined);
    return () => { current.mounted = false; current.generation += 1; };
  }, [open]);

  // The suggested destination follows the remote until the operator edits it.
  useEffect(() => {
    if (pinnedDest) return;
    setDest(cloneDestination(defaultParent, url));
  }, [defaultParent, pinnedDest, url]);

  if (!open) return null;

  const isCurrent = () => lifecycle.current.mounted;
  const chooseParent = async () => {
    if (busy) return;
    setBusy(true); setError("");
    const generation = lifecycle.current.generation;
    try {
      const picked = await chooseNativeWorkspace(defaultParent);
      if (isCurrent() && lifecycle.current.generation === generation && !picked.cancelled) {
        const name = repositoryNameFromUrl(url);
        setPinnedDest(true);
        setDest(name ? joinWorkspacePath(picked.root, name) : picked.root);
      }
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setBusy(false); }
  };
  const submit = async () => {
    if (busy) return;
    setBusy(true); setError("");
    const result = await cloneGitRepository(url.trim(), dest.trim());
    if (!isCurrent()) return;
    if (!result.ok) { setBusy(false); setError(result.error); return; }
    onCloned(result.value.root);
  };

  return (
    <div className="xn-clone-dialog__backdrop" data-testid="clone-dialog-backdrop"
      onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onCancel(); }}>
      <div ref={dialogRef} className="xn-clone-dialog__surface" role="dialog" aria-modal="true"
        aria-labelledby="xn-clone-dialog-title" data-testid="clone-dialog"
        onKeyDown={(event) => {
          if (!shouldDismissModalOnEscape(event, busy)) return;
          event.preventDefault();
          onCancel();
        }}>
        <header className="xn-clone-dialog__header">
          <GitBranch size={20} aria-hidden="true" />
          <h2 id="xn-clone-dialog-title">{tr("克隆仓库")}</h2>
        </header>
        <form className="xn-clone-dialog__body" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label htmlFor="xn-clone-url">{tr("仓库地址")}</label>
          <input id="xn-clone-url" ref={urlRef} value={url} disabled={busy} autoComplete="off"
            spellCheck={false} data-testid="clone-url" aria-describedby="xn-clone-url-hint"
            placeholder="https://github.com/org/repo.git"
            onChange={(event) => { setUrl(event.target.value); setError(""); }} />
          <p id="xn-clone-url-hint" className="xn-clone-dialog__hint">
            {tr("支持 https://、ssh:// 与 git@host:path 形式；本地路径与其他协议会被拒绝。")}
          </p>
          <label htmlFor="xn-clone-dest">{tr("目标目录")}</label>
          <div className="xn-clone-dialog__dest">
            <input id="xn-clone-dest" value={dest} disabled={busy} autoComplete="off" spellCheck={false}
              data-testid="clone-dest" placeholder={tr("绝对路径，且该目录需为空")}
              onChange={(event) => { setPinnedDest(true); setDest(event.target.value); setError(""); }} />
            <button type="button" className="xn-btn xn-btn--md xn-btn--secondary" disabled={busy || !pickerAvailable}
              data-testid="clone-pick-directory" title={pickerAvailable ? tr("选择上级文件夹") : tr("此连接不支持系统文件夹选择窗口")}
              onClick={() => void chooseParent()}>
              <FolderOpen size={15} aria-hidden="true" />{tr("选择目录")}
            </button>
          </div>
          <label className="xn-clone-dialog__confirm">
            <input type="checkbox" checked={confirmed} disabled={busy} data-testid="clone-confirm"
              onChange={(event) => { setConfirmed(event.target.checked); setError(""); }} />
            <span>{tr("我确认在本机新建目录并克隆这个仓库。")}</span>
          </label>
          {error && <p className="xn-clone-dialog__error" role="alert" data-testid="clone-error">{error}</p>}
          <div className="xn-clone-dialog__actions">
            <button type="button" className="xn-btn xn-btn--md xn-btn--secondary" disabled={busy} onClick={onCancel}>
              {tr("取消")}
            </button>
            <button type="submit" className="xn-btn xn-btn--md xn-btn--primary" data-testid="clone-submit"
              disabled={!canSubmitClone({ url, dest, confirmed, busy })}>
              {busy ? <LoaderCircle size={14} className="is-spinning" aria-hidden="true" /> : null}
              {busy ? tr("正在克隆…") : tr("开始克隆")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
