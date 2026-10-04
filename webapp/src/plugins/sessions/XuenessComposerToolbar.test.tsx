import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
  XuenessComposerToolbar,
  handlePopoverEscape,
  ComposerModelMenu,
  ComposerModelDetailCard,
  formatContextWindow,
  modelReasoningSummary,
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

test("Toolbar: model rows show reported context window and reasoning tiers, and nothing when absent", () => {
  const reported = renderToStaticMarkup(
    <ComposerModelMenu {...menuProps} models={[{ ...model, contextWindow: 200000 }]} />,
  );
  assert.match(reported, /xn-composer-toolbar__model-meta/);
  assert.match(reported, /<small title="上下文窗口">200K<\/small>/);
  assert.match(reported, /<small title="推理档位">low\/medium\/high<\/small>/);

  const absent = renderToStaticMarkup(
    <ComposerModelMenu {...menuProps} models={[{ ...model, reasoningLevels: [] }]} />,
  );
  assert.doesNotMatch(absent, /xn-composer-toolbar__model-meta/);
  assert.doesNotMatch(absent, /200K/);
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

test("ComposerModelDetailCard: identity, protocol, context, output, reasoning levels and the edit entry", () => {
  const html = renderToStaticMarkup(
    <ComposerModelDetailCard
      model={{ ...model, protocol: "anthropic", contextWindow: 200000, maxOutputTokens: 8192 }}
      anchor={{ top: 100, left: 400, right: 640 }}
      onEdit={() => {}}
    />,
  );
  assert.match(html, /data-testid="composer-model-detail"/);
  assert.match(html, /Default model/);
  assert.match(html, /模型 ID/);
  assert.match(html, /model-default/);
  assert.match(html, /协议/);
  assert.match(html, /Anthropic/);
  assert.match(html, /上下文窗口/);
  assert.match(html, /200K/);
  assert.match(html, /最大输出/);
  assert.match(html, /8\.2K/);
  assert.match(html, /推理档位/);
  assert.match(html, /low\/medium\/high/);
  assert.match(html, /编辑/);
  // 详情卡固定定位在锚点行左侧（SSR 视口 1280）：right = 1280 - 400 + 10。
  assert.match(html, /top:100px;right:890px;width:248px/);
  // 没有模型就不渲染卡片，也不编造内容。
  assert.equal(
    renderToStaticMarkup(<ComposerModelDetailCard model={undefined} anchor={{ top: 0, left: 0, right: 0 }} onEdit={() => {}} />),
    "",
  );
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
