/** ZCode v3.15.1 agent contract: built-in profiles, the agent-type listing (tests/agent-listing.test.ts), Agent output text (tests/tool-contracts.test.ts) and the Agent ⇄ task adapter. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentAdapter, AGENT_SCHEMA, contractFor, internalToolName, modelToolName, type AdapterContext } from "@xueness/agent";
import { activeProfiles, agentListing, agentOutputText, childSystemPrompt, findProfile, formatProfileLine, resourceProfile, subagentsExtension, CHILD_DENIED_TOOLS } from "../src/index.ts";

const user = (name: string, extra: Record<string, unknown> = {}) => ({ id: name.toLowerCase(), name, description: `Description ${name}`, systemPrompt: "private instructions", tools: ["Read"], ...extra });
const adapter: AdapterContext = { root: "/w", accepts: () => true };

describe("ZCode agent types", () => {
  it("lists the built-ins plus stored definitions, by name, never their instructions", () => {
    const listing = agentListing([user("B"), user("A")], ["Bash", "Glob", "Grep", "Read"]);
    const lines = listing.split("\n");
    assert.equal(lines[0], "Available agent types for the Agent tool:");
    assert.deepEqual(lines.slice(1).map((line) => line.split(":")[0]), ["- A", "- B", "- Explore", "- general-purpose", "- visual-judge"]);
    assert.ok(lines.includes("- A: Description A (Tools: Read)"));
    assert.ok(lines.includes("- Explore: " + activeProfiles([]).find((p) => p.name === "Explore")!.description + " (Tools: Glob, Grep, Read, Bash)"), "Explore lists the tools a child really gets, in ZCode's order");
    assert.ok(lines.some((line) => line.startsWith("- general-purpose: General-purpose agent") && line.endsWith("(Tools: *)")));
    assert.ok(!listing.includes("private instructions"));
    assert.ok(!listing.includes("When you launch multiple agents"), "agents run one after another here");
    assert.ok(lines.some((line) => line.startsWith("- visual-judge: THE single visual acceptance pass for a rendered deliverable") && line.endsWith("(Tools: Read, Bash)")), "ZCode's visual-judge plugin agent is built in");
    const judge = findProfile([], "visual-judge")!;
    assert.ok(judge.source === "built-in" && judge.systemPrompt.startsWith("You are the visual acceptance reviewer") && !judge.systemPrompt.includes("thoughtLevel"));
  });
  it("replaces a built-in by name and drops the plan-mode tools from a profile's tool list", () => {
    const profiles = activeProfiles([user("Explore", { tools: ["Read", "ExitPlanMode", "Bash"], disallowedTools: ["Bash(rm *)"] })]);
    assert.deepEqual(profiles.map((p) => p.name), ["general-purpose", "Explore", "visual-judge"]);
    const explore = profiles.find((p) => p.name === "Explore")!;
    assert.equal(explore.source, "resource");
    assert.equal(formatProfileLine(explore, []), "- Explore: Description Explore (Tools: Read)");
    assert.equal(formatProfileLine(resourceProfile({ id: "x", name: "X" }), []), "- X: X", "no description falls back to the name; inherited tools are not listed");
  });
  it("finds a type by ZCode name, Python id or Python's lower-case built-in ids", () => {
    const agents = [user("Reviewer")];
    assert.equal(findProfile(agents, undefined)!.name, "general-purpose");
    assert.equal(findProfile(agents, "Reviewer")!.definition, agents[0]);
    assert.equal(findProfile(agents, "reviewer")!.definition, agents[0]);
    assert.equal(findProfile(agents, "explore")!.name, "Explore");
    assert.equal(findProfile(agents, "general_purpose")!.name, "general-purpose");
    assert.equal(findProfile(agents, "nope"), null);
    assert.equal(findProfile(agents, "  "), null);
  });
  it("builds the child system prompt from ZCode's subagent sections", () => {
    const prompt = childSystemPrompt(findProfile([], "Explore")!, { cwd: "/w", isGitRepository: true, platform: "linux", shell: "bash", osVersion: "Linux 6" }, "You are Xueness, an interactive coding agent");
    assert.ok(prompt.startsWith("You are Xueness, an interactive coding agent\nYou are Xueness Explore, a file search and codebase research specialist for Xueness."));
    assert.ok(prompt.includes("\n\nNotes:\n- Agent threads always have their cwd reset between bash calls"));
    assert.ok(prompt.endsWith("<env>\nWorking directory: /w\nIs directory a git repo: Yes\nPlatform: linux\nShell: bash\nOS Version: Linux 6\n</env>"));
    assert.ok(!prompt.includes("ZCode"));
  });
  it("formats a completed agent like ZCode, without the SendMessage hint", () => {
    const text = agentOutputText({ agentId: "task-1", text: "Found one issue.", toolUses: 2, durationMs: 33, totalTokens: 11 });
    assert.equal(text, "Found one issue.\nagentId: task-1\n<usage>subagent_tokens: 11\ntool_uses: 2\nduration_ms: 33</usage>");
    assert.equal(agentOutputText({ agentId: "task-2", text: "  ", toolUses: 0, durationMs: 1 }), "(Subagent completed but returned no output.)\nagentId: task-2\n<usage>tool_uses: 0\nduration_ms: 1</usage>");
  });
});

describe("the Agent tool contract", () => {
  it("is the model name of task, with ZCode's schema minus run_in_background", () => {
    assert.equal(modelToolName("task"), "Agent"); assert.equal(internalToolName("Agent"), "task");
    const contract = contractFor("Agent")!;
    assert.equal(contract.internal, "task");
    assert.deepEqual(Object.keys((AGENT_SCHEMA as { properties: object }).properties), ["description", "prompt", "subagent_type"]);
    assert.ok(contract.description.startsWith("Launch a new agent to handle complex, multi-step tasks."));
    assert.ok(!contract.description.includes("SendMessage") && !contract.description.includes("CreateWorkflow") && !contract.description.includes("run_in_background"));
  });
  it("maps subagent_type to Python's agent and back", () => {
    assert.deepEqual(agentAdapter.toInternal({ description: " scan ", prompt: "Find X", subagent_type: " Explore " }, adapter), { prompt: "Find X", agent: "Explore", description: "scan" });
    assert.deepEqual(agentAdapter.toInternal({ description: "", prompt: "Find X" }, adapter), { prompt: "Find X" });
    assert.deepEqual(agentAdapter.toModel({ prompt: "Find X", agent: "reviewer" }, adapter), { description: "", prompt: "Find X", subagent_type: "reviewer" });
  });
});

describe("the subagents extension", () => {
  const request = () => ({ messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }], tools: ["read", "task", "todo_write", "exec"].map((name) => ({ type: "function", function: { name } })), options: {} });
  const context = (session: Record<string, unknown> = {}) => ({ session, provider: {} }) as never;
  it("offers task only when delegation is allowed, with the listing after the system prompt", async () => {
    const off = await subagentsExtension({ stateDir: "", allowed: false }).prepareRequest!(context(), request());
    assert.deepEqual(off.tools.map((tool) => (tool.function as { name: string }).name), ["read", "todo_write", "exec"]);
    assert.equal(off.messages.length, 2);
    const on = await subagentsExtension({ stateDir: "", allowed: true }).prepareRequest!(context(), request());
    assert.equal(on.tools.length, 4);
    assert.equal(on.messages[1]!._meta_source, "agent_listing_delta");
    assert.match(String(on.messages[1]!.content), /^<system-reminder>\nAvailable agent types for the Agent tool:\n/);
    assert.match(String(on.messages[1]!.content), /- Explore: .*\(Tools: Read, Bash\)/, "TodoWrite and task are child-denied");
    assert.ok(CHILD_DENIED_TOOLS.includes("todo_write"));
    const remote = await subagentsExtension({ stateDir: "", allowed: true }).prepareRequest!(context({ remote_connection: { id: 1 } }), request());
    assert.equal(remote.tools.length, 3);
  });
});
