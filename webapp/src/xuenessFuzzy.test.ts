import test from "node:test";
import assert from "node:assert/strict";

import { fuzzyMatch, fuzzyFilter } from "./xuenessFuzzy";

test("fuzzyMatch: subsequence matching with scores; non-match is -1", () => {
  assert.ok(fuzzyMatch("任务", "新建任务") >= 0);
  assert.ok(fuzzyMatch("xm", "新建任务") === -1);
  assert.ok(fuzzyMatch("dep", "/api/deploy") > fuzzyMatch("dep", "deep-golang-repo"));
  assert.ok(fuzzyMatch("", "anything") === 0);
  // 连续命中得分高于分散命中
  assert.ok(fuzzyMatch("ab", "abc") > fuzzyMatch("ab", "a-b"));
  // 词首加分：deploy 中 d 在词首
  assert.ok(fuzzyMatch("d", "deploy") > fuzzyMatch("d", "node"));
  assert.equal(fuzzyMatch("zz", "deploy"), -1);
});

test("fuzzyFilter: filters by subsequence and sorts by score desc", () => {
  const items = ["刷新历史", "打开设置", "切换到旧外壳（对照基线）", "新建任务"];
  const hits = fuzzyFilter(items, (x) => x, "打");
  assert.deepEqual(hits.map((h) => h.item), ["打开设置"]);
  const empty = fuzzyFilter(items, (x) => x, "");
  assert.equal(empty.length, items.length); // 空 needle 全保留
});
