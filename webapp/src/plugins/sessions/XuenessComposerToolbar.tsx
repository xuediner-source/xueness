import { permissionChoices } from './permissionChoices';
import './ApprovalChoiceMenu.css';
import { ContextUsageRing, type ContextUsageReading } from './ContextUsageRing';
import React, { useEffect, useRef, useState } from "react";
import { t as tr } from "../../i18n";
import { IconChevronDown } from "../../ui/icons";
import { normalizeReasoningLevels, ReasoningEffortControl } from "./ReasoningEffortSlider";
import { canUseRuntimeProfile, effectiveRuntimeProfile, runtimeProfileSelection, type ComposerModel, type RuntimeProfile } from "../../xuenessComposer";
import type { RunChoices } from "../../xuenessBridge";
import type { WorkbenchSession } from "../../xuenessWorkbench";
import type { PermissionMode } from "./permissionModes";
import { FullAccessConfirmationDialog, requiresYoloConfirmation } from "./FullAccessConfirmationDialog";
import { handlePopoverEscape, isReasoningEffortSupported, nextIndex } from "./composerModelCatalog";
import { ComposerModelMenu } from "./ComposerModelMenu";
import { ComposerModeControls } from "./ComposerModeControls";

export type ComposerToolbarProps = {
  choices: RunChoices;
  onChange(patch: Partial<RunChoices>): void;
  permissionDisabled?: boolean;
  onPermissionChange?: (mode: PermissionMode, acknowledged: boolean) => void | Promise<unknown>;
  models: ComposerModel[];
  loading: boolean;
  error: string;
  onReload(): void;
  /** Opens provider settings. A model argument focuses that saved profile. */
  onManageModels(model?: ComposerModel): void;
  /** 「设为默认」：宿主把入口接到 providers.default_selection 的后端接口。 */
  onSaveDefault?(model: ComposerModel): void;
  defaultSaved?: boolean;
  onBackground?: () => void;
  backgroundCount?: number;
  /** Kept for callers that still pass it; the actual selected state comes from choices.browser. */
  browserEnabled?: boolean;
  onToggleBrowser?(enabled: boolean): void;
  contextReading?: ContextUsageReading | null;
  contextUsage?: { used: number; max: number; cacheHitRate?: number | null };
  runtimeBudget?: WorkbenchSession["runtime_budget"];
  pauseReason?: string | null;
  onOpenUsage?: () => void;
  disabled?: boolean;
  /** Actual composer input to focus after a menu selection, when the caller has one. */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  /**
   * Minimal chrome for the lightweight local profile (owned by the providers
   * plugin): model, reasoning and context controls. Other controls stay out unless the owning plugin supplies
   * the lightweight permission selector; the model menu itself is unchanged.
   */
  minimal?: boolean;
  minimalPermissionControl?: React.ReactNode;
};

export function XuenessComposerToolbar({
  choices,
  onChange,
  models,
  loading,
  error,
  onReload,
  onManageModels,
  onSaveDefault,
  defaultSaved = false,
  onBackground,
  backgroundCount = 0,
  onToggleBrowser,
  contextUsage,
  contextReading,
  runtimeBudget,
  pauseReason,
  onOpenUsage,
  disabled = false, permissionDisabled = disabled, onPermissionChange,
  minimal = false,
  minimalPermissionControl,
  inputRef,
}: ComposerToolbarProps) {
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [confirmYoloOpen, setConfirmYoloOpen] = useState(false);
  const modeWrapRef = useRef<HTMLDivElement | null>(null);
  const modelWrapRef = useRef<HTMLDivElement | null>(null);
  const modeMenuRef = useRef<HTMLDivElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);
  const modeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const modelTriggerRef = useRef<HTMLButtonElement | null>(null);
  const focusFrameRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
  }, []);

  const focusComposerInput = () => {
    if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null;
      if (inputRef) {
        const input = inputRef.current;
        if (input?.isConnected) input.focus();
        return;
      }
      document.querySelector<HTMLTextAreaElement>("textarea.xn-composer__input, textarea.xn-lightweight-composer__textarea")?.focus();
    });
  };

  const selectedModel = models.find((model) => model.id === (choices.provider_id ?? ""))
    ?? (choices.model ? models.find((model) => model.model === choices.model) : undefined);
  const reasoningLevels = selectedModel ? normalizeReasoningLevels(selectedModel.reasoningLevels) : [];
  useEffect(() => {
    if (disabled || !selectedModel || !choices.reasoning_effort) return;
    if (!isReasoningEffortSupported(selectedModel, choices.reasoning_effort)) onChange({ reasoning_effort: undefined });
  }, [disabled, selectedModel?.id, selectedModel?.model, selectedModel?.reasoningLevels, choices.reasoning_effort, onChange]);
  const selectedPermission = permissionChoices.find((choice) => choice.value === (choices.permission_mode ?? "build")) ?? permissionChoices[0];
  const ringReading = contextReading !== undefined ? contextReading : contextUsage ? {
    usedTokens: contextUsage.used, capacityTokens: contextUsage.max,
    usageSource: "estimated" as const, capacitySource: "input-budget" as const,
  } : null;
  const browserIsEnabled = choices.browser === true;
  const activeRuntimeProfile = effectiveRuntimeProfile(selectedModel, choices.runtime_profile);
  const canSelectStandard = canUseRuntimeProfile(selectedModel, "standard");

  const closeModeMenu = (restoreInput = false) => {
    setModeMenuOpen(false);
    if (restoreInput) focusComposerInput();
  };
  const closeModelMenu = (restoreInput = false) => {
    setModelMenuOpen(false);
    if (restoreInput) focusComposerInput();
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
    // Shared composer retains its draft across profile switches. Return focus
    // after selecting the profile, just as after selecting a model.
    closeModelMenu(true);
  };
  const isModelSelected = (model: ComposerModel) => {
    if (choices.provider_id) return model.id === choices.provider_id && (!choices.model || model.model === choices.model);
    return choices.model ? model.model === choices.model : model.id === "";
  };
  const changePermission = (permission: NonNullable<RunChoices["permission_mode"]>) => {
    if (requiresYoloConfirmation(choices.permission_mode ?? "build", permission, choices.acknowledge_yolo === true)) {
      closeModeMenu(false);
      setConfirmYoloOpen(true);
      return;
    }
    if (onPermissionChange) void onPermissionChange(permission, permission === "yolo");
    else onChange({ permission_mode: permission, acknowledge_yolo: permission === "yolo" });
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
    modeMenuRef.current?.querySelector<HTMLButtonElement>("[role='menuitemcheckbox']:not(:disabled), [role='menuitemradio']:not(:disabled)")?.focus();
  }, [modeMenuOpen]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    // Land on the first model row so the detail card follows the initial focus.
    const menu = modelMenuRef.current;
    const target = menu?.querySelector<HTMLButtonElement>("[data-supplier-row]:not(:disabled), [role='menuitemradio'][data-model-row]:not(:disabled)")
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
    if (key) requestAnimationFrame(() => { const items = modeMenuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitemcheckbox']:not(:disabled), [role='menuitemradio']:not(:disabled)"); items?.[key === "ArrowUp" ? items.length - 1 : 0]?.focus(); });
  };
  const openModelMenu = (key?: string) => {
    setModeMenuOpen(false);
    setModelMenuOpen(true);
    if (key) requestAnimationFrame(() => {
      const items = Array.from(modelMenuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']:not(:disabled), [role='menuitem']:not(:disabled)") ?? []);
      if (key === "ArrowUp") items[items.length - 1]?.focus();
      else (items.find(item => item.dataset.supplierRow !== undefined || item.dataset.modelRow !== undefined) ?? items[0])?.focus();
    });
  };

  return (
    <div className="xn-composer-toolbar" data-testid="composer-toolbar" data-minimal={minimal || undefined}>
      {!minimal && <ComposerModeControls modeWrapRef={modeWrapRef} modeTriggerRef={modeTriggerRef} modeMenuRef={modeMenuRef}
        selectedPermission={selectedPermission} modeMenuOpen={modeMenuOpen} closeModeMenu={closeModeMenu}
        openModeMenu={openModeMenu} permissionDisabled={permissionDisabled} disabled={disabled} choices={choices}
        onChange={onChange} onModeKeyDown={onModeKeyDown} confirmYoloOpen={confirmYoloOpen}
        changePermission={changePermission} onToggleBrowser={onToggleBrowser} browserIsEnabled={browserIsEnabled}
        onBackground={onBackground} backgroundCount={backgroundCount} />}

      <FullAccessConfirmationDialog
        open={confirmYoloOpen}
        returnFocusTo={modeTriggerRef.current}
        onCancel={() => {
          setConfirmYoloOpen(false);
          closeModeMenu(false);
        }}
        onConfirm={() => {
          setConfirmYoloOpen(false);
          if (onPermissionChange) void onPermissionChange("yolo", true);
          else onChange({ permission_mode: "yolo", acknowledge_yolo: true });
          closeModeMenu(true);
        }}
      />

      <div className="xn-composer-toolbar__right" role="group" aria-label={tr(minimalPermissionControl ? "模型、权限与上下文" : "模型与上下文")}>
        {minimal && minimalPermissionControl}
        <ContextUsageRing enabled reading={ringReading} />
        <div className="xn-composer-toolbar__model" ref={modelWrapRef}>
          <button
            ref={modelTriggerRef}
            type="button"
            data-shortcut-action="open-model-menu" className="xn-composer-toolbar__model-trigger"
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
              onSaveDefault={onSaveDefault}
              defaultSaved={defaultSaved}
              onRequestClose={closeModelMenu}
            />
          )}
        </div>
        {selectedModel && (
          <ReasoningEffortControl
            levels={reasoningLevels}
            value={choices.reasoning_effort}
            modelName={selectedModel.model || selectedModel.name}
            scopeKey={JSON.stringify([selectedModel.id, selectedModel.model, choices.model ?? ""])}
            disabled={disabled}
            onConfigure={() => { closeModelMenu(); onManageModels(selectedModel); }}
            onChange={(reasoning_effort) => onChange({ reasoning_effort })}
          />
        )}

      </div>
    </div>
  );
}

export * from './composerModelCatalog';

export * from './ComposerModelDetailCard';

export * from './ComposerModelMenu';
