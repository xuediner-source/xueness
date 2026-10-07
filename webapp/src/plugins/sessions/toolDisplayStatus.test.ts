import test from "node:test";
import assert from "node:assert/strict";

import {
  TOOL_DISPLAY_STATUS_LABELS,
  TOOL_DISPLAY_STATUS_TONES,
  TOOL_ROW_STATUS_TO_DISPLAY,
  toolDisplayStatusOf,
} from "./toolDisplayStatus";

test("toolDisplayStatusOf: explicit identity mapping for all six states (no errorCode inference)", () => {
  for (const status of ["queued", "running", "ok", "error", "cancelled", "stopped"] as const) {
    assert.equal(toolDisplayStatusOf(status), status);
  }
});

test("TOOL_ROW_STATUS_TO_DISPLAY: covers the full ToolDisplayStatus union", () => {
  assert.deepEqual(Object.keys(TOOL_ROW_STATUS_TO_DISPLAY).sort(),
    ["cancelled", "error", "ok", "queued", "running", "stopped"]);
});

test("TOOL_DISPLAY_STATUS_LABELS: centralized status -> copy table (replaces ternary chains)", () => {
  assert.deepEqual(TOOL_DISPLAY_STATUS_LABELS, {
    queued: "排队中",
    running: "运行中",
    ok: "已完成",
    error: "失败",
    cancelled: "已取消",
    stopped: "已停止",
  });
});

test("TOOL_DISPLAY_STATUS_TONES: error/ok/neutral/warn mapping", () => {
  assert.deepEqual(TOOL_DISPLAY_STATUS_TONES, {
    queued: "warn",
    running: "warn",
    ok: "ok",
    error: "error",
    cancelled: "neutral",
    stopped: "neutral",
  });
});
