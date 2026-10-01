"""Feature-owned HTTP adapters. Host supplies transport and security gates.

Host lookups intentionally remain dynamic for the historical web API/testing
surface; no copied module globals can bypass a patched runner or provider.
"""
from ... import web as host

def handle_GET(self, parts, path, data):
    ctx = self._ctx
    if len(parts) == 4 and parts[0] == 'api' and (parts[1] == 'sessions') and (parts[3] == 'files') and host._valid_sid(parts[2]):
        try:
            session = ctx['store'].load(parts[2])
        except (OSError, ValueError):
            self._send(404, {'error': 'session not found'})
            return True
        try:
            listing = host.workspace_files(host.Path(session['root']))
        except (OSError, ValueError):
            self._send(400, {'error': 'cannot list workspace'})
            return True
        self._send(200, {'id': session['id'], **listing})
        return True
    if len(parts) == 4 and parts[0] == 'api' and (parts[1] == 'sessions') and (parts[3] == 'file') and host._valid_sid(parts[2]):
        try:
            session = ctx['store'].load(parts[2])
        except (OSError, ValueError):
            self._send(404, {'error': 'session not found'})
            return True
        query = host.urllib.parse.parse_qs(host.urllib.parse.urlparse(self.path).query)
        relative = (query.get('path') or [''])[0]
        suffix = host.Path(relative.strip()).suffix.lower() if relative.strip() else ''
        if suffix in host.BINARY_PREVIEW_SUFFIXES:
            try:
                preview = host.workspace_image_preview(host.Path(session['root']), relative)
            except PermissionError:
                self._send(400, {'error': 'path outside workspace'})
                return True
            except (OSError, ValueError, UnicodeDecodeError):
                self._send(400, {'error': 'cannot preview file'})
                return True
            self._send(200, {'id': session['id'], **preview})
            return True
        try:
            preview = host.workspace_preview(host.Path(session['root']), relative)
        except PermissionError:
            self._send(400, {'error': 'path outside workspace'})
            return True
        except (OSError, ValueError, UnicodeDecodeError):
            self._send(400, {'error': 'cannot preview file'})
            return True
        self._send(200, {'id': session['id'], **preview})
        return True
    return False

def dispatch(method, parts, query, data, ctx):
    handler = ctx.get('handler')
    route = globals().get('handle_' + method)
    if handler is None or route is None:
        return None
    from urllib.parse import urlparse
    if route(handler, parts, urlparse(handler.path).path, data):
        return host.HANDLED_RESPONSE
    return None
