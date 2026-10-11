"""In-chat and CLI face of MCP connection management: ``/mcp`` and ``xueness mcp``.

One formatter serves the chat reply and the terminal, so a listing cannot read
differently in two places. Subcommands:

* ``list`` — configured servers (enabled and disabled) from the plugin's own
  ``mcp`` resource kind. Reads configuration only; never starts a server.
* ``status [id]`` — explicit, bounded connection check through the same
  ``check_mcp`` seam the CLI ``mcp-check`` command and the confirmed web route
  use; reports the negotiated protocol and discovered tool names.
* ``connect <id>`` — explicitly start one enabled server through the existing
  :class:`~.lifecycle.Pool` and close it again; reports tools.
* ``disconnect <id>`` — release the client a supplied pool still holds. The
  bundled chat and web hosts scope MCP connections to a single run, so
  between turns there is no persistent operator connection to tear down and
  the reply says so instead of pretending to stop something.

No new connection code lives here: starting, handshakes, timeouts, process
reaping and error phrasing stay in ``mcp``/``lifecycle``/``diagnostics``.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

#: Probing every configured server in one ``status`` call must stay bounded.
MAX_STATUS_PROBES = 8
TARGET_MAX = 200
USAGE_ZH = "用法: /mcp list | status [id] | connect <id> | disconnect <id>"
USAGE_EN = "Usage: /mcp list | status [id] | connect <id> | disconnect <id>"

LABELS = {
    "zh": {
        "servers": "MCP 服务器",
        "enabled": "已启用",
        "disabled": "已停用",
        "empty": "未配置 MCP 服务器。可在设置页添加，或用 xueness resources create mcp <id> --body-file <config.json>。",
        "hint": "实时连接状态与工具: /mcp status；显式连接: /mcp connect <id>；断开: /mcp disconnect <id>",
        "connected": "已连接",
        "failed": "连接失败",
        "protocol": "协议",
        "tools": "工具",
        "not_found": "未找到已启用的 MCP 服务器: %s",
        "unknown": "未知子命令: %s",
        "released": "已断开并释放连接。",
        "no_persistent": ("未持有常驻连接。Xueness 的 MCP 连接按运行轮创建，"
                          "随每轮结束自动关闭；下一轮将按当前配置重新连接。"),
        "truncated": "(一次最多检查 %d 个已启用服务器，其余用 /mcp status <id> 单独查看)",
    },
    "en": {
        "servers": "MCP servers",
        "enabled": "enabled",
        "disabled": "disabled",
        "empty": ("No MCP servers configured. Add one in the settings page, or "
                  "xueness resources create mcp <id> --body-file <config.json>."),
        "hint": ("Live connection status and tools: /mcp status; connect: "
                 "/mcp connect <id>; disconnect: /mcp disconnect <id>"),
        "connected": "connected",
        "failed": "connection failed",
        "protocol": "protocol",
        "tools": "tools",
        "not_found": "enabled MCP server not found: %s",
        "unknown": "unknown subcommand: %s",
        "released": "Disconnected and released.",
        "no_persistent": ("No persistent connection is held. Xueness scopes MCP "
                          "connections to a single run and closes them with it; "
                          "the next run reconnects from the current configuration."),
        "truncated": "(at most %d enabled servers are probed per call; check the rest with /mcp status <id>)",
    },
}


def _labels(language) -> dict:
    return LABELS["en"] if language == "en" else LABELS["zh"]


def _transport(server: dict) -> str:
    transport = server.get("transport")
    return transport if transport in ("http", "streamable-http", "sse") else "stdio"


def _target(server: dict) -> str:
    """One bounded, operator-owned config line: argv for stdio, URL otherwise."""
    if _transport(server) == "stdio":
        command = server.get("command")
        if not isinstance(command, str) or not command.strip():
            return "-"
        args = server.get("args")
        if isinstance(args, list) and args:
            return " ".join([command] + [str(arg) for arg in args])[:TARGET_MAX]
        return command
    url = server.get("url")
    return url[:TARGET_MAX] if isinstance(url, str) and url else "-"


def configured_servers(state_dir) -> list:
    """Every configured MCP server entry, enabled and disabled, id ascending.

    Reads the plugin's own ``mcp`` resource kind with the same jail guards the
    client loader applies; one broken entry only costs that entry.
    """
    from ...resources import _is_link, _kind_dir, _load_item
    try:
        kind_dir = _kind_dir({"state_dir": state_dir}, "mcp")
    except (OSError, ValueError):
        return []
    if _is_link(kind_dir) or not kind_dir.is_dir():
        return []
    rows = []
    for path in sorted(kind_dir.glob("*.json")):
        if _is_link(path):
            continue
        item = _load_item(path)
        if item is None or not isinstance(item.get("id"), str) or not item["id"]:
            continue
        rows.append(item)
    rows.sort(key=lambda item: item["id"])
    return rows


def server_rows(state_dir) -> list:
    """Redacted listing rows: no argv beyond the operator's own config."""
    return [{
        "id": item["id"],
        "name": item.get("name") if isinstance(item.get("name"), str) else None,
        "transport": _transport(item),
        "target": _target(item),
        "enabled": item.get("enabled") is not False,
        "timeout": item.get("timeout") if isinstance(item.get("timeout"), (int, float)) else None,
    } for item in configured_servers(state_dir)]


def format_listing(rows, language=None) -> str:
    label = _labels(language)
    if not rows:
        return label["empty"]
    lines = ["%s (%d)" % (label["servers"], len(rows))]
    for row in rows:
        state = label["enabled"] if row["enabled"] else label["disabled"]
        name = " (%s)" % row["name"] if row.get("name") else ""
        lines.append("- %s%s [%s] %s: %s" % (row["id"], name, row["transport"], state, row["target"]))
    lines.append(label["hint"])
    return "\n".join(lines)


def connect_once(state_dir, server_id, root) -> dict:
    """Explicitly start one enabled server through the existing Pool, then close.

    The pool context guarantees the child process (or HTTP client) is closed on
    every path; failures come back as metadata only, never child output.
    """
    from .lifecycle import Pool
    from .mcp import load
    server = next((item for item in load(state_dir) if item["id"] == server_id), None)
    if server is None:
        raise ValueError("enabled MCP server not found")
    config = {**server, "_state_dir": str(state_dir)}
    with Pool(Path(root)) as pool:
        client = pool.get(config)
        tools = [tool.get("name", "") for tool in client.list_tools() if isinstance(tool, dict)]
        error = "tool discovery failed" if getattr(client, "error", None) else None
        return {"id": server_id, "ok": error is None,
                "protocol": getattr(client, "negotiated_protocol_version", None),
                "tools": tools, "error": error}


def status_all(state_dir, root, server_id=None, language=None) -> dict:
    """Bounded connection check for one or all enabled servers via check_mcp."""
    from .diagnostics import check_mcp
    from .mcp import load
    label = _labels(language)
    servers = load(state_dir)
    if server_id is not None:
        if not any(server["id"] == server_id for server in servers):
            raise ValueError(label["not_found"] % server_id)
        targets = [server_id]
    else:
        targets = [server["id"] for server in servers][:MAX_STATUS_PROBES]
    results = []
    for target in targets:
        try:
            result = check_mcp(state_dir, target, root)
        except (OSError, ValueError):
            result = {"id": target, "ok": False, "protocol": None,
                      "tools": [], "error": "connection failed"}
        results.append(result)
    return {"probed": len(targets), "truncated": server_id is None and len(servers) > MAX_STATUS_PROBES,
            "results": results}


def disconnect(state_dir, server_id, pool=None, language=None) -> dict:
    """Release one server's client from a supplied pool, or report there is none.

    A pool argument is a dependency seam for hosts that hold live connections;
    the bundled CLI and chat hosts do not between turns, and the reply must say
    that instead of claiming a stop that did not happen.
    """
    label = _labels(language)
    released = False
    if pool is not None:
        pool.discard(server_id)
        released = True
    return {"id": server_id, "released": released,
            "detail": label["released"] if released else label["no_persistent"]}


def format_status(document, language=None) -> str:
    label = _labels(language)
    lines = []
    for result in document["results"]:
        if result.get("ok"):
            tools = result.get("tools") or []
            listing = ", ".join(str(tool) for tool in tools[:32]) if tools else "-"
            lines.append("%s: %s（%s %s，%s %d）" % (
                result["id"], label["connected"], label["protocol"],
                result.get("protocol") or "-", label["tools"], len(tools)))
            lines.append("  %s" % listing)
        else:
            lines.append("%s: %s (%s)" % (result["id"], label["failed"],
                                          result.get("error") or "connection failed"))
    if document.get("truncated"):
        lines.append(label["truncated"] % MAX_STATUS_PROBES)
    return "\n".join(lines)


def _workspace(value) -> Path:
    try:
        return Path(value).expanduser() if value is not None else Path.cwd()
    except (OSError, RuntimeError, ValueError):
        return Path.cwd()


def run(state_dir, argument, root=None, language=None, pool=None) -> dict:
    """One ``/mcp`` action as structured data; the caller picks the rendering.

    Raises ``ValueError`` for operator-shaped mistakes (unknown subcommand,
    missing or unknown server id) so the chat loop prints one error line.
    """
    label = _labels(language)
    action, _, rest = (argument or "").strip().partition(" ")
    action, rest = action.lower(), rest.strip()
    if action in ("", "list"):
        if rest:
            raise ValueError(USAGE_ZH if language != "en" else USAGE_EN)
        rows = server_rows(state_dir)
        return {"action": "list", "document": rows,
                "text": format_listing(rows, language)}
    if action == "status":
        document = status_all(state_dir, _workspace(root), rest or None, language)
        return {"action": "status", "document": document,
                "text": format_status(document, language)}
    if action == "connect":
        if not rest:
            raise ValueError(USAGE_ZH if language != "en" else USAGE_EN)
        from .mcp import load as _load
        if not any(server["id"] == rest for server in _load(state_dir)):
            raise ValueError(label["not_found"] % rest)
        try:
            result = connect_once(state_dir, rest, _workspace(root))
        except (OSError, ValueError):
            # Pool.get closes the client and raises; failure stays metadata only.
            result = {"id": rest, "ok": False, "protocol": None,
                      "tools": [], "error": "connection failed"}
        return {"action": "connect", "document": {"results": [result], "truncated": False},
                "text": format_status({"results": [result], "truncated": False}, language)}
    if action == "disconnect":
        if not rest:
            raise ValueError(USAGE_ZH if language != "en" else USAGE_EN)
        result = disconnect(state_dir, rest, pool=pool, language=language)
        return {"action": "disconnect", "document": result, "text": result["detail"]}
    raise ValueError(label["unknown"] % action)


def handle_slash(argument, ctx) -> str:
    """``/mcp [list|status|connect|disconnect]`` through dispatch_slash."""
    state_dir = ctx.get("state_dir")
    if state_dir is None:
        return "mcp: no state directory in this session."
    session = ctx.get("session")
    root = ctx.get("root") or (session.get("root") if isinstance(session, dict) else None)
    try:
        return run(state_dir, argument, root=root,
                   language=ctx.get("language"), pool=ctx.get("mcp_pool"))["text"]
    except (OSError, ValueError) as exc:
        return "mcp: %s" % exc


# --- CLI --------------------------------------------------------------------

def add_parser(commands):
    command = commands.add_parser(
        "mcp", help="list configured MCP servers and connect or disconnect explicitly")
    sub = command.add_subparsers(dest="mcp_action")
    for name, help_text in (
            ("list", "configured servers and their transport/target"),
            ("status", "explicit bounded connection check (starts the server)"),
            ("connect", "explicitly connect to one enabled server and list tools"),
            ("disconnect", "release one server's pooled client, if any")):
        action = sub.add_parser(name, help=help_text)
        if name in ("status", "connect", "disconnect"):
            action.add_argument("id", nargs="?" if name == "status" else None,
                                help="one enabled server id (status default: every enabled server)")
        action.add_argument("--root", type=Path, default=None,
                            help="workspace used as the stdio server cwd (default: current directory)")
        action.add_argument("--json", action="store_true", help="machine-readable output on stdout")


def execute(args) -> int:
    """``xueness mcp ...``; the plugin switch is enforced by the CLI host."""
    language = getattr(args, "language", None)
    action = getattr(args, "mcp_action", None) or "list"
    target = getattr(args, "id", None)
    argument = action if not target else "%s %s" % (action, target)
    try:
        result = run(args.state, argument,
                     root=getattr(args, "root", None), language=language)
    except (OSError, ValueError) as exc:
        print("ERROR: %s" % exc, file=sys.stderr)
        return 1
    if getattr(args, "json", False):
        print(json.dumps(result.get("document", result["text"]), ensure_ascii=False, indent=2))
        return 0
    print(result["text"])
    document = result.get("document")
    if result["action"] in ("status", "connect") and isinstance(document, dict):
        results = document.get("results") or []
        return 0 if results and all(item.get("ok") for item in results) else 1
    return 0
