/** Batch the Python browser plugin as an oracle: snapshot formatting, `_call` checks and shaping, tool facts. */
import { runPython } from "../../../test-support/python-oracle.ts";

const CODE = String.raw`
import base64, binascii, json, sys, tempfile
from pathlib import Path
from unittest import mock
from xueness.bundled_plugins.browser import plugin as browser, snapshot
from xueness.plugin_runtime import set_enabled
from xueness.tool_contract import bind_execution

class Gate:
    def __init__(self): self.subjects = []
    def check(self, kind, subject, call_id): self.subjects.append([kind, subject])

class Broker:
    def __init__(self, payload): self.payload, self.calls = payload, []
    def call(self, command): self.calls.append(command); return self.payload

tmp = tempfile.mkdtemp()
state, root = Path(tmp) / "state", Path(tmp) / "root"
state.mkdir(); root.mkdir()
set_enabled(state, "browser", True)
out = []
for line in sys.stdin.read().split("\n"):
    case = json.loads(line)
    op = case["op"]
    try:
        if op == "format":
            value = {"value": snapshot.format_snapshot(case["nodes"], reported_total=case.get("total"), reported_truncated=case.get("truncated") is True)}
        elif op == "call":
            gate, broker = Gate(), Broker(case.get("payload", {"ok": True}))
            with mock.patch.object(browser, "_broker", return_value=broker), bind_execution(state_dir=state):
                result = browser._call(case["action"], root, gate, case["args"], None, "c1")
            value = {"value": result, "calls": broker.calls, "subjects": gate.subjects}
        elif op == "b64":
            try: base64.b64decode(case["text"], validate=True); value = {"value": True}
            except (binascii.Error, ValueError): value = {"value": False}
        elif op == "subject":
            value = {"value": browser._subject(case["value"])}
        else:
            value = {"value": [dict(tool.schema(), gate=tool.gate_kind, mutating=tool.mutating, concurrency=tool.concurrency_safe, subject=tool.approval_subject({"x": 1}) if tool.approval_subject else None) for tool in browser.REGISTRY]}
    except Exception as exc:
        value = {"error": type(exc).__name__, "message": str(exc)}
    out.append(value)
sys.stdout.write(json.dumps(out, ensure_ascii=False))
`;

export type OracleCase = { op: "format"; nodes: unknown; total?: unknown; truncated?: unknown } | { op: "call"; action: string; args: Record<string, unknown>; payload?: unknown } | { op: "b64"; text: string } | { op: "subject"; value: unknown } | { op: "tools" };
export interface OracleResult { value?: any; calls?: unknown[]; subjects?: [string, string][]; error?: string; message?: string }

export function pythonBrowser(cases: OracleCase[]): OracleResult[] {
  return JSON.parse(runPython(CODE, cases.map((item) => JSON.stringify(item)).join("\n"))) as OracleResult[];
}
