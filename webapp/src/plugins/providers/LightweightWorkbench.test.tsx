/**
 * 轻量档极简工作台（providers.lightweight_layout）的前端回归。
 *
 * 全部走 renderToStaticMarkup：断言轻量档隐藏/收起了哪些通用界面、标准档
 * 不受影响，以及 providers 插件关闭时轻量档界面整体不渲染。
 */
import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  LightweightComposerControls,
  lightweightContextUsage,
  lightweightLayoutActive,
} from './LightweightWorkbench';
import { XuenessComposerToolbar } from '../sessions/XuenessComposerToolbar';
import { Composer } from '../sessions/XuenessWorkbenchView';
import { Shell } from '../../XuenessShell';
import { ProviderEditor, providerDraftFromSummary } from './index';
import type { ComposerModel } from '../../xuenessComposer';
import type { RunChoices } from '../../xuenessBridge';
import type { ProviderSummary } from '../../xuenessApi';

const model: ComposerModel = {
  id: 'local-openai',
  name: '本地小模型',
  model: 'qwen3-4b-instruct',
  configured: true,
  protocol: 'openai',
  capabilities: [],
  reasoningLevels: [],
};

const choices: RunChoices = {
  provider: 'real',
  mode: 'build',
  permission_mode: 'build',
  provider_id: 'local-openai',
  runtime_profile: 'lightweight',
};

const baseProps = {
  enabled: true,
  choices,
  onChange: () => undefined,
  models: [model],
  loading: false,
  error: '',
  onReload: () => undefined,
  onManageModels: () => undefined,
};

const provider = (overrides: Partial<ProviderSummary> = {}): ProviderSummary => ({
  id: 'local-openai',
  name: 'Local OpenAI',
  baseUrl: 'https://api.example.test/v1',
  model: 'gpt-test',
  hasKey: true,
  protocol: 'openai',
  capabilities: [],
  reasoningLevels: [],
  ...overrides,
});

// -- 轻量档极简工具条 ---------------------------------------------------------

test('轻量档输入控制区只保留模型名与上下文用量，隐藏模式、浏览器、后台任务与思考强度', () => {
  const html = renderToStaticMarkup(<LightweightComposerControls
    {...baseProps}
    runtimeBudget={{ profile: 'lightweight', estimatedInputTokens: 2048, inputBudgetTokens: 6144 }}
  />);
  assert.match(html, /data-minimal="true"/);
  assert.match(html, /aria-label="选择模型"[^>]*aria-haspopup="menu"/);
  assert.match(html, /本地小模型/);
  assert.match(html, /aria-label="上下文用量"/);
  assert.match(html, /33%/);
  assert.match(html, /xn-composer-toolbar__usage--static/);
  assert.doesNotMatch(html, /aria-label="模式"/);
  assert.doesNotMatch(html, /变更前确认|自动编辑|完全访问/);
  assert.doesNotMatch(html, /启用浏览器|浏览器已启用/);
  assert.doesNotMatch(html, /后台任务/);
  assert.doesNotMatch(html, /aria-label="思考强度"/);
  assert.doesNotMatch(html, /xn-composer-toolbar__plan-marker/);
});

test('轻量档没有运行预算时不编造上下文用量', () => {
  const html = renderToStaticMarkup(<LightweightComposerControls {...baseProps} />);
  assert.doesNotMatch(html, /aria-label="上下文用量"/);
  assert.match(html, /aria-label="选择模型"/);
  assert.equal(lightweightContextUsage(null), undefined);
  assert.equal(lightweightContextUsage({ estimatedInputTokens: 0, inputBudgetTokens: 6144 }), undefined);
  assert.deepEqual(lightweightContextUsage({ profile: 'lightweight', estimatedInputTokens: 512, inputBudgetTokens: 7168 }), { used: 512, max: 7168 });
});

test('providers 插件关闭时轻量档界面不渲染，布局判定为关闭', () => {
  const html = renderToStaticMarkup(<LightweightComposerControls {...baseProps} enabled={false} />);
  assert.equal(html, '');
  assert.equal(lightweightLayoutActive('lightweight', false), false);
  assert.equal(lightweightLayoutActive('standard', true), false);
  assert.equal(lightweightLayoutActive(undefined, true), false);
  assert.equal(lightweightLayoutActive('lightweight', true), true);
});

// -- 标准档不受影响 -----------------------------------------------------------

test('标准档工具条保持完整控制区，不受轻量极简展示影响', () => {
  const html = renderToStaticMarkup(<XuenessComposerToolbar
    choices={choices}
    onChange={() => undefined}
    models={[model]}
    loading={false}
    error=""
    onReload={() => undefined}
    onManageModels={() => undefined}
    onToggleBrowser={() => undefined}
    onBackground={() => undefined}
    backgroundCount={2}
    contextUsage={{ used: 20, max: 100 }}
    onOpenUsage={() => undefined}
  />);
  assert.doesNotMatch(html, /data-minimal="true"/);
  assert.match(html, /aria-label="模式"/);
  assert.match(html, /启用浏览器/);
  assert.match(html, /后台任务/);
  // 用量仍然是有 onOpenUsage 的按钮读数。
  const usage = html.match(/<button[^>]*aria-label="上下文用量"[^>]*>/)?.[0] ?? '';
  assert.notEqual(usage, '');
  assert.doesNotMatch(html, /xn-composer-toolbar__usage--static/);
});

test('标准档 Composer 保留上下文加号与键盘提示；轻量档 Composer 只留发送/停止与控制区', () => {
  const standard = renderToStaticMarkup(<Composer onSend={() => undefined} defaultValue="hi" />);
  assert.match(standard, /data-testid="composer-plus"/);
  assert.match(standard, /Enter 发送 · Shift\+Enter 换行/);
  assert.doesNotMatch(standard, /xn-composer-toolbar/);

  const minimal = renderToStaticMarkup(<Composer
    onSend={() => undefined}
    defaultValue="hi"
    minimal
    controls={<LightweightComposerControls {...baseProps} />}
  />);
  assert.doesNotMatch(minimal, /data-testid="composer-plus"/);
  assert.doesNotMatch(minimal, /Enter 发送 · Shift\+Enter 换行/);
  assert.match(minimal, /aria-label="选择模型"/);
  assert.match(minimal, /xn-composer-toolbar/);
  // 发送按钮仍然存在。
  assert.match(minimal, /aria-label="发送"/);
});

test('Shell 接受初始收起请求：侧栏默认收起但仍可展开，未请求时保持展开', () => {
  // 宽屏环境（matchMedia 不匹配窄屏），否则 node 下默认走窄屏抽屉分支。
  (globalThis as Record<string, unknown>).window ??= {
    matchMedia: () => ({ matches: false }),
  };
  const collapsed = renderToStaticMarkup(<Shell sidebar={<div>任务列表</div>} initialSidebarCollapsed>
    <div>主区</div>
  </Shell>);
  assert.match(collapsed, /xn-shell-layout--sidebar-collapsed/);
  // 收起不是移除：任务列表仍在文档中，切换按钮仍可展开。
  assert.match(collapsed, /任务列表/);
  assert.match(collapsed, /data-testid="xn-shell-sidebar-toggle"/);

  const expanded = renderToStaticMarkup(<Shell sidebar={<div>任务列表</div>}>
    <div>主区</div>
  </Shell>);
  assert.doesNotMatch(expanded, /xn-shell-layout--sidebar-collapsed/);
});

// -- 轻量设置页分组 -----------------------------------------------------------

function editorHtml(overrides: Partial<ProviderSummary>): string {
  const summary = provider(overrides);
  return renderToStaticMarkup(<ProviderEditor
    draft={providerDraftFromSummary(summary)}
    original={summary}
    hasKey
    busy={false}
    testing={false}
    testResult={null}
    testError=""
    deleting={false}
    onDraftChange={() => undefined}
    onSave={() => undefined}
    onUse={() => undefined}
    onTest={() => undefined}
    onDelete={() => undefined}
    onCancelDelete={() => undefined}
    onCancelEdit={() => undefined}
  />);
}

test('轻量设置页按「常用 → 高级」分组，高级项默认折叠且内容保留', () => {
  const html = editorHtml({
    runtimeProfile: 'lightweight',
    contextWindow: 8192,
    maxOutputTokens: 1024,
  });
  assert.match(html, /class="xn-provider-common__label">常用<\/p>/);
  assert.match(html, /data-testid="provider-runtime-settings"/);
  const advanced = html.match(/<details[^>]*data-testid="provider-advanced-settings"[^>]*>/)?.[0] ?? '';
  assert.notEqual(advanced, '');
  assert.doesNotMatch(advanced, / open=/);
  // 折叠只是展示：高级区内容仍在文档中，字段与取值不变。
  assert.match(html, /API 兼容设置/);
  assert.match(html, /data-testid="provider-compatibility-diagnostics"/);
  assert.match(html, /data-testid="provider-lightweight-advanced"/);
  assert.match(html, /temperature/);
  assert.match(html, /恢复轻量配置默认值/);
  // 常用区字段不受影响。
  assert.match(html, /上下文窗口（tokens）/);
  assert.match(html, /最大输出（tokens）/);
});

test('标准档设置页不出现常用/高级分组，原有展示保持不变', () => {
  const html = editorHtml({});
  assert.doesNotMatch(html, /xn-provider-common__label/);
  assert.doesNotMatch(html, /data-testid="provider-advanced-settings"/);
  assert.match(html, /data-testid="provider-compatibility-diagnostics"/);
});
