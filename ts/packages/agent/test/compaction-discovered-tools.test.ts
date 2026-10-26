/** C-TOOL-05/F02.04: post-compaction discovered-tools reminder and its dedup signature. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPostCompactReminders, discoveredToolsReminder, type Row } from "../src/index.ts";

const session = (extra: Row = {}): Row => ({ discovered_tools: ["tool_a", "tool_b"], results: {}, ...extra });

describe("discoveredToolsReminder (C-TOOL-05)", () => {
  it("returns null without discovered tools", () => {
    assert.equal(discoveredToolsReminder({}), null);
    assert.equal(discoveredToolsReminder({ discovered_tools: [] }), null);
  });

  it("lists the currently discovered tools newest-first", () => {
    const reminder = discoveredToolsReminder(session());
    assert.ok(reminder);
    assert.equal(reminder!.source, "tool_discovery");
    assert.ok(reminder!.content.indexOf("- tool_b") < reminder!.content.indexOf("- tool_a"));
    assert.ok(reminder!.content.includes("tool_search"));
  });

  it("never repeats an identical announced set, order-insensitively", () => {
    assert.equal(discoveredToolsReminder(session({ announced_compact_discovered_tools: ["tool_b", "tool_a"] })), null);
    assert.ok(discoveredToolsReminder(session({ announced_compact_discovered_tools: ["tool_a"] })));
  });

  it("rides buildPostCompactReminders alongside read-state and todo entries", () => {
    const reminders = buildPostCompactReminders(session({ todos: [{ status: "in_progress", content: "keep going" }] }), "/tmp/root", [], []);
    assert.equal(reminders.filter((reminder) => reminder.source === "tool_discovery").length, 1);
  });
});
