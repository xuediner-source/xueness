import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { XuenessComposerToolbar } from "./XuenessComposerToolbar";
import type { ComposerModel } from "./xuenessComposer";
import type { RunChoices } from "./xuenessBridge";

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
