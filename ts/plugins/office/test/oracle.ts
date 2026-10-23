/** Batch the Python office plugin as an oracle: build, read and delivery text. */
import { spawnSync } from "node:child_process";
import { PYTHON, pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

const CODE = String.raw`
import base64, json, sys
from xueness.bundled_plugins.office import tooling as t, office_preview as p
out = []
for line in sys.stdin.read().split("\n"):
    case = json.loads(line)
    try:
        op = case["op"]
        if op == "build":
            value = {"data": base64.b64encode(t._build_document(case["format"], case["document"])).decode()}
        elif op == "read":
            data = base64.b64decode(case["data"])
            document, truncated = t._read_pdf(data) if case["format"] == "pdf" else t._read_office(data, case["format"])
            value = {"document": document, "truncated": truncated}
        elif op == "preview":
            value = {"preview": p.preview_bytes(base64.b64decode(case["data"]), case["suffix"], include_full_document=False)}
        else:
            value = {"text": t.delivery_content_text(base64.b64decode(case["data"]), case["suffix"])}
    except Exception as exc:
        value = {"error": str(exc)}
    out.append(value)
sys.stdout.write(json.dumps(out))
`;

export type OracleCase = { op: "build"; format: string; document: unknown } | { op: "read"; format: string; data: Buffer } | { op: "delivery" | "preview"; suffix: string; data: Buffer };
export type OracleResult = { data?: string; document?: unknown; truncated?: boolean; text?: string; preview?: unknown; error?: string };

export function pythonOffice(cases: OracleCase[]): OracleResult[] {
  const input = cases.map((item) => JSON.stringify("data" in item ? { ...item, data: item.data.toString("base64") } : item)).join("\n");
  return JSON.parse(runPython(CODE, input)) as OracleResult[];
}

/** Why the Office oracle cannot run: no Python, or the optional Office libraries are missing. */
export function officeUnavailableReason(): string | false {
  const reason = pythonUnavailableReason();
  if (reason) return reason;
  const probe = spawnSync(PYTHON, ["-c", "import docx, pptx, openpyxl, pypdf, reportlab"], { encoding: "utf8" });
  return probe.status === 0 ? false : `${PYTHON} lacks desktop/requirements-office.txt`;
}
