"""Execute the real planning delivery algorithms against isolated fixtures."""
import json
import sys
import tempfile
from types import SimpleNamespace
from xueness import plugin_runtime
from xueness.bundled_plugins.planning import delivery, work_policy


def invoke(item):
    session = item.get('session', {})
    try:
        op = item['op']
        if op == 'intent':
            return {'paths': delivery._explicit_output_paths(item['task']),
                    'requested': delivery.requests_file_output(item['task'])}
        if op == 'normalize':
            return delivery.normalize(item['items'])
        if op == 'seed':
            delivery.seed(session)
            return session
        if op == 'plan':
            result = delivery.plan('.', SimpleNamespace(check=lambda *_: None),
                                   {'items': item['items']}, session, 'fixture')
            return {'items': result['items'], 'session': session}
        if op == 'policy':
            return work_policy.instructions(session)
        if op == 'guidance':
            return delivery.GUIDANCE
        if op == 'check':
            def gate(kind, path):
                if path in item.get('denied', []):
                    raise PermissionError('fixture denied')
            with tempfile.TemporaryDirectory(prefix='xue-delivery-state-') as state:
                for name in item.get('disabled', []):
                    plugin_runtime.set_enabled(state, name, False)
                return delivery.check(item['root'], SimpleNamespace(check=gate),
                                      session, item.get('summary', ''), state_dir=state)
        raise ValueError('unknown operation')
    except Exception as error:
        return {'error': type(error).__name__, 'message': str(error)}


json.dump([invoke(item) for item in json.load(sys.stdin)], sys.stdout, ensure_ascii=True)
