"""Real planning goal lifecycle and verifier; only the external model is scripted."""
import json
import sys
import tempfile
from types import SimpleNamespace
from xueness import plugin_runtime
from xueness.bundled_plugins.planning import goal_driver as driver, session_goal
from xueness.bundled_plugins.providers import semantic_compaction


def invoke(item):
    session = item.get('session', {})
    requests = []
    clock = [100.0]
    driver.time = SimpleNamespace(monotonic=lambda: clock[0])
    driver._stamp = lambda: '2026-10-18T00:00:00+00:00'
    try:
        op = item['op']
        if op == 'evidence':
            final, rows, ids = driver._evidence(session)
            return {'final': final, 'rows': rows, 'ids': sorted(ids),
                    'failures': driver._delivery_failures(session),
                    'response': driver._has_model_response(session)}
        if op == 'verdict':
            return driver._validate_verdict(item['raw'], set(item['ids']))
        if op == 'completion':
            return {'reminder': session_goal.reminder(session),
                    'check': session_goal.merge_completion_check(item['delivery'],
                            session_goal.verify(session, item['summary']))}
        if op == 'before':
            with tempfile.TemporaryDirectory(prefix='xue-goal-state-') as state:
                if item.get('disabled'):
                    plugin_runtime.set_enabled(state, 'planning', False)
                result = driver.before_run(session, state)
            return {'result': result, 'session': session}
        if op == 'after':
            def model_json(provider, messages, **options):
                requests.append({'messages': messages,
                    'outputTokens': options['output_tokens'], 'timeoutSeconds': options['timeout_seconds'],
                    'deadline': options.get('request_deadline')})
                clock[0] += 2
                if item.get('error'):
                    raise ValueError(item['error'])
                if item.get('verdict') is not None:
                    raw = item['verdict']
                else:
                    payload = json.loads(messages[1]['content'])
                    raw = {'passed': True, 'reason': 'All criteria are established.',
                           'remaining': [], 'evidenceIds': [payload['evidence'][-1]['id']]}
                return raw, item.get('usage', {'total_tokens': 20})
            semantic_compaction.model_json = model_json
            with tempfile.TemporaryDirectory(prefix='xue-goal-state-') as state:
                if item.get('disabled'):
                    plugin_runtime.set_enabled(state, 'planning', False)
                result = driver.after_run(session, SimpleNamespace(), state, '.', None,
                    lambda: item.get('stopped', False), item.get('deadline'), item.get('elapsed', 4))
            return {'result': result, 'session': session, 'requests': requests}
        raise ValueError('unknown operation')
    except Exception as error:
        return {'error': type(error).__name__, 'message': str(error)}


json.dump([invoke(item) for item in json.load(sys.stdin)], sys.stdout, ensure_ascii=True)
