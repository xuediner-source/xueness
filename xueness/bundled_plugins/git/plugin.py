"""Trusted entrypoint for the git plugin."""
def register_cli(commands):
    from .operator_cli import add_parsers
    add_parsers(commands)


def execute_cli(args, deps=None):
    from .operator_cli import execute_cli as execute
    return execute(args, deps)


def dispatch(method, parts, query, data, ctx):
    from . import actions, clone, git_api, turn_checkpoints
    result = clone.dispatch(method, parts, query, data, ctx)
    if result is not None:
        return result
    result = actions.dispatch(method, parts, query, data, ctx)
    if result is not None:
        return result
    result = turn_checkpoints.dispatch(method, parts, query, data, ctx)
    return result if result is not None else git_api.dispatch(method, parts, query, data, ctx)


def before_tool_execution(payload):
    """Kernel seam: snapshot the workspace once before a turn's first change."""
    from . import turn_checkpoints
    turn_checkpoints.before_tool_execution(payload)
