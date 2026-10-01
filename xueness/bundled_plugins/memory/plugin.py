"""Trusted entrypoint for the memory plugin."""
def register_cli(commands):
    from .operator_cli import add_parsers
    add_parsers(commands)


def execute_cli(args, deps=None):
    from .operator_cli import execute_cli as execute
    return execute(args, deps)


def dispatch(method, parts, query, data, ctx):
    from . import memory_api, editor, catalog
    result = catalog.dispatch(method, parts, query, data, ctx)
    if result is not None:
        return result
    result = editor.dispatch(method, parts, query, data, ctx)
    return result if result is not None else memory_api.dispatch(method, parts, query, data, ctx)
