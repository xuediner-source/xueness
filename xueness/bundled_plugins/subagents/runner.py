"""Bounded read-only child-run orchestration owned by the subagents plugin."""
from __future__ import annotations

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


def run_subagent(gate, provider, agents, prompt, agent_name, *, depth: int,
                 max_depth: int, max_chars: int = 24000, registry=None,
                 parent_session=None, parent_should_stop=None, state_dir=None,
                 parent_model_selection=None, gate_class, run_fn,
                 base_system, max_steps, summary_max) -> dict:
    """Run one delegated sub-task in a read-only, bounded child session.

    The supplied harness dependencies keep this plugin independently owned
    while preserving the stable core call and test seams.
    """
    if not isinstance(prompt, str) or not prompt.strip():
        return {"ok": False, "error": "prompt must be a non-empty string"}
    from .subagents import (
        SUBAGENT_DENIED_TOOL_NAMES,
        agent_tool_allowlist,
        build_system_prompt,
        provider_for_agent,
        provider_with_agent_tools,
        select as select_agent,
    )

    agent = select_agent(agents, agent_name) if agent_name else None
    system = build_system_prompt(agent, base_system) if agent is not None else base_system
    try:
        child_provider = provider_for_agent(
            agent, provider, state_dir, parent_model_selection,
        )
    except (OSError, TypeError, ValueError) as exc:
        return {"ok": False, "error": str(exc)[:500] or "sub-agent model configuration is invalid"}
    child_provider = provider_with_agent_tools(child_provider, agent)
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
        "read_only": True,
    }
    # Keep the delegation id distinct from the internal child session id.
    task_id = registry.new_id() if registry is not None else "task-" + uuid.uuid4().hex
    child["parent"] = parent_session
    if registry is not None:
        registry.record(task_id, parent_session=parent_session,
                        agent=(agent.get("id") if isinstance(agent, dict) else None),
                        prompt=prompt, root=gate.root)

    def _cancelled() -> bool:
        return bool((parent_should_stop and parent_should_stop()) or
                    (registry is not None and registry.is_cancelled(task_id)))

    def _on_step(steps: int) -> None:
        if registry is not None:
            registry.update(task_id, steps=steps)

    # Read-only boundary: a delegate may inspect and report, never mutate.
    read_only = gate_class(Path(gate.root), allow_write=False, allow_exec=False, mode="plan")
    # Keep exact tool names separate from gate operation kinds such as `exec`.
    read_only.allowed_tool_names = agent_tool_allowlist(agent)
    # These planning tools persist workflow state; exclude them for child runs.
    read_only.denied_tool_names = SUBAGENT_DENIED_TOOL_NAMES
    run_fn(child, _NullStore(state_dir), child_provider, read_only,
           max_steps=max_steps, max_chars=max_chars, depth=depth + 1,
           max_depth=max_depth, should_stop=_cancelled, on_step=_on_step,
           policy_state_dir=state_dir)

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
    ok = not cancelled
    if registry is not None:
        if cancelled:
            registry.cancel(task_id)
        registry.finish(task_id, ok=ok, summary=summary[:summary_max],
                        error="cancelled" if cancelled else "",
                        steps=child.get("steps", 0))
    if cancelled:
        return {"ok": False, "error": "cancelled", "task_id": task_id,
                "steps": child.get("steps", 0)}
    return {"ok": True, "task_id": task_id, "summary": summary[:summary_max],
            "steps": child.get("steps", 0),
            "agent": (agent.get("id") if isinstance(agent, dict) else None)}
