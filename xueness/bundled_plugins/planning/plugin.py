"""Trusted entrypoint for the planning plugin."""


def tools():
    from .tooling import REGISTRY
    return REGISTRY
