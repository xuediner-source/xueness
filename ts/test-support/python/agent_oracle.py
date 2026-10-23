"""Real Python core oracle; scripts replace only external model/tool effects."""
import copy
import json
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

from xueness import core, plugin_runtime


def projection(session):
    fields = ('status', 'steps', 'results', 'completion', 'completion_history',
              'pause_code', 'pause_reason', 'pending_question',
              'completion_reference_repair', 'completion_reference_repairs')
    result = {key: session[key] for key in fields if key in session}
    result['messages'] = [{key: value for key, value in item.items()
                           if not key.startswith('_')} for item in session['messages']]
    return result


def scripted_run(data):
    with tempfile.TemporaryDirectory(prefix='xueness-agent-oracle-') as directory:
        root = Path(directory)
        session = copy.deepcopy(data['session'])
        session['root'] = str(root)

        class Store:
            directory = root

            def save(self, value):
                core._ensure_message_identity(value)

        class Provider:
            runtime_profile = 'standard'
            tool_calling = 'native'
            max_output_tokens = None
            context_window = None

            def __init__(self):
                self.responses = iter(copy.deepcopy(data['responses']))

            def complete(self, messages, tools):
                return next(self.responses)

        outcomes = iter(copy.deepcopy(data.get('outcomes', [])))

        def dispatch(*args):
            return next(outcomes)

        schemas = [{'type': 'function', 'function': {'name': 'read',
                    'description': 'Scripted test read',
                    'parameters': {'type': 'object', 'properties': {}}}}]
        patches = {
            'is_enabled': lambda state, pid: pid in ('providers', 'sessions', 'files'),
            'before_run': lambda *args, **kwargs: {'enabled': False},
            'after_run': lambda *args, **kwargs: {},
            'run_started': lambda *args, **kwargs: None,
            'settle_run': lambda *args, **kwargs: None,
            'before_model_request': lambda *args, **kwargs: None,
            'completion_instructions': lambda *args, **kwargs: [],
            'completion_checks': lambda *args, **kwargs: {},
            'completion_requires_evidence': lambda *args, **kwargs: False,
            'tool_schemas': lambda *args: schemas,
        }
        with patch.multiple(plugin_runtime, **patches), patch.object(core, 'dispatch', dispatch):
            core.run(session, Store(), Provider(), core.Gate(root),
                     max_steps=data.get('maxSteps', 8), max_chars=data.get('maxChars', 24000))
        return projection(session)


def invoke(data):
    op = data['op']
    if op == 'run':
        return scripted_run(data)
    if op == 'compact':
        session = data['session']
        core.compact(session, data['maxChars'], data.get('maxTokens'), data.get('instructions'))
        return session
    if op == 'partition':
        return [{**unit, 'ids': sorted(unit['ids'])} for unit in core._partition_units(data['messages'])]
    if op == 'completion':
        session = data['session']
        aliases = core.evidence_aliases(session)
        ids = core._current_turn_tool_ids(session)
        result = {'aliases': aliases, 'ids': ids,
                  'currentAliases': core._current_turn_aliases(aliases, ids),
                  'toolStatus': core._tool_execution_status(session, ids),
                  'turnId': core._turn_id(session),
                  'assessment': core.assess(data['content'], session.get('results', {}),
                     data.get('aliases', aliases), native_references=data.get('native', False))}
        if 'record' in data:
            core._record_completion_history(session, data['record'])
            result['history'] = session['completion_history']
        return result
    if op == 'validate':
        try:
            return {'result': core.validate_message(data['message'], used_ids=data.get('usedIds', []))}
        except Exception as error:
            return {'error': type(error).__name__, 'message': str(error)}
    raise ValueError('unknown operation')


items = json.load(sys.stdin)
json.dump([invoke(item) for item in items], sys.stdout, ensure_ascii=True)
