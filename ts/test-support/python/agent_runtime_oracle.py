"""Differential oracle for providers-owned lightweight prompt/runtime helpers."""
import json
import sys
from types import SimpleNamespace
from xueness.bundled_plugins.providers import lightweight as lw
from xueness.bundled_plugins.providers import context_budget as cb


def provider(data):
    mapping = {'contextWindow': 'context_window', 'maxOutputTokens': 'max_output_tokens',
               'toolCalling': 'tool_calling', 'lightweightOptions': 'lightweight_options'}
    return SimpleNamespace(**{mapping.get(key, key): value for key, value in data.items()})


def invoke(data):
    op = data['op']
    client = provider(data.get('provider', {}))
    if op == 'decode':
        lw.uuid.uuid4 = lambda: SimpleNamespace(hex='fixed')
        return lw.decode_text_response(data['response'], data['tools'])
    if op == 'stream':
        return lw.stream_answer_text(data['text'])
    if op == 'partial':
        return lw.partial_answer(data['response'], data.get('json', False))
    if op == 'text':
        return lw.text_messages(data['messages'])
    if op == 'window':
        return lw._window_result(data['message'], data.get('limit', 1400), data.get('pageLimit', 1200))
    if op == 'select':
        policy = data.get('policy', {})
        gate = SimpleNamespace(disallow=policy.get('disallow', []),
            allowed_tool_names=policy.get('allowed'), denied_tool_names=policy.get('denied', []))
        return lw.select_tools(data['tools'], data['session'], gate, client)
    if op == 'prompt':
        mapping = {'maxChars': 'max_chars', 'maxTokens': 'max_tokens', 'hostInstructions': 'host_instructions'}
        kwargs = {mapping.get(key, key): value for key, value in data.get('options', {}).items()}
        try:
            return {'result': lw.prompt_view(data['messages'], data['tools'], client, **kwargs)}
        except Exception as error:
            return {'error': type(error).__name__, 'message': str(error)}
    if op == 'budget':
        session = data['session']
        cb.observe_usage(session, client, data['usage'])
        return {'key': cb.provider_key(client), 'session': session,
                'factor': cb.calibration_factor(session.get('runtime_budget_calibration'), client)}
    raise ValueError('unknown operation')


json.dump([invoke(item) for item in json.load(sys.stdin)], sys.stdout, ensure_ascii=True)
