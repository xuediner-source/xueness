"""Trusted entrypoint for the files plugin."""
def dispatch(method, parts, query, data, ctx):
    from . import directory_api
    result = directory_api.dispatch(method, parts, query, data, ctx)
    if result is not None:
        return result
    from .http_routes import dispatch as http_dispatch
    return http_dispatch(method, parts, query, data, ctx)


def tools():
    from .builtin_tools import REGISTRY
    return REGISTRY
