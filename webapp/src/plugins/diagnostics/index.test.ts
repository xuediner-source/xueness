import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "../../i18n";
import { cleanupConfirmMessage, createObjectUrlRevocationQueue, DiagnosticsSessionsSummary, parseSessionStatusCounts, scheduleObjectUrlRevocation, totalSessionCount } from "./index";

test("diagnostics validates session status counts and totals real session rows", () => {
  const sessions = { completed: 3, running: 1, unknown: 2 };
  assert.deepEqual(parseSessionStatusCounts(sessions), sessions);
  assert.equal(totalSessionCount(sessions), 6);
  assert.deepEqual(parseSessionStatusCounts({}), {});
  assert.equal(totalSessionCount({}), 0);
});

test("diagnostics does not treat malformed session data as an empty count", () => {
  assert.equal(parseSessionStatusCounts([]), null);
  assert.equal(totalSessionCount([]), undefined);
  assert.equal(totalSessionCount({ completed: -1 }), undefined);
  assert.equal(totalSessionCount({ completed: 1.5 }), undefined);
  assert.equal(totalSessionCount({ completed: Number.MAX_SAFE_INTEGER, running: 1 }), undefined);
});

test("diagnostics session summary displays the total represented by status counts", () => {
  const html = renderToStaticMarkup(createElement(DiagnosticsSessionsSummary, {
    sessions: { completed: 3, running: 1, unknown: 2 },
  }));
  assert.match(html, /\(6\)/);
  assert.match(html, /&quot;completed&quot;: 3/);
  assert.match(html, /&quot;running&quot;: 1/);
});

test("diagnostics session summary marks malformed counts instead of showing a false zero", () => {
  const html = renderToStaticMarkup(createElement(DiagnosticsSessionsSummary, { sessions: [] }));
  assert.match(html, /—/);
  assert.doesNotMatch(html, /\(0\)/);
});

test("cleanupConfirmMessage formats days parameter properly in Chinese and English", () => {
  try {
    setLocale("zh");
    assert.equal(cleanupConfirmMessage(30), "将删除早于 30 天的日志文件。其他存储数据不会更改。");
    assert.equal(cleanupConfirmMessage(7), "将删除早于 7 天的日志文件。其他存储数据不会更改。");

    setLocale("en");
    assert.equal(cleanupConfirmMessage(30), "Log files older than 30 days will be deleted. Other stored data will not change.");
    assert.equal(cleanupConfirmMessage(7), "Log files older than 7 days will be deleted. Other stored data will not change.");
  } finally {
    setLocale("zh");
  }
});

test("scheduleObjectUrlRevocation invokes revoke callback after specified delay", async () => {
  let revokedUrl = "";
  const timer = scheduleObjectUrlRevocation("blob:test-url", 20, (url) => {
    revokedUrl = url;
  });
  assert.equal(revokedUrl, "");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(revokedUrl, "blob:test-url");
  clearTimeout(timer);
});

test("diagnostics unmount cancels pending download timers and revokes their URLs", () => {
  const scheduled: Array<() => void> = [];
  const cancelled: unknown[] = [];
  const revoked: string[] = [];
  const queue = createObjectUrlRevocationQueue(
    url => revoked.push(url),
    (_url, _delay, callback) => { scheduled.push(() => callback(_url)); return scheduled.length as unknown as ReturnType<typeof setTimeout>; },
    timer => cancelled.push(timer),
  );
  const timer = queue.schedule("blob:diagnostics");
  queue.dispose();
  scheduled[0]?.();
  assert.deepEqual(cancelled, [timer]);
  assert.deepEqual(revoked, ["blob:diagnostics"]);
});
