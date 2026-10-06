"""Cooperative cancellation of one running subtask.

Experimental feature ``subagents.cancel_one``: with settings key
``agent.subagentCancelOneEnabled`` (default off) the endpoint
``POST /api/sessions/<sid>/tasks/<tid>/cancel`` withdraws a single delegated
subtask. The parent session and every other subtask keep running; the child
stops cooperatively at its next provider/tool boundary.

``plugin.dispatch`` calls :func:`handle` first and falls through to the
operations API when the path is not this shape, so the family the plugin
already declared (``sessions/*/tasks``) covers the route without a new
``httpFamilies`` entry.

Answer order is deliberate: request shape, then the flag, then state lookups.
A disabled experiment therefore never touches the store, the registry or the
filesystem, and it answers the same way for an existing or a nonexistent
task. Turning the flag on does not widen anything either -- Host, Origin,
CSRF, desktop token, admission and the plugin-enabled check are enforced by
the shared kernel before this handler runs, and the session root is still
validated against the permitted workspaces before a task is looked up.

Disabled answers 403 rather than the ``events_cursor`` 400 convention: there
the flag gates a *parameter* on a route that stays valid, while here the whole
action is refused, which is what 403 means.
"""
from __future__ import annotations

from pathlib import Path

#: Stable ids for the feature catalog and the settings lookup.
FEATURE_ID = 'subagents.cancel_one'
SETTINGS_SECTION = 'agent'
SETTINGS_KEY = 'subagentCancelOneEnabled'
NOT_ENABLED_ERROR = 'single subtask cancellation is disabled'


def enabled(ctx) -> bool:
    """The persistent flag, read from the state directory bound to ``ctx``."""
    from ..settings.settings_store import load_settings
    section = load_settings(ctx['state_dir']).get(SETTINGS_SECTION)
    return isinstance(section, dict) and section.get(SETTINGS_KEY) is True


def handle(method, parts, data, ctx):
    """Cancel one named subtask, or return the refusal that applies.

    ``None`` means the path is not this route and the caller should keep
    dispatching. Every rejection carries only a public error string: task
    ownership, workspace identity and root validity all fail closed without
    revealing whether the target exists elsewhere.
    """
    if (len(parts) != 6 or parts[:2] != ["api", "sessions"]
            or parts[3] != "tasks" or parts[5] != "cancel"):
        return None
    if method != "POST":
        return 405, {"error": "method not allowed"}
    if data:
        return 400, {"error": "request body must be empty"}
    if not enabled(ctx):
        return 403, {"error": NOT_ENABLED_ERROR}

    session_id, task_id = parts[2], parts[4]
    try:
        session = ctx["store"].load(session_id)
    except (FileNotFoundError, KeyError, OSError, TypeError, ValueError):
        return 404, {"error": "session not found"}

    from ...web import _allowed_root
    from ..settings.workspaces_api import allowed_roots
    try:
        session_root = _allowed_root(
            Path(session["root"]), Path(ctx["web_runs"]), Path(ctx["project_dir"]), allowed_roots(ctx))
    except (KeyError, OSError, RuntimeError, TypeError, ValueError):
        return 403, {"error": "workspace root not permitted"}

    task = ctx["task_registry"].get(task_id)
    if task is None:
        return 404, {"error": "subtask not found"}
    if task.get("parent") != session_id:
        return 403, {"error": "subtask does not belong to session"}
    try:
        task_root = Path(task["root"]).resolve()
    except (KeyError, OSError, RuntimeError, TypeError, ValueError):
        return 403, {"error": "subtask workspace does not match session"}
    if task_root != session_root:
        return 403, {"error": "subtask workspace does not match session"}
    if not ctx["task_registry"].cancel(task_id):
        return 409, {"error": "subtask is not running"}
    return 200, {"cancelled": True, "taskId": task_id}
