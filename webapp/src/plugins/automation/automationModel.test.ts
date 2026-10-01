import test from "node:test";
import assert from "node:assert/strict";
import { setLocale, t, tf } from "../../i18n";
import {
  cronFromScheduleDraft,
  describeCronSchedule,
  emptyAutomationDraft,
  newWorkflowNode,
  scheduleDraftFromCron,
  validateAutomationDraft,
  validateCron,
  workflowNodesForApi,
} from "./automationModel";

test("schedule controls round trip the cron forms supported by the backend", () => {
  assert.deepEqual(scheduleDraftFromCron("0 9 * * 1-5").mode, "weekdays");
  assert.equal(cronFromScheduleDraft({ mode: "hourly", minute: 15, hour: 9, weekday: 1, custom: "" }), "15 * * * *");
  assert.equal(cronFromScheduleDraft({ mode: "daily", minute: 5, hour: 8, weekday: 1, custom: "" }), "5 8 * * *");
  assert.equal(cronFromScheduleDraft({ mode: "weekdays", minute: 0, hour: 9, weekday: 1, custom: "" }), "0 9 * * 1-5");
  assert.equal(cronFromScheduleDraft({ mode: "weekly", minute: 30, hour: 18, weekday: 5, custom: "" }), "30 18 * * 5");
  assert.equal(cronFromScheduleDraft({ mode: "custom", minute: 0, hour: 9, weekday: 1, custom: "*/10 8-18 * * 1-5" }), "*/10 8-18 * * 1-5");
  assert.equal(describeCronSchedule("0 9 * * 1-5"), "工作日 · 09:00");
});

test("English schedule summaries interpolate the minute naturally", () => {
  try {
    setLocale("en");
    assert.equal(describeCronSchedule("15 * * * *", t, tf), "Every hour at minute 15");
    assert.equal(describeCronSchedule("0 9 * * 1-5", t, tf), "Weekdays · 09:00");
    assert.equal(describeCronSchedule("0 9 * * 1", t, tf), "Weekly Monday · 09:00");
  } finally {
    setLocale("zh");
  }
});

test("cron validation checks field count, ranges, lists, steps, and weekday bounds", () => {
  assert.equal(validateCron("*/15 8-18 * * 1-5"), null);
  assert.match(validateCron("0 25 * * *") ?? "", /范围|格式/);
  assert.match(validateCron("0 9 * * 7") ?? "", /范围|格式/);
  assert.match(validateCron("0 9 * *" ) ?? "", /五个 Cron 字段/);
});

test("structured nodes serialize only executable backend fields", () => {
  const node = newWorkflowNode("compile");
  node.argv = ["npm", "run", "build"];
  node.phase = "Build";
  assert.deepEqual(workflowNodesForApi([node]), [{
    id: "compile", needs: [], kind: "command", cwd: ".", timeout: 300, phase: "Build", argv: ["npm", "run", "build"],
  }]);

  const agent = { ...newWorkflowNode("review"), kind: "agent" as const, needs: ["compile"], prompt: "Review this change", provider_id: "local", model: "reviewer", writable: true };
  assert.deepEqual(workflowNodesForApi([agent]), [{
    id: "review", needs: ["compile"], kind: "agent", cwd: ".", timeout: 300, prompt: "Review this change", provider_id: "local", model: "reviewer", writable: true,
  }]);
});

test("automation validation requires executable steps and rejects dependency cycles", () => {
  const draft = emptyAutomationDraft();
  draft.name = "Nightly build";
  draft.root = "/workspace/project";
  draft.workflowName = "Build";
  assert.match(validateAutomationDraft(draft) ?? "", /1 到 64 个执行步骤/);

  const first = newWorkflowNode("first");
  first.argv = ["echo"];
  const second = newWorkflowNode("second");
  second.argv = ["echo"];
  first.needs = ["second"];
  second.needs = ["first"];
  draft.nodes = [first, second];
  assert.match(validateAutomationDraft(draft) ?? "", /循环/);

  second.needs = ["first"];
  first.needs = [];
  assert.equal(validateAutomationDraft(draft), null);
  first.id = " first ";
  assert.match(validateAutomationDraft(draft) ?? "", /步骤 ID/);
});
