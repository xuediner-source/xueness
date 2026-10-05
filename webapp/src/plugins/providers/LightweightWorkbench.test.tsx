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
  LightweightComposer,
  LightweightComposerControls,
  LightweightReasoning,
  LightweightStatusBar,
  LightweightTimeline,
  LightweightToolGroup,
  LightweightToolRow,
  abbreviatePath,
  evaluateLightweightComposerKey,
  extractReportedUsage,
  extractToolKeySummary,
  formatTokens,
  formatToolDuration,
  groupLightweightTimelineRows,
  isReadOnlyTool,
  lightweightContextUsage,
  lightweightLayoutActive,
  toolStatusLabel,
} from './LightweightWorkbench';
import { XuenessComposerToolbar } from '../sessions/XuenessComposerToolbar';
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
  assert.match(fallbackHtml, /class="[^"]*xn-lightweight-statusbar__tokens[^"]*"[^>]*>—<\/span>/);
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
  // 空闲态：单行输入框与发送按钮
  const idleHtml = renderToStaticMarkup(<LightweightComposer
    placeholder="输入消息（Enter 发送，Shift+Enter 换行，Esc 中断）"
  />);
  assert.match(idleHtml, /<div class="xn-lightweight-composer"/);
  assert.match(idleHtml, /<textarea[^>]*class="xn-lightweight-composer__textarea"/);
  assert.match(idleHtml, /placeholder="输入消息（Enter 发送，Shift\+Enter 换行，Esc 中断）"/);
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
