import React from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { DirectoryBrowser } from "./plugins/files/DirectoryBrowser";
import { ProvidersPanel } from "./plugins/providers/ProvidersPanel";
import { UsagePanel } from "./plugins/usage/UsagePanel";
import { MemoryPanel } from "./plugins/memory/MemoryPanel";
import { SettingsSections } from "./plugins/settings/SettingsSections";
import type {
  ProviderSummary,
  UsageSummary,
  MemoryTrack,
  SettingsMap,
} from "./xuenessWorkspace";
import type { AgentCapabilities } from "./xuenessSettings";

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

// ============================================================================
// DirectoryBrowser Tests
// ============================================================================

test("DirectoryBrowser: 有数据的正常渲染，目录排在前面，文件显示大小", () => {
  const entries = [
    { name: "zebra.txt", path: "/workspace/zebra.txt", isDir: false, size: 2048 },
    { name: "docs", path: "/workspace/docs", isDir: true, size: 0 },
    { name: "alpha.txt", path: "/workspace/alpha.txt", isDir: false, size: 512 },
    { name: "bin", path: "/workspace/bin", isDir: true, size: 0 },
  ];

  const out = html(
    <DirectoryBrowser
      currentPath="/workspace"
      entries={entries}
      onNavigate={() => {}}
      onOpenFile={() => {}}
    />,
  );

  // 断言标题和当前路径
  assert.match(out, /目录浏览/);
  assert.match(out, /\/workspace/);

  // 目录应排在文件之前 (bin/docs 在 alpha/zebra 前面)
  const binIdx = out.indexOf("data-testid=\"dir-entry-bin\"");
  const docsIdx = out.indexOf("data-testid=\"dir-entry-docs\"");
  const alphaIdx = out.indexOf("data-testid=\"file-entry-alpha.txt\"");
  const zebraIdx = out.indexOf("data-testid=\"file-entry-zebra.txt\"");

  assert.ok(binIdx !== -1 && docsIdx !== -1 && alphaIdx !== -1 && zebraIdx !== -1);
  assert.ok(binIdx < alphaIdx);
  assert.ok(docsIdx < alphaIdx);
  assert.ok(alphaIdx < zebraIdx);

  // 文件大小
  assert.match(out, /2\.0 KB/);
  assert.match(out, /512 B/);
});

test("DirectoryBrowser: 空态文案展示 EmptyState", () => {
  const out = html(
    <DirectoryBrowser
      currentPath="/empty"
      entries={[]}
    />,
  );
  assert.match(out, /目录为空/);
  assert.match(out, /当前目录下没有文件或子目录/);
  assert.match(out, /data-testid="empty-state"/);
});

test("DirectoryBrowser: 错误态可见且含 role='alert'", () => {
  const out = html(
    <DirectoryBrowser
      currentPath="/workspace"
      entries={[]}
      error="无读取权限 (EACCES)"
    />,
  );
  assert.match(out, /role="alert"/);
  assert.match(out, /目录读取失败：无读取权限 \(EACCES\)/);
});

test("DirectoryBrowser: loading 时显示 Spinner", () => {
  const out = html(
    <DirectoryBrowser
      currentPath="/workspace"
      entries={[]}
      loading={true}
    />,
  );
  assert.match(out, /role="status"/);
  assert.match(out, /加载目录中\.\.\./);
});

test("DirectoryBrowser: 截断提示如实展示", () => {
  const out = html(
    <DirectoryBrowser
      currentPath="/huge"
      entries={[{ name: "file1.txt", path: "/huge/file1.txt", isDir: false, size: 10 }]}
      truncated={true}
    />,
  );
  assert.match(out, /内容过多，仅显示部分结果/);
});

test("DirectoryBrowser: 无 onCreateDir 时不渲染新建文件夹控件", () => {
  const out = html(
    <DirectoryBrowser
      currentPath="/workspace"
      entries={[]}
    />,
  );
  assert.doesNotMatch(out, /data-testid="create-dir-form"/);
  assert.doesNotMatch(out, /新建文件夹/);
});

test("DirectoryBrowser: 有 onCreateDir 时渲染新建文件夹控件与输入框", () => {
  const out = html(
    <DirectoryBrowser
      currentPath="/workspace"
      entries={[]}
      onCreateDir={() => {}}
    />,
  );
  assert.match(out, /data-testid="create-dir-form"/);
  assert.match(out, /新建文件夹/);
});

test("DirectoryBrowser: 无 onNavigate 时不出可点击目录按钮（防假控件）", () => {
  const outWithoutNav = html(
    <DirectoryBrowser
      currentPath="/workspace"
      entries={[{ name: "sub", path: "/workspace/sub", isDir: true, size: 0 }]}
    />,
  );
  assert.doesNotMatch(outWithoutNav, /data-testid="dir-navigate-sub"/);
  assert.match(outWithoutNav, /<span[^>]*>sub<\/span>/);

  const outWithNav = html(
    <DirectoryBrowser
      currentPath="/workspace"
      entries={[{ name: "sub", path: "/workspace/sub", isDir: true, size: 0 }]}
      onNavigate={() => {}}
    />,
  );
  assert.match(outWithNav, /data-testid="dir-navigate-sub"/);
});

test("DirectoryBrowser: 无 onOpenFile 时不出可点击文件按钮（防假控件）", () => {
  const outWithoutOpen = html(
    <DirectoryBrowser
      currentPath="/workspace"
      entries={[{ name: "test.md", path: "/workspace/test.md", isDir: false, size: 100 }]}
    />,
  );
  assert.doesNotMatch(outWithoutOpen, /data-testid="file-open-test\.md"/);

  const outWithOpen = html(
    <DirectoryBrowser
      currentPath="/workspace"
      entries={[{ name: "test.md", path: "/workspace/test.md", isDir: false, size: 100 }]}
      onOpenFile={() => {}}
    />,
  );
  assert.match(outWithOpen, /data-testid="file-open-test\.md"/);
});

// ============================================================================
// ProvidersPanel Tests
// ============================================================================

test("ProvidersPanel: 正常渲染列表，hasKey 用 Badge 区分，且绝对不泄露任何 apiKey", () => {
  const providers: ProviderSummary[] = [
    {
      id: "deepseek",
      name: "DeepSeek Official",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      hasKey: true,
    },
    {
      id: "ollama-local",
      name: "Local Ollama",
      baseUrl: "http://localhost:11434/v1",
      model: "qwen2.5:7b",
      hasKey: false,
    },
  ];

  const out = html(<ProvidersPanel providers={providers} />);

  assert.match(out, /模型服务商 \(Providers\)/);
  assert.match(out, /DeepSeek Official/);
  assert.match(out, /deepseek-chat/);
  assert.match(out, /Local Ollama/);
  assert.match(out, /qwen2\.5:7b/);

  // Badge 状态区分
  assert.match(out, /已配置密钥/);
  assert.match(out, /未配置密钥/);

  // 安全核心断言：绝对不出现任何 apiKey 或 secret
  assert.doesNotMatch(out, /apiKey/i);
  assert.doesNotMatch(out, /sk-[a-zA-Z0-9]{10,}/);
});

test("ProvidersPanel: 空态展示 EmptyState", () => {
  const out = html(<ProvidersPanel providers={[]} />);
  assert.match(out, /暂无模型服务商/);
  assert.match(out, /data-testid="empty-state"/);
});

test("ProvidersPanel: 错误态可见且含 role='alert'", () => {
  const out = html(<ProvidersPanel providers={[]} error="无法加载供应商配置" />);
  assert.match(out, /role="alert"/);
  assert.match(out, /获取服务商失败：无法加载供应商配置/);
});

test("ProvidersPanel: loading 时有 Spinner 反馈", () => {
  const out = html(<ProvidersPanel providers={[]} loading={true} />);
  assert.match(out, /role="status"/);
  assert.match(out, /加载服务商列表中\.\.\./);
});

// ============================================================================
// UsagePanel Tests
// ============================================================================

test("UsagePanel: 正常渲染 totals 三个数字与折线/明细系列", () => {
  const usage: UsageSummary = {
    range: "7d",
    totals: { sessions: 42, steps: 188, completed: 39 },
    series: [
      { date: "2026-09-27", sessions: 20, steps: 90 },
      { date: "2026-09-28", sessions: 22, steps: 98 },
    ],
    updatedAt: "2026-09-28T02:00:00Z",
  };

  const out = html(<UsagePanel usage={usage} />);

  assert.match(out, /用量统计 \(Usage\)/);
  assert.match(out, /统计周期: 7d/);

  // totals 三个数字存在
  assert.match(out, /总会话数/);
  assert.match(out, /42/);
  assert.match(out, /总步骤数/);
  assert.match(out, /188/);
  assert.match(out, /完成会话数/);
  assert.match(out, /39/);

  // 明细
  assert.match(out, /2026-09-27/);
  assert.match(out, /2026-09-28/);
  assert.match(out, /更新时间: 2026-09-28T02:00:00Z/);
});

test("UsagePanel: 空态展示 EmptyState", () => {
  const out = html(<UsagePanel usage={null} />);
  assert.match(out, /暂无用量数据/);
  assert.match(out, /data-testid="empty-state"/);
});

test("UsagePanel: displays reported tokens and costs without estimating missing prices", () => {
  const usage: UsageSummary = { range: "all", totals: { sessions: 1, steps: 1, completed: 1 }, series: [], updatedAt: "",
    tokens: { input: 1234, output: 56, reportedRequests: 1, unknownRequests: 2 }, costs: { USD: 0.00321 } };
  const out = html(<UsagePanel usage={usage} />);
  assert.match(out, /输入 Token/);
  assert.match(out, /1234/);
  assert.match(out, /输出 Token/);
  assert.match(out, /0\.00321 USD/);
  assert.match(out, /有 2 次请求未报告完整 Token 用量/);
  assert.match(out, /缺失费用不作估算/);
  const unknown = html(<UsagePanel usage={{ ...usage, tokens: undefined, costs: undefined }} />);
  assert.match(unknown, /服务商尚未报告 Token 用量/);
  assert.match(unknown, /服务商尚未报告费用/);
});

test("UsagePanel: 错误态可见且含 role='alert'", () => {
  const out = html(<UsagePanel usage={null} error="获取用量超额" />);
  assert.match(out, /role="alert"/);
  assert.match(out, /获取用量数据失败：获取用量超额/);
});

test("UsagePanel: loading 时有 Spinner 反馈", () => {
  const out = html(<UsagePanel usage={null} loading={true} />);
  assert.match(out, /role="status"/);
  assert.match(out, /加载用量数据中\.\.\./);
});

// ============================================================================
// MemoryPanel Tests
// ============================================================================

test("MemoryPanel: 正常渲染多个记忆轨道与文件状态", () => {
  const tracks: MemoryTrack[] = [
    { name: "memory", path: "/workspace/MEMORY.md", bytes: 1500, present: true },
    { name: "user", path: "/workspace/USER.md", bytes: 0, present: false },
    { name: "key", path: "/workspace/key.md", bytes: 420, present: true },
  ];

  const out = html(<MemoryPanel tracks={tracks} />);

  assert.match(out, /记忆轨道 \(Memory Tracks\)/);
  assert.match(out, /长期记忆 \(MEMORY\.md\)/);
  assert.match(out, /用户画像 \(USER\.md\)/);
  assert.match(out, /关键意图 \(Key Track\)/);

  assert.match(out, /存在 \(1\.5 KB\)/);
  assert.match(out, /未创建/);
  assert.match(out, /存在 \(420 B\)/);
});

test("MemoryPanel: 空态展示 EmptyState", () => {
  const out = html(<MemoryPanel tracks={[]} />);
  assert.match(out, /未发现记忆轨道/);
  assert.match(out, /data-testid="empty-state"/);
});

test("MemoryPanel: 错误态可见且含 role='alert'", () => {
  const out = html(<MemoryPanel tracks={[]} error="读取轨道失败" />);
  assert.match(out, /role="alert"/);
  assert.match(out, /获取记忆轨道失败：读取轨道失败/);
});

test("MemoryPanel: loading 时有 Spinner 反馈", () => {
  const out = html(<MemoryPanel tracks={[]} loading={true} />);
  assert.match(out, /role="status"/);
  assert.match(out, /加载记忆轨道中\.\.\./);
});

// ============================================================================
// SettingsSections Tests
// ============================================================================

const noCapabilities: AgentCapabilities = { allowMcp: false, allowSubagents: false, allowHooks: false };

test("SettingsSections renders supported capability switches in card rows", () => {
  const out = renderToStaticMarkup(<SettingsSections
    sections={[]} activeSection="agent"
    values={{}}
    capabilities={{ allowMcp: true, allowSubagents: false, allowHooks: true }}
    onToggleCapability={() => {}}
  />);
  assert.match(out, /data-testid="capability-allowMcp" data-enabled="true"/);
  assert.match(out, /data-testid="capability-allowSubagents" data-enabled="false"/);
  assert.match(out, /data-testid="capability-allowHooks" data-enabled="true"/);
  assert.match(out, /role="switch"/);
  assert.match(out, /xn-settings-group/);
});

test("SettingsSections send-shortcut description shows the platform key instead of the internal Mod token", () => {
  const out = renderToStaticMarkup(<SettingsSections
    sections={[]} activeSection="shortcuts"
    values={{}} capabilities={noCapabilities}
  />);
  assert.doesNotMatch(out, /Mod\+Enter/);
  assert.match(out, /选择 Enter 或 (?:⌘Enter|Ctrl\+Enter) 发送/);
});

test("SettingsSections has no unsupported generic JSON fallback or global save button", () => {
  const out = renderToStaticMarkup(<SettingsSections
    sections={[]} activeSection="not-a-real-section"
    values={{ example: { setting: true } }} capabilities={noCapabilities}
    onSave={() => {}} dirty saving
  />);
  assert.doesNotMatch(out, /example|保存配置/);
  assert.match(out, /settings-section-content-not-a-real-section/);
});

test("appearance uses accessible theme, font and code-preview controls", () => {
  const out = renderToStaticMarkup(<SettingsSections
    embedded sections={[]} activeSection="appearance"
    values={{ theme: "dark", fontSize: 18, tabSize: 4, wordWrap: false, terminalFontSize: 16 }}
    capabilities={noCapabilities} onUpdateSetting={() => {}}
  />);
  assert.match(out, /aria-label="界面主题"/);
  assert.match(out, /role="combobox"/);
  assert.match(out, /深色/);
  assert.match(out, /role="radiogroup" aria-label="外观"/);
  assert.match(out, /Claudex/);
  assert.match(out, /aria-label="界面字号"/);
  assert.match(out, /value="18"/);
  assert.match(out, /aria-label="代码字号"/);
  assert.doesNotMatch(out, /aria-label="缩进宽度"/);
  assert.match(out, /GitHub Light/);
  assert.match(out, /GitHub Dark/);
  assert.match(out, /data-testid="code-preview-light"/);
  assert.match(out, /data-testid="code-preview-dark"/);
  assert.doesNotMatch(out, /aria-label="自动换行"/);
  assert.doesNotMatch(out, /aria-label="自动换行"[^>]*checked=""/);
  assert.doesNotMatch(out, /aria-label="终端字号"/);
});

test("general settings group their rows into labelled cards", () => {
  const out = renderToStaticMarkup(<SettingsSections
    embedded sections={[]} activeSection="general"
    values={{}} capabilities={noCapabilities} onUpdateSetting={() => {}}
  />);
  assert.match(out, /<header class="xn-settings-card-group__header"><h2>对话行为<\/h2><p>控制消息到达时的显示方式。<\/p><\/header>/);
  assert.match(out, /<div class="xn-settings-group"><div class="xn-setting-row"><div class="xn-setting-row__copy"><h3>新消息自动滚动<\/h3>/);
  assert.ok((out.match(/class="xn-settings-group"/g) ?? []).length >= 5);
  assert.ok((out.match(/class="xn-setting-row"/g) ?? []).length >= 13);
});

test("general and browser settings only expose their live backend controls", () => {
  const general = renderToStaticMarkup(<SettingsSections embedded sections={[]} activeSection="general"
    values={{ language: "en", autoScroll: false, toolGroupingTerminalEnabled: true }}
    capabilities={noCapabilities} onUpdateSetting={() => {}} />);
  assert.match(general, /data-testid="settings-current-locale"[^>]*>English \(US\)/);
  assert.match(general, /aria-label="界面语言"/);
  assert.match(general, /选择应用 UI 的显示语言/);
  assert.match(general, /role="combobox"/);
  assert.match(general, /English/);
  assert.match(general, /aria-label="新消息自动滚动"/);
  assert.doesNotMatch(general, /aria-label="新消息自动滚动"[^>]*checked=""/);
  assert.match(general, /aria-label="显示推理内容"[^>]*checked=""/);
  assert.match(general, /aria-label="分组终端命令"[^>]*checked=""/);
  assert.doesNotMatch(general, /primitive-code|primitive-tabs/);

  const browser = renderToStaticMarkup(<SettingsSections embedded sections={[]} activeSection="browser"
    values={{ browserControlEnabled: true }} capabilities={noCapabilities} onUpdateSetting={() => {}} />);
  assert.match(browser, /aria-label="新任务启用浏览器"[^>]*checked=""/);
  assert.match(browser, /浏览器运行环境/);
});

test("general auto archive defaults off and only enables a supported retention period", () => {
  const off = renderToStaticMarkup(<SettingsSections embedded sections={[]} activeSection="general"
    values={{}} capabilities={noCapabilities} onUpdateSetting={() => {}} />);
  assert.match(off, /自动归档旧任务/);
  assert.match(off, /role="switch"[^>]*aria-label="启用自动归档"/);
  assert.doesNotMatch(off, /aria-label="启用自动归档"[^>]*checked=""/);
  assert.match(off, /role="combobox"[^>]*disabled=""[^>]*aria-label="归档保留时长"/);
  assert.match(off, /7 天/);

  const on = renderToStaticMarkup(<SettingsSections embedded sections={[]} activeSection="general"
    values={{ taskAutoArchiveEnabled: true, taskAutoArchiveOlderThanDays: 14 }}
    capabilities={noCapabilities} onUpdateSetting={() => {}} />);
  assert.match(on, /aria-label="启用自动归档"[^>]*checked=""/);
  assert.match(on, /role="combobox"[^>]*aria-label="归档保留时长"/);
  assert.match(on, /14 天/);
  assert.match(on, /未查看、置顶、正在运行或有待处理操作的任务会保留/);
});

test("shortcuts expose the registered action table and clearly separate send behavior", () => {
  const out = renderToStaticMarkup(<SettingsSections embedded sections={[]} activeSection="shortcuts"
    values={{ sendShortcut: "mod-enter", bindings: { "new-session": "Mod+N", "command-palette": "Mod+P" } }}
    capabilities={noCapabilities} onUpdateSetting={() => {}} />);
  assert.match(out, /data-testid="xn-shortcut-row-new-session"/);
  assert.match(out, /data-testid="xn-shortcut-row-open-settings"/);
  assert.match(out, /aria-label="重新录制：打开命令面板"/);
  // 设置里显示平台按键（⌘Enter / Ctrl+Enter），不泄露内部的 Mod 记号
  assert.match(out, /(?:⌘Enter|Ctrl\+Enter)/);
  assert.doesNotMatch(out, /Mod\+Enter/);
  assert.match(out, /aria-label="发送消息快捷键"/);
  assert.match(out, /Shift\+Enter/);
  assert.match(out, /Escape/);
});
