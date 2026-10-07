import { getLocale, messages, tf } from "../../i18n";

// i18n 以中文原文为 key（见 webapp/src/i18n.ts）；在此注册英文文案，
// 与 i18n.ts 内部 Object.assign(messages, …) 的扩展方式一致。
messages["昨天 {0}"] = "Yesterday {0}";

// 移植自 zcode-reference/packages/ui/src/v4/messageTimeLabel.ts。
// 品牌清理：@/i18n/IntlProvider.js → 相对路径 ../../i18n；
// useZCodeIntl/intl.formatMessage → xueness 的 t/tf；
// 文案键 chat.message.time.yesterday → 新建 i18n key「昨天 {0}」。
//
// 注意：当前 TimelineRow（xuenessWorkbench.ts）没有任何时间戳字段
// （user/assistant/tool/completion/pending_question 均无 createdAt），
// 本函数先写好待接线——调用方补上 createdAt 数据链路后传入 timestamp 即可，
// 这里不编造时间。

type DateTimeFormatterKind = "time" | "monthDayTime" | "yearMonthDayTime";

const MESSAGE_TIME_LABEL_CACHE_LIMIT = 4_000;
const messageTimeLabelCache = new Map<string, string>();
const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();

function isSameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function getDayCacheKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function getDateTimeFormatter(locale: string, kind: DateTimeFormatterKind): Intl.DateTimeFormat {
  const cacheKey = `${locale}:${kind}`;
  const cached = dateTimeFormatterCache.get(cacheKey);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat(
    locale,
    kind === "time"
      ? { hour: "2-digit", minute: "2-digit" }
      : kind === "monthDayTime"
        ? { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }
        : {
            year: "numeric",
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          },
  );
  dateTimeFormatterCache.set(cacheKey, formatter);
  return formatter;
}

function cacheMessageTimeLabel(cacheKey: string, label: string): string {
  if (messageTimeLabelCache.size >= MESSAGE_TIME_LABEL_CACHE_LIMIT) {
    messageTimeLabelCache.clear();
  }
  messageTimeLabelCache.set(cacheKey, label);
  return label;
}

/** 消息时间标签：今天 HH:mm / 昨天「昨天 HH:mm」/ 同年 M/D HH:mm / 跨年完整日期。
 * 语言取 i18n 全局 locale（与 tf 一致，保证「昨天」标签和日期格式同语言）。
 * timestamp 非法时返回 null，由调用方决定是否隐藏时间标签。 */
export function formatMessageTimeLabel(
  timestamp: number,
  nowTimestamp = Date.now(),
): string | null {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const locale = getLocale();

  const messageDate = new Date(timestamp);
  const now = new Date(nowTimestamp);
  if (Number.isNaN(messageDate.getTime()) || Number.isNaN(now.getTime())) return null;

  const cacheKey = `${locale}:${timestamp}:${getDayCacheKey(now)}`;
  const cached = messageTimeLabelCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const timeText = getDateTimeFormatter(locale, "time").format(messageDate);
  if (isSameDay(messageDate, now)) {
    return cacheMessageTimeLabel(cacheKey, timeText);
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(messageDate, yesterday)) {
    return cacheMessageTimeLabel(cacheKey, tf("昨天 {0}", [timeText]));
  }

  if (messageDate.getFullYear() === now.getFullYear()) {
    return cacheMessageTimeLabel(
      cacheKey,
      getDateTimeFormatter(locale, "monthDayTime").format(messageDate),
    );
  }

  return cacheMessageTimeLabel(
    cacheKey,
    getDateTimeFormatter(locale, "yearMonthDayTime").format(messageDate),
  );
}
