import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

import { createDebouncer } from "./debounce";

test("createDebouncer: 尾沿防抖只保留最后一次 push，到时触发一次", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let runs = 0;
    const debouncer = createDebouncer(120, () => {
      runs += 1;
    });
    assert.equal(debouncer.pending, false);
    debouncer.push();
    debouncer.push();
    assert.equal(debouncer.pending, true);
    mock.timers.tick(119);
    assert.equal(runs, 0, "计时未到不应触发");
    mock.timers.tick(1);
    assert.equal(runs, 1, "到时后恰好触发一次");
    assert.equal(debouncer.pending, false);
  } finally {
    mock.timers.reset();
  }
});

test("createDebouncer: cancel 丢弃未触发的回调，重复 cancel 安全", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let runs = 0;
    const debouncer = createDebouncer(60, () => {
      runs += 1;
    });
    debouncer.push();
    debouncer.cancel();
    debouncer.cancel();
    mock.timers.tick(1000);
    assert.equal(runs, 0);
    assert.equal(debouncer.pending, false);
    // cancel 之后仍可再次 push。
    debouncer.push();
    mock.timers.tick(60);
    assert.equal(runs, 1);
  } finally {
    mock.timers.reset();
  }
});

test("createDebouncer: 触发后重新 push 开始新的一轮", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let runs = 0;
    const debouncer = createDebouncer(50, () => {
      runs += 1;
    });
    debouncer.push();
    mock.timers.tick(50);
    debouncer.push();
    mock.timers.tick(49);
    assert.equal(runs, 1);
    mock.timers.tick(1);
    assert.equal(runs, 2);
  } finally {
    mock.timers.reset();
  }
});
