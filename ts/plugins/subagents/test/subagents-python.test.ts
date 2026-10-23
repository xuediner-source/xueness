/** Differential: definition loading, selection, tool allowlists, prompts and child bookkeeping against the Python plugin. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pyJsonDumps } from "@xueness/contracts";
import { agentDisallowed, agentToolAllowlist, buildSystemPrompt, childSummary, clip, loadSubagents, normalizeDisallowedTools, recoveryInfo, selectSubagent } from "../src/index.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

const canonical = (value: unknown): unknown => JSON.parse(pyJsonDumps(value, { sortKeys: true }));
const sorted = (value: Set<string> | null): string[] | null => value === null ? null : [...value].sort();

function fixture(): { state: string; close(): void } {
  const state = mkdtempSync(join(tmpdir(), "xueness-subagents-py-"));
  const dir = join(state, "resources", "subagents"); mkdirSync(dir, { recursive: true });
  const put = (name: string, body: unknown): void => writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
  put("b.json", { id: " reviewer ", name: " Reviewer ", systemPrompt: "  Review carefully.  ", tools: ["Read", "grep", "WebSearch", 7, "nope"], disallowedTools: ["Bash(rm *)", "  "] });
  put("a.json", { id: "zeta", name: "Zeta", prompt: "Zeta prompt", enabled: true, model: "m1" });
  put("c.json", { id: "off", name: "Off", enabled: false });
  put("d.json", { id: "", name: "Blank" });
  put("e.json", "{not json");
  put("f.json", "[1, 2]");
  put("g.json", { id: "alpha", name: "Alpha", description: "Only a description", tools: ["*"], disallowed_tools: ["websearch"] });
  put("h.txt", { id: "ignored", name: "Ignored" });
  put("i.json", { id: "nan", name: "NaN", tools: "read", extra: NaN });
  writeFileSync(join(dir, "j.json"), '{"id": "nanv", "name": "Nan V", "score": NaN}');
  symlinkSync(join(dir, "b.json"), join(dir, "k.json"));
  return { state, close: () => rmSync(state, { recursive: true, force: true }) };
}

const SELECTORS: unknown[] = ["reviewer", "REVIEWER", "Reviewer", " reviewer", "zeta", "explore", "Explore", "general-purpose", "General_Purpose", "missing", "", "  ", 5, null];
const TOOLS: unknown[] = [{}, { tools: null }, { tools: "read" }, { tools: [] }, { tools: ["*"] }, { tools: [" * "] }, { tools: ["READ", "Grep", "websearch", "WebSearch", "exec", 1, "bogus"] }, "not a dict"];
const DISALLOWED: unknown[] = [null, [], "read", ["Bash(rm *)", " WebSearch ", "(x)", "", 3, "Edit"], ["Read"]];
const CLIPS: [string, number][] = [["abcdef", 4], ["abcdef", 0], ["日本語テキスト", 12], ["x".repeat(30), 14], ["abc   def", 7], ["abc", 1]];
const CHILDREN = [
  { status: "completed", messages: [{ role: "assistant", content: "Found it." }], results: {} },
  { status: "running", messages: [{ role: "assistant", content: "", tool_calls: [{ id: "c1" }] }], results: {} },
  { status: "paused", messages: [{ role: "assistant", tool_calls: [{ id: "c1" }] }, { role: "tool", tool_call_id: "c1" }], results: { c1: {} } },
  { status: "stopped", messages: [] },
  { status: "completed", completion: { summary: "S" }, messages: [{ role: "assistant", content: "later" }], pending_question: null, delegation: {} },
  { status: "running", pending_question: { q: 1 }, messages: [] },
  { status: "running", delegation: { cancelled: true }, messages: [] },
  { status: "needs_review", messages: ["bad"] },
];

describe("subagents match Python", { skip: pythonUnavailableReason() ?? (process.platform === "win32" ? "POSIX links" : false) }, () => {
  it("load, select, allowlists, disallowed rules, prompts, summaries and recovery", () => {
    const { state, close } = fixture();
    try {
      const python = JSON.parse(runPython(String.raw`
import json, math, sys
from xueness.bundled_plugins.subagents import subagents as S
from xueness.bundled_plugins.subagents.child_sessions import recovery_info
from xueness.tool_registry import BUILTIN_TOOL_NAMES
c = json.load(sys.stdin)
def clean(v):
    if isinstance(v, float) and math.isnan(v): return "NaN"
    if isinstance(v, dict): return {k: clean(x) for k, x in v.items()}
    if isinstance(v, list): return [clean(x) for x in v]
    return v
loaded = S.load(c["state"])
def summary(child):
    completion = child.get("completion"); out = ""
    if isinstance(completion, dict) and isinstance(completion.get("summary"), str): out = completion["summary"]
    if not out:
        for m in reversed(child.get("messages", [])):
            if isinstance(m, dict) and m.get("role") == "assistant" and m.get("content"):
                out = m["content"]; break
    return out
print(json.dumps(clean({
  "loaded": loaded,
  "selected": [S.select(loaded, s) for s in c["selectors"]],
  "tools": [None if (r := S.agent_tool_allowlist(a)) is None else sorted(r) for a in c["tools"]],
  "known": sorted(BUILTIN_TOOL_NAMES),
  "disallowed": [sorted(S.normalize_disallowed_tools(d)) for d in c["disallowed"]],
  "agentDisallowed": [sorted(S.normalize_disallowed_tools(a.get("disallowedTools") or a.get("disallowed_tools") or ())) for a in loaded],
  "clips": [S.clip(t, n) for t, n in c["clips"]],
  "prompts": [S.build_system_prompt(a, "BASE") for a in loaded] + [S.build_system_prompt(None, "BASE"), S.build_system_prompt({"systemPrompt": "x" * 5000}, "B"), S.build_system_prompt({"prompt": "p"}, None)],
  "recovery": [recovery_info(ch) if all(isinstance(m, dict) for m in ch.get("messages", [])) or True else None for ch in c["children"]],
  "summaries": [summary(ch) for ch in c["children"][:5]],
})))
`, JSON.stringify({ state, selectors: SELECTORS, tools: TOOLS, disallowed: DISALLOWED, clips: CLIPS, children: CHILDREN }))) as Record<string, unknown>;
      const loaded = loadSubagents(state);
      const clean = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "number" && Number.isNaN(item) ? "NaN" : item));
      assert.deepEqual(clean(loaded), python.loaded);
      assert.deepEqual(canonical(SELECTORS.map((selector) => selectSubagent(loaded, selector))), canonical(clean(python.selected)));
      const known = python.known as string[];
      assert.deepEqual(TOOLS.map((agent) => sorted(agentToolAllowlist(agent, known))), python.tools);
      assert.deepEqual(DISALLOWED.map((value) => [...normalizeDisallowedTools(value)].sort()), python.disallowed);
      assert.deepEqual(loaded.map((agent) => [...agentDisallowed(agent)].sort()), python.agentDisallowed);
      assert.deepEqual(CLIPS.map(([text, max]) => clip(text, max)), python.clips);
      assert.deepEqual([...loaded.map((agent) => buildSystemPrompt(agent, "BASE")), buildSystemPrompt(null, "BASE"), buildSystemPrompt({ systemPrompt: "x".repeat(5000) }, "B"), buildSystemPrompt({ prompt: "p" }, null)], python.prompts);
      assert.deepEqual(CHILDREN.map((child) => recoveryInfo(child)), python.recovery);
      assert.deepEqual(CHILDREN.slice(0, 5).map((child) => childSummary(child)), python.summaries);
    } finally { close(); }
  });
});
