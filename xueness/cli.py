"""Xueness command-line entrypoint."""
import argparse
import json
import os
import shlex
import sys
from pathlib import Path
from .core import MODES, Gate, Store, answer_session, run, session_events
from .core import KNOWN_TOOLS as _core_known_tools
from .core import parse_disallow_list as _core_parse_disallow_list
from .plugins import activate
from . import plugin_sdk
from . import commands as commands_module
from . import resources as resources_module
from . import plugin_runtime, plugin_cli
from .core import append_user_turn
from .memory import load as load_memory
from .cli_interrupt import RunInterrupt
from .cli_input import capture_clipboard_image, enqueue, multiline, snapshot
from . import operator_cli, provider_config, providers_api
from .session_lease import lease
from contextlib import ExitStack
from .task_registry import TaskRegistry
from .bundled_plugins.sessions.cli import CHAT_HELP, CHAT_HELP_EN

# The authoritative tool list lives in ``core`` next to the tool table; keeping a
# second copy here is how a per-tool policy silently drifts out of sync.
KNOWN_TOOLS = _core_known_tools
parse_disallow_list = _core_parse_disallow_list


def _render_event(ev, file=None, language="zh", stream_state=None):
    from .bundled_plugins.sessions import cli as owned
    return owned.render_event(ev, deps=_compat_cli_dependencies(None),
                              file=file, language=language, stream_state=stream_state)


def _add_agent_flags(parser):
    from .bundled_plugins.sessions import cli as owned
    return owned.add_agent_flags(parser)


def _model_selection_record(provider_id, model, reasoning_effort):
    from .bundled_plugins.sessions import cli as owned
    return owned._model_selection_record(provider_id, model, reasoning_effort)


def _prepare_agent(args, parser, store, session):
    from .bundled_plugins.sessions import cli as owned
    return owned.prepare_agent(args, parser, store, session,
                               deps=_compat_cli_dependencies(parser))


def _load_commands(state_dir, root=None, *, language=None):
    from .bundled_plugins.sessions import cli as owned
    return owned.load_commands(state_dir, root, language=language,
                               deps=_compat_cli_dependencies(None))


def _require_cli_plugins(args) -> str | None:
    """Return a refusal message before any command can create local state."""
    owner = plugin_runtime.cli_owner(args.cmd, args)
    requested = [owner] if owner else []
    if args.cmd in ("run", "chat"):
        requested.append("providers")
    for flag, plugin_id in (("skill_catalog", "skills"), ("inject_skills", "skills"),
                            ("allow_hooks", "hooks"), ("allow_mcp", "mcp"),
                            ("allow_subagents", "subagents")):
        if getattr(args, flag, False):
            requested.append(plugin_id)
    # Order-preserving dedupe keeps the first, most direct refusal stable.
    for plugin_id in dict.fromkeys(requested):
        try:
            plugin_runtime.require_enabled(args.state, plugin_id)
        except ValueError as exc:
            return str(exc)
    return None


def _prompt(label: str) -> str:
    from .bundled_plugins.sessions import cli as owned
    return owned.prompt(label, deps=_compat_cli_dependencies(None))


def _approval_prompt(label: str) -> str:
    from .bundled_plugins.sessions import cli as owned
    return owned.approval_prompt(label, deps=_compat_cli_dependencies(None))


def _latest_chat(store, root):
    from .bundled_plugins.sessions import cli as owned
    return owned.latest_chat(store, root, deps=_compat_cli_dependencies(None))


def _chat_loop(args, parser, store, session):
    from .bundled_plugins.sessions import cli as owned
    return owned.chat_loop(args, parser, store, session,
                           deps=_compat_cli_dependencies(parser))


def _chat_loop_owned(args, parser, store, session, owned_stack):
    from .bundled_plugins.sessions import cli as owned
    return owned.chat_loop_owned(args, parser, store, session, owned_stack,
                                 deps=_compat_cli_dependencies(parser))


def _print_summary(session, json_mode):
    from .bundled_plugins.sessions import cli as owned
    return owned.print_summary(session, json_mode,
                               deps=_compat_cli_dependencies(None))


def _stage2_cli(args, parser, store):
    owner = plugin_runtime.cli_owner(args.cmd, args)
    handler = getattr(plugin_runtime.entrypoint(owner), "execute_cli", None) if owner else None
    if handler is None:
        parser.error("plugin does not provide a CLI executor")
    import inspect
    return (handler(args, deps=_compat_cli_dependencies(parser))
            if "deps" in inspect.signature(handler).parameters else handler(args))


def _resources_ctx(args) -> dict:
    return {"state_dir": args.state}


def _run_resources(args, parser) -> int:
    """CLI face over resources.dispatch — the exact jail/validation the web
    uses, no second implementation to drift. Non-2xx prints the payload's
    error on stderr and exits 1; success prints JSON on stdout."""
    method = {"list": "GET", "show": "GET", "create": "POST",
              "enable": "PATCH", "disable": "PATCH", "delete": "DELETE"}[args.res_cmd]
    # The web API has no single-item GET: show rides the list route and
    # filters here, on the same jail-validated payload.
    if args.res_cmd in ("list", "create", "show"):
        parts = ["api", "resources", args.kind]
    else:
        parts = ["api", "resources", args.kind, args.id]
    data = {}
    if args.res_cmd in ("enable", "disable"):
        # PATCH merges only the keys present, so the toggle cannot clobber
        # description/body/config stored on the item.
        data = {"enabled": args.res_cmd == "enable"}
    if args.res_cmd == "create":
        data["id"] = args.id
        if args.description is not None:
            data["description"] = args.description
        if args.event is not None:
            data["event"] = args.event
        if args.command is not None:
            data["command"] = args.command
        if args.body is not None:
            data["body"] = args.body
        if getattr(args, "body_file", None) is not None:
            if args.body is not None:
                parser.error("--body and --body-file are mutually exclusive")
            if str(args.body_file) == "-":
                data["body"] = sys.stdin.read()
            else:
                try:
                    data["body"] = args.body_file.read_text(encoding="utf-8")
                except OSError as exc:
                    parser.error(f"--body-file unreadable: {exc.strerror}")
        data["enabled"] = not args.disable
    status, payload = resources_module.dispatch(method, parts, {}, data, _resources_ctx(args))
    if status is None:
        parser.error("unsupported resources subcommand")
    if status >= 400:
        print(f"ERROR ({status}): {payload.get('error', 'unknown')}", file=sys.stderr)
        return 1
    if args.res_cmd == "create":
        print(json.dumps(payload.get("item", {}), ensure_ascii=False, indent=2))
    elif args.res_cmd in ("enable", "disable"):
        print(json.dumps({"id": args.id, "enabled": args.res_cmd == "enable"}, ensure_ascii=False))
    elif args.res_cmd == "delete":
        print(json.dumps({"deleted": args.id}, ensure_ascii=False))
    else:
        if args.res_cmd == "show":
            items = payload.get("items", [])
            match = next((item for item in items if item.get("id") == args.id), None)
            if match is None:
                print(f"ERROR (404): resource not found: {args.id}", file=sys.stderr)
                return 1
            print(json.dumps(match, ensure_ascii=False, indent=2))
        else:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def _stream_json_event(ev) -> None:
    from .bundled_plugins.sessions import cli as owned
    return owned.stream_json_event(ev, deps=_compat_cli_dependencies(None))


def _event_renderer(language="zh"):
    from .bundled_plugins.sessions import cli as owned
    return owned.event_renderer(language, deps=_compat_cli_dependencies(None))


def _register_session_cli(commands):
    from .bundled_plugins.sessions.cli import add_parsers
    add_parsers(commands)


def _register_settings_cli(commands):
    from .bundled_plugins.settings.operator_cli import add_parsers
    add_parsers(commands)


def _register_usage_cli(commands):
    from .bundled_plugins.usage.operator_cli import add_parsers
    add_parsers(commands)


def _register_memory_cli(commands):
    from .bundled_plugins.memory.operator_cli import add_parsers
    add_parsers(commands)


def _register_git_cli(commands):
    from .bundled_plugins.git.operator_cli import add_parsers
    add_parsers(commands)


def register_builtin_cli(commands, plugin_id):
    """Compatibility delegate for callers of the former host registrar."""
    if plugin_id not in plugin_runtime.PLUGIN_IDS:
        raise ValueError("unknown builtin CLI plugin: " + str(plugin_id))
    register = getattr(plugin_runtime.entrypoint(plugin_id), "register_cli", None)
    if register:
        register(commands)


def _compat_cli_dependencies(parser):
    """Explicit compatibility seam for legacy CLI monkeypatches.

    Plugin handlers receive only this invocation's collaborators. The plugin
    owns command behavior; this object keeps patches to xueness.cli effective
    for callers that still use the historical import path.
    """
    names = (
        "MODES", "Gate", "Store", "answer_session", "run", "session_events",
        "append_user_turn", "parse_disallow_list", "activate", "plugin_sdk",
        "commands_module", "plugin_runtime", "operator_cli", "provider_config",
        "providers_api", "load_memory", "RunInterrupt", "capture_clipboard_image",
        "enqueue", "multiline", "snapshot", "lease", "TaskRegistry", "_render_event",
        "_add_agent_flags", "_model_selection_record", "_prepare_agent", "_load_commands",
        "_prompt", "_approval_prompt", "CHAT_HELP", "CHAT_HELP_EN", "_latest_chat",
        "_chat_loop", "_chat_loop_owned", "_print_summary", "_stream_json_event",
        "_event_renderer", "ExitStack", "Path", "json", "os", "shlex", "sys",
    )
    from types import SimpleNamespace
    values = {name: globals()[name] for name in names if name in globals()}
    values["parser"] = parser
    return SimpleNamespace(**values)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="xueness", description="Xueness local coding-agent harness")
    parser.add_argument("--state", type=Path, default=Path(__file__).resolve().parent.parent / ".state")
    parser.add_argument("--language", choices=("zh", "en"), default=os.environ.get("XUENESS_LANGUAGE", "zh"),
                        help="CLI language (zh or en)")
    commands = parser.add_subparsers(dest="cmd")
    plugin_runtime.register_cli_parsers(commands)
    plugin_cli.add_parsers(commands)
    res_cmd = commands.add_parser("resources",
                                  help="manage skills/commands/hooks/mcp/subagents/plugins resources")
    res_sub = res_cmd.add_subparsers(dest="res_cmd", required=True)
    res_list = res_sub.add_parser("list", help="list items of one kind (JSON)")
    res_list.add_argument("kind", choices=resources_module.KINDS)
    res_show = res_sub.add_parser("show", help="print one resource item (JSON)")
    res_show.add_argument("kind", choices=resources_module.KINDS)
    res_show.add_argument("id")
    for verb, helptext in (("create", "create a resource item"),
                           ("enable", "enable one resource item"),
                           ("disable", "disable one resource item"),
                           ("delete", "delete one resource item (config file removed; journal untouched)")):
        sub = res_sub.add_parser(verb, help=helptext)
        sub.add_argument("kind", choices=resources_module.KINDS)
        sub.add_argument("id")
        if verb == "create":
            sub.add_argument("--description", default=None)
            sub.add_argument("--event", default=None,
                             help="hooks only: hook event name")
            sub.add_argument("--command", default=None,
                             help="hooks: command; mcp config via --body-file")
            sub.add_argument("--body", default=None, help="skills/commands: inline prompt body")
            sub.add_argument("--body-file", type=Path, default=None,
                             help="skills/commands: read body from a file ('-' for stdin)")
            sub.add_argument("--disable", action="store_true",
                             help="create the item disabled (default enabled)")
    args = parser.parse_args(argv)
    if args.cmd is None:
        args = parser.parse_args(["--state", str(args.state), "--language", args.language, "chat"])
    if args.cmd in plugin_cli.GROUP_NAMES:
        return plugin_cli.execute(args)
    refusal = _require_cli_plugins(args)
    if refusal:
        print(f"ERROR: {refusal}", file=sys.stderr)
        return 1
    if args.cmd == "resources":
        return _run_resources(args, parser)
    owner = plugin_runtime.cli_owner(args.cmd, args)
    if owner is None:
        parser.error("unsupported command")
    handler = getattr(plugin_runtime.entrypoint(owner), "execute_cli", None)
    if handler is None:
        parser.error("plugin does not provide a CLI executor")
    import inspect
    if "deps" in inspect.signature(handler).parameters:
        return handler(args, deps=_compat_cli_dependencies(parser))
    return handler(args)


if __name__ == "__main__":
    sys.exit(main())
