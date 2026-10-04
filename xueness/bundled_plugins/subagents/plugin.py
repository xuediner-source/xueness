"""Trusted bundled loader for delegated sub-agent definitions."""
from __future__ import annotations

from ...plugin_contract import Plugin


class SubagentsPlugin(Plugin):
    """Expose configured agents to the bounded task tool."""

    kind = "subagents"

    def load(self, state_dir, root, session) -> dict:
        from ...subagents import load
        return {"subagents": load(state_dir)}


def dispatch(method, parts, query, data, ctx):
    from ...operations_api import dispatch as operations
    return operations(method, parts, query, data, ctx)


def run_task(gate, provider, agents, prompt, agent_name, *, depth, max_depth,
             max_chars=24000, registry=None, parent_session=None,
             parent_should_stop=None, state_dir=None, parent_model_selection=None,
             Gate, run, system, max_steps, summary_max, task_id=None):
    """Entrypoint for the core's stable sub-agent delegation seam."""
    from .runner import run_subagent
    return run_subagent(
        gate, provider, agents, prompt, agent_name, depth=depth,
        max_depth=max_depth, max_chars=max_chars, registry=registry,
        parent_session=parent_session, parent_should_stop=parent_should_stop,
        state_dir=state_dir, parent_model_selection=parent_model_selection,
        task_id=task_id,
        gate_class=Gate, run_fn=run, base_system=system,
        max_steps=max_steps, summary_max=summary_max)


def create_service():
    from .task_registry import TaskRegistry
    return TaskRegistry()


def create_coordinator(session, registry=None):
    from .coordinator import TaskCoordinator
    return TaskCoordinator(session, registry)


def tools():
    from .tools import REGISTRY
    return REGISTRY


def completion_check(root, gate, session, summary, *, state_dir=None):
    from .coordinator import completion_check
    return completion_check(session)
