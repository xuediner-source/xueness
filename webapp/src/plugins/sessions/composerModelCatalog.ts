import React from "react";
import { t as tr, tf } from "../../i18n";
import type { ComposerModel } from "../../xuenessComposer";
import { isImeComposingEvent } from "../../xuenessShortcutDisplay";
export function groupComposerModels(models: ComposerModel[], locale: 'zh' | 'en' = 'zh') {
  const groups = new Map<string, { id: string; name: string; models: ComposerModel[] }>();
  for (const model of models) {
    const id = model.supplierId || (model.id === '' ? 'environment' : 'saved');
    const name = (locale === 'en' ? model.supplierNameEn : model.supplierName) || model.supplierName
      || tr(id === 'environment' ? '环境模型' : '已保存的配置');
    if (!groups.has(id)) groups.set(id, { id, name, models: [] });
    groups.get(id)!.models.push(model);
  }
  return [...groups.values()];
}

/** Wrap-aware movement for menu rows; exported so SSR tests can assert it. */
export function nextIndex(current: number, length: number, key: "ArrowDown" | "ArrowUp" | "Home" | "End"): number {
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (current < 0) return key === "ArrowDown" ? 0 : length - 1;
  return (current + (key === "ArrowDown" ? 1 : -1) + length) % length;
}

export function handlePopoverEscape(
  event: {
    key: string;
    preventDefault: () => void;
    stopPropagation?: () => void;
    isComposing?: boolean;
    keyCode?: number;
    nativeEvent?: { isComposing?: boolean; keyCode?: number };
    compositionActive?: boolean;
  },
  closeMenu: (restoreInput: boolean) => void,
  trigger: { focus: () => void } | null,
): boolean {
  if (event.key === "Escape" && !isImeComposingEvent(event)) {
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

/** Keep restored or edited model choices from sending an undeclared effort. */
export function isReasoningEffortSupported(model: Pick<ComposerModel, "reasoningLevels"> | undefined, effort: string | undefined): boolean {
  return !effort || !model || model.reasoningLevels?.includes(effort) === true;
}

/** Row hit area the detail card anchors to, in viewport coordinates. */
export type ModelDetailAnchor = { top: number; left: number; right: number };
export type ModelPopoverBounds = { top: number; bottom: number; left: number; right: number };

/**
 * Place the detail card beside the anchored row: left of it when the viewport
 * allows, otherwise flipped to the right; vertically clamped so the card never
 * leaves the viewport. Pure so SSR tests can assert the flip and clamp rules.
 */
export function modelDetailCardStyle(
  anchor: ModelDetailAnchor,
  viewport: { width: number; height: number },
  card: { width: number; maxHeight: number },
  popover?: ModelPopoverBounds,
): React.CSSProperties {
  const margin = 8;
  const gap = 10;
  const width = Math.max(0, Math.min(card.width, viewport.width - margin * 2));
  const top = Math.max(margin, Math.min(anchor.top, viewport.height - card.maxHeight - margin));
  if (popover) {
    // Keep the detail card outside the interactive model menu. On a narrow
    // viewport neither side may fit, so put it above or below the whole menu.
    const leftSpace = popover.left - margin - gap;
    const rightSpace = viewport.width - popover.right - margin - gap;
    if (leftSpace >= width) {
      return { top, left: popover.left - gap - width, width, maxHeight: card.maxHeight };
    }
    if (rightSpace >= width) {
      return { top, left: popover.right + gap, width, maxHeight: card.maxHeight };
    }
    const aboveSpace = Math.max(0, popover.top - margin - gap);
    const belowSpace = Math.max(0, viewport.height - popover.bottom - margin - gap);
    const above = aboveSpace >= belowSpace;
    const left = Math.max(margin, Math.min(popover.left, viewport.width - width - margin));
    return above
      ? { bottom: viewport.height - popover.top + gap, left, width, maxHeight: Math.min(card.maxHeight, aboveSpace) }
      : { top: popover.bottom + gap, left, width, maxHeight: Math.min(card.maxHeight, belowSpace) };
  }
  if (anchor.left - gap - width >= margin) {
    return { top, right: viewport.width - anchor.left + gap, width, maxHeight: card.maxHeight };
  }
  const right = anchor.right + gap;
  if (right + width <= viewport.width - margin) return { top, left: right, width, maxHeight: card.maxHeight };
  return {
    top,
    left: Math.max(margin, Math.min(right, viewport.width - width - margin)),
    width,
    maxHeight: card.maxHeight,
  };
}

/** A reported cost multiplier, or null when the catalog did not provide one. */
export function reportedCostMultiplier(model: { costMultiplier?: number | null }): number | null {
  const value = model.costMultiplier;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

/** Compact multiplier such as 1× or 1.5×. Returns null instead of inventing a rate. */
export function formatCostMultiplier(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const rounded = Math.round(value * 100) / 100;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, "");
  return `${text}×`;
}

/** Thinking line: declared reasoning levels, or null when the profile did not report any. */
export function modelThinkingText(model: Pick<ComposerModel, "reasoningLevels">): string | null {
  const levels = (model.reasoningLevels ?? []).filter(level => typeof level === "string" && level.length > 0);
  if (levels.length === 0) return null;
  return `${tr("支持")} · ${levels.join("/")}`;
}

/**
 * One factual sentence from fields the profile already has.
 * An authored description wins. Otherwise the sentence lists only reported facts.
 */
export function modelDetailSentence(model: ComposerModel): string | null {
  const authored = typeof model.description === "string" ? model.description.trim() : "";
  if (authored) return authored;
  const parts: string[] = [];
  parts.push(tr(model.protocol === "anthropic" ? "Anthropic 协议" : "OpenAI 兼容协议"));
  const context = formatContextWindow(model.contextWindow);
  if (context) parts.push(tf("上下文 {0}", [context]));
  const levels = (model.reasoningLevels ?? []).filter(level => typeof level === "string" && level.length > 0);
  if (levels.length > 0) parts.push(tf("推理档位 {0}", [levels.join("/")]));
  if (model.runtimeProfile === "lightweight") parts.push(tr("本地轻量档"));
  else if (model.runtimeProfile === "standard") parts.push(tr("标准档"));
  return parts.length > 0 ? parts.join(" · ") : null;
}
