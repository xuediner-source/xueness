import React from "react";
import { Globe, Lightbulb } from "lucide-react";
import { t as tr } from "../../i18n";
import { IconCheck, IconChevronDown, IconX } from "../../ui/icons";
import type { RunChoices } from "../../xuenessBridge";
import { permissionChoices } from './permissionChoices';

export function ComposerModeControls({
  modeWrapRef, modeTriggerRef, modeMenuRef, selectedPermission, modeMenuOpen, closeModeMenu, openModeMenu, permissionDisabled,
  disabled, choices, onChange, onModeKeyDown, confirmYoloOpen, changePermission, onToggleBrowser, browserIsEnabled,
  onBackground, backgroundCount,
}: {
  modeWrapRef: React.RefObject<HTMLDivElement | null>;
  modeTriggerRef: React.RefObject<HTMLButtonElement | null>;
  modeMenuRef: React.RefObject<HTMLDivElement | null>;
  selectedPermission: (typeof permissionChoices)[number];
  modeMenuOpen: boolean;
  closeModeMenu: (restoreInput?: boolean) => void;
  openModeMenu: (key?: string) => void;
  permissionDisabled: boolean;
  disabled: boolean;
  choices: RunChoices;
  onChange(patch: Partial<RunChoices>): void;
  onModeKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  confirmYoloOpen: boolean;
  changePermission: (permission: NonNullable<RunChoices["permission_mode"]>) => void;
  onToggleBrowser?(enabled: boolean): void;
  browserIsEnabled: boolean;
  onBackground?: () => void;
  backgroundCount: number;
}) {
  return (
      <div className="xn-composer-toolbar__left" role="group" aria-label={tr("权限与工具")}>
        <div className="xn-composer-toolbar__mode-control" ref={modeWrapRef}>
          <button
            ref={modeTriggerRef}
            type="button"
            className={`xn-composer-toolbar__mode-trigger${selectedPermission.value === "yolo" ? " is-warning" : ""}`}
            data-shortcut-action="open-mode-menu" aria-label={tr("模式")}
            aria-haspopup="menu"
            aria-expanded={modeMenuOpen}
            title={tr("模式")}
            disabled={permissionDisabled}
            onClick={() => modeMenuOpen ? closeModeMenu() : openModeMenu()}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                openModeMenu(event.key);
              }
            }}
          >
            <selectedPermission.Icon size={16} aria-hidden="true" />
            <span>{tr(selectedPermission.label)}</span>
            <IconChevronDown />
          </button>
          {modeMenuOpen && (
            <div
              ref={modeMenuRef}
              className="xn-composer-toolbar__popover xn-composer-toolbar__mode-popover"
              role="menu"
              aria-label={tr("模式与权限")}
              onKeyDown={onModeKeyDown}
              onBlur={(event) => {
                if (!confirmYoloOpen && !event.currentTarget.contains(event.relatedTarget as Node | null)) closeModeMenu();
              }}
            >
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={choices.mode === "plan"}
                className="xn-composer-toolbar__menu-row xn-composer-toolbar__plan-toggle"
                disabled={disabled}
                onClick={() => onChange({ mode: choices.mode === "plan" ? "build" : "plan" })}
              >
                <Lightbulb size={18} aria-hidden="true" />
                <span className="xn-composer-toolbar__menu-copy">
                  <strong>{tr("计划模式")}</strong>
                  <small>{tr("编辑前先出计划。")}</small>
                </span>
                <span className="xn-composer-toolbar__menu-indicator" aria-hidden="true">
                  {choices.mode === "plan" && <IconCheck />}
                </span>
              </button>
              <div className="xn-composer-toolbar__separator" role="separator" />
              <div className="xn-composer-toolbar__permission-options" role="group" aria-label={tr("执行权限")}>
                {permissionChoices.map((item) => {
                  const selected = (choices.permission_mode ?? "build") === item.value;
                  return (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      className="xn-composer-toolbar__menu-row xn-composer-toolbar__permission-option"
                      data-permission={item.value}
                      key={item.value}
                      disabled={permissionDisabled}
                      onClick={() => changePermission(item.value)}
                    >
                      <item.Icon size={18} aria-hidden="true" />
                      <span className="xn-composer-toolbar__menu-copy">
                        <strong>{tr(item.label)}</strong>
                        <small>{tr(item.description)}</small>
                      </span>
                      <span className="xn-composer-toolbar__menu-indicator" aria-hidden="true">
                        {selected && <IconCheck />}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {choices.mode === "plan" && (
            <span className="xn-composer-toolbar__plan-marker" data-testid="composer-plan-marker">
              <span className="xn-composer-toolbar__vertical-separator" role="separator" aria-orientation="vertical" />
              <button
                type="button"
                className="xn-composer-toolbar__plan-marker-button"
                aria-label={tr("移除计划模式")}
                title={tr("移除计划模式")}
                disabled={disabled}
                onClick={() => onChange({ mode: "build" })}
              >
                <Lightbulb size={16} className="xn-composer-toolbar__plan-marker-bulb" aria-hidden="true" />
                <IconX className="xn-composer-toolbar__plan-marker-close" />
                <span>{tr("计划模式")}</span>
              </button>
            </span>
          )}
        </div>
        {onToggleBrowser && (
          <button
            type="button"
            className="xn-composer-toolbar__tool xn-composer-toolbar__browser"
            aria-label={browserIsEnabled ? tr("浏览器已启用") : tr("启用浏览器")}
            title={browserIsEnabled ? tr("浏览器已启用") : tr("启用浏览器")}
            aria-pressed={browserIsEnabled}
            disabled={disabled}
            onClick={() => onToggleBrowser(!browserIsEnabled)}
          ><Globe size={15} aria-hidden="true" /><span>{browserIsEnabled ? tr("浏览器已启用") : tr("启用浏览器")}</span></button>
        )}
        {onBackground && backgroundCount > 0 && (
          <button type="button" className="xn-composer-toolbar__tool" disabled={disabled} onClick={onBackground}>
            {tr("后台任务")} <span className="xn-composer-toolbar__count">{backgroundCount}</span>
          </button>
        )}
      </div>
  );
}
