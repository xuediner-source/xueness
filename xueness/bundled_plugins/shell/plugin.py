"""Trusted entrypoint for the shell plugin."""


def tools():
    from .tooling import REGISTRY
    return REGISTRY
