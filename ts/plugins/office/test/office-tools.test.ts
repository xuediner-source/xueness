/** Differential: the three Office tools' path rules, read proofs and write flow against Python's handlers. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createToolEnv, runTool } from "@xueness/engine-tools";
import { officeTools } from "../src/index.ts";
import { runPython } from "../../../test-support/python-oracle.ts";
import { officeUnavailableReason } from "./oracle.ts";

const skip = officeUnavailableReason();
type Op = [tool: string, args: Record<string, unknown>] | ["touch", string];
const DOCX = { title: "原稿", paragraphs: [{ text: "first" }] };
const OPS: Op[] = [
  ["office_read", { path: "missing.docx" }], ["office_create", { path: "a.docx", format: "docx", document: DOCX }], ["office_create", { path: "a.docx", format: "docx", document: DOCX }],
  ["office_create", { path: "b.txt", format: "docx", document: DOCX }], ["office_create", { path: "a.docx", format: "odt", document: DOCX }], ["office_create", { path: "../x.docx", format: "docx", document: DOCX }],
  ["office_create", { path: "sub/x.docx", format: "docx", document: DOCX }], ["office_create", { path: "link/x.docx", format: "docx", document: DOCX }], ["office_create", { path: "dir.docx", format: "docx", document: DOCX }],
  ["office_create", { path: "notes.txt/x.docx", format: "docx", document: DOCX }], ["office_create", { path: 5, format: "docx", document: DOCX }], ["office_create", { path: "n.docx", format: "docx", document: { paragraphs: "x" } }],
  ["office_read", { path: "C:x.docx" }], ["office_read", { path: "a\\b.docx" }], ["office_read", { path: "./a.docx" }], ["office_read", { path: "" }], ["office_read", { path: 3 }],
  ["office_read", { path: "notes.txt" }], ["office_read", { path: "big.pdf" }], ["office_read", { path: "linkfile.docx" }], ["office_read", { path: "real/inner.docx" }],
  ["office_replace", { path: "a.docx", format: "docx", expected_sha256: "zz", document: DOCX }], ["office_replace", { path: "a.docx", format: "docx", expected_sha256: "0".repeat(64), document: DOCX }],
  ["office_read", { path: "a.docx" }], ["office_replace", { path: "a.docx", format: "pptx", expected_sha256: "$sha", document: DOCX }],
  ["office_replace", { path: "a.docx", format: "docx", expected_sha256: "$sha", document: { title: 3 } }],
  ["office_replace", { path: "a.docx", format: "docx", expected_sha256: "$sha", document: { title: "第二版", tables: [{ rows: [["x", "y"]] }] } }],
  ["office_replace", { path: "a.docx", format: "docx", expected_sha256: "$sha", document: DOCX }], ["office_read", { path: "a.docx" }],
  ["touch", "a.docx"], ["office_replace", { path: "a.docx", format: "docx", expected_sha256: "$sha", document: DOCX }],
  ["office_create", { path: "c.pdf", format: "pdf", document: { title: "P", paragraphs: [{ text: "body" }] } }], ["office_read", { path: "c.pdf" }],
  ["office_create", { path: "C.XLSX", format: "xlsx", document: { sheets: [{ name: "S", rows: [[1, "x"]] }] } }], ["office_read", { path: "C.XLSX" }],
  ["office_create", { path: "d.pptx", format: "pptx", document: { slides: [{ title: "T", bullets: ["b"] }] } }], ["office_read", { path: "d.pptx" }],
];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "office-tools-"));
  writeFileSync(join(root, "notes.txt"), "text");
  writeFileSync(join(root, "big.pdf"), Buffer.alloc(8_000_001));
  mkdirSync(join(root, "dir.docx")); mkdirSync(join(root, "real"));
  writeFileSync(join(root, "real", "inner.docx"), "not a zip");
  for (const [target, path] of [[join(root, "real"), join(root, "link")], [join(root, "a.docx"), join(root, "linkfile.docx")]] as const) {
    try { symlinkSync(target, path); } catch (error) { if (!["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
  return root;
}

const PY = String.raw`
import json, sys
from xueness.bundled_plugins.office import tooling as t
class Gate:
    web_approval_gate = False
    def check(self, kind, path): pass
root, ops = json.loads(sys.stdin.read())
session, out, sha = {"id": "s1"}, [], ""
for op in ops:
    if op[0] == "touch":
        with open(root + "/" + op[1], "ab") as f: f.write(b"x")
        continue
    args = {k: (sha if v == "$sha" else v) for k, v in op[1].items()}
    handler = {"office_read": t._read, "office_create": t._create, "office_replace": t._replace}[op[0]]
    try:
        result = handler(root, Gate(), args, session, "c1")
        if op[0] == "office_read" and result.get("ok"): sha = result["sha256"]
        out.append({k: v for k, v in result.items() if k not in ("sha256", "bytes")})
    except (ValueError, PermissionError) as exc:
        out.append({"error": str(exc), "kind": type(exc).__name__})
out.append(sorted((k, v["format"]) for k, v in session.get("_office_read_proofs", {}).items()))
print(json.dumps(out))
`;

async function runTs(root: string): Promise<unknown[]> {
  const session: Record<string, unknown> = { id: "s1" };
  const tools = new Map(officeTools({ session: () => session }).map((tool) => [tool.name, tool]));
  const env = createToolEnv({ cwd: root, artifactsDir: join(tmpdir(), "office-artifacts"), owner: "s1" });
  const out: unknown[] = [];
  let sha = "";
  for (const op of OPS) {
    if (op[0] === "touch") { writeFileSync(join(root, op[1] as string), "x", { flag: "a" }); continue; }
    const args = Object.fromEntries(Object.entries(op[1] as Record<string, unknown>).map(([k, v]) => [k, v === "$sha" ? sha : v]));
    const result = await runTool(tools.get(op[0])!, args, env);
    if (result.ok) {
      const data = { ...(result.data as Record<string, unknown>) };
      if (op[0] === "office_read") sha = data.sha256 as string;
      delete data.sha256; delete data.bytes;
      out.push(data);
    } else out.push({ error: result.error!.message, kind: result.error!.code === "permission_denied" ? "PermissionError" : "ValueError" });
  }
  const proofs = (session._office_read_proofs ?? {}) as Record<string, { format: string }>;
  out.push(Object.keys(proofs).sort().map((key) => [key, proofs[key]!.format]));
  return out;
}

describe("office tools match Python", { skip }, () => {
  it("path rules, read proofs, create-only and proof-gated replace", async () => {
    const tsRoot = fixture(), pyRoot = fixture();
    try {
      const ts = await runTs(tsRoot);
      const python = JSON.parse(runPython(PY, JSON.stringify([pyRoot, OPS]))) as unknown[];
      assert.equal(ts.length, python.length);
      ts.forEach((value, index) => assert.deepEqual(value, python[index], `step ${index}: ${JSON.stringify(OPS[index])}`));
    } finally { rmSync(tsRoot, { recursive: true, force: true }); rmSync(pyRoot, { recursive: true, force: true }); }
  });
});
