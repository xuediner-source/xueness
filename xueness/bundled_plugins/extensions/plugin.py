"""Manifest marketplace contribution."""
def dispatch(method,parts,query,data,ctx):
    from .marketplace import dispatch as route
    return route(method,parts,query,data,ctx)
