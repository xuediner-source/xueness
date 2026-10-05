import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale, t } from "../../i18n";
import {
  XuenessComposerToolbar,
  handlePopoverEscape,
  ComposerModelMenu,
  ComposerModelDetailCard,
  formatContextWindow,
  formatCostMultiplier,
  modelReasoningSummary,
  modelThinkingText,
  modelDetailSentence,
  modelMatchesPreset,
  nextCatalogTab,
  modelDetailCardStyle,
  nextIndex,
} from "./XuenessComposerToolbar";
import type { ComposerModel } from "../../xuenessComposer";
import type { RunChoices } from "../../xuenessBridge";

const model: ComposerModel = {
  id: "provider-a",
  name: "Default model",
  model: "model-default",
  configured: true,
  protocol: "openai",
  capabilities: [],
  reasoningLevels: ["low", "medium", "high"],
};
const choices: RunChoices = {
  provider: "real",
  provider_id: "provider-a",
  mode: "plan",
  permission_mode: "edit",
};
const baseProps = {
  choices,
  onChange: () => {},
  models: [model],
  loading: false,
  error: "",
  onReload: () => {},
  onManageModels: () => {},
};

test("Toolbar: the trigger reports the selected permission and the mode can open as a menu", () => {
  const html = renderToStaticMarkup(<XuenessComposerToolbar {...baseProps} />);
  assert.match(html, /data-testid="composer-toolbar"/);
  assert.match(html, /aria-label="模式"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/);
  assert.match(html, /<strong>Default model<\/strong>|Default model/);
  assert.match(html, /<span>自动编辑<\/span>/);
  assert.match(html, /data-testid="composer-plan-marker"/);
});

test("Toolbar: plan is a selectable permission mode shown by the trigger", () => {
  const html = renderToStaticMarkup(
    <XuenessComposerToolbar {...baseProps} choices={{ ...choices, permission_mode: "plan" }} />,
  );
  assert.match(html, /<span>计划<\/span>/);
  assert.doesNotMatch(html, /<span>自动编辑<\/span>/);
});

test("Toolbar: model picker is a keyboard-openable menu and unsupported context usage stays hidden", () => {
  const noUsage = renderToStaticMarkup(<XuenessComposerToolbar {...baseProps} />);
  assert.match(noUsage, /aria-label="选择模型"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/);
  assert.match(noUsage, /Default model/);
  assert.doesNotMatch(noUsage, /aria-label="上下文用量"/);
  const reportedUsage = renderToStaticMarkup(
    <XuenessComposerToolbar
      {...baseProps}
      contextUsage={{ used: 20, max: 100 }}
      onOpenUsage={() => {}}
    />,
  );
  assert.match(reportedUsage, /aria-label="上下文用量"/);
  assert.match(reportedUsage, /20 \/ 100/);
});

test("Toolbar: reasoning selector clears to default instead of inventing a model default", () => {
  const html = renderToStaticMarkup(
    <XuenessComposerToolbar
      {...baseProps}
      choices={{ ...choices, model: "model-default", reasoning_effort: undefined }}
    />,
  );
  assert.match(html, /aria-label="思考强度"/);
  assert.match(html, /xn-composer-toolbar__reasoning-select/);
  assert.doesNotMatch(html, /<select[^>]*aria-label="思考强度"/);
});

test("Toolbar: on popover close via Escape, restores focus to trigger button and does not restore composer input", () => {
  const events: string[] = [];
  const trigger = { focus: () => events.push("trigger-focus") };
  let restoreInputArg: boolean | null = null;
  const closeMenu = (restoreInput: boolean) => {
    restoreInputArg = restoreInput;
    events.push("close-menu");
  };
  const escapeEvent = {
    key: "Escape",
    preventDefault: () => events.push("prevent-default"),
    stopPropagation: () => events.push("stop-propagation"),
  };
  const handled = handlePopoverEscape(escapeEvent, closeMenu, trigger);
  assert.equal(handled, true);
  assert.equal(restoreInputArg, false);
  assert.deepEqual(events, ["prevent-default", "stop-propagation", "close-menu", "trigger-focus"]);

  const nonEscapeEvent = {
    key: "Enter",
    preventDefault: () => events.push("prevent-default-non"),
    stopPropagation: () => events.push("stop-propagation-non"),
  };
  assert.equal(handlePopoverEscape(nonEscapeEvent, closeMenu, trigger), false);
});

// -- Qoder 式模型弹层：档位行、行内元数据与详情卡 -----------------------------

const menuProps = {
  loading: false,
  error: "",
  models: [model],
  disabled: false,
  isSelected: (candidate: ComposerModel) => candidate.id === model.id,
  activeRuntimeProfile: "standard" as const,
  canSelectStandard: true,
  selectedModel: model,
  onChooseModel: () => {},
  onChooseProfile: () => {},
  onReload: () => {},
  onManageModels: () => {},
  onRequestClose: () => {},
};

test("Toolbar: profile tiers lead the popover and model rows keep menu keyboard semantics", () => {
  const html = renderToStaticMarkup(
    <ComposerModelMenu {...menuProps} models={[{ ...model, contextWindow: 200000 }]} />,
  );
  assert.match(html, /role="menu"/);
  assert.match(html, /data-testid="composer-runtime-profile"/);
  assert.match(html, /<span>标准<\/span>/);
  assert.match(html, /<span>本地轻量<\/span>/);
  // 档位行出现在模型列表之前。
  const profileAt = html.indexOf('data-testid="composer-runtime-profile"');
  const optionsAt = html.indexOf("xn-composer-toolbar__model-options");
  assert.ok(profileAt >= 0 && optionsAt >= 0 && profileAt < optionsAt);
  // 模型行仍是可键盘上下选择的 menuitemradio。
  assert.match(html, /role="menuitemradio"[^>]*data-model-row="provider-a:model-default"/);
  // 既有入口保留：管理模型与读取失败时的重试。
  assert.match(html, /管理模型/);
  assert.match(renderToStaticMarkup(<ComposerModelMenu {...menuProps} error="HTTP 502" />), /重试/);
});

test("Toolbar: model rows show a reported cost multiplier and hide it when the catalog has none", () => {
  const reported = renderToStaticMarkup(
    <ComposerModelMenu {...menuProps} models={[{ ...model, costMultiplier: 1.5 }]} />,
  );
  assert.match(reported, /data-testid="model-row-cost"/);
  assert.match(reported, /1\.5×/);
  // 上下文和推理档位留在详情卡，不编进行内倍率。
  assert.doesNotMatch(reported, /xn-composer-toolbar__model-meta/);

  const absent = renderToStaticMarkup(
    <ComposerModelMenu {...menuProps} models={[{ ...model, reasoningLevels: [], contextWindow: 200000 }]} />,
  );
  assert.doesNotMatch(absent, /data-testid="model-row-cost"/);
  assert.doesNotMatch(absent, /×/);
  // 分档预设没有独立倍率字段，即使模型声明了上下文也不编造预设倍率。
  assert.doesNotMatch(absent, /data-preset="auto"[^>]*>[\s\S]*×/);
});

test("Toolbar: the model menu offers 「设为默认」only when the host wires it", () => {
  const buttonMarkup = (html: string) =>
    html.match(/data-testid="composer-save-default"[\s\S]*?<\/button>/)?.[0] ?? "";
  const wired = renderToStaticMarkup(<ComposerModelMenu {...menuProps} onSaveDefault={() => {}} />);
  assert.match(wired, /data-testid="composer-save-default"/);
  assert.match(buttonMarkup(wired), /设为默认/);
  assert.doesNotMatch(buttonMarkup(wired), /xn-composer-toolbar__menu-indicator/);
  assert.match(wired, /管理模型/);
  // 已保存过就改口并给出确认标记。
  const saved = renderToStaticMarkup(
    <ComposerModelMenu {...menuProps} onSaveDefault={() => {}} defaultSaved />,
  );
  assert.match(buttonMarkup(saved), /已设为默认/);
  assert.match(buttonMarkup(saved), /xn-composer-toolbar__menu-indicator/);
  // providers 未生效时宿主不接线，整个入口不渲染。
  assert.doesNotMatch(renderToStaticMarkup(<ComposerModelMenu {...menuProps} />), /composer-save-default/);
  // 没有选中模型时也没有可保存的默认值。
  assert.doesNotMatch(
    renderToStaticMarkup(<ComposerModelMenu {...menuProps} onSaveDefault={() => {}} selectedModel={undefined} />),
    /composer-save-default/,
  );
});

test("formatContextWindow and modelReasoningSummary: compact facts or null when unreported", () => {
  assert.equal(formatContextWindow(undefined), null);
  assert.equal(formatContextWindow(0), null);
  assert.equal(formatContextWindow(-5), null);
  assert.equal(formatContextWindow(200000), "200K");
  assert.equal(formatContextWindow(128000), "128K");
  assert.equal(formatContextWindow(1048576), "1M");
  assert.equal(formatContextWindow(512), "512");
  assert.equal(modelReasoningSummary({ reasoningLevels: [] }), null);
  assert.equal(modelReasoningSummary({ reasoningLevels: ["medium"] }), "medium");
  assert.equal(modelReasoningSummary({ reasoningLevels: ["low", "medium", "high"] }), "low/medium/high");
  assert.equal(modelReasoningSummary({ reasoningLevels: ["a", "b", "c", "d"] }), "a/b/c+");
});

test("ComposerModelDetailCard: context, thinking, cost, a factual sentence and Edit", () => {
  const html = renderToStaticMarkup(
    <ComposerModelDetailCard
      model={{ ...model, protocol: "anthropic", contextWindow: 200000, maxOutputTokens: 8192, costMultiplier: 2 }}
      anchor={{ top: 100, left: 400, right: 640 }}
      onEdit={() => {}}
    />,
  );
  assert.match(html, /data-testid="composer-model-detail"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /role="group"/);
  assert.match(html, /aria-label="模型详情：Default model"/);
  assert.match(html, /Default model/);
  assert.match(html, /<dt>上下文<\/dt><dd>200K<\/dd>/);
  assert.match(html, /<dt>推理<\/dt><dd>支持 · low\/medium\/high<\/dd>/);
  assert.match(html, /<dt>成本<\/dt><dd>2×<\/dd>/);
  assert.match(html, /Anthropic 协议 · 上下文 200K · 推理档位 low\/medium\/high/);
  assert.match(html, /data-testid="composer-model-detail-edit"/);
  assert.match(html, /编辑/);
  // 详情卡固定定位在锚点行左侧（SSR 视口 1280）：right = 1280 - 400 + 10。
  assert.match(html, /top:100px;right:890px;width:248px/);
  const missing = renderToStaticMarkup(
    <ComposerModelDetailCard
      model={{ ...model, reasoningLevels: [], description: "" }}
      anchor={{ top: 100, left: 400, right: 640 }}
      onEdit={() => {}}
    />,
  );
  assert.match(missing, /<dt>上下文<\/dt><dd>—<\/dd>/);
  assert.match(missing, /<dt>推理<\/dt><dd>—<\/dd>/);
  assert.match(missing, /<dt>成本<\/dt><dd>—<\/dd>/);
  assert.doesNotMatch(missing, /×/);
  // 没有模型就不渲染卡片，也不编造内容。
  assert.equal(
    renderToStaticMarkup(<ComposerModelDetailCard model={undefined} anchor={{ top: 0, left: 0, right: 0 }} onEdit={() => {}} />),
    "",
  );
});

function clickByTestId(node: React.ReactNode, testId: string): Array<() => void> {
  const found: Array<() => void> = [];
  const visit = (child: React.ReactNode): void => {
    if (child == null || typeof child === "boolean" || typeof child === "string" || typeof child === "number") return;
    if (Array.isArray(child)) {
      child.forEach(visit);
      return;
    }
    if (typeof child !== "object" || !("props" in child)) return;
    const element = child as React.ReactElement<{ "data-testid"?: string; onClick?: () => void; children?: React.ReactNode }>;
    if (element.props?.["data-testid"] === testId && typeof element.props.onClick === "function") found.push(element.props.onClick);
    visit(element.props?.children);
  };
  visit(node);
  return found;
}

test("ComposerModelDetailCard: Edit calls the settings callback", () => {
  let edits = 0;
  const tree = ComposerModelDetailCard({
    model,
    anchor: { top: 10, left: 400, right: 640 },
    onEdit: () => { edits += 1; },
  });
  const clicks = clickByTestId(tree, "composer-model-detail-edit");
  assert.equal(clicks.length, 1);
  clicks[0]();
  assert.equal(edits, 1);
});

test("Toolbar: New and Custom tabs keep environment models and saved profiles apart", () => {
  const env = { ...model, id: "", name: "Environment", model: "env-model" };
  const custom = { ...model, id: "provider-a", name: "Default model", model: "model-default" };
  const models = [env, custom];
  const customHtml = renderToStaticMarkup(
    <ComposerModelMenu {...menuProps} models={models} catalogTab="custom" />,
  );
  assert.match(customHtml, /role="tablist"/);
  const newTab = customHtml.match(/<button[^>]*data-testid="composer-model-tab-new"[^>]*>/)?.[0] ?? "";
  const customTab = customHtml.match(/<button[^>]*data-testid="composer-model-tab-custom"[^>]*>/)?.[0] ?? "";
  assert.match(newTab, /aria-selected="false"/);
  assert.match(customTab, /aria-selected="true"/);
  assert.match(customHtml, /aria-controls="composer-model-tabpanel"/);
  assert.match(customHtml, /data-model-row="provider-a:model-default"/);
  assert.doesNotMatch(customHtml, /data-model-row=":env-model"/);

  const newHtml = renderToStaticMarkup(
    <ComposerModelMenu {...menuProps} models={models} catalogTab="new" selectedModel={env} isSelected={() => false} />,
  );
  const newTabOn = newHtml.match(/<button[^>]*data-testid="composer-model-tab-new"[^>]*>/)?.[0] ?? "";
  const customTabOff = newHtml.match(/<button[^>]*data-testid="composer-model-tab-custom"[^>]*>/)?.[0] ?? "";
  assert.match(newTabOn, /aria-selected="true"/);
  assert.match(customTabOff, /aria-selected="false"/);
  assert.match(newHtml, /data-model-row=":env-model"/);
  assert.doesNotMatch(newHtml, /data-model-row="provider-a:model-default"/);
  assert.equal(nextCatalogTab("new", "ArrowRight"), "custom");
  assert.equal(nextCatalogTab("custom", "ArrowLeft"), "new");
  assert.equal(nextCatalogTab("new", "ArrowLeft"), "custom");
});

test("Toolbar: presets filter on reported fields and the detail card follows detailKey", () => {
  const big = {
    ...model,
    id: "big",
    name: "Big context",
    model: "big-model",
    contextWindow: 200000,
    reasoningLevels: [] as string[],
    runtimeProfile: "standard" as const,
  };
  const small = {
    ...model,
    id: "small",
    name: "Small reasoner",
    model: "small-model",
    contextWindow: 8192,
    reasoningLevels: ["low"],
    runtimeProfile: "lightweight" as const,
  };
  const peers = [big, small];
  assert.equal(modelMatchesPreset(big, "ultimate", peers), true);
  assert.equal(modelMatchesPreset(small, "ultimate", peers), false);
  assert.equal(modelMatchesPreset(small, "performance", peers), true);
  assert.equal(modelMatchesPreset(big, "performance", peers), false);
  assert.equal(modelMatchesPreset(small, "efficient", peers), true);
  assert.equal(modelMatchesPreset(big, "efficient", peers), false);
  assert.equal(modelMatchesPreset(big, "auto", peers), true);

  const ultimate = renderToStaticMarkup(
    <ComposerModelMenu {...menuProps} models={peers} catalogTab="custom" preset="ultimate" />,
  );
  const ultimateButton = ultimate.match(/<button[^>]*data-preset="ultimate"[^>]*>/)?.[0] ?? "";
  assert.match(ultimateButton, /aria-checked="true"/);
  assert.match(ultimate, /Big context/);
  assert.doesNotMatch(ultimate, /Small reasoner/);
  assert.doesNotMatch(ultimate, /×/);

  const efficient = renderToStaticMarkup(
    <ComposerModelMenu {...menuProps} models={peers} catalogTab="custom" preset="efficient" />,
  );
  assert.match(efficient, /Small reasoner/);
  assert.doesNotMatch(efficient, /Big context/);

  const card = renderToStaticMarkup(
    <ComposerModelMenu
      {...menuProps}
      models={[{ ...big, description: "已有说明" }]}
      catalogTab="custom"
      detailKey="big:big-model"
    />,
  );
  assert.match(card, /data-testid="composer-model-detail"/);
  assert.match(card, /aria-describedby="composer-model-detail"/);
  assert.match(card, /已有说明/);
  assert.match(card, /<dt>上下文<\/dt><dd>200K<\/dd>/);
  assert.match(card, /<dt>推理<\/dt><dd>—<\/dd>/);
  assert.match(card, /编辑/);
});

test("model picker strings exist in English", () => {
  try {
    setLocale("en");
    assert.equal(t("自动"), "Auto");
    assert.equal(t("旗舰"), "Ultimate");
    assert.equal(t("性能"), "Performance");
    assert.equal(t("高效"), "Efficient");
    assert.equal(t("新模型"), "New");
    assert.equal(t("自定义"), "Custom");
    assert.equal(t("上下文"), "Context");
    assert.equal(t("推理"), "Thinking");
    assert.equal(t("成本"), "Cost");
    assert.equal(t("支持"), "Supported");
    assert.equal(t("成本倍率"), "Cost multiplier");
    assert.equal(t("查看模型文档"), "View Docs");
    assert.equal(t("+ 添加"), "+ Add");
    assert.equal(t("添加"), "Add");
    assert.equal(formatCostMultiplier(undefined), null);
    assert.equal(formatCostMultiplier(0), null);
    assert.equal(formatCostMultiplier(1), "1×");
    assert.equal(formatCostMultiplier(1.5), "1.5×");
    assert.equal(modelThinkingText({ reasoningLevels: [] }), null);
    assert.equal(modelThinkingText({ reasoningLevels: ["high"] }), "Supported · high");
    assert.match(modelDetailSentence({ ...model, protocol: "openai", reasoningLevels: [], runtimeProfile: "standard" }) ?? "", /OpenAI-compatible protocol/);
  } finally {
    setLocale("zh");
  }
});

test("modelDetailCardStyle: flips to the row's right when the left side has no room and clamps into the viewport", () => {
  const card = { width: 248, maxHeight: 340 };
  // 左侧放得下：卡片贴在行左侧，top 不变。
  const left = modelDetailCardStyle({ top: 100, left: 400, right: 648 }, { width: 1280, height: 800 }, card);
  assert.deepEqual(left, { top: 100, right: 890, width: 248, maxHeight: 340 });
  // 左侧放不下：翻到行右侧并夹在视口内。
  const flipped = modelDetailCardStyle({ top: 100, left: 200, right: 448 }, { width: 800, height: 600 }, card);
  assert.deepEqual(flipped, { top: 100, left: 458, width: 248, maxHeight: 340 });
  // 行太靠下：top 被夹住，卡片不会离开视口。
  const clamped = modelDetailCardStyle({ top: 500, left: 400, right: 648 }, { width: 1280, height: 600 }, card);
  assert.equal(clamped.top, 252);
});

test("Toolbar menu keyboard movement wraps and honours Home/End", () => {
  assert.equal(nextIndex(-1, 3, "ArrowDown"), 0);
  assert.equal(nextIndex(-1, 3, "ArrowUp"), 2);
  assert.equal(nextIndex(2, 3, "ArrowDown"), 0);
  assert.equal(nextIndex(0, 3, "ArrowUp"), 2);
  assert.equal(nextIndex(1, 3, "Home"), 0);
  assert.equal(nextIndex(1, 3, "End"), 2);
});
