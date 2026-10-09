"""Approval-gated command tools contributed by the shell plugin."""
from __future__ import annotations
import json, os, re, subprocess
from ...tool_contract import BuiltinTool


def _decode_output(value):
    if isinstance(value, str):
        return value
    if not value:
        return ""
    if value.startswith((b'\xff\xfe', b'\xfe\xff')):
        return value.decode('utf-16', errors='replace')
    try:
        return value.decode('utf-8-sig')
    except UnicodeDecodeError:
        if os.name == 'nt':
            import ctypes
            return value.decode(f'cp{ctypes.windll.kernel32.GetOEMCP()}', errors='replace')
        return value.decode('utf-8', errors='replace')


def _description():
    text = "Run an argv command in workspace (approval required). argv is executed directly, not through a shell."
    if os.name == 'nt':
        return text + (" Host OS: Windows. Prefer the glob/grep/list file tools for discovery. "
                       "For PowerShell syntax, pass powershell.exe -NoProfile -NonInteractive -Command followed by the command. "
                       "PowerShell cmdlets are not executable names. Unix find -name and Unix shell commands are not portable here.")
    return text + " Host OS: POSIX. For shell syntax, explicitly invoke an available shell."


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
    try:
        proc = run_external(subprocess.run, argv, cwd=root, shell=False, stdin=subprocess.DEVNULL,
                          capture_output=True, timeout=30,
                          creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0) if os.name == 'nt' else 0,
                          env={k: v for k, v in os.environ.items()
                               if not re.search(r"KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL", k, re.I)})
    except FileNotFoundError:
        return {"ok": False, "error": "command not found", "error_code": "command_not_found", "argv": argv,
                "retryable": False, "output": "The executable is unavailable on this host. " + _description()}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "command timed out after 30 seconds", "error_code": "command_timeout",
                "argv": argv, "retryable": False}
    output = (_decode_output(proc.stdout) + _decode_output(proc.stderr))[:12000]
    return {"ok": proc.returncode == 0, "exit_code": proc.returncode, "argv": argv, "output": output}


REGISTRY: tuple[BuiltinTool, ...] = (
    BuiltinTool("exec", _description(),
                {"argv": {"type": "array", "items": {"type": "string"}}}, ("argv",), "exec", True, _exec),
)
