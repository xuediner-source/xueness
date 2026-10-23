/**
 * The policy without rules or read-only commands must decide exactly like
 * Python's WebGate: same allows, same refusals with the same messages, same
 * one-shot approval spending, in every permission mode.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
import { KNOWN_KINDS, PERMISSION_MODES, PermissionSession, type PermissionMode } from "../src/index.ts";

const skip = pythonUnavailableReason() ?? false;
/** Step 3 kinds for ZCode ExitPlanMode / EnterPlanMode; policy.test.ts covers them. */
const TS_ONLY_KINDS = new Set(["plan_exit", "plan_enter"]);
const PATH_KINDS = new Set(["read", "list", "glob", "grep", "write", "edit"]);
const DRAFT = "/state/plan-drafts/0123456789abcdef0123456789abcdef.md";

interface Case {
  mode: PermissionMode;
  kind: string;
  subject: string;
  disallow: string[];
  /** Approve this call before checking it twice. */
  approve: boolean;
  draft: boolean;
}

function cases(): Case[] {
  const kinds = [...KNOWN_KINDS].filter((kind) => !TS_ONLY_KINDS.has(kind)).concat("unknown_kind");
  const subjects = (kind: string): string[] => PATH_KINDS.has(kind) ? ["src/a.ts"]
    : kind === "exec" ? ['["npm","test"]', JSON.stringify({ connection: "prod", connection_digest: "d1", argv: ["ls"] })] : ["subject"];
  const all: Case[] = [];
  for (const mode of PERMISSION_MODES) {
    for (const kind of kinds) {
      for (const subject of subjects(kind)) {
        for (const approve of [false, true]) {
          for (const disallow of [[], ["exec", "read", "web_search"]]) all.push({ mode, kind, subject, disallow, approve, draft: false });
        }
      }
    }
    for (const kind of ["write", "edit"]) all.push({ mode, kind, subject: DRAFT, disallow: [], approve: false, draft: true });
  }
  // Python jails path kinds before anything else; the TS bridge does that, so the draft is only compared where it is allowed.
  return all.filter((item) => !item.draft || item.mode === "plan");
}

const PYTHON = `
import json, sys, tempfile, threading
from xueness.web import WebGate
from xueness.tool_registry import REGISTRY

class Draft:
    path = ${JSON.stringify(DRAFT)}
    def matches(self, subject):
        return subject == self.path
    def denial(self, kind):
        return kind + " denied: write the plan to " + self.path

root = tempfile.mkdtemp()
out = []
for case in json.load(sys.stdin):
    approvals = {}
    if case["approve"]:
        approvals = {"s1": {case["kind"]: {"call-1": case["subject"]}}}
    gate = WebGate(root, "s1", approvals, threading.Lock(), disallow=case["disallow"],
                   permission_mode=case["mode"], plan_draft=Draft() if case["mode"] == "plan" else None)
    outcome = []
    for _ in range(2):
        try:
            gate._check(case["kind"], case["subject"], "call-1")
            outcome.append("allow")
        except PermissionError as exc:
            outcome.append("deny: " + str(exc))
    out.append(outcome)
known = sorted({tool.gate_kind for tool in REGISTRY} | {"mcp", "planning"})
print(json.dumps({"outcomes": out, "known": known}))
`;

describe("policy against Python's WebGate", () => {
  it("decides every mode, kind, approval and disallow combination identically", { skip }, () => {
    const all = cases();
    const python = JSON.parse(runPython(PYTHON, JSON.stringify(all))) as { outcomes: string[][]; known: string[] };
    assert.deepEqual([...KNOWN_KINDS].filter((kind) => !TS_ONLY_KINDS.has(kind)).sort(), python.known);
    const draft = { path: DRAFT, matches: (subject: string) => subject === DRAFT, denial: (kind: string) => `${kind} denied: write the plan to ${DRAFT}` };
    const mismatches: string[] = [];
    all.forEach((item, index) => {
      const session = new PermissionSession({ mode: item.mode, disallow: item.disallow, readOnlyCommands: false, planDraft: item.mode === "plan" ? draft : null });
      if (item.approve) session.grantOnce("call-1", item.kind, item.subject);
      const subjectKind = PATH_KINDS.has(item.kind) ? "path" : item.kind === "exec" ? "command" : "text";
      const outcome = [0, 1].map(() => {
        const decision = session.check({ tool: item.kind, kind: item.kind, subject: item.subject, subjectKind, callId: "call-1" });
        return decision.behavior === "allow" ? "allow" : `deny: ${decision.message}`;
      });
      if (JSON.stringify(outcome) !== JSON.stringify(python.outcomes[index])) mismatches.push(`${JSON.stringify(item)}: ts ${JSON.stringify(outcome)} python ${JSON.stringify(python.outcomes[index])}`);
    });
    assert.deepEqual(mismatches, []);
    assert.ok(all.length > 300, `${all.length} cases`);
  });
});
