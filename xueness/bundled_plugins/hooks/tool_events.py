"""Tool event pipeline participation for the hooks plugin (PostToolUse seam).

The kernel's tool event pipeline dispatches module callbacks from trusted
entrypoints; this module is the hooks plugin's contribution. A user lifecycle
hook stays opt-in and default-off, exactly as before: it only joins the
pipeline when its resource JSON explicitly declares ``"pipeline": true``, and
only for the two Post events. Pipeline hooks fire through the kernel seam --
with the tool result in their stdin payload and the pipeline's serial dispatch,
exception isolation and timeout cap -- instead of the legacy fire point in the
run loop. Hooks without the flag keep firing at exactly the same point with
exactly the same payload as before.

Like every other observer on the pipeline this module can never change a
recorded result: it returns ``None``, and a hook's exit code is metadata only.
"""
from __future__ import annotations

import json

PIPELINE_FLAG = "pipeline"

#: The payload's tool result is bounded before it travels to a child process:
#: a full tool output (a 24 KB file read, say) must not stream into a hook by
#: accident, so oversized results degrade to a truncated preview.
RESULT_PAYLOAD_CAP = 8000


def _bounded_result(result) -> dict:
    """The tool result as hook payload data, within :data:`RESULT_PAYLOAD_CAP`."""
    if not isinstance(result, dict):
        return {"truncated": True, "preview": ""}
    try:
        encoded = json.dumps(result, ensure_ascii=False)
    except (TypeError, ValueError, OverflowError):
        return {"truncated": True, "preview": ""}
    if len(encoded) <= RESULT_PAYLOAD_CAP:
        return result
    return {"truncated": True, "preview": encoded[:RESULT_PAYLOAD_CAP]}


def fire_pipeline(root, state_dir, event: str, payload: dict) -> list:
    """Run the pipeline-declared hooks for ``event``; never raises.

    Uses the same paranoid runner as every other hook (argv-only, stdin
    payload, sandboxed environment, per-hook timeout). A broken loader or an
    unreadable hooks directory costs the firing, never the run.
    """
    try:
        from ...hooks import HookRunner, load
        hooks = load(state_dir)
        if not any(isinstance(hook, dict) and hook.get(PIPELINE_FLAG)
                   for hook in hooks):
            return []
        runner = HookRunner(hooks, root)
        return runner.fire(event, payload, pipeline=True)
    except Exception:  # noqa: BLE001 - observing must never break a run
        return []


def after_tool_execution(payload: dict) -> None:
    """Kernel tool-event seam: fire pipeline PostToolUse hooks for this result.

    Fired once per registry tool call after the handler settled and before the
    result is recorded for the model. The event follows the legacy semantics:
    ``PostToolUse`` for a successful call, ``PostToolUseFailure`` otherwise,
    matched by the tool name as before. Observation only -- the hook cannot
    change the result this returns into.
    """
    if not isinstance(payload, dict):
        return
    session = payload.get("session")
    state_dir = payload.get("state_dir")
    if not isinstance(session, dict) or state_dir is None:
        return
    result = payload.get("result")
    ok = bool(isinstance(result, dict) and result.get("ok"))
    event = "PostToolUse" if ok else "PostToolUseFailure"
    fire_pipeline(session.get("root"), state_dir, event, {
        "session_id": session.get("id", ""),
        "tool": payload.get("tool") or "",
        "tool_call_id": payload.get("tool_call_id") or "",
        "ok": ok,
        "result": _bounded_result(result),
    })
