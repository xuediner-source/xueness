"""Trusted entrypoint for the git plugin."""
def register_cli(commands):
    from .operator_cli import add_parsers
    add_parsers(commands)


def execute_cli(args, deps=None):
    from .operator_cli import execute_cli as execute
    return execute(args, deps)


def dispatch(method, parts, query, data, ctx):
    from . import git_api, actions
    result = actions.dispatch(method, parts, query, data, ctx)
    return result if result is not None else git_api.dispatch(method, parts, query, data, ctx)
