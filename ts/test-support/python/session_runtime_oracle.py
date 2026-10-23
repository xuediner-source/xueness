"""Real sessions runtime controls; only storage and external model calls are isolated."""
import copy
import json
import sys
import tempfile
from types import SimpleNamespace
from xueness import plugin_runtime
from xueness.bundled_plugins.sessions import auto_title, manual_compact, model_switch


def invoke(item):
    try:
        op = item['op']
        if op == 'normalize':
            return model_switch.normalize(item['request'])
        if op == 'target':
            return model_switch.parse_target(item['text'])
        if op == 'selection':
            p, m, e = model_switch.plan_selection(item['previous'], item['fields'])
            return model_switch.selection_record(p, m, e)
        if op == 'record':
            s = item['session']
            model_switch.record_switch(s, item['previous'], item['selected'])
            s['model_history'][-1]['at'] = 'STAMP'
            return s
        if op == 'title':
            return auto_title.title_from_model(item['text'])
        if op == 'title_inputs':
            s = item['session']
            exchange = auto_title.first_exchange(s)
            return {'needs': auto_title.needs_title(s), 'child': auto_title.is_child_session(s),
                    'exchange': exchange,
                    'prompt': auto_title.build_prompt(s.get('task'), *exchange) if exchange else None}
        if op == 'compact':
            session = item['session']
            saves = []
            store = SimpleNamespace(load=lambda _: copy.deepcopy(session),
                                    save=lambda s: saves.append(copy.deepcopy(s)))
            with tempfile.TemporaryDirectory(prefix='xue-compact-state-') as state:
                if item.get('disabled'):
                    plugin_runtime.set_enabled(state, 'sessions', False)
                result = manual_compact.compact_now(store, session['id'], item.get('note'),
                    state_dir=state, source=item.get('source', 'http'), budget=item.get('budget'))
            return {'result': result, 'saves': saves}
        raise ValueError('unknown operation')
    except Exception as error:
        if isinstance(error, manual_compact.CompactError):
            return {'error': error.payload()}
        return {'error': type(error).__name__, 'message': str(error)}


json.dump([invoke(item) for item in json.load(sys.stdin)], sys.stdout, ensure_ascii=True)
