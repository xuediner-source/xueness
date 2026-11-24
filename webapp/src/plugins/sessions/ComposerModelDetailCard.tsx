import React from "react";
import { t as tr, tf } from "../../i18n";
import { IconPencil } from "../../ui/icons";
import type { ComposerModel } from "../../xuenessComposer";
import {
  formatContextWindow, formatCostMultiplier, modelDetailCardStyle, modelDetailSentence, modelThinkingText, reportedCostMultiplier,
  type ModelDetailAnchor, type ModelPopoverBounds,
} from "./composerModelCatalog";
const MODEL_DETAIL_CARD = { width: 248, maxHeight: 340 } as const;

export type ComposerModelDetailCardProps = {
  model: ComposerModel | undefined;
  anchor: ModelDetailAnchor;
  popoverBounds?: ModelPopoverBounds;
  cardRef?: React.Ref<HTMLDivElement>;
  onPointerEnter?(): void;
  onPointerLeave?(): void;
  onKeyDown?(event: React.KeyboardEvent<HTMLDivElement>): void;
  onEdit(): void;
};

/**
 * Hover/focus detail card: context length, thinking support, cost, one factual
 * sentence, and Edit into that provider's settings. Missing facts render 「—」.
 * Cost stays 「—」 when the catalog did not report a multiplier.
 */
export function ComposerModelDetailCard({
  model,
  anchor,
  popoverBounds,
  cardRef,
  onPointerEnter,
  onPointerLeave,
  onKeyDown,
  onEdit,
}: ComposerModelDetailCardProps): React.JSX.Element | null {
  if (!model) return null;
  const context = formatContextWindow(model.contextWindow);
  const thinking = modelThinkingText(model);
  const cost = formatCostMultiplier(reportedCostMultiplier(model));
  const sentence = modelDetailSentence(model);
  return (
    <div
      ref={cardRef}
      className="xn-composer-toolbar__model-detail"
      style={modelDetailCardStyle(anchor, {
        width: typeof window === "undefined" ? 1280 : window.innerWidth,
        height: typeof window === "undefined" ? 800 : window.innerHeight,
      }, MODEL_DETAIL_CARD, popoverBounds)}
      id="composer-model-detail"
      role="group"
      tabIndex={0}
      aria-label={tf("模型详情：{0}", [model.name])}
      data-testid="composer-model-detail"
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      onKeyDown={onKeyDown}
    >
      <div className="xn-composer-toolbar__model-detail-name" title={model.name}>{model.name}</div>
      {!model.configured && <div className="xn-composer-toolbar__model-detail-unconfigured">{tr("未配置")}</div>}
      <dl className="xn-composer-toolbar__model-detail-facts">
        <div><dt>{tr("上下文")}</dt><dd>{context ?? "—"}</dd></div>
        <div><dt>{tr("推理")}</dt><dd>{thinking ?? "—"}</dd></div>
        <div><dt>{tr("成本")}</dt><dd>{cost ?? "—"}</dd></div>
      </dl>
      <p className="xn-composer-toolbar__model-detail-note">{sentence ?? "—"}</p>
      <button type="button" className="xn-composer-toolbar__model-detail-edit" data-testid="composer-model-detail-edit" onClick={onEdit}>
        <IconPencil size={12} aria-hidden="true" />
        <span>{tr("编辑")}</span>
      </button>
    </div>
  );
}
