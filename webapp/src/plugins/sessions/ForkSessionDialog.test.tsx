import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ForkBoundaryChoices, ForkSessionDialog } from "./ForkSessionDialog";
import type { ForkBoundary } from "../../xuenessWorkbench";

const boundaries: ForkBoundary[] = [
  { token: "opaque-selector-a", turn: 1, endIndex: 4, preview: "Initial request" },
  { token: "opaque-selector-b", turn: 4, endIndex: 18, preview: "Follow-up question" },
];

test("fork boundary choices display server turn numbers and previews without exposing selector or message index", () => {
  const html = renderToStaticMarkup(<ForkBoundaryChoices boundaries={boundaries} selectedToken="opaque-selector-b" onSelect={() => undefined} />);
  assert.match(html, /第 1 轮结束/);
  assert.match(html, /第 4 轮结束/);
  assert.match(html, /Initial request/);
  assert.match(html, /Follow-up question/);
  assert.match(html, /aria-checked="true"/);
  assert.doesNotMatch(html, /opaque-selector-[ab]|endIndex|>4<|>18</);
});

test("fork dialog asks the user to select a safe boundary and supports an optional title", () => {
  const html = renderToStaticMarkup(<ForkSessionDialog open sourceId="session-1" sourceTitle="Research" onCancel={() => undefined} onFork={() => undefined} />);
  assert.match(html, /role="dialog"/);
  assert.match(html, /分叉会话/);
  assert.match(html, /新会话标题（可选）/);
  assert.match(html, /待审批操作与旧会话的审批状态不会复制/);
  assert.match(html, /不会自动调用模型或工具/);
});
