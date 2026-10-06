/**
 * 轻量档极简工作台（providers.lightweight_layout）的前端回归。
 *
 * 全部走 renderToStaticMarkup：断言轻量档隐藏/收起了哪些通用界面、标准档
 * 不受影响，以及 providers 插件关闭时轻量档界面整体不渲染。
 */
import React from 'react';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  LightweightComposer,
  LightweightComposerControls,
  LightweightReasoning,
  LightweightStatusBar,
  LightweightTimeline,
  LightweightToolGroup,
  LightweightToolRow,
  abbreviatePath,
  evaluateLightweightComposerKey,
  evaluateLightweightDisclosureKey,
  evaluateLightweightGlobalKey,
  extractReportedUsage,
  extractToolKeySummary,
  formatTokens,
  formatToolDuration,
  groupLightweightTimelineRows,
  isReadOnlyTool,
  lightweightComposerHint,
  lightweightContextUsage,
  lightweightLayoutActive,
  lightweightStatusPresentation,
  lightweightStatusReadout,
  lightweightToolStatusLabel,
  OVERLAY_SELECTOR,
  toolStatusLabel,
} from './LightweightWorkbench';
import { XuenessComposerToolbar } from '../sessions/XuenessComposerToolbar';
import { setLocale } from '../../i18n';
import { Composer } from '../sessions/XuenessWorkbenchView';
import { Shell } from '../../XuenessShell';
import { ProviderEditor, providerDraftFromSummary } from './index';
import type { ComposerModel } from '../../xuenessComposer';
import type { RunChoices } from '../../xuenessBridge';
import type { ProviderSummary } from '../../xuenessApi';
import type { TimelineRow } from '../../xuenessWorkbench';

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

// -- 紧凑时间线：只读合并、单行折叠与状态 ---------------------------------------

test('isReadOnlyTool: 正确识别只读工具与写/执行工具', () => {
  assert.equal(isReadOnlyTool('read_file'), true);
  assert.equal(isReadOnlyTool('view_file'), true);
  assert.equal(isReadOnlyTool('list_dir'), true);
  assert.equal(isReadOnlyTool('grep_search'), true);
  assert.equal(isReadOnlyTool('find_by_name'), true);
  assert.equal(isReadOnlyTool('search_web'), true);
  assert.equal(isReadOnlyTool('read_url_content'), true);
  assert.equal(isReadOnlyTool('inspect_code'), true);
  assert.equal(isReadOnlyTool('web_search'), true);
  assert.equal(isReadOnlyTool('web_fetch'), true);
  assert.equal(isReadOnlyTool('todo_read'), true);
  assert.equal(isReadOnlyTool('subagent_status'), true);

  assert.equal(isReadOnlyTool('write_to_file'), false);
  assert.equal(isReadOnlyTool('replace_file_content'), false);
  assert.equal(isReadOnlyTool('run_command'), false);
  assert.equal(isReadOnlyTool('bash'), false);
  assert.equal(isReadOnlyTool('custom_mutator'), false);
  assert.equal(isReadOnlyTool('todo_write'), false);
  assert.equal(isReadOnlyTool('subagent_run'), false);
});

test('groupLightweightTimelineRows: 连续 2 个及以上的只读工具自动合并为组，单次只读与写操作保持独立', () => {
  const tool = (seq: number, name: string): TimelineRow => ({
    kind: 'tool',
    seq,
    turnId: 'turn-1',
    toolCallId: `call-${seq}`,
    name,
    subject: `subj-${seq}`,
    status: 'ok',
    error: '',
    errorCode: '',
  });

  const rows: TimelineRow[] = [
    { kind: 'user', seq: 1, turnId: 'turn-1', text: '查找问题' },
    tool(2, 'read_file'),
    tool(3, 'grep_search'),
    tool(4, 'find_by_name'),
    tool(5, 'replace_file_content'),
    tool(6, 'view_file'),
    tool(7, 'run_command'),
    tool(8, 'list_dir'),
    tool(9, 'read_url_content'),
    { kind: 'assistant', seq: 10, turnId: 'turn-1', text: '已修复' },
    { kind: 'completion', seq: 11, verified: true, summary: '完成' },
  ];

  const grouped = groupLightweightTimelineRows(rows);
  assert.equal(grouped.length, 8);
  assert.equal(grouped[0].kind, 'user');
  assert.equal(grouped[1].kind, 'read-only-group');
  if (grouped[1].kind === 'read-only-group') {
    assert.equal(grouped[1].rows.length, 3);
    assert.deepEqual(grouped[1].rows.map(r => r.name), ['read_file', 'grep_search', 'find_by_name']);
  }
  assert.equal(grouped[2].kind, 'tool');
  if (grouped[2].kind === 'tool') {
    assert.equal(grouped[2].row.name, 'replace_file_content');
  }
  // 单个 view_file 不形成组
  assert.equal(grouped[3].kind, 'tool');
  if (grouped[3].kind === 'tool') {
    assert.equal(grouped[3].row.name, 'view_file');
  }
  assert.equal(grouped[4].kind, 'tool');
  if (grouped[4].kind === 'tool') {
    assert.equal(grouped[4].row.name, 'run_command');
  }
  // 连续 2 个只读工具形成组
  assert.equal(grouped[5].kind, 'read-only-group');
  if (grouped[5].kind === 'read-only-group') {
    assert.equal(grouped[5].rows.length, 2);
    assert.deepEqual(grouped[5].rows.map(r => r.name), ['list_dir', 'read_url_content']);
  }
  assert.equal(grouped[6].kind, 'assistant');
  assert.equal(grouped[7].kind, 'completion');
});

test('extractToolKeySummary & formatToolDuration & toolStatusLabel: 提取关键参数、耗时与状态', () => {
  assert.equal(extractToolKeySummary('read_file', '', { file_path: '/src/main.ts' }), '/src/main.ts');
  assert.equal(extractToolKeySummary('grep_search', '', { query: 'export function' }), 'export function');
  assert.equal(extractToolKeySummary('run_command', '', { command: 'cargo test' }), 'cargo test');
  assert.equal(extractToolKeySummary('web_fetch', '', { url: 'https://example.com/api' }), 'https://example.com/api');
  assert.equal(extractToolKeySummary('list', '', { path: '/var/log' }), '/var/log');
  assert.equal(extractToolKeySummary('glob', '', { pattern: '**/*.md' }), '**/*.md');
  assert.equal(extractToolKeySummary('todo_read', '', { title: '审核代码' }), '审核代码');
  assert.equal(extractToolKeySummary('custom_tool', 'subject-preview', {}), 'subject-preview');

  assert.equal(formatToolDuration(undefined), null);
  assert.equal(formatToolDuration(150), '150ms');
  assert.equal(formatToolDuration(2400), '2.4s');
  assert.equal(formatToolDuration(65000), '65.0s');

  assert.equal(toolStatusLabel('ok'), '已完成');
  assert.equal(toolStatusLabel('running'), '运行中');
  assert.equal(toolStatusLabel('error'), '失败');
});

test('LightweightToolRow: 支持折叠 (默认) 与展开 (defaultOpen=true)，详情包含入参出参', () => {
  const row = {
    kind: 'tool' as const,
    seq: 1,
    turnId: 't1',
    toolCallId: 'c1',
    name: 'read_file',
    subject: '/etc/hosts',
    status: 'ok' as const,
    error: '',
    errorCode: '',
    durationMs: 320,
    input: { file_path: '/etc/hosts' },
    output: '127.0.0.1 localhost',
  };

  // 默认折叠：无 open 属性
  const foldedHtml = renderToStaticMarkup(<LightweightToolRow row={row} />);
  assert.match(foldedHtml, /<details class="xn-lightweight-tool"/);
  assert.doesNotMatch(foldedHtml, /<details class="xn-lightweight-tool"[^>]*open/);
  assert.match(foldedHtml, /class="xn-lightweight-tool__name">read_file<\/span>/);
  assert.match(foldedHtml, /class="xn-lightweight-tool__args"[^>]*>\/etc\/hosts<\/span>/);
  assert.match(foldedHtml, /class="xn-lightweight-tool__status"[^>]*>已完成<\/span>/);
  assert.match(foldedHtml, /class="xn-lightweight-tool__duration">320ms<\/span>/);

  // 展开状态：带有 open 属性且渲染入参出参
  const expandedHtml = renderToStaticMarkup(<LightweightToolRow row={row} defaultOpen />);
  assert.match(expandedHtml, /<details class="xn-lightweight-tool"[^>]*open=""/);
  assert.match(expandedHtml, /127\.0\.0\.1 localhost/);
});

test('LightweightToolGroup: 支持折叠 (默认) 与展开 (defaultOpen=true)，显示数量统计与子项', () => {
  const rows = [
    {
      kind: 'tool' as const,
      seq: 1,
      turnId: 't1',
      toolCallId: 'c1',
      name: 'list_dir',
      subject: '/src',
      status: 'ok' as const,
      error: '',
      errorCode: '',
    },
    {
      kind: 'tool' as const,
      seq: 2,
      turnId: 't1',
      toolCallId: 'c2',
      name: 'read_file',
      subject: '/src/app.ts',
      status: 'ok' as const,
      error: '',
      errorCode: '',
    },
  ];

  // 默认折叠
  const foldedHtml = renderToStaticMarkup(<LightweightToolGroup rows={rows} />);
  assert.match(foldedHtml, /<details class="xn-lightweight-tool-group"/);
  assert.doesNotMatch(foldedHtml, /<details class="xn-lightweight-tool-group"[^>]*open/);
  assert.match(foldedHtml, /只读操作 \(2\)/);
  assert.match(foldedHtml, /list_dir/);
  assert.match(foldedHtml, /read_file/);

  // 展开状态
  const expandedHtml = renderToStaticMarkup(<LightweightToolGroup rows={rows} defaultOpen />);
  assert.match(expandedHtml, /<details class="xn-lightweight-tool-group"[^>]*open=""/);
});

test('LightweightReasoning: 思考过程组件支持默认折叠与展开状态', () => {
  const folded = renderToStaticMarkup(<LightweightReasoning reasoning="分析需求" />);
  assert.match(folded, /<details class="xn-lightweight-reasoning"/);
  assert.doesNotMatch(folded, /<details class="xn-lightweight-reasoning"[^>]*open/);
  assert.match(folded, /思考过程/);
  assert.match(folded, /分析需求/);

  const expanded = renderToStaticMarkup(<LightweightReasoning reasoning="分析需求" defaultOpen />);
  assert.match(expanded, /<details class="xn-lightweight-reasoning"[^>]*open=""/);
});

test('LightweightTimeline: 思考过程默认折叠，流式中显示微光指示器', () => {
  const rows: TimelineRow[] = [
    { kind: 'user', seq: 1, turnId: 't1', text: '你好' },
    {
      kind: 'assistant',
      seq: 2,
      turnId: 't1',
      text: '你好！有什么我可以帮你的？',
      reasoning: '用户正在打招呼，需要礼貌回复。',
    },
  ];

  const html = renderToStaticMarkup(<LightweightTimeline rows={rows} streamingPending />);
  assert.match(html, /class="xn-lightweight-timeline"/);
  assert.match(html, /你好！有什么我可以帮你的？/);
  // 思考过程默认折叠
  assert.match(html, /<details class="xn-lightweight-reasoning"/);
  assert.doesNotMatch(html, /<details class="xn-lightweight-reasoning"[^>]*open/);
  assert.match(html, /用户正在打招呼，需要礼貌回复。/);
});

test('LightweightTimeline: 流式 Markdown 使用统一提交门并延后代码高亮', () => {
  const text = '说明\n\n```ts\nconst ready = true;\n```\n';
  const streamingHtml = renderToStaticMarkup(<LightweightTimeline rows={[
    { kind: 'assistant', seq: 8, turnId: 'stream-8', text, streaming: true },
  ]} />);
  assert.match(streamingHtml, /data-highlight="after-stream"/);
  assert.match(streamingHtml, /data-highlight-timing="after-stream"/);

  const settledHtml = renderToStaticMarkup(<LightweightTimeline rows={[
    { kind: 'assistant', seq: 8, turnId: 'stream-8', text, streaming: false },
  ]} />);
  assert.match(settledHtml, /data-highlight="on-visible"/);
  assert.doesNotMatch(settledHtml, /data-highlight="after-stream"/);
});

// -- 极简状态行 (Pi Footer) ----------------------------------------------------

test('extractReportedUsage: 支持数组与单对象格式，只累加真实报告用量，缺失或非法返回 null', () => {
  assert.equal(extractReportedUsage(null), null);
  assert.equal(extractReportedUsage(undefined), null);
  assert.equal(extractReportedUsage([]), null);
  assert.equal(extractReportedUsage('invalid'), null);
  assert.equal(extractReportedUsage([{}]), null);
  assert.equal(extractReportedUsage([{ usage: { prompt_tokens: -5, completion_tokens: 10 } }]), null);

  // 数组格式
  const validRecords = [
    { usage: { prompt_tokens: 1200, completion_tokens: 300 } },
    { usage: { input_tokens: 800, output_tokens: 200 } },
  ];
  const usage = extractReportedUsage(validRecords);
  assert.notEqual(usage, null);
  assert.equal(usage?.inputTokens, 2000);
  assert.equal(usage?.outputTokens, 500);
  assert.equal(usage?.totalTokens, 2500);

  // 单对象格式
  const singleObjectUsage = extractReportedUsage({ prompt_tokens: 500, completion_tokens: 150 });
  assert.notEqual(singleObjectUsage, null);
  assert.equal(singleObjectUsage?.inputTokens, 500);
  assert.equal(singleObjectUsage?.outputTokens, 150);
  assert.equal(singleObjectUsage?.totalTokens, 650);
});

test('abbreviatePath: 路径缩写支持 Home 目录与深层路径，缺失返回「—」', () => {
  assert.equal(abbreviatePath(null), '—');
  assert.equal(abbreviatePath(''), '—');
  assert.equal(abbreviatePath('   '), '—');
  assert.equal(abbreviatePath('/home/box/workspace/project'), '~/workspace/project');
  assert.equal(abbreviatePath('/Users/alice/repo'), '~/repo');
  assert.equal(abbreviatePath('/var/lib/data/repos/my-app'), '…/repos/my-app');
  assert.equal(abbreviatePath('/workspace'), '/workspace');
});

test('formatTokens: 格式化 Token 计数，缺失返回「—」', () => {
  assert.equal(formatTokens(null), '—');
  assert.equal(formatTokens(undefined), '—');
  assert.equal(formatTokens(-1), '—');
  assert.equal(formatTokens(NaN), '—');
  assert.equal(formatTokens(500), '500');
  assert.equal(formatTokens(1250), '1.3k');
  assert.equal(formatTokens(15000), '15k');
  assert.equal(formatTokens(1500000), '1.5M');
});

test('LightweightStatusBar: 展示模型、路径、真实 Token 或「—」降级，支持窄屏响应式类', () => {
  // 完整数据
  const fullHtml = renderToStaticMarkup(<LightweightStatusBar
    modelName="qwen3-4b-instruct"
    workspaceRoot="/home/box/wt-agy-c2"
    reportedUsage={{ inputTokens: 2500, outputTokens: 800, totalTokens: 3300 }}
    status="running"
  />);
  assert.match(fullHtml, /qwen3-4b-instruct/);
  assert.match(fullHtml, /~\/wt-agy-c2/);
  assert.match(fullHtml, /↑2\.5k ↓800/);
  assert.match(fullHtml, /运行中/);
  assert.match(fullHtml, /xn-lightweight-status__dot--running/);

  // 缺失数据时的降级「—」
  const fallbackHtml = renderToStaticMarkup(<LightweightStatusBar
    modelName={null}
    workspaceRoot={null}
    reportedUsage={null}
    status="idle"
  />);
  assert.match(fallbackHtml, /class="[^"]*xn-lightweight-statusbar__model[^"]*"[^>]*>—<\/span>/);
  assert.match(fallbackHtml, /class="[^"]*xn-lightweight-statusbar__cwd[^"]*"[^>]*>—<\/span>/);
  assert.match(fallbackHtml, /class="[^"]*xn-lightweight-statusbar__left"[^>]*role="group"/);
  assert.match(fallbackHtml, /class="[^"]*xn-lightweight-statusbar__tokens[^"]*"[^>]*><span class="xn-lightweight-statusbar__sr">暂无报告用量<\/span><span aria-hidden="true">—<\/span>/);
  assert.match(fallbackHtml, /空闲/);
  assert.match(fallbackHtml, /xn-lightweight-status__dot--idle/);

  // 窄屏类
  const narrowHtml = renderToStaticMarkup(<LightweightStatusBar
    modelName="gpt-4o"
    status="error"
    isNarrow
  />);
  assert.match(narrowHtml, /xn-lightweight-statusbar--narrow/);
  assert.match(narrowHtml, /出错了/);
  assert.match(narrowHtml, /xn-lightweight-status__dot--error/);

  // 待运行/等待中状态
  const pendingHtml = renderToStaticMarkup(<LightweightStatusBar
    modelName="gpt-4o"
    status="pending"
  />);
  assert.match(pendingHtml, /等待中/);
  assert.match(pendingHtml, /xn-lightweight-status__dot--paused/);
});

// -- 极简输入区与键盘驱动 -------------------------------------------------------

test('evaluateLightweightComposerKey: 键盘事件评估策略（Enter/Shift+Enter/Esc/Ctrl+L/Up/Down/IME）', () => {
  const baseCtx = {
    text: '',
    historyIndex: null,
    historyCount: 2,
    running: false,
    stopping: false,
  };

  // IME 组合中不触发任何操作
  assert.equal(evaluateLightweightComposerKey({ key: 'Enter', nativeEvent: { isComposing: true } }, baseCtx), null);
  assert.equal(evaluateLightweightComposerKey({ key: 'Enter', isComposing: true }, baseCtx), null);
  assert.equal(evaluateLightweightComposerKey({ key: 'Enter', keyCode: 229 }, baseCtx), null);
  assert.equal(evaluateLightweightComposerKey({ key: 'ArrowUp', isComposing: true }, baseCtx), null);

  // Enter 发送，Shift+Enter 换行
  assert.equal(evaluateLightweightComposerKey({ key: 'Enter', shiftKey: false }, baseCtx), 'send');
  assert.equal(evaluateLightweightComposerKey({ key: 'Enter', shiftKey: true }, baseCtx), 'newline');

  // Ctrl/Cmd+L 清屏式滚动到底部
  assert.equal(evaluateLightweightComposerKey({ key: 'l', ctrlKey: true }, baseCtx), 'clear_screen');
  assert.equal(evaluateLightweightComposerKey({ key: 'L', metaKey: true }, baseCtx), 'clear_screen');

  // Esc 中断：运行中且未停止时触发 stop，未运行时为 null
  assert.equal(evaluateLightweightComposerKey({ key: 'Escape' }, { ...baseCtx, running: true }), 'stop');
  assert.equal(evaluateLightweightComposerKey({ key: 'Escape' }, { ...baseCtx, running: true, stopping: true }), null);
  assert.equal(evaluateLightweightComposerKey({ key: 'Escape' }, { ...baseCtx, running: false }), null);

  // Up/Down 历史调出：输入框为空时 Up 调出最新一条历史
  assert.equal(evaluateLightweightComposerKey({ key: 'ArrowUp' }, { ...baseCtx, text: '' }), 'history_prev');
  // 输入框非空且未进入历史模式时，Up 不覆盖当前输入
  assert.equal(evaluateLightweightComposerKey({ key: 'ArrowUp' }, { ...baseCtx, text: 'hello' }), null);
  // 浏览历史时 Down 移至下一条或恢复草稿
  assert.equal(evaluateLightweightComposerKey({ key: 'ArrowDown' }, { ...baseCtx, historyIndex: 0 }), 'history_next');
  // 未浏览历史时 Down 为 null
  assert.equal(evaluateLightweightComposerKey({ key: 'ArrowDown' }, baseCtx), null);
});

test('LightweightComposer: 结构渲染包含自增高单行文本框、停止按钮与排队发送按钮', () => {
  // 空闲态：单行输入框与发送按钮。placeholder 只描述输入内容，快捷键写在说明行里。
  const idleHtml = renderToStaticMarkup(<LightweightComposer placeholder="输入消息" />);
  assert.match(idleHtml, /<form class="xn-lightweight-composer"/);
  assert.match(idleHtml, /<textarea[^>]*class="xn-lightweight-composer__textarea"/);
  assert.match(idleHtml, /placeholder="输入消息"/);
  assert.match(idleHtml, /data-testid="composer-send"/);
  assert.doesNotMatch(idleHtml, /data-testid="composer-stop"/);

  // 运行中状态：显示停止按钮与排队发送按钮
  const runningHtml = renderToStaticMarkup(<LightweightComposer
    running
    queueWhenRunning
    onStop={() => undefined}
  />);
  assert.match(runningHtml, /data-testid="composer-stop"/);
  assert.match(runningHtml, /data-testid="composer-queue"/);
});

// -- 轻量/标准一致性：键盘与发送快捷键 ---------------------------------------

test('evaluateLightweightComposerKey: 尊重用户的发送快捷键设置', () => {
  const baseCtx = { text: '', historyIndex: null, historyCount: 0, running: false, stopping: false };
  assert.equal(
    evaluateLightweightComposerKey({ key: 'l', ctrlKey: true }, { ...baseCtx, historyCount: 0 }),
    'clear_screen',
    'Alt 不参与，Ctrl/Cmd+L 仍是滚到底',
  );
  assert.equal(evaluateLightweightComposerKey({ key: 'l', ctrlKey: true, altKey: true }, baseCtx), null,
    'Alt+Ctrl+L 让给浏览器/终端');
  assert.equal(evaluateLightweightComposerKey({ key: 'l', metaKey: true }, baseCtx), 'clear_screen');

  // 默认 Enter 发送
  assert.equal(evaluateLightweightComposerKey({ key: 'Enter' }, { ...baseCtx, sendShortcut: 'enter' }), 'send');
  assert.equal(evaluateLightweightComposerKey({ key: 'Enter', shiftKey: true }, { ...baseCtx, sendShortcut: 'enter' }), 'newline');
  assert.equal(evaluateLightweightComposerKey({ key: 'Enter', altKey: true }, { ...baseCtx, sendShortcut: 'enter' }), null,
    'Alt+Enter 保留给 textarea/平台，不应触发发送');
  assert.equal(evaluateLightweightComposerKey({ key: 'Enter', ctrlKey: true, altKey: true }, { ...baseCtx, sendShortcut: 'enter' }), null,
    '带 Alt 的组合键不能被普通 Enter 发送策略截获');

  // ⌘/Ctrl+Enter 发送时，裸 Enter 不发送（与标准档 composerEnterIntent 一致）
  assert.equal(evaluateLightweightComposerKey({ key: 'Enter' }, { ...baseCtx, sendShortcut: 'mod-enter' }), null);
  assert.equal(evaluateLightweightComposerKey({ key: 'Enter', shiftKey: true }, { ...baseCtx, sendShortcut: 'mod-enter' }), null);
  assert.equal(evaluateLightweightComposerKey({ key: 'Enter', metaKey: true }, { ...baseCtx, sendShortcut: 'mod-enter' }), 'send');
  assert.equal(evaluateLightweightComposerKey({ key: 'Enter', ctrlKey: true }, { ...baseCtx, sendShortcut: 'mod-enter' }), 'send');
  assert.equal(evaluateLightweightComposerKey({ key: 'Enter', ctrlKey: true, altKey: true }, { ...baseCtx, sendShortcut: 'mod-enter' }), null,
    'Alt+Ctrl+Enter 不能被 Mod+Enter 发送策略截获');
  assert.equal(
    evaluateLightweightComposerKey({ key: 'Enter', ctrlKey: true, shiftKey: true }, { ...baseCtx, sendShortcut: 'mod-enter' }),
    null,
    'Mod+Shift+Enter 不发送',
  );
});

test('evaluateLightweightComposerKey: 浮层展开时让位，Esc 不吞掉菜单关闭，上下键不抢列表', () => {
  const overlay = { text: '', historyIndex: null, historyCount: 2, running: true, stopping: false, overlayOpen: true };
  assert.equal(evaluateLightweightComposerKey({ key: 'Escape' }, overlay), null);
  assert.equal(evaluateLightweightComposerKey({ key: 'ArrowUp' }, { ...overlay, running: false }), null);
  assert.equal(evaluateLightweightComposerKey({ key: 'ArrowDown' }, { ...overlay, historyIndex: 1 }), null);
  // 浮层关闭后恢复原有语义
  assert.equal(evaluateLightweightComposerKey({ key: 'Escape' }, { ...overlay, overlayOpen: false }), 'stop');
  assert.equal(evaluateLightweightComposerKey({ key: 'ArrowDown' }, { ...overlay, historyIndex: 1, overlayOpen: false }), 'history_next');
  assert.equal(evaluateLightweightComposerKey({ key: 'ArrowUp' }, { ...overlay, running: false, overlayOpen: false }), 'history_prev');
});

test('evaluateLightweightDisclosureKey: 折叠项 Enter 与空格都能展开', () => {
  assert.equal(evaluateLightweightDisclosureKey({ key: 'Enter' }), 'toggle');
  assert.equal(evaluateLightweightDisclosureKey({ key: ' ' }), 'toggle');
  assert.equal(evaluateLightweightDisclosureKey({ key: 'Spacebar' }), 'toggle');
  assert.equal(evaluateLightweightDisclosureKey({ key: 'Escape' }), null);
  assert.equal(evaluateLightweightDisclosureKey({ key: 'ArrowUp' }), null);
  assert.equal(evaluateLightweightDisclosureKey({ key: ' ', isComposing: true }), null, '输入法组合中不切换');
  assert.equal(evaluateLightweightDisclosureKey({ key: 'Enter', keyCode: 229 }), null);
});

test('evaluateLightweightGlobalKey: 轻量档全局按键不抢输入控件与浮层', () => {
  const loose = {
    inComposer: false, inEditableField: false, overlayOpen: false,
    panelOpen: false, running: false, stopping: false,
  };
  assert.equal(evaluateLightweightGlobalKey({ key: 'l', ctrlKey: true }, loose), 'clear-screen');
  assert.equal(evaluateLightweightGlobalKey({ key: 'L', metaKey: true }, loose), 'clear-screen');
  // 焦点在轻量输入框：composer 自己已经处理，容器不重复执行
  assert.equal(evaluateLightweightGlobalKey({ key: 'l', ctrlKey: true }, { ...loose, inComposer: true }), null);
  // 焦点在其它插件的输入框/终端/编辑器：一律不接管（Mod+L 本身是浏览器保留键）
  assert.equal(
    evaluateLightweightGlobalKey({ key: 'l', ctrlKey: true }, { ...loose, inEditableField: true, inComposer: false }),
    null,
  );
  // 对话框/命令面板/浮层展开时让位
  assert.equal(evaluateLightweightGlobalKey({ key: 'l', ctrlKey: true }, { ...loose, overlayOpen: true }), null);
  assert.equal(evaluateLightweightGlobalKey({ key: 'Escape' }, { ...loose, overlayOpen: true, running: true }), null);
  // Esc：二级面板优先关闭，回到对话；否则中断运行中的回合
  assert.equal(evaluateLightweightGlobalKey({ key: 'Escape' }, { ...loose, panelOpen: true }), 'close-panel');
  assert.equal(
    evaluateLightweightGlobalKey({ key: 'Escape' }, { ...loose, panelOpen: true, running: true }),
    'close-panel',
    '面板里也先返回对话，不顺手中断任务',
  );
  assert.equal(evaluateLightweightGlobalKey({ key: 'Escape' }, { ...loose, running: true }), 'stop');
  assert.equal(evaluateLightweightGlobalKey({ key: 'Escape' }, { ...loose, running: true, stopping: true }), null);
  assert.equal(evaluateLightweightGlobalKey({ key: 'Escape' }, { ...loose, inEditableField: true, running: true }), null);
  assert.equal(evaluateLightweightGlobalKey({ key: 'Escape' }, loose), null);
  // 其它按键一律放行给浏览器与其它插件
  assert.equal(evaluateLightweightGlobalKey({ key: 'k', ctrlKey: true }, loose), null);
  assert.equal(evaluateLightweightGlobalKey({ key: 'Enter' }, { ...loose, running: true }), null);
});

test('evaluateLightweightGlobalKey: 输入法组合、重复键与已被接管的按键一律不处理', () => {
  const loose = {
    inComposer: false, inEditableField: false, overlayOpen: false,
    panelOpen: false, running: true, stopping: false,
  };
  assert.equal(evaluateLightweightGlobalKey({ key: 'Escape', defaultPrevented: true }, loose), null);
  assert.equal(evaluateLightweightGlobalKey({ key: 'Escape', repeat: true }, loose), null);
  assert.equal(evaluateLightweightGlobalKey({ key: 'Escape', isComposing: true }, loose), null);
  assert.equal(evaluateLightweightGlobalKey({ key: 'l', ctrlKey: true, keyCode: 229 }, loose), null);
});

test('lightweightComposerHint: 键盘提示跟随发送快捷键设置，并覆盖轻量档全部键位', () => {
  const enterHint = lightweightComposerHint('enter', false, false);
  assert.match(enterHint, /Enter 发送/);
  assert.match(enterHint, /Shift\+Enter 换行/);
  assert.match(enterHint, /Esc 中断/);
  assert.match(enterHint, /Ctrl\/Cmd\+L 滚到底/);
  assert.doesNotMatch(enterHint, /排队追加/);

  const modHint = lightweightComposerHint('mod-enter', false, false);
  assert.match(modHint, /^⌘\/Ctrl\+Enter 发送/);
  assert.doesNotMatch(modHint, /^Enter 发送/);

  assert.match(lightweightComposerHint('enter', true, true), /排队追加/);
});

test('LightweightComposer: 占位符不宣称固定发送键，键位说明随设置变化', () => {
  const enterHtml = renderToStaticMarkup(<LightweightComposer />);
  const modHtml = renderToStaticMarkup(<LightweightComposer sendShortcut="mod-enter" />);

  const placeholderOf = (html: string) => /<textarea[^>]*placeholder="([^"]*)"/.exec(html)?.[1] ?? '';
  assert.doesNotMatch(placeholderOf(enterHtml), /Enter/);
  assert.doesNotMatch(placeholderOf(modHtml), /Enter/);

  // 说明行（aria-describedby 的目标）才是键位的唯一来源，并跟随设置
  const describedBy = /aria-describedby="([^"]+)"/.exec(enterHtml)?.[1] ?? '';
  assert.ok(describedBy, '输入框必须关联键盘说明');
  const hintNode = new RegExp(`id="${describedBy}"[^>]*>([^<]*)<`).exec(enterHtml)?.[1] ?? '';
  assert.match(hintNode, /Enter 发送/);
  const modHintNode = new RegExp(`id="${(/aria-describedby="([^"]+)"/.exec(modHtml))?.[1]}"[^>]*>([^<]*)<`).exec(modHtml)?.[1] ?? '';
  assert.match(modHintNode, /^⌘\/Ctrl\+Enter 发送/);
});

// -- 轻量/标准一致性：状态读数对等 ---------------------------------------------

test('lightweightStatusPresentation: 状态词表覆盖标准档用到的全部取值', () => {
  assert.deepEqual(lightweightStatusPresentation('running'), { label: '运行中', tone: 'running' });
  assert.deepEqual(lightweightStatusPresentation('streaming'), { label: '运行中', tone: 'running' });
  assert.deepEqual(lightweightStatusPresentation('pending'), { label: '等待中', tone: 'paused' });
  assert.deepEqual(lightweightStatusPresentation('queued'), { label: '等待中', tone: 'paused' });
  assert.deepEqual(lightweightStatusPresentation('paused'), { label: '已暂停', tone: 'paused' });
  assert.deepEqual(lightweightStatusPresentation('needs_review'), { label: '需要审核', tone: 'paused' });
  assert.deepEqual(lightweightStatusPresentation('awaiting_user'), { label: '等待用户', tone: 'paused' });
  assert.deepEqual(lightweightStatusPresentation('stalled'), { label: '运行停滞', tone: 'paused' });
  assert.deepEqual(lightweightStatusPresentation('failed'), { label: '出错了', tone: 'error' });
  assert.deepEqual(lightweightStatusPresentation('provider_error'), { label: '出错了', tone: 'error' });
  assert.deepEqual(lightweightStatusPresentation('cancelled'), { label: '已取消', tone: 'idle' });
  assert.deepEqual(lightweightStatusPresentation('completed'), { label: '已完成', tone: 'done' });
  assert.deepEqual(lightweightStatusPresentation(undefined), { label: '空闲', tone: 'idle' });
  assert.deepEqual(lightweightStatusPresentation(''), { label: '空闲', tone: 'idle' });
  // 未知状态不虚构，回落空闲文案但保留原状态色以外的中性表现
  assert.deepEqual(lightweightStatusPresentation('whatever'), { label: '空闲', tone: 'idle' });
});

test('lightweightStatusPresentation: 停止中、输出中断与排队各有独立读数', () => {
  assert.deepEqual(lightweightStatusPresentation('running', { stopping: true }), { label: '正在停止', tone: 'running' });
  assert.deepEqual(lightweightStatusPresentation('cancelled', { interrupted: true }), { label: '已中断', tone: 'paused' });
  assert.deepEqual(lightweightStatusPresentation('idle', { interrupted: true }), { label: '已中断', tone: 'paused' });
  assert.deepEqual(lightweightStatusPresentation('completed', { queueCount: 2 }), { label: '已完成', tone: 'done' },
    '已有明确状态时不被队列覆盖');
  assert.deepEqual(lightweightStatusPresentation('idle', { queueCount: 2 }), { label: '队列中', tone: 'paused' });
});

test('lightweightStatusReadout: 队列条数并入同一句读数，没有队列时不编造', () => {
  const running = lightweightStatusPresentation('running');
  assert.equal(lightweightStatusReadout(running), '运行中');
  assert.equal(lightweightStatusReadout(running, 0), '运行中');
  assert.equal(lightweightStatusReadout(running, undefined), '运行中');
  assert.equal(lightweightStatusReadout(running, 3), '运行中 · 队列 3');
});

test('LightweightStatusBar: 状态读数补齐停止中、中断与队列，且只播报状态句', () => {
  const stoppingHtml = renderToStaticMarkup(<LightweightStatusBar
    modelName="qwen3-4b-instruct"
    status="running"
    stopping
  />);
  assert.match(stoppingHtml, /正在停止/);
  assert.match(stoppingHtml, /xn-lightweight-status__dot--running/);

  const queueHtml = renderToStaticMarkup(<LightweightStatusBar
    modelName="qwen3-4b-instruct"
    status="running"
    queueCount={2}
  />);
  assert.match(queueHtml, /运行中 · 队列 2/);
  assert.match(queueHtml, /data-tone="running"/);

  const interruptedHtml = renderToStaticMarkup(<LightweightStatusBar
    modelName="qwen3-4b-instruct"
    status="cancelled"
    interrupted
  />);
  assert.match(interruptedHtml, /已中断/);
  assert.match(interruptedHtml, /xn-lightweight-status__dot--paused/);

  const failedHtml = renderToStaticMarkup(<LightweightStatusBar modelName="m" status="failed" />);
  assert.match(failedHtml, /出错了/);
  assert.match(failedHtml, /xn-lightweight-status__dot--error/);
});

// -- 无障碍：地标、可访问名与 aria-live 策略 -----------------------------------

test('LightweightStatusBar: 是带名称的地标，易变读数不在实时区内，只有状态句播报', () => {
  const html = renderToStaticMarkup(<LightweightStatusBar
    modelName="qwen3-4b-instruct"
    workspaceRoot="/home/box/project"
    reportedUsage={{ inputTokens: 2500, outputTokens: 800, totalTokens: 3300 }}
    status="running"
  />);
  // 整行是可浏览的 region 地标，不再是包裹一切的 role="status"
  assert.match(html, /<footer[^>]*role="region"[^>]*aria-label="轻量模式状态行"/);
  assert.doesNotMatch(html, /<footer[^>]*role="status"/);
  // 只有状态读数在一个 polite 实时区里，且原子播报整句
  const readout = html.match(/<span[^>]*data-testid="lightweight-status-readout"[^>]*>/)?.[0] ?? '';
  assert.notEqual(readout, '');
  assert.match(readout, /role="status"/);
  assert.match(readout, /aria-live="polite"/);
  assert.match(readout, /aria-atomic="true"/);
  // 每轮都变的 Token 读数与路径刻意留在实时区外：整段左侧不携带任何 live 语义
  const left = html.slice(html.indexOf('__left'), html.indexOf('__right'));
  assert.doesNotMatch(left, /aria-live/);
  assert.doesNotMatch(left, /role="status"/);
  assert.match(left, /↑2\.5k ↓800/);
});

test('LightweightTimeline: 整条流是 role="log" 地标，流式期间标 aria-busy 不打断朗读', () => {
  const rows: TimelineRow[] = [
    { kind: 'user', seq: 1, turnId: 't1', text: '你好' },
    { kind: 'assistant', seq: 2, turnId: 't1', text: '正在写的回答', streaming: true },
  ];
  const streamingHtml = renderToStaticMarkup(<LightweightTimeline rows={rows} streamingPending />);
  assert.match(streamingHtml, /<div[^>]*role="log"[^>]*aria-label="紧凑时间线"/);
  assert.match(streamingHtml, /aria-live="polite"/);
  assert.match(streamingHtml, /aria-relevant="additions"/);
  assert.match(streamingHtml, /aria-busy="true"/);

  const settledHtml = renderToStaticMarkup(<LightweightTimeline rows={rows} />);
  assert.match(settledHtml, /aria-busy="false"/);
});

test('LightweightTimeline: 空态与载入态都是同一个地标，流式指示器有文字且不重复播报', () => {
  const emptyHtml = renderToStaticMarkup(<LightweightTimeline rows={[]} />);
  assert.match(emptyHtml, /role="log"/);
  assert.match(emptyHtml, /aria-label="紧凑时间线"/);
  assert.match(emptyHtml, /暂无事件/);

  const loadingHtml = renderToStaticMarkup(<LightweightTimeline rows={[]} streamingPending />);
  assert.match(loadingHtml, /role="log"/);
  assert.match(loadingHtml, /aria-busy="true"/);
  assert.match(loadingHtml, /正在生成回复…/);

  // 有历史行时：三个点纯装饰（aria-hidden），状态文字才是唯一的 role="status"
  const rows: TimelineRow[] = [{ kind: 'user', seq: 1, turnId: 't1', text: '你好' }];
  const pendingHtml = renderToStaticMarkup(<LightweightTimeline rows={rows} streamingPending />);
  assert.match(pendingHtml, /data-testid="lightweight-timeline-streaming"/);
  const dots = pendingHtml.match(/<span class="xn-lightweight-streaming-dots"[^>]*>/)?.[0] ?? '';
  assert.notEqual(dots, '', '脉冲点容器必须存在且被标注为装饰');
  assert.match(dots, /aria-hidden="true"/);
  assert.equal(
    pendingHtml.match(/role="status"/g)?.length,
    1,
    '同一屏只保留一个流式状态实时区，避免重复朗读',
  );
});

test('LightweightComposer: 输入区是带名称的地标，输入框有稳定可访问名与键盘说明', () => {
  const html = renderToStaticMarkup(<LightweightComposer
    running
    queueWhenRunning
    queueBusy
    onStop={() => undefined}
  />);
  assert.match(html, /<form[^>]*aria-label="消息输入"/);
  const textarea = html.match(/<textarea[^>]*>/)?.[0] ?? '';
  assert.match(textarea, /aria-label="消息输入框"/);
  assert.match(textarea, /aria-describedby="[^"]+"/);
  // 说明文本真实存在（不是只挂在 placeholder 上），且被 aria-describedby 指向
  const hintId = textarea.match(/aria-describedby="([^"]+)"/)?.[1];
  assert.ok(hintId, '输入框必须关联键盘说明');
  assert.ok(html.includes(`id="${hintId}"`), 'aria-describedby 必须指向真实存在的元素');
  assert.match(html, /class="xn-lightweight-composer__hint"[^>]*>[^<]*Esc 中断/);

  // 图标按钮都有文字级可访问名，图标本身对 AT 隐藏
  const stopLabel = html.match(/data-testid="composer-stop"/) ? html.match(/<button[^>]*data-testid="composer-stop"[^>]*>/)?.[0] ?? '' : '';
  assert.match(stopLabel, /aria-label="停止当前任务"/);
  assert.match(html, /aria-label="正在排队…"/, '排队中的按钮名要说清正在发生什么');
  assert.equal(
    [...html.matchAll(/<svg[^>]*>/g)].every((tag) => /aria-hidden="true"/.test(tag[0])),
    true,
    '装饰图标必须对 AT 隐藏',
  );
  assert.match(html, /<span class="xn-lightweight-composer__status" role="status">正在排队…<\/span>/);

  // 停止请求已发出后，按钮名与状态读数都要变
  const stoppingHtml = renderToStaticMarkup(<LightweightComposer running stopping onStop={() => undefined} />);
  const stoppingButton = stoppingHtml.match(/<button[^>]*data-testid="composer-stop"[^>]*>/)?.[0] ?? '';
  assert.match(stoppingButton, /aria-label="正在停止"/);
  assert.match(stoppingButton, /disabled=""/);
});

test('轻量档折叠项保留原生 summary 焦点语义，不再额外挂 tabIndex', () => {
  const row = {
    kind: 'tool' as const,
    seq: 1,
    turnId: 't1',
    toolCallId: 'c1',
    name: 'read_file',
    subject: '/etc/hosts',
    status: 'ok' as const,
    error: '',
    errorCode: '',
  };
  const html = renderToStaticMarkup(<LightweightToolRow row={row} />);
  assert.match(html, /<summary class="xn-lightweight-tool__summary"/);
  assert.doesNotMatch(html, /tabindex="0"/, 'summary 本身可聚焦，重复挂 tabIndex 会多出一个焦点停靠');

  const groupHtml = renderToStaticMarkup(<LightweightToolGroup rows={[row, { ...row, seq: 2, name: 'list_dir' }]} />);
  assert.match(groupHtml, /<summary class="xn-lightweight-tool-group__summary"/);
  assert.doesNotMatch(groupHtml, /tabindex="0"/);

  const reasoningHtml = renderToStaticMarkup(<LightweightReasoning reasoning="分析" />);
  assert.doesNotMatch(reasoningHtml, /tabindex="0"/);
});

// -- 样式与对比度：只用现有 design tokens，动效可降级 --------------------------

test('LightweightWorkbench.css 只用既有设计令牌，并为流式指示器提供降级动效', async () => {
  const css = await readFile(resolve(process.cwd(), 'src/plugins/providers/LightweightWorkbench.css'), 'utf8');
  const block = (selector: string): string =>
    css.match(new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

  // 不硬编码颜色：新增的读数/提示/脉冲点一律走令牌
  for (const selector of [
    'xn-lightweight-streaming-dot',
    'xn-lightweight-composer__hint',
    'xn-lightweight-composer__status',
    'xn-lightweight-statusbar__status-text',
    'xn-lightweight-status__dot--done',
  ]) {
    const body = block(selector);
    assert.notEqual(body, '', `缺少 ${selector} 样式`);
    assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b/i, `${selector} 不允许写死十六进制颜色`);
    assert.doesNotMatch(body, /\brgba?\(/i, `${selector} 不允许写死 rgb(a) 颜色`);
    assert.match(body, /var\(--/, `${selector} 必须引用设计令牌`);
  }

  // 文字读数不靠半透明压对比度
  assert.doesNotMatch(block('xn-lightweight-composer__hint'), /opacity:/);
  assert.doesNotMatch(block('xn-lightweight-statusbar__status-text'), /opacity:/);

  // 脉冲动效必须能被 prefers-reduced-motion 关掉，且静帧仍然可见
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.xn-lightweight-streaming-dot\s*\{[^}]*animation: none/);
  assert.match(block('xn-lightweight-streaming-dot'), /opacity: 1/);
});


// -- i18n：轻量档新增文案在英文档必须真的被翻译 -------------------------------

test('轻量档新增的状态、地标与键位文案在英文档不回落中文', () => {
  try {
    setLocale('en');
    const composerHtml = renderToStaticMarkup(<LightweightComposer
      running
      stopping
      queueWhenRunning
      queueBusy
      sendShortcut="mod-enter"
      onStop={() => undefined}
    />);
    const statusHtml = renderToStaticMarkup(<LightweightStatusBar
      status="running"
      stopping
      interrupted
      queueCount={3}
      reportedUsage={{ inputTokens: 120, outputTokens: 40 }}
      workspaceRoot="/tmp/workspace"
      modelName="qwen3-4b"
    />);
    const timelineHtml = renderToStaticMarkup(<LightweightTimeline
      rows={[
        { seq: 1, kind: 'assistant', text: 'Working', status: 'streaming' } as never,
        { seq: 2, kind: 'user', turnId: 'turn-1', text: 'Hello' } as never,
        { seq: 3, kind: 'tool', turnId: 'turn-1', toolCallId: 'c3', name: 'ask_user', subject: '', status: 'ok', error: '', errorCode: '', input: { question: 'Which one?' } } as never,
        { seq: 4, kind: 'pending_question', question: 'Which one?' } as never,
      ]}
      streamingPending
    />);

    for (const [name, html] of [['composer', composerHtml], ['status', statusHtml], ['timeline', timelineHtml]] as const) {
      assert.doesNotMatch(html, /[\u4e00-\u9fff]/, `${name} 在英文档仍有中文文案`);
    }
    // 翻译后的键位说明与地标名依然完整
    assert.match(composerHtml, /aria-label="Message input"/);
    assert.match(composerHtml, /⌘\/Ctrl\+Enter to send/);
    assert.match(composerHtml, /Esc to interrupt/);
    assert.match(statusHtml, /Stopping · Queue 3/);
    assert.match(timelineHtml, /<span class="xn-lightweight-msg__author">My message<\/span>/);
    assert.match(timelineHtml, /<span class="xn-lightweight-msg__author">Xueness reply<\/span>/);
    assert.match(timelineHtml, /<span class="xn-lightweight-tool__status" data-status="pending">Awaiting answer<\/span>/);
    assert.match(renderToStaticMarkup(<LightweightStatusBar status="running" queueCount={3} />), /Running · Queue 3/);
  } finally {
    setLocale('zh');
  }
  assert.match(renderToStaticMarkup(<LightweightStatusBar status="running" queueCount={3} />), /运行中 · 队列 3/);
});

// -- 审计复核补漏：分组 key 稳定、等待回答、完成判定、修饰键、浮层选择器 ------

const readOnlyTool = (seq: number, name = 'read_file'): TimelineRow => ({
  kind: 'tool',
  seq,
  turnId: 'turn-1',
  toolCallId: `call-${seq}`,
  name,
  subject: `subj-${seq}`,
  status: 'ok',
  error: '',
  errorCode: '',
});

test('groupLightweightTimelineRows: 组 key 不随流式追加变化，展开态与焦点不丢', () => {
  const two = groupLightweightTimelineRows([readOnlyTool(3), readOnlyTool(4)]);
  const three = groupLightweightTimelineRows([readOnlyTool(3), readOnlyTool(4), readOnlyTool(5)]);
  assert.equal(two[0].kind, 'read-only-group');
  assert.equal(two[0].id, 'ro-group-3');
  assert.equal(three[0].id, two[0].id, '新只读工具并入同一个组时 key 必须不变');
});

test('LightweightTimeline: 等待回答的行不再被静默丢弃，名称与标准档一致', () => {
  const html = renderToStaticMarkup(<LightweightTimeline rows={[
    { kind: 'pending_question', seq: 4, question: '要保留旧文件吗？' },
  ]} />);
  assert.match(html, /data-testid="timeline-item-question-4"/);
  assert.match(html, /data-role="pending_question"/);
  assert.match(html, /等待回答/);
  assert.match(html, /要保留旧文件吗？/);
});

test('LightweightTimeline: 完成行沿用标准档的验证与交付判定，不再一律念「运行结束」', () => {
  const completion = (row: Extract<TimelineRow, { kind: 'completion' }>) =>
    renderToStaticMarkup(<LightweightTimeline rows={[row]} />);
  const verified = completion({
    kind: 'completion', seq: 9, verified: true, status: 'verified', toolExecutionStatus: 'succeeded', summary: '测试通过',
  });
  const unverified = completion({
    kind: 'completion', seq: 9, verified: false, status: 'unverified', toolExecutionStatus: 'failed', summary: '',
  });
  const incomplete = completion({
    kind: 'completion', seq: 9, verified: false, status: 'incomplete', summary: '',
  });
  assert.match(verified, /运行结束 · 工具成功证据通过/);
  assert.match(unverified, /工具证据未通过验证/);
  assert.match(incomplete, /回答尚未完成/);
  assert.match(incomplete, /已暂停/);
});

test('轻量档按键判定: 带修饰键的组合不劫持清屏与历史翻找', () => {
  const ctx = { text: '', historyIndex: null, historyCount: 2, running: true, stopping: false };
  assert.equal(evaluateLightweightComposerKey({ key: 'l', ctrlKey: true, shiftKey: true }, ctx), null, 'Ctrl+Shift+L 属浏览器');
  assert.equal(evaluateLightweightComposerKey({ key: 'l', ctrlKey: true, altKey: true }, ctx), null, 'Ctrl+Alt+L 属其它插件');
  assert.equal(evaluateLightweightComposerKey({ key: 'l', ctrlKey: true }, ctx), 'clear_screen');
  assert.equal(evaluateLightweightComposerKey({ key: 'ArrowUp', shiftKey: true }, ctx), null);
  assert.equal(evaluateLightweightComposerKey({ key: 'ArrowUp', metaKey: true }, ctx), null);
  assert.equal(evaluateLightweightComposerKey({ key: 'ArrowDown', altKey: true }, { ...ctx, historyIndex: 1 }), null);
  assert.equal(evaluateLightweightComposerKey({ key: 'ArrowUp' }, ctx), 'history_prev');

  const global = { inComposer: false, inEditableField: false, overlayOpen: false, panelOpen: false, running: true, stopping: false };
  assert.equal(evaluateLightweightGlobalKey({ key: 'L', ctrlKey: true, shiftKey: true }, global), null);
  assert.equal(evaluateLightweightGlobalKey({ key: 'L', ctrlKey: true, altKey: true }, global), null);
  assert.equal(evaluateLightweightGlobalKey({ key: 'L', metaKey: true }, global), 'clear-screen');
});

test('OVERLAY_SELECTOR 只列打开时才挂载的浮层节点，不用 [open] 死选择器', async () => {
  const toolbar = await readFile(resolve(process.cwd(), 'src/plugins/sessions/XuenessComposerToolbar.tsx'), 'utf8');
  const palette = await readFile(resolve(process.cwd(), 'src/plugins/sessions/CommandPalette.tsx'), 'utf8');
  assert.doesNotMatch(OVERLAY_SELECTOR, /\[open\]/, '工具条菜单不是 <details>，[open] 永远不命中');
  for (const token of ['[role="dialog"]', '[role="menu"]', '[role="listbox"]']) {
    assert.ok(OVERLAY_SELECTOR.includes(token), `浮层判定缺少 ${token}`);
  }
  assert.match(OVERLAY_SELECTOR, /\.xn-command-overlay/);
  assert.match(toolbar, /className="xn-composer-toolbar__popover[\s\S]{0,90}role="menu"/);
  assert.match(palette, /className="xn-command-overlay"/);
  assert.match(palette, /role="listbox"/);
});

test('LightweightStatusBar: Token 读数给屏幕阅读器展开，箭头字形本身不播报', () => {
  const html = renderToStaticMarkup(<LightweightStatusBar
    modelName="qwen3-4b"
    workspaceRoot="/tmp/workspace"
    reportedUsage={{ inputTokens: 1200, outputTokens: 40 }}
    status="running"
  />);
  assert.match(html, /<span class="xn-lightweight-statusbar__sr">服务报告的 Token 用量：输入 [\d.]+k?，输出 [\d.]+k?<\/span>/);
  assert.match(html, /<span aria-hidden="true">↑[\d.]+k? ↓[\d.]+k?<\/span>/);
});

test('LightweightStatusBar: 状态色不只靠 6px 圆点表达，读数文字按 tone 着色且只用令牌', async () => {
  const errorHtml = renderToStaticMarkup(<LightweightStatusBar status="provider_error" />);
  assert.match(errorHtml, /data-tone="error"/);
  assert.match(errorHtml, /出错了/);
  const pausedHtml = renderToStaticMarkup(<LightweightStatusBar status="needs_review" />);
  assert.match(pausedHtml, /data-tone="paused"/);

  const css = await readFile(resolve(process.cwd(), 'src/plugins/providers/LightweightWorkbench.css'), 'utf8');
  for (const tone of ['error', 'paused', 'done']) {
    const body = css.match(new RegExp(`\\.xn-lightweight-statusbar\\[data-tone="${tone}"\\] \\.xn-lightweight-statusbar__status-text\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    assert.notEqual(body, '', `缺少 data-tone="${tone}" 的读数配色`);
    assert.match(body, /var\(--/, `${tone} 配色必须引用设计令牌`);
    assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b/i, `${tone} 配色不允许写死十六进制颜色`);
    assert.doesNotMatch(body, /opacity:/, `${tone} 配色不允许靠透明度压对比`);
  }
});

const cssPath = () => resolve(process.cwd(), 'src/plugins/providers/LightweightWorkbench.css');

test('ask_user 在等回答时念「等待回答」，答完回落成这一行的真实状态', () => {
  assert.equal(lightweightToolStatusLabel('ok', true), '等待回答');
  assert.equal(lightweightToolStatusLabel('ok'), '已完成');
  assert.equal(lightweightToolStatusLabel('error'), '失败');

  const askUser: TimelineRow = {
    kind: 'tool',
    seq: 7,
    turnId: 'turn-1',
    toolCallId: 'call-7',
    name: 'ask_user',
    subject: '',
    status: 'ok',
    error: '',
    errorCode: '',
    input: { question: '要按哪个方案改？' },
  } as TimelineRow;
  const question: TimelineRow = { kind: 'pending_question', seq: 8, question: '要按哪个方案改？' };

  const waitingHtml = renderToStaticMarkup(<LightweightTimeline rows={[askUser, question]} />);
  assert.match(waitingHtml, /<span class="xn-lightweight-tool__status" data-status="pending">等待回答<\/span>/);
  assert.match(waitingHtml, /等待回答/);

  const answeredHtml = renderToStaticMarkup(<LightweightTimeline rows={[askUser]} />);
  assert.match(answeredHtml, /<span class="xn-lightweight-tool__status" data-status="ok">已完成<\/span>/);
});

test('轻量档消息行带屏幕阅读器作者名，视觉仍是极简气泡', async () => {
  const html = renderToStaticMarkup(<LightweightTimeline rows={[
    { kind: 'user', seq: 1, turnId: 't1', text: '你好' },
    { kind: 'assistant', seq: 2, turnId: 't1', text: '在的' },
  ]} />);
  assert.match(html, /<span class="xn-lightweight-msg__author">我的消息<\/span>/);
  assert.match(html, /<span class="xn-lightweight-msg__author">Xueness 回复<\/span>/);

  const css = await readFile(cssPath(), 'utf8');
  const rule = css.match(/\.xn-lightweight-statusbar__sr,\s*\.xn-lightweight-msg__author\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(rule, /clip: rect\(0, 0, 0, 0\)/, '作者名靠 clip 隐藏，不是删掉');
  assert.doesNotMatch(rule, /display:\s*none/, 'display:none 会让屏幕阅读器读不到作者名');
});

test('轻量档控制区与标准档同名：成组且可发现', () => {
  const html = renderToStaticMarkup(<LightweightComposer controls={<LightweightComposerControls {...baseProps} />} />);
  assert.match(html, /<div class="xn-lightweight-composer__controls" role="group" aria-label="运行选项">/);
});

test('工具状态徽标只用设计令牌，合并组与「等待回答」不落到裸文字配色', async () => {
  const css = await readFile(cssPath(), 'utf8');
  const base = css.match(/\.xn-lightweight-tool__status,\s*\.xn-lightweight-tool-group__status\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.notEqual(base, '', '合并组徽标缺少与单行工具共用的基础样式');

  for (const status of ['ok', 'running', 'error', 'cancelled']) {
    const shared = css.match(new RegExp(`\\.xn-lightweight-tool__status\\[data-status="${status}"\\],\\s*\\.xn-lightweight-tool-group__status\\[data-status="${status}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    assert.match(shared, /color: var\(--(ok-fg|warn-fg|error-fg|fg-muted)\)/, `${status} 态合并组徽标缺少可读的文字色令牌`);
    assert.doesNotMatch(shared, /#[0-9a-f]{3,8}\b/i, `${status} 态不允许写死十六进制颜色`);
  }
  const pending = css.match(/\.xn-lightweight-tool__status\[data-status="pending"\]\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(pending, /var\(--warn-fg\)/, '等待回答不能沿用「已完成」的绿');

  const dots = css.match(/\.xn-lightweight-status__dot--(?:running|paused|error|done)\s*\{[^}]*\}/g) ?? [];
  assert.equal(dots.length, 4, '四种状态点配色必须齐全');
  for (const dot of dots) {
    assert.match(dot, /var\(--(warn|error|ok)-fg\)/, '状态点要用为文字准备的令牌，6px 圆点在浅底上不够对比');
  }
});

test('共享工具条切档位后收菜单，并把焦点交回轻量档输入框', async () => {
  const toolbar = await readFile(resolve(process.cwd(), 'src/plugins/sessions/XuenessComposerToolbar.tsx'), 'utf8');
  assert.match(toolbar, /textarea\.xn-composer__input,\s*textarea\.xn-lightweight-composer__textarea/,
    '回落选择器漏了轻量档输入框，切档位后焦点会掉到 body');
  assert.match(toolbar, /const chooseRuntimeProfile[\s\S]{0,460}?closeModelMenu\(true\);/,
    '档位切换换掉整棵输入区树，必须像选模型一样收菜单并归还焦点');
});
