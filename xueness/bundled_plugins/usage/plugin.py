"""Trusted entrypoint for the usage plugin."""
def register_cli(commands):
    from .operator_cli import add_parsers
    add_parsers(commands)


def execute_cli(args, deps=None):
    from .operator_cli import execute_cli as execute
    return execute(args, deps)


def dispatch(method, parts, query, data, ctx):
    from . import usage_api
    return usage_api.dispatch(method, parts, query, data, ctx)
