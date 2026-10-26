/** F08.01: the context-inheritance and child-configuration rule sets (inheritance.ts). */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { branchHistory, childToolGrant, childWithInheritedHistory, clampModelSelection, INHERITED_SOURCE, inheritableParentMessages } from "../src/index.ts";

type Row = Record<string, unknown>;

const parentFixture = (): Row => ({
  id: "p".repeat(32),
  messages: [
    { role: "system", content: "you are the parent" },
    { role: "user", content: "audit the payments module", _input_kind: "guide" },
    { role: "user", content: "please audit the payments module" },
    { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "read", arguments: "{}" } }] },
    { role: "user", content: "", _background_task_notice: { task_id: "task-1" } },
    { role: "assistant", content: "reading the ledger now", _meta_source: "agent_listing_delta" },
    { role: "assistant", content: "here is the ledger state" },
    { role: "user", content: "", _meta_source: "task_status" },
    { role: "assistant", content: "" },
    { role: "user", content: "summarize the findings" },
  ],
});

describe("inheritableParentMessages", () => {
  it("keeps only plain narration turns and drops system, guide, notices, meta rows, pure tool calls and empties", () => {
    const kept = inheritableParentMessages(parentFixture());
    assert.deepEqual(kept.map((row) => [row.role, row.content]), [
      ["user", "please audit the payments module"],
      ["assistant", "here is the ledger state"],
      ["user", "summarize the findings"],
    ]);
  });

  it("returns deep clones — mutating a kept row never touches the parent journal", () => {
    const parent = parentFixture();
    const kept = inheritableParentMessages(parent);
    (kept[0]!.content as string[]).length;
    kept[0]!.content = "tampered";
    delete kept[1]!.role;
    const again = inheritableParentMessages(parent);
    assert.equal(again[0]!.content, "please audit the payments module");
    assert.equal(again[1]!.role, "assistant");
    assert.equal((parent.messages as Row[])[2]!.content, "please audit the payments module");
  });

  it("handles non-dict parents and message entries without throwing", () => {
    assert.deepEqual(inheritableParentMessages(null), []);
    assert.deepEqual(inheritableParentMessages({}), []);
    assert.deepEqual(inheritableParentMessages({ messages: ["nope", 3, null] }), []);
  });
});

describe("branchHistory", () => {
  const turns = (count: number): Row => ({ messages: Array.from({ length: count }, (_, index) => ({ role: "user", content: "turn " + index })) });

  it("keeps the newest turns in chronological order within maxMessages", () => {
    const branch = branchHistory(turns(30), { maxMessages: 5, maxChars: 10000 });
    assert.deepEqual(branch.messages.map((row) => row.content), ["turn 25", "turn 26", "turn 27", "turn 28", "turn 29"]);
    assert.equal(branch.truncated, true);
  });

  it("stops before busting maxChars but always keeps at least one turn", () => {
    const branch = branchHistory(turns(10), { maxMessages: 100, maxChars: 21 });
    // three "turn N" turns are 18 chars together; a fourth would bust 21.
    assert.deepEqual(branch.messages.map((row) => row.content), ["turn 7", "turn 8", "turn 9"]);
    assert.equal(branch.truncated, true);
    assert.ok(branch.chars > 0);
    const single = branchHistory(turns(10), { maxMessages: 100, maxChars: 1 });
    assert.deepEqual(single.messages.map((row) => row.content), ["turn 9"]);
    assert.equal(single.truncated, true);
  });

  it("a short parent is kept whole and untruncated", () => {
    const branch = branchHistory(turns(2), { maxMessages: 20, maxChars: 1000 });
    assert.equal(branch.messages.length, 2);
    assert.equal(branch.truncated, false);
  });

  it("an empty parent gives an empty branch", () => {
    const branch = branchHistory({}, {});
    assert.deepEqual(branch, { messages: [], truncated: false, chars: 0 });
  });
});

describe("childWithInheritedHistory", () => {
  const child = (): Row => ({
    id: "c".repeat(32),
    messages: [
      { role: "system", content: "child system" },
      { role: "user", content: "the task prompt" },
    ],
    delegation: {},
  });

  it("places the branch between the system and task prompts, tagged and counted", () => {
    const shaped = childWithInheritedHistory(child(), { messages: [{ role: "user", content: "prior turn" }, { role: "assistant", content: "prior answer" }], truncated: true }) as { messages: Row[]; delegation: Row };
    assert.deepEqual(shaped.messages.map((row) => [row.role, row.content, row._meta_source]), [
      ["system", "child system", undefined],
      ["user", "prior turn", INHERITED_SOURCE],
      ["assistant", "prior answer", INHERITED_SOURCE],
      ["user", "the task prompt", undefined],
    ]);
    assert.equal(shaped.delegation.contextInherited, true);
    assert.equal(shaped.delegation.inheritedMessages, 2);
    assert.equal(shaped.delegation.inheritedTruncated, true);
  });

  it("an empty branch leaves contextInherited false and the messages untouched", () => {
    const fresh = child();
    const shaped = childWithInheritedHistory(fresh, { messages: [] }) as { messages: Row[]; delegation: Row };
    assert.equal(shaped.delegation.contextInherited, false);
    assert.equal(shaped.delegation.inheritedMessages, 0);
    assert.equal(shaped.messages.length, 2);
    assert.equal("inheritedTruncated" in shaped.delegation, false);
  });

  it("rejects malformed children", () => {
    assert.throws(() => childWithInheritedHistory({ delegation: {} } as Row, { messages: [] }), TypeError);
    assert.throws(() => childWithInheritedHistory({ messages: [] } as Row, { messages: [] }), TypeError);
  });
});

describe("clampModelSelection", () => {
  const parent = { provider_id: "prov-a", model: "model-a", reasoning_effort: "low" };

  it("an override inside the ceiling passes through", () => {
    const { selection, clamped } = clampModelSelection({ model: "model-b" }, parent, ["model-a", "model-b"]);
    assert.deepEqual(selection, { model: "model-b" });
    assert.deepEqual(clamped, []);
  });

  it("an override outside the ceiling falls back to the parent selection for that key", () => {
    const { selection, clamped } = clampModelSelection({ model: "model-z" }, parent, ["model-a", "model-b"]);
    assert.deepEqual(selection, { model: "model-a" });
    assert.deepEqual(clamped, ["model"]);
  });

  it("allowed null means no ceiling is configured", () => {
    const { selection, clamped } = clampModelSelection({ provider_id: "prov-x", model: "model-z", reasoning_effort: "high" }, parent, null);
    assert.deepEqual(selection, { provider_id: "prov-x", model: "model-z", reasoning_effort: "high" });
    assert.deepEqual(clamped, []);
  });

  it("only the model key is ceiling-filtered; partial overrides keep the parent's other keys", () => {
    const { selection } = clampModelSelection({ model: "model-a" }, parent, ["model-a"]);
    assert.deepEqual(selection, { model: "model-a" });
    const outside = clampModelSelection({ provider_id: "prov-b", model: "model-z" }, parent, ["model-a"]);
    assert.deepEqual(outside.selection, { provider_id: "prov-b", model: "model-a" });
    assert.deepEqual(outside.clamped, ["model"]);
  });
});

describe("childToolGrant", () => {
  const known = ["read", "write", "bash", "task", "task_collect", "EnterPlanMode"];
  const profile = (tools: readonly string[] | null, disallowedTools: readonly string[] = []): { tools?: readonly string[] | null; disallowedTools?: readonly string[] | null } =>
    tools === null ? { disallowedTools } : { tools, disallowedTools };

  it("declared tools intersect the parent's universe and stay a subset of it", () => {
    const grant = childToolGrant({ profile: profile(["read", "write", "nonexistent"]), known });
    assert.deepEqual(grant.effective, ["read", "write"]);
    assert.equal(grant.inherits, false);
  });

  it("an inheriting profile (tools null) gets the parent's set minus denials, never the raw universe", () => {
    const grant = childToolGrant({ profile: profile(null), known, parentAllowed: ["read", "write"], parentDisallowed: ["write"] });
    assert.deepEqual(grant.effective, ["read"]);
    assert.equal(grant.inherits, true);
    const wild = childToolGrant({ profile: profile(["*"]), known, parentAllowed: ["read"] });
    assert.deepEqual(wild.effective, ["read"]);
    assert.equal(wild.inherits, true);
  });

  it("forced and parent denials are subtracted from a declared set", () => {
    const grant = childToolGrant({ profile: profile(["read", "bash", "EnterPlanMode"]), known, parentDisallowed: ["bash"], forcedDenied: ["task_collect"] });
    assert.deepEqual(grant.effective, ["read"]);
    assert.ok(grant.denied.includes("EnterPlanMode"));
    assert.ok(grant.denied.includes("bash"));
    assert.ok(grant.denied.includes("task_collect"));
  });

  it("profile denials apply through the alias mapping and deny the mapped name", () => {
    const grant = childToolGrant({ profile: profile(null, ["task"]), known: [...known, "subagent_task"], parentAllowed: ["read", "task", "subagent_task"], alias: (name) => (name === "task" ? "subagent_task" : name) });
    assert.deepEqual(grant.effective, ["read"]);
    assert.ok(grant.denied.includes("subagent_task"));
    assert.ok(grant.denied.includes("task"));
  });

  it("results are sorted, deduped and confined to the universe", () => {
    const grant = childToolGrant({ profile: profile(["bash", "read", "bash"]), known: ["read", "bash"], forcedDenied: ["read", "READ"] });
    assert.deepEqual(grant.effective, ["bash"]);
    assert.deepEqual(grant.denied, ["read"]);
    for (const name of grant.effective) assert.ok(["read", "bash"].includes(name));
  });

  it("an explicitly empty tool list grants nothing and does not inherit", () => {
    const grant = childToolGrant({ profile: profile([]), known });
    assert.deepEqual(grant.effective, []);
    assert.equal(grant.inherits, false);
  });
});
