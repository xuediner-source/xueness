"""Trusted entrypoint for the sessions plugin."""


def register_cli(commands):
    from .cli import add_parsers
    from .operator_cli import add_session_parsers
    add_parsers(commands)
    add_session_parsers(commands)


def execute_cli(args, deps=None):
    from .cli import execute_cli as execute
    return execute(args, deps)


def dispatch(method, parts, query, data, ctx):
    from .composer_api import dispatch as composer_dispatch
    result = composer_dispatch(method, parts, query, data, ctx)
    if result is not None:
        return result
    from .deltas import dispatch as delta_dispatch
    result = delta_dispatch(method, parts, query, data, ctx)
    if result is not None:
        return result
    from .sessions_api import dispatch as session_dispatch
    result = session_dispatch(method, parts, query, data, ctx)
    if result is not None:
        return result
    from .http_routes import dispatch as http_dispatch
    return http_dispatch(method, parts, query, data, ctx)


def tools():
    from .tooling import REGISTRY
    return REGISTRY
