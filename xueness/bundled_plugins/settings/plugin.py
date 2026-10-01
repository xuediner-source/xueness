"""Trusted entrypoint for the settings plugin."""
def register_cli(commands):
    from .operator_cli import add_parsers
    add_parsers(commands)


def execute_cli(args, deps=None):
    from .operator_cli import execute_cli as execute
    return execute(args, deps)


def dispatch(method, parts, query, data, ctx):
    from . import settings_store, workspaces_api
    workspace_response = workspaces_api.dispatch(method, parts, query, data, ctx)
    if workspace_response is not None:
        return workspace_response
    return settings_store.dispatch(method, parts, query, data, ctx)
