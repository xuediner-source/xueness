import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Search } from "lucide-react";
import { t as tr, tf, useLocale } from "../../i18n";
import { IconCheck, IconRefresh } from "../../ui/icons";
import type { ComposerModel, RuntimeProfile } from "../../xuenessComposer";
import type { WorkbenchSession } from "../../xuenessWorkbench";
import { isImeComposingEvent } from "../../xuenessShortcutDisplay";
import {
  formatCostMultiplier, groupComposerModels, handlePopoverEscape, nextIndex, reportedCostMultiplier,
  type ModelDetailAnchor, type ModelPopoverBounds,
} from "./composerModelCatalog";
import { ComposerModelDetailCard } from "./ComposerModelDetailCard";
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
  /** Opens provider settings. A model argument focuses that saved profile. */
  onManageModels(model?: ComposerModel): void;
  /** 「设为默认」小操作（providers.default_selection）；宿主不接线时整个入口不渲染。 */
  onSaveDefault?(model: ComposerModel): void;
  defaultSaved?: boolean;
  /** Close the popover; a truthy argument re-focuses the composer input. */
  onRequestClose(restoreInput?: boolean): void;
  /** Renders the detail card for this row key without a pointer event (tests). */
  detailKey?: string;
  initialSupplierId?: string;
};

/**
 * 模型弹层按目录声明的供应商提供两级导航，不推测能力等级。
 * 模型行只在目录给出成本倍率时显示它。悬停或键盘聚焦弹出详情卡。
 * 「标准 / 本地轻量」仍是既有运行档位开关。Esc 关闭并把焦点还给触发按钮。
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
  onSaveDefault,
  defaultSaved = false,
  onRequestClose,
  detailKey,
  initialSupplierId,
}: ComposerModelMenuProps): React.JSX.Element {
  const locale = useLocale();
  const [supplierId, setSupplierId] = useState(initialSupplierId ?? '');
  const [query, setQuery] = useState('');
  const groups = groupComposerModels(models, locale);
  const supplier = groups.find(group => group.id === supplierId);
  const needle = query.trim().toLocaleLowerCase();
  const visibleModels = (supplier?.models ?? models).filter(model =>
    !needle || [model.name, model.model, model.supplierName, model.supplierNameEn].join(' ').toLocaleLowerCase().includes(needle));
  /** Row the detail card is anchored to; set on hover or keyboard focus. */
  const [modelDetail, setModelDetail] = useState<{
    key: string;
    anchor: ModelDetailAnchor;
    popoverBounds?: ModelPopoverBounds;
  } | null>(null);
  const popoverElementRef = useRef<HTMLDivElement | null>(null);
  const detailCardRef = useRef<HTMLDivElement | null>(null);
  const detailCloseTimer = useRef<number | null>(null);
  const setMenuElement = useCallback((node: HTMLDivElement | null) => {
    popoverElementRef.current = node;
    if (typeof menuRef === "function") menuRef(node);
    else if (menuRef) (menuRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
  }, [menuRef]);
  const clearModelDetail = () => {
    setModelDetail(null);
  };
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
      clearModelDetail();
    }, 180);
  };
  const showDetail = (key: string, row: HTMLElement) => {
    cancelDetailClose();
    const rect = row.getBoundingClientRect();
    const menu = popoverElementRef.current?.getBoundingClientRect();
    setModelDetail({
      key,
      anchor: { top: rect.top, left: rect.left, right: rect.right },
      popoverBounds: menu ? { top: menu.top, bottom: menu.bottom, left: menu.left, right: menu.right } : undefined,
    });
  };
  useEffect(() => () => cancelDetailClose(), []);
  useEffect(() => {
    if (!supplierId) return;
    popoverElementRef.current?.querySelector<HTMLButtonElement>('[data-model-row]:not(:disabled)')?.focus();
  }, [supplierId]);

  const goBack = () => {
    const previous = supplierId;
    setSupplierId(''); clearModelDetail();
    requestAnimationFrame(() => Array.from(popoverElementRef.current?.querySelectorAll<HTMLButtonElement>('[data-supplier-row]') ?? [])
      .find(button => button.dataset.supplierRow === previous)?.focus());
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposingEvent(event)) return;
    if (event.key === 'ArrowLeft' && supplier && !(event.target instanceof HTMLInputElement)) { event.preventDefault(); goBack(); return; }
    if (event.key === 'ArrowRight' && (event.target as HTMLElement).dataset.supplierRow) {
      event.preventDefault(); setSupplierId((event.target as HTMLElement).dataset.supplierRow!); clearModelDetail(); return;
    }
    if (event.key === 'Escape' && needle) { event.preventDefault(); event.stopPropagation(); setQuery(''); clearModelDetail(); return; }
    if (event.key === 'Escape' && supplier) { event.preventDefault(); event.stopPropagation(); goBack(); return; }
    if (handlePopoverEscape(event, onRequestClose, triggerRef?.current ?? null)) return;
    if (event.target instanceof HTMLInputElement && ['Home', 'End'].includes(event.key)) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']:not(:disabled), [role='menuitem']:not(:disabled)"));
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    items[nextIndex(current, items.length, event.key as "ArrowDown" | "ArrowUp" | "Home" | "End")]?.focus();
  };
  const shownDetailKey = modelDetail?.key ?? detailKey;
  const shownAnchor = modelDetail?.anchor ?? (detailKey ? { top: 96, left: 520, right: 760 } : null);
  const detailModel = shownDetailKey
    ? models.find((model) => model.id + ":" + model.model === shownDetailKey)
    : undefined;
  return (
    <div
      ref={setMenuElement}
      className="xn-composer-toolbar__popover xn-composer-toolbar__model-popover"
      data-supplier-navigation="true"
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
      <label className="xn-composer-toolbar__model-search"><Search size={14} aria-hidden="true" />
        <input type="search" aria-label={tr('搜索供应商或模型')} placeholder={tr('搜索供应商或模型')} value={query}
          onChange={event => { setQuery(event.target.value); clearModelDetail(); }} /></label>
      {supplier ? <button type="button" role="menuitem" className="xn-composer-toolbar__supplier-back" onClick={goBack}>
        <ArrowLeft size={14} aria-hidden="true" /><span>{supplier.name}</span><small>{supplier.models.length}</small>
      </button> : <div className="xn-composer-toolbar__supplier-heading">{tr(needle ? '搜索结果' : '按供应商选择')}<span>{needle ? visibleModels.length : groups.length}</span></div>}
      {!loading && !error && models.length === 0 && (
        <div className="xn-composer-toolbar__message">{tr("暂无可用模型")}</div>
      )}
      {!loading && !error && models.length > 0 && (
        <div
          role="group"
          aria-label={tr("可用模型")}
          className="xn-composer-toolbar__model-options"
          data-testid="composer-model-options"
          onScroll={clearModelDetail}
        >
          {!supplier && !needle ? groups.map(group => <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded="false"
            className="xn-composer-toolbar__supplier-option" key={group.id} data-supplier-row={group.id} disabled={disabled}
            onClick={() => { setSupplierId(group.id); clearModelDetail(); }}>
            <span className="xn-composer-toolbar__supplier-mark" aria-hidden="true">{group.name.slice(0, 1).toUpperCase()}</span>
            <span className="xn-composer-toolbar__supplier-copy"><strong title={group.name}>{group.name}</strong><small>{tf('{0} 个模型', [group.models.length])}
              {group.models.some(isSelected) && <span className="xn-composer-toolbar__supplier-current"> · {tr('当前选择')}</span>}</small></span>
            <ChevronRight size={15} aria-hidden="true" />
          </button>) : visibleModels.map((model) => {
            const selected = isSelected(model);
            const rowKey = model.id + ":" + model.model;
            const costLabel = formatCostMultiplier(reportedCostMultiplier(model));
            return (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                aria-describedby={shownDetailKey === rowKey ? "composer-model-detail" : undefined}
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
                title={!model.configured ? tr("该模型尚未配置") : `${model.name} · ${model.model}`}
              >
                <span className="xn-composer-toolbar__model-name">{supplier && model.supplierName && model.name.startsWith(model.supplierName + ' · ')
                  ? model.name.slice(model.supplierName.length + 3) : model.name}
                  {needle && !supplier && model.supplierName && <small>{locale === 'en' ? model.supplierNameEn ?? model.supplierName : model.supplierName}</small>}</span>
                {!model.configured && <small>{tr("未配置")}</small>}
                {costLabel && (
                  <span className="xn-composer-toolbar__model-cost" data-testid="model-row-cost" title={tr("成本倍率")}>{costLabel}</span>
                )}
                <span className="xn-composer-toolbar__menu-indicator" aria-hidden="true">
                  {selected && <IconCheck />}
                </span>
              </button>
            );
          })}
          {(supplier || needle) && visibleModels.length === 0 && <div className="xn-composer-toolbar__message">{tr('没有匹配的模型')}</div>}
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
            {Number.isFinite(selectedModel.contextWindow ?? (activeRuntimeProfile === "lightweight" ? 16384 : undefined)) && <span>{tf("上下文窗口 {0} tokens", [(selectedModel.contextWindow ?? 16384).toLocaleString()])}</span>}
            {Number.isFinite(selectedModel.maxOutputTokens ?? (activeRuntimeProfile === "lightweight" ? 1024 : undefined)) && <span>{tf("输出上限 {0} tokens", [(selectedModel.maxOutputTokens ?? 1024).toLocaleString()])}</span>}
            {activeRuntimeProfile === "lightweight" && <small>{tr("运行后会显示输入预算估算；这不是服务商实际用量。")}</small>}
          </>
        )}
        {pauseReason && <span className="xn-composer-toolbar__pause-reason">{tf("暂停原因：{0}", [pauseReason])}</span>}
      </div>}
      <div className="xn-composer-toolbar__model-footer">
        {onSaveDefault && selectedModel && (
          <button
            type="button"
            role="menuitem"
            className="xn-composer-toolbar__default"
            data-testid="composer-save-default"
            disabled={disabled || !selectedModel.configured}
            title={tr("把当前模型与推理档位存为默认，之后的新会话与未指定模型的运行都使用它。")}
            onClick={() => onSaveDefault(selectedModel)}
          >{defaultSaved && <span className="xn-composer-toolbar__menu-indicator" aria-hidden="true"><IconCheck /></span>}<span>{tr(defaultSaved ? "已设为默认" : "设为默认")}</span></button>
        )}
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
      {shownAnchor && detailModel && (
        <ComposerModelDetailCard
          model={detailModel}
          anchor={shownAnchor}
          popoverBounds={modelDetail?.popoverBounds}
          cardRef={detailCardRef}
          onPointerEnter={cancelDetailClose}
          onPointerLeave={scheduleDetailClose}
          onKeyDown={(event) => { handlePopoverEscape(event, onRequestClose, triggerRef?.current ?? null); }}
          onEdit={() => {
            onRequestClose();
            onManageModels(detailModel);
          }}
        />
      )}
    </div>
  );
}
