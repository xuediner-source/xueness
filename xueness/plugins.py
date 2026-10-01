"""Capability plugins: one uniform seam for the opt-in run extensions.

Why this exists: skills, hooks, MCP servers and sub-agents were each wired by
hand in both ``web.py`` and ``cli.py``. The MCP block was near-identical in the
two callers, so a fix applied to one silently missed the other -- the same
duplication that previously let two ``KNOWN_TOOLS`` copies disagree about which
tools exist.

Each capability now lives behind one plugin object and both callers go through
:func:`activate`. Adding a capability means adding one class and one registry
entry, not editing two call sites and hoping they stay in step.

Policy stays with the caller. ``activate`` loads only the plugins named in
``names``, so deny-by-default remains visible at each call site rather than
being hidden inside a loader. A plugin that fails to load degrades to "not
loaded" -- never an exception that would turn a bad resource file into a 500.
"""
from __future__ import annotations

from .plugin_contract import Plugin


# Implementations live in trusted package entry modules. These aliases retain
# the historical import surface used by callers and tests.
from .bundled_plugins.skills.plugin import SkillsPlugin  # noqa: E402
from .bundled_plugins.hooks.plugin import HooksPlugin  # noqa: E402
from .bundled_plugins.subagents.plugin import SubagentsPlugin  # noqa: E402
from .bundled_plugins.mcp.plugin import McpPlugin  # noqa: E402


#: Registry. Keys are the names callers opt in with (CLI flag / web body key).
PLUGINS: dict[str, type[Plugin]] = {
    "skills": SkillsPlugin,
    "hooks": HooksPlugin,
    "subagents": SubagentsPlugin,
    "mcp": McpPlugin,
}


class Activation:
    """The result of activating plugins: ``run()`` kwargs plus teardown.

    Use as a context manager so a failed run cannot leak MCP subprocesses::

        with activate(["mcp"], state_dir, root, session) as ext:
            run(..., **ext.kwargs)
    """

    def __init__(self):
        self.kwargs: dict = {}
        self._plugins: list[Plugin] = []

    def close(self) -> None:
        for plugin in reversed(self._plugins):
            plugin.teardown()

    def __enter__(self) -> "Activation":
        return self

    def __exit__(self, *_exc) -> bool:
        self.close()
        return False


def activate(names, state_dir, root, session) -> Activation:
    """Build the run extensions for ``names`` in a stable order.

    Unknown or failed plugins are skipped: a typo in a caller's list must not
    abort a run, and must not silently grant the capability either.
    """
    act = Activation()
    seen = set()
    from .plugin_runtime import is_enabled
    for name in names:
        if name in seen:
            continue
        seen.add(name)
        cls = PLUGINS.get(name)
        if cls is None:
            continue
        # The legacy names are also the bundled module IDs. Custom classes
        # registered by older embedders remain loadable through this public API.
        if name in {"skills", "hooks", "subagents", "mcp"}:
            try:
                if not is_enabled(state_dir, name):
                    continue
            except Exception:
                # A damaged policy store cannot grant a capability.
                continue
        plugin = cls()
        try:
            contribution = plugin.load(state_dir, root, session) or {}
        except Exception:
            # load() may acquire resources before it fails. A skipped plugin
            # still owns those resources and must release them now.
            try:
                plugin.teardown()
            except Exception:
                pass
            continue
        act.kwargs.update(contribution)
        act._plugins.append(plugin)
    return act
