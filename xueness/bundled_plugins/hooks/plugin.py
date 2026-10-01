"""Trusted bundled loader for lifecycle hooks."""
from __future__ import annotations

from pathlib import Path
from ...plugin_contract import Plugin


class HooksPlugin(Plugin):
    """Run lifecycle hooks through the bounded argv-only runner."""

    kind = "hooks"

    def load(self, state_dir, root, session) -> dict:
        from ...hooks import HookRunner, load
        return {"hooks": HookRunner(load(state_dir), Path(root))}
