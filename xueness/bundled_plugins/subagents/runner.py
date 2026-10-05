"""Bounded read-only child-run orchestration owned by the subagents plugin."""
from __future__ import annotations

import math
import time
import uuid
from pathlib import Path


class _NullStore:
    """In-memory store for sub-agent runs.

    A delegated run stays out of the parent's journal by using a store whose
    ``save`` method is a no-op instead of writing a session file.
    """

    def __init__(self, directory=None):
        self.directory = directory

    def save(self, session: dict) -> None:
        return None


# A child is bounded even when it uses the standard provider profile. The
# lightweight runtime may apply a stricter configured wall-time limit.
SUBAGENT_MAX_WALL_SECONDS = 120


def _assign_subagent_request_deadline(parent_provider, child_provider):
    """Bound a recognized child adapter without changing the parent's client."""
    from ..providers.provider import AnthropicMessages, OpenAICompatible

    adapter_types = (AnthropicMessages, OpenAICompatible)
    wrapped = getattr(child_provider, "_provider", None)
    if isinstance(child_provider, adapter_types):
        adapter = child_provider
    elif isinstance(wrapped, adapter_types):
        adapter = wrapped
    else:
        # Keep the historical behavior of fake and third-party provider objects.
        return None

    deadline = time.monotonic() + SUBAGENT_MAX_WALL_SECONDS
    for source in (parent_provider, adapter):
        inherited = getattr(source, "request_deadline", None)
        if type(inherited) not in (int, float):
            continue
        try:
            inherited = float(inherited)
        except (OverflowError, ValueError):
            continue
        if math.isfinite(inherited):
            deadline = min(deadline, inherited)
    # child_provider is normally the tool-filtering proxy. Its setter forwards
    # request-local settings to the isolated adapter instance it wraps.
    setattr(child_provider, "request_deadline", deadline)
    return deadline


def run_subagent(gate, provider, agents, prompt, agent_name, *, depth: int,
                 max_depth: int, max_chars: int = 24000, registry=None,
                 parent_session=None, parent_should_stop=None, state_dir=None,
                 parent_model_selection=None, task_id=None, gate_class, run_fn,
                 base_system, max_steps, summary_max) -> dict:
    """Run one delegated sub-task in a read-only, bounded child session.

    The supplied harness dependencies keep this plugin independently owned
    while preserving the stable core call and test seams.
    """
    from .subagents import (
        SUBAGENT_DENIED_TOOL_NAMES,
        agent_tool_allowlist,
        build_system_prompt,
        provider_for_agent,
        provider_with_agent_tools,
        select as select_agent,
    )

    # Async callers reserve the id before submitting the worker. Keep that
    # record and never replace its start time or erase a cancellation race.
    supplied_task_id = task_id
    if supplied_task_id is not None and (
            not isinstance(supplied_task_id, str) or not supplied_task_id):
        return {"ok": False, "error": "invalid task id"}

    def fail_before_run(error, *, agent=None):
        result = {"ok": False, "error": error}
        if supplied_task_id is not None:
            result.update({"task_id": supplied_task_id, "steps": 0})
            if registry is not None:
                if registry.get(supplied_task_id) is None:
                    registry.record(
                        supplied_task_id, parent_session=parent_session,
                        agent=(agent.get("id") if isinstance(agent, dict) else None),
                        prompt=prompt, root=gate.root,
                    )
                registry.finish(supplied_task_id, ok=False, error=error, steps=0)
        return result

    if not isinstance(prompt, str) or not prompt.strip():
        return fail_before_run("prompt must be a non-empty string")

    if agent_name is not None and (not isinstance(agent_name, str) or not agent_name.strip()):
        return fail_before_run("sub-agent selector must be a non-empty string")
    agent = select_agent(agents, agent_name) if agent_name is not None else None
    if agent_name is not None and agent is None:
        return fail_before_run("sub-agent not found")

    system = build_system_prompt(agent, base_system) if agent is not None else base_system
    try:
        child_provider = provider_for_agent(
            agent, provider, state_dir, parent_model_selection,
        )
    except (OSError, TypeError, ValueError) as exc:
        return fail_before_run(
            str(exc)[:500] or "sub-agent model configuration is invalid", agent=agent,
        )

    parent_disallowed = set()
    for field in ("disallow", "disallow_tool_names", "denied_tool_names"):
        values = getattr(gate, field, ())
        if values:
            try:
                parent_disallowed.update(values)
            except TypeError:
                pass
    child_provider = provider_with_agent_tools(
        child_provider, agent, denied=parent_disallowed,
        parent_allowed=getattr(gate, "allowed_tool_names", None),
    )
    _assign_subagent_request_deadline(provider, child_provider)
    if getattr(child_provider, 'runtime_profile', 'standard') == 'lightweight':
        from ..providers.lightweight import SYSTEM as LIGHT_SYSTEM
        read_only_system = LIGHT_SYSTEM + '\nThis delegated task is read-only. Inspect and report; do not edit, write, execute commands or delegate.'
        system = build_system_prompt(agent, read_only_system) if agent is not None else read_only_system
    child = {
        "id": "sub-" + uuid.uuid4().hex,
        "task": prompt,
        "root": str(gate.root),
        "status": "pending",
        "messages": [{"role": "system", "content": system},
                     {"role": "user", "content": prompt}],
        "results": {}, "compactions": [], "archived_messages": [], "steps": 0,
        "completion": None, "todos": [], "pending_question": None,
        # Output offloading writes files, so child bookkeeping is mutation-free.
        # Children stay on the plan ceiling. They do not inherit edit/yolo,
        # and they do not receive the parent's plan draft.
        "read_only": True,
        "permission_mode": "plan",
        "mode": "plan",
    }
    # Keep the delegation id distinct from the internal child session id.
    if task_id is None:
        task_id = registry.new_id() if registry is not None else "task-" + uuid.uuid4().hex
    child["parent"] = parent_session
    if registry is not None and registry.get(task_id) is None:
        registry.record(task_id, parent_session=parent_session,
                        agent=(agent.get("id") if isinstance(agent, dict) else None),
                        prompt=prompt, root=gate.root)

    def _cancelled() -> bool:
        return bool((parent_should_stop and parent_should_stop()) or
                    (registry is not None and registry.is_cancelled(task_id)))

    def _on_step(steps: int) -> None:
        if registry is not None:
            registry.update(task_id, steps=steps)

    run_error = False
    try:
        # Read-only boundary: a delegate may inspect and report, never mutate.
        read_only = gate_class(
            Path(gate.root), allow_write=False, allow_exec=False, mode="plan",
            disallow=getattr(gate, "disallow", ()),
            permission_mode="plan", hold_remote_exec=True,
        )
        # Keep exact tool names separate from gate operation kinds such as `exec`.
        read_only.allowed_tool_names = agent_tool_allowlist(agent)
        parent_allowed = getattr(gate, "allowed_tool_names", None)
        if parent_allowed is not None:
            parent_allowed = frozenset(parent_allowed)
            read_only.allowed_tool_names = (
                parent_allowed if read_only.allowed_tool_names is None
                else read_only.allowed_tool_names.intersection(parent_allowed)
            )
        # These planning tools persist workflow state; exclude them for child runs.
        read_only.denied_tool_names = SUBAGENT_DENIED_TOOL_NAMES | frozenset(parent_disallowed)
        if not _cancelled():
            run_fn(child, _NullStore(state_dir), child_provider, read_only,
                   max_steps=max_steps, max_chars=max_chars, depth=depth + 1,
                   max_depth=max_depth, should_stop=_cancelled, on_step=_on_step,
                   policy_state_dir=state_dir,
                   max_wall_seconds=SUBAGENT_MAX_WALL_SECONDS)
    except Exception:
        # Provider failures are one child failure, not a failure of the parent
        # session. The registry and parent both receive a bounded safe result.
        run_error = True

    cancelled = _cancelled()
    summary = ""
    completion = child.get("completion")
    if isinstance(completion, dict) and isinstance(completion.get("summary"), str):
        summary = completion["summary"]
    if not summary:
        for message in reversed(child.get("messages", [])):
            if message.get("role") == "assistant" and message.get("content"):
                summary = message["content"]
                break
    child_status = child.get("status")
    ok = not cancelled and not run_error and child_status == "completed"
    if cancelled:
        error = "cancelled"
    elif run_error:
        error = "sub-agent run failed"
    elif not ok:
        reason = child.get("pause_reason")
        error = (reason[:500] if isinstance(reason, str) and reason.strip()
                 else "sub-agent ended with status " + str(child_status or "unknown"))
    else:
        error = ""
    if registry is not None:
        if cancelled:
            registry.cancel(task_id)
        registry.finish(task_id, ok=ok, summary=summary[:summary_max],
                        error=error,
                        steps=child.get("steps", 0))
    if cancelled:
        return {"ok": False, "error": "cancelled", "task_id": task_id,
                "steps": child.get("steps", 0)}
    result = {"ok": ok, "task_id": task_id, "summary": summary[:summary_max],
              "steps": child.get("steps", 0),
              "agent": (agent.get("id") if isinstance(agent, dict) else None)}
    if error:
        result["error"] = error
    return result
