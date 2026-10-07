/**
 * 会话工作时长格式化（纯函数）。
 *
 * 移植自 zcode `packages/ui/src/v4/conversationWorkDuration.ts` 的
 * `formatConversationWorkDuration`，品牌清理：
 * - ZCode 的 `Locale` 类型 → 本地 `"zh" | "en"`；
 * - `useZCodeIntl`/`intl.formatMessage` → 内嵌单位表（与 zcode 的
 *   zh-CN `天/时/分/秒`、en-US `d/h/m/s` 文案一致，中文单位前加空格）。
 *
 * 纯函数：同样的输入永远得到同样的输出，不读全局状态，便于单测。
 */

export type ConversationWorkLocale = "zh" | "en";
export type ConversationWorkDurationUnit = "day" | "hour" | "minute" | "second";

const DURATION_UNIT_LABELS: Record<ConversationWorkLocale, Record<ConversationWorkDurationUnit, string>> = {
  zh: { day: "天", hour: "时", minute: "分", second: "秒" },
  en: { day: "d", hour: "h", minute: "m", second: "s" },
};

function formatDurationUnit(value: number, unit: ConversationWorkDurationUnit, locale: ConversationWorkLocale): string {
  const label = DURATION_UNIT_LABELS[locale][unit];
  // 中文时长单位需要空格；英文单位本身已带缩写，不额外插入空格。
  return `${value}${locale === "zh" ? " " : ""}${label}`;
}

/**
 * 把毫秒时长格式化为「3 分 25 秒」/「3m 25s」。
 * - `undefined`/非数字/负数 → `null`（调用方据此隐藏计时 pill，不编造数据）；
 * - 不足 1 秒按 1 秒计；最多保留两个最大的非零单位。
 */
export function formatConversationWorkDuration(
  durationMs: number | undefined,
  locale: ConversationWorkLocale = "zh",
): string | null {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return null;

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (days > 0) parts.push(formatDurationUnit(days, "day", locale));
  if (hours > 0) parts.push(formatDurationUnit(hours, "hour", locale));
  if (minutes > 0) parts.push(formatDurationUnit(minutes, "minute", locale));
  if (seconds > 0 || parts.length === 0) {
    parts.push(formatDurationUnit(seconds, "second", locale));
  }

  return parts.slice(0, 2).join(" ");
}
