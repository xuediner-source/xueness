import test from "node:test";
import assert from "node:assert/strict";
import {
  draftFromResource,
  makeSubagentPayload,
  slugifySubagentId,
} from "./SubagentSettings";

test("subagent resource drafts distinguish inherited tools from an empty whitelist", () => {
  const inherited = draftFromResource({ id: "reader", name: "Reader", createdAt: "", updatedAt: "" });
  const empty = draftFromResource({ id: "silent", name: "Silent", tools: [], createdAt: "", updatedAt: "" });
  assert.equal(inherited.toolsMode, "all");
  assert.equal(empty.toolsMode, "custom");
  assert.deepEqual(empty.tools, []);
  assert.deepEqual(makeSubagentPayload(inherited).tools, ["*"]);
  assert.deepEqual(makeSubagentPayload(empty).tools, []);
});

test("subagent payload persists runtime model fields, prompt details, tools, and display color", () => {
  const draft = draftFromResource({
    id: "analyst",
    name: "Analyst",
    description: "Inspect code",
    systemPrompt: "Be concise",
    color: "cyan",
    providerId: "team-profile",
    model: "gpt-6-sol",
    reasoningEffort: "high",
    tools: ["read", "grep"],
    createdAt: "",
    updatedAt: "",
  });
  assert.deepEqual(makeSubagentPayload(draft), {
    name: "Analyst",
    description: "Inspect code",
    systemPrompt: "Be concise",
    color: "cyan",
    providerId: "team-profile",
    model: "gpt-6-sol",
    reasoningEffort: "high",
    tools: ["read", "grep"],
    enabled: true,
  });
});

test("subagent IDs generated from names stay inside the resource ID format", () => {
  assert.equal(slugifySubagentId("  Repo Analyst / One  "), "repo-analyst-one");
  assert.equal(slugifySubagentId("🔥"), "");
});
