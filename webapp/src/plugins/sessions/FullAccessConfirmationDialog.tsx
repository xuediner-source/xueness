import { AlertTriangle, Folder, Terminal, Globe } from "lucide-react";
import "./FullAccessConfirmationDialog.css";
import React, { useRef } from "react";
import { t as tr } from "../../i18n";
import { shouldDismissModalOnEscape, useModalFocusScope } from "../shared";
import type { PermissionMode } from "./permissionModes";

export function requiresYoloConfirmation(
  current: PermissionMode | undefined,
  next: PermissionMode,
  acknowledged: boolean,
): boolean {
  return next === "yolo" && (current !== "yolo" || !acknowledged);
}

export type FullAccessConfirmationDialogProps = {
  open: boolean;
  returnFocusTo?: HTMLElement | null;
  onCancel(): void;
  onConfirm(): void;
};

/** Honest scope of the sessions plugin's web permission mode. */
export function FullAccessConfirmationDialog({
  open,
  returnFocusTo,
  onCancel,
  onConfirm,
}: FullAccessConfirmationDialogProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useModalFocusScope({ open, dialogRef, initialFocusRef: cancelRef, returnFocusTo });

  if (!open) return null;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!shouldDismissModalOnEscape(event)) return;
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };

  return (
    <div className="xn-dialog-overlay" role="presentation" data-testid="full-access-confirmation-backdrop">
      <section
        ref={dialogRef}
        className="xn-dialog xn-full-access"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="xn-full-access-title"
        aria-describedby="xn-full-access-description"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <h2 id="xn-full-access-title" className="xn-dialog__title"><AlertTriangle size={23} aria-hidden="true" />{tr("切换到完全访问？")}</h2>
        <p id="xn-full-access-description">
          {tr("完全访问会跳过全部工具审批与应用权限规则，包括拒绝列表、强制询问和远程操作确认。Agent 可直接使用文件、命令、浏览器和已连接工具。")}
        </p>
        <div className="xn-full-access__permissions">
          <div><Folder size={23} aria-hidden="true" /><span><strong>{tr("文件和文件夹")}</strong><small>{tr("文件工具可访问当前系统账户有权访问的位置。")}</small></span></div>
          <div><Terminal size={23} aria-hidden="true" /><span><strong>{tr("终端命令")}</strong><small>{tr("本地命令以当前操作系统账户运行；如果账户有权限，命令可能访问工作区外文件。")}</small></span></div>
          <div><Globe size={23} aria-hidden="true" /><span><strong>{tr("互联网与已连接的工具")}</strong><small>{tr("已启用的联网和远程工具无需逐次确认。")}</small></span></div>
        </div>
        <p className="xn-full-access__risk">{tr("这可能造成文件丢失、敏感数据泄露或执行非预期指令。你可以随时切回变更前确认。")}</p>
        <p className="xn-full-access__limits">{tr("应用内的审批、拒绝和强制询问规则在完全访问期间不生效。")} {tr("操作系统权限仍适用，系统拒绝的操作仍会失败。")}</p>
        <div className="xn-dialog__actions">
          <button
            ref={cancelRef}
            type="button"
            className="xn-btn xn-btn--md xn-btn--secondary"
            data-testid="full-access-cancel"
            onClick={onCancel}
          >{tr("取消")}</button>
          <button
            type="button"
            className="xn-btn xn-btn--md xn-full-access__confirm"
            data-testid="full-access-confirm"
            onClick={onConfirm}
          ><AlertTriangle size={15} aria-hidden="true" />{tr("确认完全访问")}</button>
        </div>
      </section>
    </div>
  );
}
