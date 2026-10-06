"""Desktop metadata belongs to a feature plugin; hosting also provides recovery."""
def dispatch(method, parts, query, data, ctx):
    from .permissions import dispatch as dispatch_permissions
    permission_result = dispatch_permissions(method, parts, query, data, ctx)
    if permission_result is not None:
        return permission_result
    if parts == ['api', 'desktop', 'tray']:
        if method != 'GET':
            return 405, {'error': 'method not allowed'}
        if not ctx.get('desktop_token'):
            return 403, {'error': 'desktop host required'}
        from pathlib import Path
        from ...http_contract import HANDLED_RESPONSE
        root = Path(ctx['webapp_dir']).resolve()
        page = root/'tray.html'
        if page.resolve().parent != root or page.is_symlink():
            return 404, {'error': 'not found'}
        try:
            body = page.read_bytes()
        except OSError:
            return 503, {'error': 'ui asset missing'}
        ctx['handler']._send(200, body, 'text/html; charset=utf-8')
        return HANDLED_RESPONSE
    if parts == ['api', 'desktop', 'status'] and method == 'GET':
        from .host import desktop_status
        return 200, desktop_status(ctx)
    return None
