"""Pi-lite model transport; the host retains sessions, tools and approvals."""
from __future__ import annotations

import time
import uuid

from ... import plugin_runtime
from ..providers.proxy import ProviderProxy
from ..providers.provider import ProviderRequestError
from ..providers.cancel_watch import ProviderCancelled
from .pi_sidecar import PiLiteSidecarSupervisor, SidecarProtocolError, start_local_provider
from .pi_sidecar_process import _local_provider
from .runtime import PROTOCOL_VERSION, validate_stream_chunk


class PiLiteProvider(ProviderProxy):
    _proxy_fields = ProviderProxy._proxy_fields | {
        'session_id', 'holder', 'should_stop', 'supervisor',
    }

    def __init__(self, provider, state_dir, session, *, should_stop=None, supervisor=None):
        self.provider = provider
        self.state_dir = state_dir
        self.session_id = session['id']
        self.holder = session
        self.should_stop = should_stop
        self.supervisor = supervisor or PiLiteSidecarSupervisor(state_dir)

    def complete(self, messages, tools):
        return self.stream(messages, tools)

    def stream(self, messages, tools, on_delta=None, on_reasoning_delta=None):
        # Accessing the switcher's request method applies a queued model switch
        # before capturing its selection; it never sends a request in the host.
        getattr(self.provider, 'stream')
        if not _local_provider(self.provider):
            raise ValueError('pi-lite requires a loopback provider endpoint')
        if getattr(self.provider, 'runtime_profile', None) != 'lightweight':
            raise ValueError('pi-lite requires the lightweight provider profile')
        live_session = getattr(self.provider, 'session', None)
        holder = live_session if isinstance(live_session, dict) else self.holder
        selection = holder.get('model_selection') or {}
        provider_id = getattr(self.provider, 'provider_id', selection.get('provider_id'))
        payload = {
            'providerId': provider_id,
            'model': self.provider.model,
            'reasoningEffort': getattr(self.provider, 'reasoning_effort', None),
            'expectedBase': self.provider.base,
            'messages': messages, 'tools': tools,
            'runtimeOptions': {
                'runtimeProfile': 'lightweight',
                'contextWindow': self.provider.context_window,
                'maxOutputTokens': self.provider.max_output_tokens,
                'toolCalling': self.provider.tool_calling,
                'compatibility': dict(self.provider.compatibility or {}),
                'lightweightOptions': dict(self.provider.lightweight_options or {}),
            },
        }
        # One child per inference makes cleanup independent of provider copies,
        # queued turns, failed callbacks and later model switches.
        sidecar_id = uuid.uuid4().hex
        request = {'version': PROTOCOL_VERSION, 'requestId': sidecar_id,
                   'sessionId': self.session_id, 'method': 'turn/start', 'payload': payload}
        deadline = getattr(self.provider, 'request_deadline', None)
        timeout = max(0, deadline - time.monotonic()) if deadline is not None else 120
        if timeout <= 0:
            raise ProviderRequestError(category='timeout', stage='deadline')
        payload['timeoutSeconds'] = timeout

        def stopping():
            if self.should_stop is not None and self.should_stop():
                return True
            return any(not plugin_runtime.is_enabled(self.state_dir, pid)
                       for pid in ('runtimes', 'sessions', 'providers'))

        def consume(frame):
            if not frame['ok']:
                details = frame.get('error', {}).get('details') or {}
                raise ProviderRequestError(
                    status=details.get('status'), category=details.get('category', 'request_failed'),
                    context_overflow=details.get('contextOverflow') is True,
                    stage=details.get('stage', 'response'))
            chunk = frame['payload']
            if chunk.get('type') == 'result':
                if set(chunk) != {'type', 'result'} or not isinstance(chunk['result'], dict):
                    raise SidecarProtocolError('invalid pi-lite result')
                return
            validate_stream_chunk(chunk)
            if chunk['type'] == 'text-delta' and on_delta is not None:
                on_delta(chunk['text'])
            elif chunk['type'] == 'reasoning-delta' and on_reasoning_delta is not None:
                on_reasoning_delta(chunk['text'])

        if stopping():
            raise ProviderCancelled()
        try:
            sidecar = start_local_provider(self.supervisor, sidecar_id, session_profile='pi-lite')
            final = sidecar.request_stream(request, consume, timeout=timeout, should_stop=stopping)
            return final['payload']['result']
        finally:
            self.supervisor.stop(sidecar_id, grace=0.5)


def for_session(provider, state_dir, session, *, should_stop=None, supervisor=None,
                runtime_profile=None):
    """Select the trusted model transport without moving host tool execution."""
    if session.get('runtime_mode') != 'pi-lite':
        return provider
    for pid in ('runtimes', 'sessions', 'providers'):
        plugin_runtime.require_enabled(state_dir, pid)
    profile = runtime_profile or session.get('runtime_profile') or getattr(provider, 'runtime_profile', None)
    if profile != 'lightweight':
        raise ValueError('pi-lite requires the lightweight provider profile')
    if not _local_provider(provider):
        raise ValueError('pi-lite requires a loopback provider endpoint')
    return PiLiteProvider(provider, state_dir, session,
                          should_stop=should_stop, supervisor=supervisor)
