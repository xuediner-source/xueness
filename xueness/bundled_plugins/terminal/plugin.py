"""Trusted entrypoint for the terminal plugin."""
def dispatch(method, parts, query, data, ctx):
    from . import terminals
    return terminals.dispatch(method, parts, query, data, ctx)


def create_service():
    from .terminals import Broker
    return Broker()
