"""Trusted bundled loader for the skills capability."""
from __future__ import annotations

from ...plugin_contract import Plugin


class SkillsPlugin(Plugin):
    """Render enabled skills as untrusted prompt context."""

    kind = "skills"

    def load(self, state_dir, root, session) -> dict:
        from ...skills import load, catalog, read_skill
        if session.get("skill_catalog"):
            return {"skills": catalog(state_dir) or None,
                    "skill_reader": lambda sid: read_skill(state_dir, sid)}
        return {"skills": load(state_dir) or None}
