"""Trusted bundled loader for the skills capability."""
from __future__ import annotations

from pathlib import Path

from ...plugin_contract import Plugin


class SkillsPlugin(Plugin):
    """Render enabled skills as untrusted prompt context."""

    kind = "skills"

    def load(self, state_dir, root, session) -> dict:
        from ...skills import load, catalog, read_skill
        workspace = Path(root) if root is not None else None
        if session.get("skill_catalog"):
            return {"skills": catalog(state_dir, workspace) or None,
                    "skill_reader": lambda sid: read_skill(state_dir, sid, workspace)}
        return {"skills": load(state_dir) or None}


def register_cli(commands):
    from .skills_cli import add_parsers
    add_parsers(commands)


def execute_cli(args):
    from .skills_cli import execute
    return execute(args)


def execute_slash(name, argument, ctx):
    """In-chat ``/skills`` entry contributed through plugin_runtime.dispatch_slash.

    Only ``skills`` is claimed here; any other name returns ``None`` so the
    chat loop keeps its existing behavior.
    """
    if name != "skills":
        return None
    from . import skills_cli
    return skills_cli.handle_slash(argument, ctx)


def dispatch(method, parts, query, data, ctx):
    from . import files_api
    return files_api.dispatch(method, parts, query, data, ctx)
