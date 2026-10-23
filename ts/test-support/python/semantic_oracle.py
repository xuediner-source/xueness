"""Run real semantic compaction with only the model and clock scripted."""
import copy
import json
import sys
from types import SimpleNamespace
from unittest.mock import patch
from xueness import plugin_runtime
from xueness.bundled_plugins.providers import semantic_compaction as sc


def invoke(data):
    session = copy.deepcopy(data['session'])
    requests, saves = [], []
    stopped = [False]
    provider = SimpleNamespace(context_window=data.get('contextWindow'), max_output_tokens=data.get('maxOutputTokens'))

    def model_json(client, prompt, **kwargs):
        requests.append(copy.deepcopy(prompt))
        payload = json.loads(prompt[1]['content'])
        raw = {key: [] for key in sc.SECTIONS}
        raw['requirements'] = ['Preserved human requirements']
        raw['verification'] = ['Only observed tool records are verification facts']
        raw['coveredMessageIds'] = payload['requiredCoverage']
        mode = data.get('mode')
        if mode == 'invalid':
            raw['coveredMessageIds'] = []
        if mode == 'mutate':
            session['messages'][1]['content'] += ' changed by callback'
        if mode == 'cancel':
            stopped[0] = True
        return raw, {'prompt_tokens': 10, 'completion_tokens': 3, 'total_tokens': 13}

    class Store:
        def save(self, value):
            if data.get('mode') == 'save_error':
                raise OSError('save failed')
            saves.append(copy.deepcopy(value))

    with patch.object(plugin_runtime, 'is_enabled', lambda *args: data.get('enabled', True)), \
         patch.object(sc, 'model_json', model_json), patch.object(sc, 'stamp', lambda: '2026-10-18T00:00:00.000+00:00'), \
         patch.object(sc.uuid, 'uuid4', lambda: SimpleNamespace(hex='b' * 32)):
        try:
            result = sc.before_model_request(session, provider, state_dir=None,
                max_chars=data.get('maxChars', 4096), max_tokens=data.get('maxTokens'),
                should_stop=lambda: stopped[0], store=Store())
        except Exception as error:
            result = {'error': type(error).__name__, 'message': str(error)}
    return {'result': result, 'session': session, 'requests': requests, 'saves': saves}


json.dump([invoke(item) for item in json.load(sys.stdin)], sys.stdout, ensure_ascii=True)
