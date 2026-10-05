"""``GET /api/resources/hooks/trust`` — the read-only trust status for one root.

The same document the CLI prints, over the existing ``resources/hooks`` family
and the same workspace fence every other workspace-bound route uses. There is
deliberately no HTTP write path: granting trust is a reviewed operator decision
made through the CLI, where the digests were displayed. A root outside the
fence is refused before anything is read, without hints about what exists.
"""
from __future__ import annotations

from pathlib import Path

from . import workspace_hooks as store


def dispatch(method, parts, query, data, ctx):
    """Handle ``GET /api/resources/hooks/trust?root=…``; ``None`` elsewhere."""
    if parts[:3] != ["api", "resources", "hooks"] or len(parts) != 4 \
            or parts[3] != "trust":
        return None
    if method.upper() != "GET":
        # Non-GET falls through to the generic resource repository, whose CRUD
        # routes for this family are unchanged.
        return None
    raw = (query or {}).get("root", [""])[0]
    state_dir = ctx.get("state_dir")
    if state_dir is None:
        return 400, {"error": "state_dir missing from context"}
    if not raw:
        return 400, {"error": "root query parameter is required"}
    try:
        from ...web import _allowed_root
        from ..settings.workspaces_api import allowed_roots
        root = _allowed_root(Path(raw), ctx["web_runs"], ctx["project_dir"],
                             allowed_roots(ctx))
    except (OSError, ValueError, RuntimeError, TypeError, KeyError):
        return 400, {"error": "workspace root not permitted"}
    try:
        document = store.status_document(state_dir, root)
    except OSError:
        return 500, {"error": "workspace hooks could not be read"}
    return 200, {**document, "stateDir": str(state_dir)}
