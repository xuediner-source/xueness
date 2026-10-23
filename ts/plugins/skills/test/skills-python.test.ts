/** Differential: discovery, merging, frontmatter, catalog, bodies, validation and read pointers against the Python plugin. */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { describe, it } from "node:test";
import { pyJsonDumps } from "@xueness/contracts";
import { contextReminder, listAll, observeRead, parseFrontmatter, pythonCatalog, readBody, stripFrontmatter, validateSkill } from "../src/index.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
import { skillFixture } from "./fixture.ts";

const skip = pythonUnavailableReason() ?? false;
const TEXTS = [
  "---\nname: a\ndescription: b\n---\nbody", "\ufeff\ufeff---\r\nname: x\r\n---", "---\nname: a", "---\n---\n", "---\n: novalue\nkey with space: 1\n---\n",
  "---\nName: Upper\nDESCRIPTION: \"quoted\"\n---\nb", "---\ndescription: >-\n  a\n\n  b\n---\n", "---\ndescription: |+\n  a\n   b\n\n---\n", "  ---\nname: s\n---\n",
  "---\nname: one\nname: two\n---\n", "---\ntags: x, y , x,,\"q\"\n---\n", "---\n\tindented: v\nname: v\n---\n", "---\rname: cr\rdescription: d\r---\rbody",
  "no front", "", "---\nname: ok-name\ndescription: fine\n---\n\n   \n", "---\nname: ok\ndescription: fine\n---\nreal body",
  "---\nname: -bad\ndescription: d\n---\nb", "---\nname: " + "a".repeat(65) + "\ndescription: d\n---\nb", "---\nname: x\ndescription: \u3000\n---\nb",
];
const SESSIONS = [
  { messages: [{ role: "user" }], skill_context_references: [{ id: "file:project:alpha", tool_call_id: "c1", turn: 1 }, { id: "r1", tool_call_id: "c2", turn: 1 }, { id: "old", tool_call_id: "c0", turn: 0 }] },
  { messages: [{ role: "user" }, { role: "user" }], skill_context_references: [{ id: " spaced", tool_call_id: "c", turn: 2 }, { id: "x".repeat(201), tool_call_id: "c", turn: 2 }, { id: "ok", tool_call_id: "c\u0001", turn: 2 }, { id: "dup", tool_call_id: "a", turn: 2 }, { id: "dup", tool_call_id: "b", turn: 2 }] },
  { messages: [{ role: "user" }], skill_context_references: Array.from({ length: 9 }, (_, i) => ({ id: "日本".repeat(60) + i, tool_call_id: `c${i}`, turn: 1 })) },
  { messages: [], skill_context_references: "nope" },
];

describe("skills match Python", { skip }, () => {
  it("discovery, merge, catalog, bodies, frontmatter, validation and pointers", () => {
    const { base, root, state } = skillFixture();
    try {
      const output = runPython(String.raw`
import json, sys
from pathlib import Path
from xueness.bundled_plugins.skills import skills as S, file_skills as F, continuity as C
from xueness.bundled_plugins.skills.creator_tooling import _validate
cases = json.load(sys.stdin)
class Gate:
    def check(self, *a): pass
listing = S.list_all(cases["state"], Path(cases["root"]))
bodies = [F.read_body(r) for r in listing["skills"] if r["source"] != "resource"]
validated = []
for t in cases["texts"]:
    try: validated.append(_validate(None, Gate(), {"content": t}, {}, "c"))
    except Exception as e: validated.append({"raised": type(e).__name__})
pointers = []
for s in cases["sessions"]:
    pointers.append(C.context_reminder(s))
observed = []
for s in cases["sessions"]:
    s = json.loads(json.dumps(s))
    C.observe_read({"tool": "skill_read", "session": s, "tool_call_id": "new", "result": {"ok": True, "id": "file:project:alpha"}})
    C.observe_read({"tool": "skill_read", "session": s, "tool_call_id": "bad\n", "result": {"ok": True, "id": "r9"}})
    observed.append(s.get("skill_context_references"))
print(json.dumps({
  "listing": listing, "nocompat": S.list_all(cases["state"], Path(cases["root"]), include_compat=False)["skills"],
  "stateonly": S.list_all(cases["state"], None),
  "catalog": S.catalog(cases["state"], Path(cases["root"])),
  "bodies": bodies,
  "parsed": [list(F.parse_frontmatter(t)) for t in cases["texts"]],
  "stripped": [F.strip_frontmatter(t) for t in cases["texts"]],
  "validated": validated, "pointers": pointers, "observed": observed,
}))
`, JSON.stringify({ state, root, texts: TEXTS, sessions: SESSIONS }));
      const python = JSON.parse(output) as Record<string, unknown>;
      const dumps = (value: unknown): string => pyJsonDumps(value);
      const listing = listAll(state, root);
      assert.equal(dumps(listing.skills), dumps((python.listing as Record<string, unknown>).skills), "merged rows");
      assert.equal(dumps(listing.diagnostics), dumps((python.listing as Record<string, unknown>).diagnostics), "diagnostics");
      assert.equal(dumps(listAll(state, root, false).skills), dumps(python.nocompat));
      assert.equal(dumps(listAll(state, null)), dumps(python.stateonly));
      assert.equal(pythonCatalog(listing.skills), python.catalog);
      const bodies = listing.skills.filter((row) => row.source !== "resource").map((row) => { const read = readBody(row); return read.ok ? { ok: true, content: read.content, bytesRead: read.size, sizeBytes: read.size } : read; });
      assert.equal(dumps(bodies), dumps(python.bodies));
      assert.equal(dumps(TEXTS.map((text) => { const parsed = parseFrontmatter(text); return [parsed.values, parsed.keys, parsed.error]; })), dumps(python.parsed));
      assert.deepEqual(TEXTS.map(stripFrontmatter), python.stripped);
      // Python raises StopIteration for a lone-CR file (its validator splits only on LF); TS answers "skill_empty_body".
      const validated = TEXTS.map((text) => { try { return validateSkill(text); } catch { return { raised: "ValueError" }; } });
      (python.validated as Record<string, unknown>[]).forEach((row, index) => {
        if (row.raised === "StopIteration") assert.deepEqual(validated[index], { ok: false, errors: [{ code: "skill_empty_body" }], executed: false }, TEXTS[index]);
        else assert.equal(dumps(validated[index]), dumps(row), TEXTS[index]);
      });
      assert.deepEqual(SESSIONS.map((session) => contextReminder(structuredClone(session))), python.pointers);
      const observed = SESSIONS.map((session) => {
        const copy = structuredClone(session) as Record<string, unknown>;
        observeRead(copy, "skill_read", "new", { ok: true, data: { id: "file:project:alpha" } });
        observeRead(copy, "skill_read", "bad\n", { ok: true, data: { id: "r9" } });
        return copy.skill_context_references ?? null;
      });
      assert.deepEqual(observed, python.observed);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
