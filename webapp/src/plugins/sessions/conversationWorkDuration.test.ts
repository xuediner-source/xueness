import test from "node:test";
import assert from "node:assert/strict";

import { formatConversationWorkDuration } from "./conversationWorkDuration";

test("formatConversationWorkDuration: undefined / NaN / negative yields null (no fabricated data)", () => {
  assert.equal(formatConversationWorkDuration(undefined), null);
  assert.equal(formatConversationWorkDuration(NaN), null);
  assert.equal(formatConversationWorkDuration(-5), null);
});

test("formatConversationWorkDuration: sub-second rounds up to 1 second", () => {
  assert.equal(formatConversationWorkDuration(0), "1 秒");
  assert.equal(formatConversationWorkDuration(400), "1 秒");
  assert.equal(formatConversationWorkDuration(0, "en"), "1s");
});

test("formatConversationWorkDuration: keeps at most two largest units", () => {
  assert.equal(formatConversationWorkDuration(65_000), "1 分 5 秒");
  assert.equal(formatConversationWorkDuration(65_000, "en"), "1m 5s");
  assert.equal(formatConversationWorkDuration(3_600_000), "1 时");
  assert.equal(formatConversationWorkDuration(3_600_000, "en"), "1h");
  assert.equal(formatConversationWorkDuration(90_061_000), "1 天 1 时");
  assert.equal(formatConversationWorkDuration(90_061_000, "en"), "1d 1h");
  assert.equal(formatConversationWorkDuration(5_000), "5 秒");
});

test("formatConversationWorkDuration: matches zcode zh-CN/en-US unit copy", () => {
  assert.equal(formatConversationWorkDuration(1_000), "1 秒");
  assert.equal(formatConversationWorkDuration(60_000), "1 分");
  assert.equal(formatConversationWorkDuration(3_600_000), "1 时");
  assert.equal(formatConversationWorkDuration(86_400_000), "1 天");
  assert.equal(formatConversationWorkDuration(86_400_000, "en"), "1d");
});
