"""Trusted bundled loader for lifecycle hooks."""
from __future__ import annotations

from pathlib import Path
from ...plugin_contract import Plugin


class HooksPlugin(Plugin):
    """Run lifecycle hooks through the bounded argv-only runner."""

    kind = "hooks"

    def load(self, state_dir, root, session) -> dict:
        from ...hooks import HookRunner, load
        from . import workspace_hooks
        hooks = workspace_hooks.extend_for_runner(state_dir, root, load(state_dir), session)
        return {"hooks": HookRunner(hooks, Path(root))}


def dispatch(method, parts, query, data, ctx):
    from . import trust_api
    return trust_api.dispatch(method, parts, query, data, ctx)


def register_cli(commands):
    from .hooks_cli import add_parsers
    add_parsers(commands)


def execute_cli(args):
    from .hooks_cli import execute
    return execute(args)


def after_tool_execution(payload):
    """Kernel tool-event seam: pipeline PostToolUse hooks for one tool result."""
    from . import tool_events
    tool_events.after_tool_execution(payload)
