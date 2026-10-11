"""Fixed bundled feature; marketplace resource is an inert opt-in marker."""
from ...plugin_contract import Plugin
import re

PACKAGE_ID = 'xueness-model-monitor'
MARKET_MANIFEST = {'id': PACKAGE_ID, 'version': '1.0.0', 'apiVersion': 1,
                   'builtin': 'model_monitor', 'capabilities': [], 'enabled': False}


class ModelMonitorPlugin(Plugin):
    def load(self, state_dir, root, session):
        return {}


def dispatch(method, parts, query, data, ctx):
    if parts[:2] != ['api', 'model_monitor']:
        return None
    from . import observer
    try:
        observer.require_available(ctx['state_dir'])
        if method == 'GET' and len(parts) == 2:
            session_id = query.get('session_id', [None])[0]
            if session_id is not None and (not isinstance(session_id, str) or not re.fullmatch(r'[0-9a-f]{32}', session_id)):
                return 400, {'error': 'invalid session id'}
            return 200, {'observations': observer.read(ctx['state_dir'], session_id)}
        if method == 'POST' and len(parts) == 3 and parts[2] == 'clear':
            if data != {'confirmed': True}:
                return 400, {'error': 'confirm clearing local monitoring records'}
            observer.clear(ctx['state_dir'])
            return 200, {'cleared': True, 'observations': []}
        return 405, {'error': 'method not allowed'}
    except (OSError, ValueError):
        return 400, {'error': 'model monitoring records unavailable'}
