import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import {
  Button,
  Panel,
  Tabs,
  Badge,
  Field,
  EmptyState,
  CodeBlock,
  Spinner,
  AppShell,
  Stat,
} from "./primitives";

test("Button: renders variants, sizes, and handles disabled attribute", () => {
  // Primary default size md
  const outPrimary = renderToStaticMarkup(
    <Button variant="primary">提交</Button>,
  );
  assert.match(outPrimary, /data-testid="primitive-button"/);
  assert.match(outPrimary, /xn-btn--primary/);
  assert.match(outPrimary, /xn-btn--md/);
  assert.match(outPrimary, /提交/);
  assert.doesNotMatch(outPrimary, /disabled=""/);

  // Danger sm disabled
  const outDisabled = renderToStaticMarkup(
    <Button variant="danger" size="sm" disabled={true} title="删除操作">
      删除
    </Button>,
  );
  assert.match(outDisabled, /xn-btn--danger/);
  assert.match(outDisabled, /xn-btn--sm/);
  assert.match(outDisabled, /disabled=""/);
  assert.match(outDisabled, /title="删除操作"/);
});

test("Panel: renders title, subtitle, actions, and respect padding normal/flush", () => {
  const outNormal = renderToStaticMarkup(
    <Panel
      title="面板标题"
      subtitle="副标题说明"
      actions={<button type="button">操作</button>}
      padding="normal"
    >
      <div>面板内容</div>
    </Panel>,
  );
  assert.match(outNormal, /data-testid="primitive-panel"/);
  assert.match(outNormal, /data-padding="normal"/);
  assert.match(outNormal, /面板标题/);
  assert.match(outNormal, /副标题说明/);
  assert.match(outNormal, /面板内容/);
  assert.match(outNormal, /<button[^>]*>操作<\/button>/);

  const outFlush = renderToStaticMarkup(
    <Panel padding="flush">
      <div>列表内容</div>
    </Panel>,
  );
  assert.match(outFlush, /data-padding="flush"/);
  assert.doesNotMatch(outFlush, /data-testid="primitive-panel-head"/);
});

test("Tabs: renders tab list and sets active state", () => {
  const tabs = [
    { id: "tab-1", label: "概览" },
    { id: "tab-2", label: "详情" },
  ];
  const out = renderToStaticMarkup(<Tabs tabs={tabs} active="tab-1" />);
  assert.match(out, /data-testid="primitive-tabs"/);
  assert.match(out, /role="tablist"/);
  assert.match(out, /data-testid="tab-tab-1"[^>]*aria-selected="true"/);
  assert.match(out, /data-testid="tab-tab-1"[^>]*data-active="true"/);
  assert.match(out, /data-testid="tab-tab-2"[^>]*aria-selected="false"/);
  assert.doesNotMatch(out, /data-testid="tab-tab-2"[^>]*data-active="true"/);
});

test("Badge: renders tone variants", () => {
  const tones = ["neutral", "ok", "warn", "error", "info"] as const;
  for (const tone of tones) {
    const out = renderToStaticMarkup(<Badge tone={tone}>{tone}</Badge>);
    assert.match(out, new RegExp(`data-tone="${tone}"`));
    assert.match(out, new RegExp(`xn-badge`));
  }
});

test("Field: renders label, hint, and children", () => {
  const out = renderToStaticMarkup(
    <Field label="用户名" hint="请输入4-16位字符">
      <input type="text" />
    </Field>,
  );
  assert.match(out, /data-testid="primitive-field"/);
  assert.match(out, /用户名/);
  assert.match(out, /请输入4-16位字符/);
  assert.match(out, /<input type="text"\/>/);
});

test("EmptyState: renders title and hint correctly", () => {
  const out = renderToStaticMarkup(
    <EmptyState title="暂无数据" hint="请检查过滤条件" />,
  );
  assert.match(out, /data-testid="empty-state"/);
  assert.match(out, /暂无数据/);
  assert.match(out, /请检查过滤条件/);
});

test("CodeBlock: renders pre element with text and tone", () => {
  const out = renderToStaticMarkup(
    <CodeBlock text="const a = 1;" tone="add" />,
  );
  assert.match(out, /data-testid="primitive-code"/);
  assert.match(out, /data-tone="add"/);
  assert.match(out, /const a = 1;/);
});

test("Spinner: renders spinner dot and optional label", () => {
  const outNoLabel = renderToStaticMarkup(<Spinner />);
  assert.match(outNoLabel, /data-testid="primitive-spinner"/);
  assert.match(outNoLabel, /role="status"/);

  const outWithLabel = renderToStaticMarkup(<Spinner label="加载中..." />);
  assert.match(outWithLabel, /加载中\.\.\./);
});

test("AppShell: renders header, sidebar, and main layout structure", () => {
  const out = renderToStaticMarkup(
    <AppShell
      header={<div>头部内容</div>}
      sidebar={<div>侧栏内容</div>}
    >
      <div>主要区域</div>
    </AppShell>,
  );
  assert.match(out, /data-testid="primitive-shell"/);
  assert.match(out, /头部内容/);
  assert.match(out, /侧栏内容/);
  assert.match(out, /主要区域/);
});

test("Stat: renders label and value", () => {
  const out = renderToStaticMarkup(<Stat label="步数" value={<strong>42</strong>} />);
  assert.match(out, /data-testid="primitive-stat"/);
  assert.match(out, /步数/);
  assert.match(out, /<strong>42<\/strong>/);
});
