"""Resolve subscription models through the same host-owned conversation seam."""
from __future__ import annotations
from . import broker, state


class NativeProvider:
    def __init__(self, state_dir, record, reasoning_effort=None):
        self.state_dir = state_dir
        self.account_id = record['subscriptionId']
        self.model = record['model']
        self.base = record['baseUrl']
        self.reasoning_effort = reasoning_effort
        self.capabilities = frozenset(record.get('capabilities', []))
        self.runtime_profile = 'standard'
        self.context_window = record.get('contextWindow')
        self.max_output_tokens = record.get('maxOutputTokens')
        self.tool_calling = 'native'
        self.compatibility = {}
        self.lightweight_options = {}
        self.protocol = 'openai'
        self.session_id = None

    def complete(self, messages, tools):
        return self.stream(messages, tools)

    def stream(self, messages, tools, on_delta=None, on_reasoning_delta=None):
        state.require_available(self.state_dir)
        def emit(chunk):
            if not isinstance(chunk, dict) or not isinstance(chunk.get('text'), str):
                return
            callback = on_delta if chunk.get('type') == 'content' else on_reasoning_delta if chunk.get('type') == 'reasoning' else None
            if callback:
                from ..providers.provider import _notify_stream_callback
                _notify_stream_callback(callback, chunk['text'])
        from ..providers.provider import ProviderRequestError, _explicit_request_deadline
        try:
            deadline = _explicit_request_deadline(self)
            result = broker.call(self.state_dir, 'generate', self.account_id,
                                  {'model': self.model, 'messages': messages, 'tools': tools or [],
                                   'sessionId': self.session_id, 'reasoningEffort': self.reasoning_effort,
                                   'maxTokens': self.max_output_tokens}, emit,
                                 **({'request_deadline': deadline} if deadline is not None else {}))
        except broker.SubscriptionRequestError as error:
            raise ProviderRequestError(error.status, category=error.category,
                                       context_overflow=error.category == 'context_overflow',
                                       stage='response', exception_type=type(error).__name__) from None
        state.require_available(self.state_dir)
        if not isinstance(result, dict) or not isinstance(result.get('content'), str) or not isinstance(result.get('tool_calls'), list):
            raise ProviderRequestError(category='invalid_response', stage='parse')
        from ..providers.response_metadata import reported_usage
        usage = reported_usage(result.get('_usage'))
        result.pop('_usage', None)
        if usage:
            result['_usage'] = usage
        result['_request_attempts'] = 1
        return result


def resolve(state_dir, record, model=None, reasoning_effort=None, runtime_profile=None):
    state.require_available(state_dir)
    item = state.definition(record['subscriptionId'])
    if not item:
        raise ValueError('subscription provider not found')
    if model is not None and model != record['model']:
        raise ValueError('select a subscription model from the catalog')
    if runtime_profile not in (None, 'standard'):
        raise ValueError('subscription models use the standard runtime')
    if reasoning_effort is not None and reasoning_effort not in record.get('reasoningLevels', []):
        raise ValueError('subscription model does not declare this reasoning effort')
    return NativeProvider(state_dir, record, reasoning_effort)
