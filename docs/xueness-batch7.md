# Xueness 第七批：应用级外壳与时间线视觉（冻结契约）

日期：2026-09-28。依据 `docs/xueness-ui-comparison.md`（实测对比：原生 1 个 JS/270KB
vs ZCode 13 个/13.3MB）。目标：**保留原生轻架构，补齐布局成熟度**——不是把原生做成 ZCode 的样子。

## 0. 现状（对比报告结论）

原生 = 顶栏 + 标签行 + 内容区；ZCode = 常驻侧栏 + 聊天主区。差距在于：
任务列表切走就看不见、时间线是行式列表读长对话弱、模型回复没有 Markdown 排版、
浮动控件（RunControls / 切换提示）仍是旧内联样式、无快捷键、窄屏未折叠。

## 1. Lane S（新建 `webapp/src/XuenessShell.tsx`）——gemini

### 导出（签名逐字冻结）

```tsx
import React from "react";

export type ShellProps = {
  /** 侧栏：任务列表与导航 */
  sidebar: React.ReactNode;
  /** 顶栏右侧内容（如新建任务输入） */
  topbarExtra?: React.ReactNode;
  /** 顶栏标题 */
  title?: string;
  /** 顶栏副标题 */
  subtitle?: string;
  /** 底部状态栏 */
  status?: React.ReactNode;
  children: React.ReactNode;
};
export function Shell(props: ShellProps): JSX.Element;

export type SidebarNavProps = {
  items: { id: string; label: string; active: boolean }[];
  onSelect?: (id: string) => void;
  /** 侧栏宽度（px），默认 260 */
  width?: number;
};
export function SidebarNav(props: SidebarNavProps): JSX.Element;

export type TimelineCardProps = {
  /** "user" | "assistant" | "tool" */
  role: string;
  title?: string;
  status?: "ok" | "error" | "pending" | string;
  /** 正文（纯文本；等宽显示当 mono 为真） */
  body: string;
  mono?: boolean;
  meta?: string;
};
export function TimelineCard(props: TimelineCardProps): JSX.Element;

/** 极简 Markdown：只支持 ``` 代码块、`行内`、- 列表、**粗体**。不得引依赖。 */
export function SimpleMarkdown(props: { text: string }): JSX.Element;
```

### 要求
- 全部走 `./ui/primitives` 与设计令牌（`var(--...)`），**禁止写死颜色**。
- `Shell` 用 grid：侧栏固定宽 + 主区自适应 + 状态栏置底；整屏高度。
- 窄屏（`max-width: 900px`）：侧栏默认折叠，提供可点击的展开/收起按钮。
- `SidebarNav` 项有 active 态、`aria-current`。
- `TimelineCard` 的 status 用 `Badge` 的 tone 映射（ok→ok、error→error、pending→warn，其余 neutral）。
- `SimpleMarkdown`：**不得引任何依赖**，手写解析上述四种语法即可；解析结果仍要
  安全（文本转义，不能把 `text` 当 HTML 注入）。
- `renderToStaticMarkup` 可渲染。

### 写入范围
1. `webapp/src/XuenessShell.tsx`（新建）
2. `webapp/src/XuenessShell.test.tsx`（新建）
3. `webapp/src/styles.css`（**只准追加** `xn-shell*` / `xn-card*` / `xn-md*` 相关规则；
   不得修改既有选择器）

禁止改动：`XuenessWorkbenchContainer.tsx`、`App.tsx`、`main.tsx`、`ui/primitives.tsx`、
`XuenessWorkbenchView*.tsx`、`XuenessPanels.tsx`、任何 `.py`。

### 测试
SSR 断言：Shell 三区都渲染、SidebarNav active/`aria-current`/回调、TimelineCard 三种 role 与
status→tone 映射、SimpleMarkdown 四种语法各断言（含**恶意 HTML 必须被转义**）、空输入不抛。

## 2. Lane T（新建 `webapp/src/XuenessTimeline.tsx`）——gemini

把时间线条目升级为卡片流，并做轻量 Markdown。**不改 `XuenessWorkbenchView.tsx`**
（那个文件既有 20 项断言，父代理负责接线）。

### 导出（签名逐字冻结）

```tsx
import type { TimelineRow } from "./xuenessWorkbench";

export type TimelineStreamProps = {
  rows: TimelineRow[];
  /** 渲染空态时的文案 */
  emptyText?: string;
};
export function TimelineStream(props: TimelineStreamProps): JSX.Element;
```

### 要求
- 依据 `TimelineRow` 的**真实字段**渲染（先读 `webapp/src/xuenessWorkbench.ts` 的
  `TimelineRow` 类型与 `toTimelineRows`，字段名以此为准）。
- assistant 正文用 `SimpleMarkdown`；tool 结果等宽；user 轮次与其它视觉区分。
- 空行显示 `emptyText ?? "暂无事件"`。
- 走 `./ui/primitives` + `./XuenessShell` 的 `TimelineCard`。

### 写入范围
1. `webapp/src/XuenessTimeline.tsx`（新建）
2. `webapp/src/XuenessTimeline.test.tsx`（新建）

### 测试
用真实形状的 `TimelineRow[]` 断言：三种角色都渲染、tool 的错误码可见、空态文案、
Markdown 代码块出现在 assistant 行。

## 3. 集成（父代理，不属本批 Lane）

父代理改 `XuenessWorkbenchContainer.tsx` / `App.tsx` / `RunControls.tsx`：
把 `Shell` 接成应用外壳、时间线换成 `TimelineStream`、浮动控件接入设计系统、
加 ⌘N / ⌘K。**Lane 不得触碰这些文件。**

## 4. 验收
- 两个 Lane 各自：新测试全过、既有 9 个前端套件零回归、`tsc` 新文件零错误、
  `npm run build` 成功、**Playwright 截图**（深浅色 + 窄屏各至少一张）。
- 父代理：集成后跑全量（Python 687 + 前端全部）、真实浏览器九面板 0 错误、部署、截图对比。
- 不引新依赖；不改后端；不部署。
