import React, { useEffect, useRef, useState } from "react";
import { Hand, Lightbulb, ShieldAlert, ShieldCheck } from "lucide-react";
import { t as tr, tf } from "../../i18n";
import { IconCheck, IconChevronDown, IconRefresh, IconX } from "../../ui/icons";
import { Select } from "../../ui/Select";
import { canUseRuntimeProfile, effectiveRuntimeProfile, runtimeProfileSelection, type ComposerModel, type RuntimeProfile } from "../../xuenessComposer";
import type { RunChoices } from "../../xuenessBridge";
import type { WorkbenchSession } from "../../xuenessWorkbench";

export type ComposerToolbarProps = {
  choices: RunChoices;
  onChange(patch: Partial<RunChoices>): void;
  models: ComposerModel[];
  loading: boolean;
  error: string;
  onReload(): void;
  onManageModels(): void;
  onBackground?: () => void;
  backgroundCount?: number;
  /** Kept for callers that still pass it; the actual selected state comes from choices.browser. */
  browserEnabled?: boolean;
  onToggleBrowser?(enabled: boolean): void;
  contextUsage?: { used: number; max: number; cacheHitRate?: number | null };
  runtimeBudget?: WorkbenchSession["runtime_budget"];
  pauseReason?: string | null;
  onOpenUsage?: () => void;
  disabled?: boolean;
};

const permissionChoices = [
  { value: "build", label: "变更前确认", description: "改文件前先问我。", Icon: Hand },
  { value: "edit", label: "自动编辑", description: "自动编辑文件。", Icon: ShieldCheck },
  { value: "yolo", label: "完全访问", description: "减少确认次数。", Icon: ShieldAlert },
] as const satisfies {
  value: NonNullable<RunChoices["permission_mode"]>;
  label: string;
  description: string;
  Icon: React.ComponentType<{ size?: number; className?: string }>;
}[];

function focusComposerInput(): void {
  document.querySelector<HTMLTextAreaElement>("textarea.xn-composer__input")?.focus();
}

function nextIndex(current: number, length: number, key: "ArrowDown" | "ArrowUp" | "Home" | "End"): number {
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (current < 0) return key === "ArrowDown" ? 0 : length - 1;
  return (current + (key === "ArrowDown" ? 1 : -1) + length) % length;
}

export function handlePopoverEscape(
  event: { key: string; preventDefault: () => void; stopPropagation?: () => void },
  closeMenu: (restoreInput: boolean) => void,
  trigger: { focus: () => void } | null,
): boolean {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation?.();
    closeMenu(false);
    trigger?.focus();
    return true;
  }
  return false;
}

export function XuenessComposerToolbar({
  choices,
  onChange,
  models,
  loading,
  error,
  onReload,
  onManageModels,
  onBackground,
  backgroundCount = 0,
  onToggleBrowser,
  contextUsage,
  runtimeBudget,
  pauseReason,
  onOpenUsage,
  disabled = false,
}: ComposerToolbarProps) {
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modeWrapRef = useRef<HTMLDivElement | null>(null);
  const modelWrapRef = useRef<HTMLDivElement | null>(null);
  const modeMenuRef = useRef<HTMLDivElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const modeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null);

  const selectedModel = models.find((model) => model.id === (choices.provider_id ?? ""))
    ?? (choices.model ? models.find((model) => model.model === choices.model) : undefined);
  const selectedPermission = permissionChoices.find((choice) => choice.value === (choices.permission_mode ?? "build")) ?? permissionChoices[0];
  const hasUsage = Boolean(
    contextUsage &&
    Number.isFinite(contextUsage.used) &&
    Number.isFinite(contextUsage.max) &&
    contextUsage.used > 0 &&
    contextUsage.max > 0 &&
    onOpenUsage,
  );
  const usagePercent = hasUsage && contextUsage
    ? Math.min(100, Math.max(0, (contextUsage.used / contextUsage.max) * 100))
    : 0;
  const browserIsEnabled = choices.browser === true;
  const activeRuntimeProfile = effectiveRuntimeProfile(selectedModel, choices.runtime_profile);
  const canSelectStandard = canUseRuntimeProfile(selectedModel, "standard");

  const closeModeMenu = (restoreInput = false) => {
    setModeMenuOpen(false);
    if (restoreInput) requestAnimationFrame(focusComposerInput);
  };
  const closeModelMenu = (restoreInput = false) => {
    setModelMenuOpen(false);
    if (restoreInput) requestAnimationFrame(focusComposerInput);
  };
  const chooseModel = (model: ComposerModel) => {
    onChange({
      provider_id: model.id,
      model: model.model,
      reasoning_effort: undefined,
    });
    closeModelMenu(true);
  };
  const chooseRuntimeProfile = (profile: RuntimeProfile) => {
    if (disabled || !selectedModel?.configured || (profile === "standard" && !canSelectStandard)) return;
    onChange({ runtime_profile: runtimeProfileSelection(profile) });
  };
  const isModelSelected = (model: ComposerModel) => {
    if (choices.provider_id) return model.id === choices.provider_id && (!choices.model || model.model === choices.model);
    return choices.model ? model.model === choices.model : model.id === "";
  };
  const changePermission = (permission: NonNullable<RunChoices["permission_mode"]>) => {
    onChange({ permission_mode: permission });
    closeModeMenu(true);
  };

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!modeWrapRef.current?.contains(target)) setModeMenuOpen(false);
      if (!modelWrapRef.current?.contains(target)) setModelMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, []);

  useEffect(() => {
    if (!modeMenuOpen) return;
    modeMenuRef.current?.querySelector<HTMLButtonElement>("[role='menuitemcheckbox']")?.focus();
  }, [modeMenuOpen]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    modelMenuRef.current?.querySelector<HTMLButtonElement>("[role='menuitemradio']:not(:disabled)")?.focus();
  }, [modelMenuOpen]);

  const onModeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (handlePopoverEscape(event, closeModeMenu, modeTriggerRef.current)) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitemcheckbox']:not(:disabled), [role='menuitemradio']:not(:disabled)"));
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    items[nextIndex(current, items.length, event.key as "ArrowDown" | "ArrowUp" | "Home" | "End")]?.focus();
  };

  const onModelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (handlePopoverEscape(event, closeModelMenu, modelTriggerRef.current)) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']:not(:disabled), [role='menuitem']:not(:disabled)"));
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    items[nextIndex(current, items.length, event.key as "ArrowDown" | "ArrowUp" | "Home" | "End")]?.focus();
  };

  const openModeMenu = (key?: string) => {
    setModelMenuOpen(false);
    setModeMenuOpen(true);
    if (key) requestAnimationFrame(() => modeMenuRef.current?.querySelector<HTMLButtonElement>(key === "ArrowUp" ? "[role='menuitemradio']:last-of-type" : "[role='menuitemcheckbox']")?.focus());
  };
  const openModelMenu = (key?: string) => {
    setModeMenuOpen(false);
    setModelMenuOpen(true);
    if (key) requestAnimationFrame(() => {
      const items = Array.from(modelMenuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']:not(:disabled), [role='menuitem']:not(:disabled)") ?? []);
      items[(key === "ArrowUp" ? items.length - 1 : 0)]?.focus();
    });
  };

  return (
    <div className="xn-composer-toolbar" data-testid="composer-toolbar">
      <div className="xn-composer-toolbar__left" role="group" aria-label={tr("权限与工具")}>
        <div className="xn-composer-toolbar__mode-control" ref={modeWrapRef}>
          <button
            ref={modeTriggerRef}
            type="button"
            className={`xn-composer-toolbar__mode-trigger${selectedPermission.value === "yolo" ? " is-warning" : ""}`}
            aria-label={tr("模式")}
            aria-haspopup="menu"
            aria-expanded={modeMenuOpen}
            title={tr("模式")}
            disabled={disabled}
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
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeModeMenu();
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
                      key={item.value}
                      disabled={disabled}
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
            className="xn-composer-toolbar__tool"
            aria-pressed={browserIsEnabled}
            disabled={disabled}
            onClick={() => onToggleBrowser(!browserIsEnabled)}
          >{browserIsEnabled ? tr("浏览器已启用") : tr("启用浏览器")}</button>
        )}
        {onBackground && backgroundCount > 0 && (
          <button type="button" className="xn-composer-toolbar__tool" disabled={disabled} onClick={onBackground}>
            {tr("后台任务")} <span className="xn-composer-toolbar__count">{backgroundCount}</span>
          </button>
        )}
      </div>

      <div className="xn-composer-toolbar__right" role="group" aria-label={tr("模型与上下文")}>
        <div className="xn-composer-toolbar__model" ref={modelWrapRef}>
          <button
            ref={modelTriggerRef}
            type="button"
            className="xn-composer-toolbar__model-trigger"
            aria-label={tr("选择模型")}
            aria-haspopup="menu"
            aria-expanded={modelMenuOpen}
            title={tr("选择模型")}
            disabled={disabled}
            onClick={() => modelMenuOpen ? closeModelMenu() : openModelMenu()}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                openModelMenu(event.key);
              }
            }}
          >
            <span>{selectedModel?.name ?? choices.model ?? tr("管理模型")}</span>
            <IconChevronDown />
          </button>
          {modelMenuOpen && (
            <div
              ref={modelMenuRef}
              className="xn-composer-toolbar__popover xn-composer-toolbar__model-popover"
              role="menu"
              aria-label={tr("可用模型")}
              onKeyDown={onModelKeyDown}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeModelMenu();
              }}
            >
              {loading && <div className="xn-composer-toolbar__message">{tr("正在读取模型...")}</div>}
              {error && (
                <div role="alert" className="xn-composer-toolbar__error">
                  <span>{error}</span>
                  <button type="button" role="menuitem" onClick={onReload} disabled={disabled}>
                    <IconRefresh size={14} /> {tr("重试")}
                  </button>
                </div>
              )}
              {!loading && !error && models.length === 0 && (
                <div className="xn-composer-toolbar__message">{tr("暂无可用模型")}</div>
              )}
              {!loading && !error && models.length > 0 && (
                <div className="xn-composer-toolbar__model-options" role="group" aria-label={tr("可用模型")}>
                  {models.map((model) => {
                    const selected = isModelSelected(model);
                    return (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={selected}
                        key={model.id + ":" + model.model}
                        className="xn-composer-toolbar__model-option"
                        disabled={disabled || !model.configured}
                        onClick={() => chooseModel(model)}
                        title={!model.configured ? tr("该模型尚未配置") : model.model}
                      >
                        <span className="xn-composer-toolbar__model-name">{model.name}</span>
                        {!model.configured && <small>{tr("未配置")}</small>}
                        <span className="xn-composer-toolbar__menu-indicator" aria-hidden="true">
                          {selected && <IconCheck />}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="xn-composer-toolbar__runtime-profile" role="group" aria-label={tr("运行档位")}>
                <div className="xn-composer-toolbar__popover-heading">{tr("运行档位")}</div>
                {(["standard", "lightweight"] as const).map(profile => {
                  const allowed = profile !== "standard" || canSelectStandard;
                  const title = !selectedModel ? tr("请先选择模型")
                    : !allowed ? tr("JSON 工具模式要求本地轻量配置；先在服务商设置中改为原生工具调用。") : undefined;
                  return <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={activeRuntimeProfile === profile}
                    key={profile}
                    className="xn-composer-toolbar__profile-option"
                    disabled={disabled || !selectedModel?.configured || !allowed}
                    onClick={() => chooseRuntimeProfile(profile)}
                    title={title}
                  >
                    <span>{tr(profile === "standard" ? "标准" : "本地轻量")}</span>
                    <span className="xn-composer-toolbar__menu-indicator" aria-hidden="true">
                      {activeRuntimeProfile === profile && <IconCheck />}
                    </span>
                  </button>;
                })}
                {!canSelectStandard && <p className="xn-composer-toolbar__profile-note">{tr("JSON 工具模式只能使用本地轻量档位。")}</p>}
              </div>
              {(selectedModel || runtimeBudget || pauseReason) && <div className="xn-composer-toolbar__budget-hint" aria-label={tr("运行预算估算")}>
                {runtimeBudget?.profile === activeRuntimeProfile && (
                  <>
                    {Number.isFinite(runtimeBudget.estimatedInputTokens) && Number.isFinite(runtimeBudget.inputBudgetTokens) && <span>{tf("输入估算 {0} / 预算 {1} tokens", [runtimeBudget.estimatedInputTokens!.toLocaleString(), runtimeBudget.inputBudgetTokens!.toLocaleString()])}</span>}
                    {Number.isFinite(runtimeBudget.reservedOutputTokens) && <span>{tf("输出预留 {0} tokens", [runtimeBudget.reservedOutputTokens!.toLocaleString()])}</span>}
                    {Number.isFinite(runtimeBudget.activeTools) && <span>{tf("可用工具 {0}", [runtimeBudget.activeTools!.toLocaleString()])}</span>}
                    <small>{tr("输入数值为本地估算，不是服务商报告的实际用量。")}</small>
                  </>
                )}
                {runtimeBudget?.profile !== activeRuntimeProfile && selectedModel && (
                  <>
                    {Number.isFinite(selectedModel.contextWindow ?? (activeRuntimeProfile === "lightweight" ? 8192 : undefined)) && <span>{tf("上下文窗口 {0} tokens", [(selectedModel.contextWindow ?? 8192).toLocaleString()])}</span>}
                    {Number.isFinite(selectedModel.maxOutputTokens ?? (activeRuntimeProfile === "lightweight" ? 1024 : undefined)) && <span>{tf("输出上限 {0} tokens", [(selectedModel.maxOutputTokens ?? 1024).toLocaleString()])}</span>}
                    {activeRuntimeProfile === "lightweight" && <small>{tr("运行后会显示输入预算估算；这不是服务商实际用量。")}</small>}
                  </>
                )}
                {pauseReason && <span className="xn-composer-toolbar__pause-reason">{tf("暂停原因：{0}", [pauseReason])}</span>}
              </div>}
              <div className="xn-composer-toolbar__model-footer">
                <button
                  type="button"
                  role="menuitem"
                  className="xn-composer-toolbar__manage"
                  disabled={disabled}
                  onClick={() => {
                    closeModelMenu();
                    onManageModels();
                  }}
                >{tr("管理模型")}</button>
              </div>
            </div>
          )}
        </div>
        {selectedModel && selectedModel.reasoningLevels.length > 1 && (
          <Select
            className="xn-composer-toolbar__reasoning-select"
            aria-label={tr("思考强度")}
            title={tr("思考强度")}
            value={choices.reasoning_effort ?? ""}
            disabled={disabled}
            onChange={(event) => onChange({ reasoning_effort: event.target.value || undefined })}
          >
            <option value="">{tr("默认")}</option>
            {selectedModel.reasoningLevels.map((level) => <option key={level} value={level}>{level}</option>)}
          </Select>
        )}
        {hasUsage && contextUsage && (
          <button
            type="button"
            className="xn-composer-toolbar__usage"
            aria-label={tr("上下文用量")}
            title={contextUsage.used.toLocaleString() + " / " + contextUsage.max.toLocaleString()}
            disabled={disabled}
            onClick={onOpenUsage}
          >
            <span className="xn-composer-toolbar__usage-track" aria-hidden="true">
              <span style={{ width: usagePercent + "%" }} />
            </span>
            <span>{Math.round(usagePercent)}%</span>
          </button>
        )}
      </div>
    </div>
  );
}
