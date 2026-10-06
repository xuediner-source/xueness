import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCallBudgetStatus, ToolExecutionSettings, parseToolBudget } from "./ToolExecutionSettings";
import { SessionExperimentSettings } from "../sessions/SessionExperimentSettings";

test("all experimental controls default off and are unavailable without a save handler", () => {
  const html = renderToStaticMarkup(<><SessionExperimentSettings values={{}} /><ToolExecutionSettings values={{}} /></>);
  assert.equal((html.match(/role="switch"/g) ?? []).length, 4);
  assert.doesNotMatch(html, /checked=""/);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 5);
});

test("tool budget validates actual counts rather than inventing unavailable data", () => {
  assert.deepEqual(parseToolBudget({ enabled: false }), { enabled: false, used: 0, limit: 0, remaining: 0 });
  assert.deepEqual(parseToolBudget({ enabled: true, used: 10, limit: 20, remaining: 10 }), { enabled: true, used: 10, limit: 20, remaining: 10 });
  for (const used of [-1, 1.5, "2"]) assert.throws(() => parseToolBudget({ enabled: true, used, limit: 100, remaining: 99 }));
  assert.throws(() => parseToolBudget({ enabled: true, used: 2, limit: 100, remaining: 100 }));
  assert.equal(renderToStaticMarkup(<ToolCallBudgetStatus enabled={false} sessionId="s1" />), "");
});
