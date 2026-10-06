"""Approval-gated command tools contributed by the shell plugin."""
from __future__ import annotations
import json, os, re, subprocess
from ...tool_contract import BuiltinTool

def _exec(root, gate, args, session, call_id) -> dict:
    argv = args["argv"]
    if not isinstance(argv, list) or not argv or any(not isinstance(x, str) or not x for x in argv):
        raise ValueError("argv must be a nonempty array of strings")
    # Computed once so the experimental dry-run probes the exact subject this
    # call really faces. ``None`` means carry on: Gate and subprocess unchanged.
    subject = (json.dumps(argv, ensure_ascii=False, separators=(",", ":"))
               if getattr(gate, "web_approval_gate", False) else " ".join(argv))
    from ..tools.dry_run import guard
    preview = guard(root, gate, "exec", subject, args)
    if preview is not None:
        return preview
    if getattr(gate, "web_approval_gate", False):
        gate.check("exec", subject, call_id)
    else:
        gate.check("exec", subject)
    from ...process_runtime import run_external
    proc = run_external(subprocess.run, argv, cwd=root, shell=False, capture_output=True, text=True, timeout=30,
                          env={k: v for k, v in os.environ.items()
                               if not re.search(r"KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL", k, re.I)})
    output = (proc.stdout + proc.stderr)[:12000]
    return {"ok": proc.returncode == 0, "exit_code": proc.returncode, "argv": argv, "output": output}


REGISTRY: tuple[BuiltinTool, ...] = (
    BuiltinTool("exec", "Run an argv command in workspace (approval required)",
                {"argv": {"type": "array", "items": {"type": "string"}}}, ("argv",), "exec", True, _exec),
)
