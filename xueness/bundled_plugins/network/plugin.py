"""Trusted public web tools contribution."""
def tools():
    from .tooling import REGISTRY
    return REGISTRY

def composer_capabilities():
    from .composer_capabilities import CAPABILITIES
    return CAPABILITIES

def dispatch(method, parts, query, data, ctx):
    from .settings_api import dispatch as settings_dispatch
    return settings_dispatch(method, parts, query, data, ctx)
