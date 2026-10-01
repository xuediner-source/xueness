# Xueness 第六批：剩余迁移 + 前端重构（冻结契约）

日期：2026-09-28。本批两件事：**把该迁移的控件迁到原生**，以及**重做前端视觉**。

## 0. 现状与根因

- 原生前端**没有任何样式表**：`webapp/src/` 下无 `.css`，101 处内联样式，Tailwind 已安装
  但从未 import。视觉因此粗糙——这是"做得太差"的直接原因。
- 后端接口齐全但前端未接：`/api/directory`、`/api/system`、`/api/settings/<section>`（5 个
  分区，原生只用了 `agent`）、`/api/providers`、`/api/usage`、`/api/memory/tracks`。
- `webapp/src/xuenessSnapshot.ts` 仍 `import type` 自 `@zcode/shared`。

## 1. 视觉设计系统（Lane A1 交付，Lane A2 消费）

### 文件
- `webapp/src/styles.css`（新建）— 设计令牌 + 基础排版 + 组件类
- `webapp/src/ui/primitives.tsx`（新建）— 共享展示组件

### 硬性视觉要求
- 支持**深色**（`index.html` 的 `html.dark`）与浅色；用 CSS 变量做令牌，
  禁止在组件里写死颜色值（`#xxx`）——一律走 `var(--...)`。
- 令牌至少覆盖：背景/面板/边框/前景/弱前景/主色/成功/警告/危险/圆角/阴影/间距/字号。
- 排版：正文字号 14px、行高 1.5；标题层级分明；等宽字体用于代码/路径。
- 交互态：按钮 hover/active/disabled/focus-visible 都要有可见反馈。
- 布局：整屏高度、侧栏固定宽、主区自适应、溢出滚动；窄屏（<900px）侧栏可折叠。
- **不使用 ZCode 的样式表**，不引新依赖（Tailwind 已在，可用，也可纯 CSS）。

### `ui/primitives.tsx` 导出（签名逐字冻结）

```tsx
import React from "react";

export function Button(props: {
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  disabled?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  title?: string;
  "aria-label"?: string;
}): JSX.Element;

export function Panel(props: {
  title?: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  /** 无内边距时设为 "flush"（子项自己管边距，如列表/表格） */
  padding?: "normal" | "flush";
}): JSX.Element;

export function Tabs(props: {
  tabs: { id: string; label: string }[];
  active: string;
  onSelect?: (id: string) => void;
}): JSX.Element;

export function Badge(props: {
  children: React.ReactNode;
  tone?: "neutral" | "ok" | "warn" | "error" | "info";
}): JSX.Element;

export function Field(props: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element;

export function EmptyState(props: { title: string; hint?: string }): JSX.Element;

export function CodeBlock(props: {
  text: string;
  tone?: "neutral" | "add" | "remove";
}): JSX.Element;

export function Spinner(props?: { label?: string }): JSX.Element;

/** 通用容器：整屏布局骨架 */
export function AppShell(props: {
  header: React.ReactNode;
  sidebar?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element;

/** 键值摘要行（状态栏用） */
export function Stat(props: { label: string; value: React.ReactNode }): JSX.Element;
```

**要求**：全部为纯渲染（无 IO、无副作用），可 `renderToStaticMarkup`。每个组件带
`data-testid`，便于断言。

### Lane A1 还要重做这两个现有视图的视觉
- `webapp/src/XuenessWorkbenchView.tsx`（TaskList/Timeline/Approvals/Composer/WorkbenchHeader）
- `webapp/src/XuenessWorkbenchView2.tsx`（FileBrowser/DiffView/SettingsPanel）

**不得改动其导出签名与既有 `data-testid`/`aria-*`**——现有 20 个 SSR 断言必须继续通过。
只换视觉（内联样式 → 类名 + primitives）。

## 2. 新面板（Lane A2 交付）

### 文件
`webapp/src/XuenessPanels.tsx`（新建）+ `webapp/src/XuenessPanels.test.tsx`（新建）

### 导出（签名逐字冻结）

```tsx
import type { Result, XuenessDirectoryListing, ProviderSummary, UsageSummary, MemoryTrack, SettingsMap } from "./xuenessWorkspace";   // 见 §3
import type { AgentCapabilities } from "./xuenessSettings";

export type DirectoryBrowserProps = {
  /** 当前目录绝对路径，未选为 null */
  currentPath: string | null;
  entries: { name: string; path: string; isDir: boolean; size: number }[];
  error?: string;
  truncated?: boolean;
  loading?: boolean;
  onNavigate?: (path: string) => void;     // 进入子目录 / 上级
  onOpenFile?: (path: string) => void;     // 选中文件
  onCreateDir?: (name: string) => void;    // 新建文件夹
};
export function DirectoryBrowser(props: DirectoryBrowserProps): JSX.Element;

export type ProvidersPanelProps = {
  providers: ProviderSummary[];
  error?: string;
  loading?: boolean;
};
export function ProvidersPanel(props: ProvidersPanelProps): JSX.Element;

export type UsagePanelProps = {
  usage: UsageSummary | null;
  error?: string;
  loading?: boolean;
};
export function UsagePanel(props: UsagePanelProps): JSX.Element;

export type MemoryPanelProps = {
  tracks: MemoryTrack[];
  error?: string;
  loading?: boolean;
};
export function MemoryPanel(props: MemoryPanelProps): JSX.Element;

export type SettingsSectionsProps = {
  sections: { id: string; label: string }[];
  activeSection: string;
  onSelectSection?: (id: string) => void;
  values: SettingsMap;
  capabilities: AgentCapabilities;
  onToggleCapability?: (key: keyof AgentCapabilities, value: boolean) => void;
  onSave?: () => void | Promise<unknown>;
  saveError?: string;
  dirty?: boolean;
};
export function SettingsSections(props: SettingsSectionsProps): JSX.Element;
```

全部通过 `./ui/primitives` 构建，**不得自己 fetch**，不得放占位控件。
空态用 `EmptyState`，错误用可见的 `role="alert"`。

## 3. 数据层（Lane B 交付，GLM）

### 文件
`webapp/src/xuenessWorkspace.ts`（新建）+ `webapp/src/xuenessWorkspace.test.ts`（新建）

**复用** `./xuenessApi` 的导出（已存在真实实现），**不得自己拼 URL**。

```ts
import type { Result } from "./xuenessWorkbench";

export type DirectoryEntry = { name: string; path: string; isDir: boolean; size: number };
export type XuenessDirectoryListing = {
  path: string; entries: DirectoryEntry[]; truncated: boolean;
};
export type ProviderSummary = { id: string; name: string; baseUrl: string; model: string; hasKey: boolean };
export type UsageSummary = {
  range: string;
  totals: { sessions: number; steps: number; completed: number };
  series: { date: string; sessions: number; steps: number }[];
  updatedAt: string;
};
export type MemoryTrack = {
  name: "memory" | "user" | "key"; path: string; bytes: number; present: boolean;
};
export type SettingsMap = Record<string, unknown>;

export function userScopeReason(value: unknown): string;   // 纯函数：从 capability 里取原因，缺省 ""
export async function loadHome(): Promise<Result<string>>;
export async function loadDirectory(path: string, includeHidden?: boolean): Promise<Result<XuenessDirectoryListing>>;
export async function createFolder(path: string, name: string): Promise<Result<string>>;
export async function loadProviders(): Promise<Result<ProviderSummary[]>>;
export async function loadUsage(range?: string): Promise<Result<UsageSummary>>;
export async function loadMemoryTracks(): Promise<Result<MemoryTrack[]>>;
export async function loadAllSettings(defaults: SettingsMap): Promise<Result<SettingsMap>>;
```

失败一律 `{ok:false, error}` 不抛；错误文本用 `error instanceof Error ? error.message : String(error)`。
`loadAllSettings` 用 `xuenessApi.getSettings()`（会抛），**按 5 个分区合并**到 defaults 之上。

## 4. 集成（父代理自己负责）

`webapp/src/XuenessWorkbenchContainer.tsx`、`webapp/src/main.tsx`、`webapp/index.html` 由父代理改。
Lane 不得触碰这三个文件。

## 5. 验收

- Lane A1：`renderToStaticMarkup` 能渲染全部 primitives；既有 20 项视图断言仍全过；
  `npm run build` 成功；**贴默认页与各面板的 Playwright 截图**（深浅色各一张）。
- Lane A2：新增 SSR 断言覆盖四个面板与设置分区（含空态、错误态）；`tsc` 新文件零错误；
  截图至少一张。
- Lane B：单测覆盖成功/失败路径（fetch 打桩）；`tsc` 新文件零错误。
- 全体零回归：既有 Python 674、前端 85、两个 golden 校验器。
- 不改后端；不部署；不引新依赖。
