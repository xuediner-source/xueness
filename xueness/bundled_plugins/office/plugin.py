"""Trusted entrypoint for the office plugin."""


def tools():
    from .tooling import REGISTRY
    return REGISTRY


def composer_capabilities():
    from .composer_capabilities import CAPABILITIES
    return CAPABILITIES
