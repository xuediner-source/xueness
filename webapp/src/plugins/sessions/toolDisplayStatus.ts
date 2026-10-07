/**
 * 工具调用展示状态的集中映射（纯函数模块）。
 *
 * 移植自 zcode `packages/shared/src/tool-call-summary.ts`：
 * - `CompactToolCallState` → xueness 的 `ToolDisplayStatus`
 *  （`"queued" | "running" | "ok" | "error" | "cancelled" | "stopped"`，
 *   定义见 `xuenessWorkbench.ts`）；
 * - `TOOL_CALL_STATUS_MESSAGE_IDS` → `TOOL_DISPLAY_STATUS_LABELS`
 *  （状态→中文文案的集中映射表，调用方用 `tr()` 做语言切换，替代三元链）；
 * - `getCompactToolCallStatusMessageId` 的 `stopped` 特判 → `toolDisplayStatusOf`
 *   的显式映射表（行状态与展示状态同构，`"stopped"` 直接映射，不再用 errorCode 推导）。
 *
 * 纯函数：同样的输入永远得到同样的输出，便于单测。
 */

import type { ToolDisplayStatus } from "../../xuenessWorkbench";

/** 工具行原始状态：与 `TimelineRow` 的 tool `status` 同构。 */
export type ToolRowStatus = ToolDisplayStatus;

/** 行状态 → 展示状态的显式映射（替代 errorCode 推导 hack）。 */
export const TOOL_ROW_STATUS_TO_DISPLAY: Record<ToolRowStatus, ToolDisplayStatus> = {
  queued: "queued",
  running: "running",
  ok: "ok",
  error: "error",
  cancelled: "cancelled",
  stopped: "stopped",
};

/**
 * 状态 → 中文文案的集中映射表（对应 zcode 的 `chat.toolCall.status.*` 文案 id）。
 * 值是中文源文案，渲染时用 `tr()` 查英文：
 * - "排队中" → "Queued"、"运行中" → "Running"、"已完成" → "Completed"、
 * - "失败" → "Failed"、"已取消" → "Cancelled"、"已停止" → "Stopped"。
 */
export const TOOL_DISPLAY_STATUS_LABELS: Record<ToolDisplayStatus, string> = {
  queued: "排队中",
  running: "运行中",
  ok: "已完成",
  error: "失败",
  cancelled: "已取消",
  stopped: "已停止",
};

/** 展示状态 → 色调（替代原来的三元链）。 */
export const TOOL_DISPLAY_STATUS_TONES: Record<ToolDisplayStatus, "warn" | "ok" | "error" | "neutral"> = {
  queued: "warn",
  running: "warn",
  ok: "ok",
  error: "error",
  cancelled: "neutral",
  stopped: "neutral",
};

/** 行状态 → 展示状态：显式查表，无推导、无默认值分支。 */
export function toolDisplayStatusOf(status: ToolRowStatus): ToolDisplayStatus {
  return TOOL_ROW_STATUS_TO_DISPLAY[status];
}
