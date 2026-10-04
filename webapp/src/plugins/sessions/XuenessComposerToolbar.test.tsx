import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { XuenessComposerToolbar, handlePopoverEscape } from "./XuenessComposerToolbar";
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
