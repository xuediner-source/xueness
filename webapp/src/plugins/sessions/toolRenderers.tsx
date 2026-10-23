import React from "react";
import type { TimelineRow, ToolDisplayStatus } from "../../xuenessWorkbench";
import { t as tr } from "../../i18n";
import { TOOL_DISPLAY_STATUS_LABELS } from "./toolDisplayStatus";
import { internalToolName } from "../../xuenessToolNames";

/** Stable renderer identities owned by the sessions feature.  The registry is
 * deliberately data-first: plugin state can select a renderer, but it cannot
 * inject executable code into the conversation. */
export type ToolRendererId = "read" | "edit" | "exec" | "files" | "browser" | "workflow" | "task" | "fallback";
export type ToolRow = Extract<TimelineRow, { kind: "tool" }>;

export type ToolRenderer = Readonly<{
  id: ToolRendererId;
  requiredPlugins: readonly string[];
  matches: (name: string) => boolean;
  /** Short label used when a dependency is unavailable. */
  safeLabel: string;
}>;

const exact = (names: readonly string[]) => (name: string) => names.includes(name);
const required = (...ids: string[]): readonly string[] => Object.freeze(ids);

const READ_RENDERER: ToolRenderer = Object.freeze({
  id: "read",
  requiredPlugins: required("sessions", "files"),
  matches: exact(["read", "read_file", "read_text"]),
  safeLabel: "文件读取详情不可用",
});

const EDIT_RENDERER: ToolRenderer = Object.freeze({
  id: "edit",
  requiredPlugins: required("sessions", "files"),
  // Keep write/edit identities together so an edit result can show its diff,
  // while avoiding broad substring matching (e.g. TodoWrite is unrelated).
  matches: exact(["edit", "write", "write_file", "replace_file_content", "file_edit_apply"]),
  safeLabel: "文件改动详情不可用",
});

const EXEC_RENDERER: ToolRenderer = Object.freeze({
  id: "exec",
  // `exec` is the approved command tool owned by the shell plugin. The
  // terminal plugin provides interactive PTY sessions and is independent of
  // this renderer.
  requiredPlugins: required("sessions", "shell"),
  matches: exact(["exec", "shell", "bash", "sh", "powershell", "exec_start", "exec_poll"]),
  safeLabel: "终端输出详情不可用",
});

/** Native identities are enumerated from bundled manifests, never prefix-matched. */
export const NATIVE_TOOL_IDENTITIES = Object.freeze({
  files: Object.freeze(['list', 'glob', 'grep']),
  browser: Object.freeze(['browser_navigate', 'browser_inspect', 'browser_snapshot', 'browser_click', 'browser_fill', 'browser_screenshot']),
  workflow: Object.freeze(['workflow_create', 'workflow_amend', 'workflow_run', 'workflow_status', 'save_workflow', 'list_saved_workflows', 'run_saved_workflow', 'background_exec', 'background_status', 'background_cancel', 'background_logs', 'workflow_answer_actor']),
  task: Object.freeze(['task', 'task_collect', 'task_resume', 'task_send_message']),
});
const FILES_RENDERER: ToolRenderer = Object.freeze({ id: 'files', requiredPlugins: required('sessions', 'files'), matches: exact(NATIVE_TOOL_IDENTITIES.files), safeLabel: '文件搜索详情不可用' });
const BROWSER_RENDERER: ToolRenderer = Object.freeze({ id: 'browser', requiredPlugins: required('sessions', 'browser', 'files'), matches: exact(NATIVE_TOOL_IDENTITIES.browser), safeLabel: '浏览器详情不可用' });
const WORKFLOW_RENDERER: ToolRenderer = Object.freeze({ id: 'workflow', requiredPlugins: required('sessions', 'workflows', 'files', 'shell'), matches: exact(NATIVE_TOOL_IDENTITIES.workflow), safeLabel: '工作流详情不可用' });
const TASK_RENDERER: ToolRenderer = Object.freeze({ id: 'task', requiredPlugins: required('sessions', 'subagents', 'files'), matches: exact(NATIVE_TOOL_IDENTITIES.task), safeLabel: '子任务详情不可用' });

const FALLBACK_RENDERER: ToolRenderer = Object.freeze({
  id: "fallback",
  requiredPlugins: required(),
  matches: () => true,
  safeLabel: "工具详情不可用",
});

/** Public, immutable registry.  Renderer order is part of the contract:
 * specific identities are resolved before the safe fallback. */
export const TOOL_RENDERER_REGISTRY: Readonly<Record<ToolRendererId, ToolRenderer>> = Object.freeze({
  read: READ_RENDERER,
  edit: EDIT_RENDERER,
  exec: EXEC_RENDERER,
  files: FILES_RENDERER,
  browser: BROWSER_RENDERER,
  workflow: WORKFLOW_RENDERER,
  task: TASK_RENDERER,
  fallback: FALLBACK_RENDERER,
});
/** Naming aliases keep the registry usable by sessions subviews that follow
 * the ToolCallBlock terminology used by the reference implementation. */
export const toolRendererRegistry = TOOL_RENDERER_REGISTRY;

export const TOOL_RENDERER_ORDER: readonly ToolRenderer[] = Object.freeze([
  READ_RENDERER,
  EDIT_RENDERER,
  EXEC_RENDERER,
  FILES_RENDERER, BROWSER_RENDERER, WORKFLOW_RENDERER, TASK_RENDERER,
  FALLBACK_RENDERER,
]);

function dependenciesEffective(renderer: ToolRenderer, effectivePluginIds?: ReadonlySet<string>): boolean {
  // Omitted state is used by isolated/static rendering and keeps the pure
  // component backwards compatible. Production passes the catalog's
  // effective IDs, which fails closed when the catalog is unavailable.
  return effectivePluginIds === undefined || renderer.requiredPlugins.every(id => effectivePluginIds.has(id));
}

/** Resolve by stable tool identity and then enforce dependency effectiveness. */
export function resolveToolRenderer(name: string, effectivePluginIds?: ReadonlySet<string>): ToolRenderer {
  const internal = internalToolName(name); // a ZCode name (Bash, Read…) picks the Xueness tool's renderer
  const candidate = TOOL_RENDERER_ORDER.find(renderer => renderer.id !== "fallback" && renderer.matches(internal)) ?? FALLBACK_RENDERER;
  return dependenciesEffective(candidate, effectivePluginIds) ? candidate : FALLBACK_RENDERER;
}
export const resolveToolCallRenderer = resolveToolRenderer;

export type ToolStatusShellProps = {
  status: ToolDisplayStatus;
  pendingApproval?: boolean;
  children?: React.ReactNode;
};

/** Shared status shell for all tool identities.  It intentionally carries no
 * spinner or timer: running/failed/approval semantics come from the row and
 * remain stable while the same toolCallId is updated in place. */
export function ToolStatusShell({ status, pendingApproval = false, children }: ToolStatusShellProps): React.JSX.Element {
  const label = pendingApproval
    ? tr("等待批准")
    : status === "ok" ? "" : tr(TOOL_DISPLAY_STATUS_LABELS[status]);
  // Successful calls stay quiet even if a caller supplied a generic child;
  // only active, failed, stopped, or approval states get a shell.
  if (!label) return <></>;
  return <span className="xn-zc-tool-state" data-tool-status-shell="true" data-status={pendingApproval ? "pendingApproval" : status} data-failed={(!pendingApproval && status === "error") || undefined}>
    {children ?? label}
  </span>;
}

