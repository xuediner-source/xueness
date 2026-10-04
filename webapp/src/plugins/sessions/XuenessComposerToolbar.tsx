import React, { useEffect, useRef, useState } from "react";
import { ClipboardList, Hand, Lightbulb, ShieldAlert, ShieldCheck } from "lucide-react";
import { t as tr, tf } from "../../i18n";
import { IconCheck, IconChevronDown, IconPencil, IconRefresh, IconX } from "../../ui/icons";
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
  /**
   * Minimal chrome for the lightweight local profile (owned by the providers
   * plugin): the model trigger (with its runtime-profile menu) and the context
   * usage readout only. Permission, browser, background and reasoning controls
   * are left out; the model menu itself is unchanged.
   */
  minimal?: boolean;
};

const permissionChoices = [
  { value: "plan", label: "计划", description: "只读并先出计划。", Icon: ClipboardList },
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

/** Wrap-aware movement for menu rows; exported so SSR tests can assert it. */
export function nextIndex(current: number, length: number, key: "ArrowDown" | "ArrowUp" | "Home" | "End"): number {
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

/** Compact context size for the model rows: 200000 → "200K", 1048576 → "1M". */
export function formatContextWindow(tokens: number | undefined | null): string | null {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return null;
  const compact = (value: number): string => {
    const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  };
  if (tokens >= 1_000_000) return `${compact(tokens / 1_000_000)}M`;
  if (tokens >= 1000) return `${compact(tokens / 1000)}K`;
  return String(tokens);
}

/** Row-level reasoning summary: at most three levels plus a "+" marker. */
export function modelReasoningSummary(model: Pick<ComposerModel, "reasoningLevels">): string | null {
  const levels = (model.reasoningLevels ?? []).filter(level => typeof level === "string" && level.length > 0);
  if (levels.length === 0) return null;
  return levels.slice(0, 3).join("/") + (levels.length > 3 ? "+" : "");
}

/** Row hit area the detail card anchors to, in viewport coordinates. */
export type ModelDetailAnchor = { top: number; left: number; right: number };

/**
 * Place the detail card beside the anchored row: left of it when the viewport
 * allows, otherwise flipped to the right; vertically clamped so the card never
 * leaves the viewport. Pure so SSR tests can assert the flip and clamp rules.
 */
export function modelDetailCardStyle(
  anchor: ModelDetailAnchor,
  viewport: { width: number; height: number },
  card: { width: number; maxHeight: number },
): React.CSSProperties {
  const margin = 8;
  const gap = 10;
  const top = Math.max(margin, Math.min(anchor.top, viewport.height - card.maxHeight - margin));
  if (anchor.left - gap - card.width >= margin) {
    return { top, right: viewport.width - anchor.left + gap, width: card.width, maxHeight: card.maxHeight };
  }
  return {
    top,
    left: Math.min(anchor.right + gap, Math.max(margin, viewport.width - card.width - margin)),
    width: card.width,
    maxHeight: card.maxHeight,
  };
}

const MODEL_DETAIL_CARD = { width: 248, maxHeight: 340 } as const;

export type ComposerModelDetailCardProps = {
  model: ComposerModel | undefined;
  anchor: ModelDetailAnchor;
  cardRef?: React.Ref<HTMLDivElement>;
  onPointerEnter?(): void;
  onPointerLeave?(): void;
  onKeyDown?(event: React.KeyboardEvent<HTMLDivElement>): void;
  onEdit(): void;
};

/**
 * Hover/focus detail card for one model row: identity, protocol, context and
 * output limits, reasoning levels, plus the edit entry into model settings.
 * Renders nothing without a model — the rows are the source of truth.
 */
export function ComposerModelDetailCard({
  model,
  anchor,
  cardRef,
  onPointerEnter,
  onPointerLeave,
  onKeyDown,
  onEdit,
}: ComposerModelDetailCardProps): React.JSX.Element | null {
  if (!model) return null;
  const context = formatContextWindow(model.contextWindow);
  const maxOutput = formatContextWindow(model.maxOutputTokens);
  const levels = (model.reasoningLevels ?? []).filter(level => typeof level === "string" && level.length > 0);
  return (
    <div
      ref={cardRef}
      className="xn-composer-toolbar__model-detail"
      style={modelDetailCardStyle(anchor, {
        width: typeof window === "undefined" ? 1280 : window.innerWidth,
        height: typeof window === "undefined" ? 800 : window.innerHeight,
      }, MODEL_DETAIL_CARD)}
      role="group"
      aria-label={tf("模型详情：{0}", [model.name])}
      data-testid="composer-model-detail"
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      onKeyDown={onKeyDown}
    >
      <div className="xn-composer-toolbar__model-detail-name" title={model.name}>{model.name}</div>
      {!model.configured && <div className="xn-composer-toolbar__model-detail-unconfigured">{tr("未配置")}</div>}
      <dl className="xn-composer-toolbar__model-detail-facts">
        <div><dt>{tr("模型 ID")}</dt><dd title={model.model}>{model.model || "—"}</dd></div>
        <div><dt>{tr("协议")}</dt><dd>{model.protocol === "anthropic" ? "Anthropic" : "OpenAI"}</dd></div>
        <div><dt>{tr("上下文窗口")}</dt><dd>{context ?? "—"}</dd></div>
        <div><dt>{tr("最大输出")}</dt><dd>{maxOutput ?? "—"}</dd></div>
        <div><dt>{tr("推理档位")}</dt><dd>{levels.length > 0 ? levels.join("/") : "—"}</dd></div>
      </dl>
      <button type="button" className="xn-composer-toolbar__model-detail-edit" onClick={onEdit}>
        <IconPencil size={12} aria-hidden="true" />
        <span>{tr("编辑")}</span>
      </button>
    </div>
  );
}

export type ComposerModelMenuProps = {
  menuRef?: React.Ref<HTMLDivElement>;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
  loading: boolean;
  error: string;
  models: ComposerModel[];
  disabled: boolean;
  isSelected(model: ComposerModel): boolean;
  activeRuntimeProfile: RuntimeProfile;
  canSelectStandard: boolean;
  selectedModel: ComposerModel | undefined;
  runtimeBudget?: WorkbenchSession["runtime_budget"];
  pauseReason?: string | null;
  onChooseModel(model: ComposerModel): void;
  onChooseProfile(profile: RuntimeProfile): void;
  onReload(): void;
  onManageModels(): void;
  /** Close the popover; a truthy argument re-focuses the composer input. */
  onRequestClose(restoreInput?: boolean): void;
};

/**
 * Qoder 式模型弹层：顶部「标准 / 本地轻量」档位行，模型行右侧显示上下文窗口
 * 与推理档位，悬停或键盘聚焦某行时弹出详情卡（含编辑入口）。只做展示与本地
 * 详情卡状态；数据、选择与关闭回调全部来自宿主，键盘上下选择与 Esc 关闭
 * 在这里统一处理。
 */
export function ComposerModelMenu({
  menuRef,
  triggerRef,
  loading,
  error,
  models,
  disabled,
  isSelected,
  activeRuntimeProfile,
  canSelectStandard,
  selectedModel,
  runtimeBudget,
  pauseReason,
  onChooseModel,
  onChooseProfile,
  onReload,
  onManageModels,
  onRequestClose,
}: ComposerModelMenuProps): React.JSX.Element {
  /** Row the detail card is anchored to; set on hover or keyboard focus. */
  const [modelDetail, setModelDetail] = useState<{ key: string; anchor: ModelDetailAnchor } | null>(null);
  const detailCardRef = useRef<HTMLDivElement | null>(null);
  const detailCloseTimer = useRef<number | null>(null);
  const cancelDetailClose = () => {
    if (detailCloseTimer.current !== null) {
      window.clearTimeout(detailCloseTimer.current);
      detailCloseTimer.current = null;
    }
  };
  const scheduleDetailClose = () => {
    cancelDetailClose();
    detailCloseTimer.current = window.setTimeout(() => {
      detailCloseTimer.current = null;
      setModelDetail(null);
    }, 180);
  };
  const showDetail = (key: string, row: HTMLElement) => {
    cancelDetailClose();
    const rect = row.getBoundingClientRect();
    setModelDetail({ key, anchor: { top: rect.top, left: rect.left, right: rect.right } });
  };
  useEffect(() => () => cancelDetailClose(), []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (handlePopoverEscape(event, onRequestClose, triggerRef?.current ?? null)) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']:not(:disabled), [role='menuitem']:not(:disabled)"));
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    items[nextIndex(current, items.length, event.key as "ArrowDown" | "ArrowUp" | "Home" | "End")]?.focus();
  };
  const detailModel = modelDetail
    ? models.find((model) => model.id + ":" + model.model === modelDetail.key)
    : undefined;

  return (
    <div
      ref={menuRef}
      className="xn-composer-toolbar__popover xn-composer-toolbar__model-popover"
      role="menu"
      aria-label={tr("可用模型")}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onRequestClose();
      }}
    >
      <div
        className="xn-composer-toolbar__runtime-profile"
        role="group"
        aria-label={tr("运行档位")}
        data-testid="composer-runtime-profile"
      >
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
            onClick={() => onChooseProfile(profile)}
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
        <div
          className="xn-composer-toolbar__model-options"
          role="group"
          aria-label={tr("可用模型")}
          onScroll={() => setModelDetail(null)}
        >
          {models.map((model) => {
            const selected = isSelected(model);
            const rowKey = model.id + ":" + model.model;
            const contextLabel = formatContextWindow(model.contextWindow);
            const reasoningLabel = modelReasoningSummary(model);
            return (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                key={rowKey}
                data-model-row={rowKey}
                className="xn-composer-toolbar__model-option"
                disabled={disabled || !model.configured}
                onClick={() => onChooseModel(model)}
                onMouseEnter={(event) => showDetail(rowKey, event.currentTarget)}
                onFocus={(event) => showDetail(rowKey, event.currentTarget)}
                onMouseLeave={(event) => {
                  if (document.activeElement === event.currentTarget) return;
                  scheduleDetailClose();
                }}
                onBlur={(event) => {
                  const next = event.relatedTarget as Node | null;
                  if (next && detailCardRef.current?.contains(next)) {
                    cancelDetailClose();
                    return;
                  }
                  if (next && event.currentTarget.parentElement?.contains(next)) return;
                  scheduleDetailClose();
                }}
                title={!model.configured ? tr("该模型尚未配置") : model.model}
              >
                <span className="xn-composer-toolbar__model-name">{model.name}</span>
                {!model.configured && <small>{tr("未配置")}</small>}
                {(contextLabel || reasoningLabel) && (
                  <span className="xn-composer-toolbar__model-meta">
                    {contextLabel && <small title={tr("上下文窗口")}>{contextLabel}</small>}
                    {reasoningLabel && <small title={tr("推理档位")}>{reasoningLabel}</small>}
                  </span>
                )}
                <span className="xn-composer-toolbar__menu-indicator" aria-hidden="true">
                  {selected && <IconCheck />}
                </span>
              </button>
            );
          })}
        </div>
      )}
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
            onRequestClose();
            onManageModels();
          }}
        >{tr("管理模型")}</button>
      </div>
      {modelDetail && (
        <ComposerModelDetailCard
          model={detailModel}
          anchor={modelDetail.anchor}
          cardRef={detailCardRef}
          onPointerEnter={cancelDetailClose}
          onPointerLeave={scheduleDetailClose}
          onKeyDown={(event) => { handlePopoverEscape(event, onRequestClose, triggerRef?.current ?? null); }}
          onEdit={() => {
            onRequestClose();
            onManageModels();
          }}
        />
      )}
    </div>
  );
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
  minimal = false,
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
    contextUsage.max > 0,
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
      if (!modelWrapRef.current?.contains(target)) closeModelMenu();
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
    // Land on the first model row so the detail card follows the initial focus.
    const menu = modelMenuRef.current;
    const target = menu?.querySelector<HTMLButtonElement>("[role='menuitemradio'][data-model-row]:not(:disabled)")
      ?? menu?.querySelector<HTMLButtonElement>("[role='menuitemradio']:not(:disabled)");
    target?.focus();
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
      if (key === "ArrowUp") items[items.length - 1]?.focus();
      else (items.find(item => item.dataset.modelRow !== undefined) ?? items[0])?.focus();
    });
  };

  return (
    <div className="xn-composer-toolbar" data-testid="composer-toolbar" data-minimal={minimal || undefined}>
      {!minimal && <div className="xn-composer-toolbar__left" role="group" aria-label={tr("权限与工具")}>
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
      </div>}

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
            <ComposerModelMenu
              menuRef={modelMenuRef}
              triggerRef={modelTriggerRef}
              loading={loading}
              error={error}
              models={models}
              disabled={disabled}
              isSelected={isModelSelected}
              activeRuntimeProfile={activeRuntimeProfile}
              canSelectStandard={canSelectStandard}
              selectedModel={selectedModel}
              runtimeBudget={runtimeBudget}
              pauseReason={pauseReason}
              onChooseModel={chooseModel}
              onChooseProfile={chooseRuntimeProfile}
              onReload={onReload}
              onManageModels={onManageModels}
              onRequestClose={closeModelMenu}
            />
          )}
        </div>
        {!minimal && selectedModel && selectedModel.reasoningLevels.length > 1 && (
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
        {hasUsage && contextUsage && (onOpenUsage ? (
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
        ) : (
          <span
            className="xn-composer-toolbar__usage xn-composer-toolbar__usage--static"
            aria-label={tr("上下文用量")}
            title={contextUsage.used.toLocaleString() + " / " + contextUsage.max.toLocaleString()}
          >
            <span className="xn-composer-toolbar__usage-track" aria-hidden="true">
              <span style={{ width: usagePercent + "%" }} />
            </span>
            <span>{Math.round(usagePercent)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}
