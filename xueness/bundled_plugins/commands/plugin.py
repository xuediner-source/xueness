"""Trusted entrypoint for the commands plugin."""
from __future__ import annotations


def register_cli(commands):
    from .commands_cli import add_parsers
    add_parsers(commands)


def execute_cli(args):
    from .commands_cli import execute
    return execute(args)


def execute_slash(name, argument, ctx):
    """In-chat ``/commands`` entry contributed through plugin_runtime.dispatch_slash.

    Only ``commands`` is claimed here; any other name returns ``None`` so the
    chat loop keeps its existing behavior.
    """
    if name != "commands":
        return None
    from . import commands_cli
    return commands_cli.handle_slash(argument, ctx)


def dispatch(method, parts, query, data, ctx):
    from . import files_api
    return files_api.dispatch(method, parts, query, data, ctx)
