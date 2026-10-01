"""Kernel router for tool implementations contributed by feature plugins.

Schemas and dispatch use the same stable objects; handlers retain Gate checks.
The legacy xueness.builtin_tools import aliases this router.
"""
from __future__ import annotations
import subprocess
from pathlib import Path
from .tool_contract import BuiltinTool, Handler, execution_context
from .bundled_plugins.files.builtin_tools import _walk_files, path_in, glob_search, grep_search, MAX_GLOB_HITS, MAX_GREP_HITS, MAX_GREP_PER_FILE
from .bundled_plugins.planning.tooling import normalize_todos, MAX_TODO_ITEMS, TODO_STATUSES
from .plugin_runtime import PLUGIN_IDS, entrypoint

REGISTRY = tuple(tool for pid in PLUGIN_IDS for tool in getattr(entrypoint(pid), 'tools', lambda: ())())
#: Name -> entry, for dispatch. Built once from the ordered registry.
REGISTRY_BY_NAME: dict[str, BuiltinTool] = {tool.name: tool for tool in REGISTRY}

#: Names every base tool accepts, in registry order.
BUILTIN_TOOL_NAMES: tuple[str, ...] = tuple(tool.name for tool in REGISTRY)

#: Every kind ``Gate.check`` accepts. The base tools plus ``mcp``, which is
#: dispatched by the capability seam rather than this registry but is still a
#: gate kind the CLI/web may disallow. Kept here (next to the tool table) so the
#: CLI and the web layer cannot drift apart.
KNOWN_TOOLS: tuple[str, ...] = BUILTIN_TOOL_NAMES + ("mcp",)

# A remote-bound session can reach its target only through the selected SSH
# connection. It may still use planning, ask-user, and explicitly enabled
# network tools. Dynamic skill/MCP/delegation tools are excluded in core.run.
REMOTE_ALLOWED_TOOL_NAMES = frozenset({
    "remote_exec", "web_fetch", "web_search", "ask_user", "todo_read",
    "todo_write", "workflow_create", "workflow_amend", "workflow_status", "tool_search", "tool_result_read",
})
REMOTE_LOCAL_TOOL_NAMES = frozenset(
    name for name in BUILTIN_TOOL_NAMES if name not in REMOTE_ALLOWED_TOOL_NAMES
)


def tool_schemas() -> list:
    """The provider-facing schema list, derived from :data:`REGISTRY`."""
    return [tool.schema() for tool in REGISTRY]


def dispatch(root: Path, gate, name: str, args: dict, session: dict | None = None) -> dict:
    """Route one base tool call to its registry handler; never grants access.

    Preserves the original ``execute`` contract exactly: the ``_tool_call_id``
    the web gate smuggles through ``args`` is stripped here, an unknown name is
    a ``ValueError`` (reported as ``"ValueError"``), and any OSError/ValueError/
    KeyError/PermissionError/TimeoutExpired from a handler degrades to a
    structured failure -- PermissionError always reported as ``"denied"``.
    """
    try:
        call_id = args.get("_tool_call_id") if isinstance(args, dict) else None
        if isinstance(args, dict) and "_tool_call_id" in args:
            args = {key: value for key, value in args.items() if key != "_tool_call_id"}
        if (session and session.get("remote_connection")
                and name not in REMOTE_ALLOWED_TOOL_NAMES):
            raise PermissionError("tool unavailable for remote session")
        if name == "remote_exec" and session and session.get("remote_connection"):
            bound = session["remote_connection"]
            if (not isinstance(bound, dict) or args.get("connection") != bound.get("id")
                    or args.get("connection_digest") != bound.get("digest")):
                raise PermissionError("remote command does not match the session connection")
        if name in getattr(gate, "disallow", ()):
            raise PermissionError("tool disallowed")
        tool = REGISTRY_BY_NAME.get(name)
        if tool is None:
            raise ValueError("unknown tool")
        # Apply the persisted switch at the common invocation boundary, not
        # only in the model loop. Approval replay and direct context-bound
        # callers must not resurrect a disabled contribution.
        try:
            context = execution_context()
        except ValueError:
            context = None  # Historical unbound low-level callers have no policy store.
        state_dir = (context.get("state_dir") or getattr(context.get("store"), "directory", None)
                     if context is not None else getattr(gate, "state_dir", None))
        if context is not None and state_dir is None:
            return {"ok": False, "error": "plugin policy unavailable"}
        if state_dir is not None:
            from .plugin_runtime import tool_owner, is_enabled
            owner = tool_owner(name)
            if owner is None or not is_enabled(state_dir, owner):
                return {"ok": False, "error": "plugin disabled"}
        return tool.handler(root, gate, args, session, call_id)
    except (OSError, ValueError, KeyError, PermissionError, subprocess.TimeoutExpired) as exc:
        # Exceptions may contain command output/environment from untrusted
        # processes: do not echo them.
        return {"ok": False, "error": "denied" if isinstance(exc, PermissionError) else type(exc).__name__}
