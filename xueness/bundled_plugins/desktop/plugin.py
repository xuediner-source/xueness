"""Desktop metadata belongs to a feature plugin; hosting also provides recovery."""
def dispatch(method, parts, query, data, ctx):
    if parts == ['api', 'desktop', 'status'] and method == 'GET':
        from .host import desktop_status
        return 200, desktop_status(ctx)
    return None
