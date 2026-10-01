# Xueness 工作台切片 2（第三批剩余）冻结契约

日期：2026-09-28。本文件冻结第三批剩余两项：**文件/差异浏览**与**设置页**。
两条实现线并行，本契约是唯一真源。

## 0. 重要事实约束（不得违反）

1. **后端没有 diff 接口**。`grep -ni diff xueness/web.py` 为空。因此差异**只能**由客户端从
   journal 派生：`GET /api/sessions/{id}/journal` 返回完整 session，其中 assistant 消息的
   tool_calls 带 `edit` 的 `{path, old, new}`（以及 `write` 的 `{path, content}`）。
   - 派生结果是**调用意图的文本差异**，不是 git 意义上的工作树 diff（不读磁盘当前内容）。
   - UI 必须如实标注这是「本次会话记录的改动」，**不得**声称是当前文件系统差异。
2. **文件预览是只读的**：`GET /api/sessions/{id}/file?path=…`，≤1MB、UTF-8、无 NUL。
   二进制/超限/越界会 400。UI 要如实显示这些错误。
3. **设置分区**：`general | appearance | shortcuts | browser | agent`。
   - `POST /api/settings/<section>` 是**整节替换**语义，所以 patch 必须先在服务端已存值上合并
     （`xuenessServices.persistSettingsPatch` 已处理，必须复用它，不要自己写裸 POST）。
   - `agent` 分区三个开关会 spawn 子进程/嵌套模型：**读取必须 fail-closed**，只有字面 `true`
     才算开启。

## 1. 数据层：`webapp/src/xuenessSettings.ts`（签名已冻结，填充 stub）

见文件内的类型与函数声明。要点：

- `loadWorkbenchSettings(defaults)` → 复用 `xuenessServices.loadSettings`，包成 `Result`。
- `saveWorkbenchSettings(defaults, patch)` → 复用 `persistSettingsPatch`，包成 `Result`。
- `readAgentCapabilities(values)`：**fail-closed**，只有 `=== true` 才 true。
- `capabilityPatch(caps)` → `{allowMcp, allowSubagents, allowHooks}`。

数据层**不得**直接 fetch，必须复用 `xuenessServices` 的导出。

## 2. 数据层扩展：`webapp/src/xuenessWorkbench.ts` 新增（本切片新增）

在现有文件末尾追加（**不改动已有导出**）：

```ts
export type FileChange = {
  path: string;
  kind: "write" | "edit";
  ok: boolean;
  /** edit 的 old/new；write 时为 undefined */
  old?: string;
  new?: string;
  /** write 的新内容（截断），edit 时为 undefined */
  content?: string;
};

export type FileChangeSet = {
  changes: FileChange[];
  /** 派生自会话 journal，非磁盘 diff —— UI 必须如实标注 */
  source: "session-journal";
};

export async function loadJournal(id: string): Promise<Result<unknown>>;
export function deriveFileChanges(journal: unknown): FileChangeSet;
```

`deriveFileChanges` 纯函数规则：
- 遍历 `journal.messages` 里的 assistant `tool_calls`，取 `write` / `edit`。
- 用该 `tool_call_id` 在 `journal.results[id].ok` 判定 `ok`（缺失即 false）。
- `write` → `{kind:"write", path, ok, content}`（`content` 截断到 4000 字符）。
- `edit` → `{kind:"edit", path, ok, old, new}`（各截断到 4000）。
- 顺序 = journal 中出现顺序。参数不是合法 JSON 或形状不对 → 跳过该条，不抛。

## 3. 视图层：`webapp/src/XuenessWorkbenchView2.tsx`（新建）

只依赖传入 props，纯渲染，可 `renderToStaticMarkup`。

```ts
export type FileBrowserProps = {
  files: { path: string; size: number }[];
  truncated: boolean;
  selectedPath?: string | null;
  preview?: { path: string; text: string; truncated: boolean } | null;
  previewError?: string;
  onSelect?: (path: string) => void;
};

export type DiffViewProps = {
  changeSet: FileChangeSet | null;
  error?: string;
};

export type SettingsPanelProps = {
  values: SettingsMap;
  capabilities: AgentCapabilities;
  onToggleCapability?: (key: keyof AgentCapabilities, value: boolean) => void;
  onSave?: () => void | Promise<unknown>;
  saveError?: string;
  dirty?: boolean;
};

export function FileBrowser(props: FileBrowserProps): JSX.Element;
export function DiffView(props: DiffViewProps): JSX.Element;
export function SettingsPanel(props: SettingsPanelProps): JSX.Element;
```

UI 约束：
- `FileBrowser`：文件列表，选中项高亮（`aria-current="true"`）；`truncated` 时显示截断提示；
  `previewError` 时显示错误而不是空白；空列表显示「暂无文件」。
- `DiffView`：**必须**显示来源标注「来自会话记录，不是当前磁盘差异」（或等价文案）；
  edit 显示 old/new 两个代码块；write 显示内容；`changeSet` 为 null 显示「暂无改动」；
  `error` 时显示错误。**不得**把它渲染成「当前文件差异」。
- `SettingsPanel`：三个能力开关是 checkbox，`onToggleCapability` 回传 `keyof AgentCapabilities`；
  开启态要有明确视觉区分；`saveError` 显示；`dirty` 时保存按钮可用。**不得**放无回调的假开关。

## 4. 验收

- 数据层：`readAgentCapabilities` fail-closed 全覆盖（缺键、非布尔、字符串 "true" 都必须是 false）；
  `deriveFileChanges` 的 write/edit/ok/非 JSON/缺结果全覆盖。
- 视图层：三组件 SSR 断言关键文本；DiffView **必须**断言来源标注存在；
  SettingsPanel 断言三个 checkbox 及其状态。
- 集成（父代理）：真实服务 + Playwright，文件树→预览、diff 来源标注、设置开关保存往返。
- 不改后端；不部署；不因单项通过宣称全量 parity。
