import test from "node:test";
import assert from "node:assert/strict";

import { getLocale, setLocale } from "../../i18n";
import { formatMessageTimeLabel } from "./messageTimeLabel";

function fmt(kind: "time" | "monthDayTime" | "yearMonthDayTime", date: Date): string {
  const locale = getLocale();
  return new Intl.DateTimeFormat(
    locale,
    kind === "time"
      ? { hour: "2-digit", minute: "2-digit" }
      : kind === "monthDayTime"
        ? { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }
        : { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" },
  ).format(date);
}

function withLocale(locale: "zh" | "en", run: () => void): void {
  const previous = getLocale();
  setLocale(locale);
  try {
    run();
  } finally {
    setLocale(previous);
  }
}

test("同一天只显示 HH:mm", () => {
  withLocale("zh", () => {
    const now = new Date(2026, 9, 7, 15, 30, 0).getTime();
    const message = new Date(2026, 9, 7, 10, 5, 0);
    assert.equal(formatMessageTimeLabel(message.getTime(), now), fmt("time", message));
  });
});

test("昨天显示「昨天 HH:mm」", () => {
  withLocale("zh", () => {
    const now = new Date(2026, 9, 7, 15, 30, 0).getTime();
    const message = new Date(2026, 9, 6, 22, 41, 0);
    assert.equal(formatMessageTimeLabel(message.getTime(), now), `昨天 ${fmt("time", message)}`);
  });
});

test("昨天标签跟随英文 locale", () => {
  withLocale("en", () => {
    const now = new Date(2026, 9, 7, 15, 30, 0).getTime();
    const message = new Date(2026, 9, 6, 22, 41, 0);
    assert.equal(formatMessageTimeLabel(message.getTime(), now), `Yesterday ${fmt("time", message)}`);
  });
});

test("同年非昨天显示 M/D HH:mm", () => {
  withLocale("zh", () => {
    const now = new Date(2026, 9, 7, 15, 30, 0).getTime();
    const message = new Date(2026, 4, 3, 9, 8, 0);
    assert.equal(formatMessageTimeLabel(message.getTime(), now), fmt("monthDayTime", message));
  });
});

test("跨年显示完整日期", () => {
  withLocale("zh", () => {
    const now = new Date(2026, 9, 7, 15, 30, 0).getTime();
    const message = new Date(2024, 11, 25, 9, 8, 0);
    assert.equal(formatMessageTimeLabel(message.getTime(), now), fmt("yearMonthDayTime", message));
  });
});

test("非法时间戳返回 null", () => {
  withLocale("zh", () => {
    const now = Date.now();
    assert.equal(formatMessageTimeLabel(Number.NaN, now), null);
    assert.equal(formatMessageTimeLabel(0, now), null);
    assert.equal(formatMessageTimeLabel(-100, now), null);
    assert.equal(formatMessageTimeLabel(Number.POSITIVE_INFINITY, now), null);
  });
});

test("缓存命中返回相同标签", () => {
  withLocale("zh", () => {
    const now = new Date(2026, 9, 7, 15, 30, 0).getTime();
    const message = new Date(2026, 9, 5, 12, 0, 0).getTime();
    const first = formatMessageTimeLabel(message, now);
    const second = formatMessageTimeLabel(message, now);
    assert.equal(first, second);
    assert.ok(first !== null);
  });
});
