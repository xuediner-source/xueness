"""``GET /api/resources/commands/files`` — the merged command listing for the UI.

The browser asks for one workspace root; the answer is the same rows, sources,
shadowing and diagnostics the CLI prints, over the same jail. The request never
widens what one command may cost, and a root outside the operator's workspace
fence is refused before anything is scanned. Bodies are not part of a listing;
``commands inspect`` remains the only bounded body view.
"""
from __future__ import annotations

from pathlib import Path

from . import file_commands
from . import commands as store


def _workspace(value, ctx):
    """The existing workspace fence, or ``None`` for a state-directory-only view."""
    from ...web import _allowed_root
    from ..settings.workspaces_api import allowed_roots
    return _allowed_root(Path(value), ctx["web_runs"], ctx["project_dir"], allowed_roots(ctx))


def dispatch(method, parts, query, data, ctx):
    if parts[:4] != ["api", "resources", "commands", "files"] or len(parts) != 4:
        return None
    if method.upper() != "GET":
        return 405, {"error": "method not allowed"}
    raw = (query or {}).get("root", [""])[0]
    # The interface language only chooses which shipped prompt text a built-in
    # row carries; an unknown value is data and falls back to the default.
    language = (query or {}).get("language", [""])[0]
    state_dir = ctx.get("state_dir")
    if state_dir is None:
        return 400, {"error": "state_dir missing from context"}
    root = None
    if raw:
        try:
            root = _workspace(raw, ctx)
        except (OSError, ValueError, RuntimeError, TypeError, KeyError):
            # Same refusal as every other workspace-bound route (a host without
            # web context keys has no permitted workspace to offer): no listing,
            # no hint about what exists outside the fence.
            return 400, {"error": "workspace root not permitted"}
    try:
        document = store.list_all(state_dir, root, language=language)
    except OSError:
        return 500, {"error": "command roots could not be read"}
    return 200, {"root": str(root) if root is not None else None,
                 "stateDir": str(state_dir),
                 "commands": document["commands"],
                 "diagnostics": document["diagnostics"],
                 "limits": {"expandChars": store.EXPAND_MAX_CHARS,
                            "previewChars": file_commands.BODY_PREVIEW_CHARS,
                            "commandFileBytes": file_commands.MAX_COMMAND_FILE_BYTES,
                            "commandsPerRoot": file_commands.MAX_COMMANDS_PER_ROOT}}
