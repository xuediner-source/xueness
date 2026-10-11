"""Passive response identity, metadata provenance and independent opt-in."""
from copy import copy
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from xueness import plugin_runtime, plugin_sdk
from xueness.bundled_plugins.model_monitor import observer, plugin
from xueness.bundled_plugins.providers.provider import OpenAICompatible, _with_reported_usage, _read_openai_stream, _read_anthropic_stream


class ModelMonitorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)

    def enable(self):
        self.assertTrue(plugin_sdk.install_all(self.state, [plugin.MARKET_MANIFEST])['ok'])
        plugin_runtime.set_enabled(self.state, 'model_monitor', True)

    def test_no_recording_before_install_or_when_disabled(self):
        provider = OpenAICompatible(base='https://example.test/v1', model='requested', key='fake')
        self.assertIs(observer.wrap(self.state, 'test', provider), provider)
        observer.record(self.state, 'test', provider, {'_response_models': ['returned']})
        self.assertFalse((self.state / 'model-monitor').exists())
        self.enable(); wrapped = observer.wrap(self.state, 'test', provider)
        plugin_runtime.set_enabled(self.state, 'model_monitor', False)
        with patch.object(provider, 'complete', return_value={'content': 'real fixture text', 'tool_calls': [], '_response_models': ['returned']}) as request:
            self.assertEqual(wrapped.complete([], [])['content'], 'real fixture text')
        request.assert_called_once(); self.assertEqual(observer.read(self.state), [])

    def test_payload_model_overrides_assistant_injected_metadata(self):
        reply = _with_reported_usage({'content': 'I am some other model', '_response_models': ['spoofed']}, {'model': 'wire-reported'})
        self.assertEqual(reply['_response_models'], ['wire-reported'])
        reply = _with_reported_usage({'content': 'I am a model', '_response_models': ['spoofed']}, {})
        self.assertNotIn('_response_models', reply)

    def test_saved_default_is_named_in_monitoring_records(self):
        from xueness.bundled_plugins.providers import provider_config, providers_api, default_selection
        self.enable()
        status, _ = providers_api._handle_save({'state_dir': self.state}, {
            'id': 'saved', 'name': 'Saved fixture', 'baseUrl': 'https://example.test/v1',
            'model': 'requested', 'apiKey': 'fake-secret', 'protocol': 'openai'})
        self.assertEqual(status, 200)
        default_selection.save(self.state, {'providerId': 'saved', 'model': 'requested'})
        wrapped = provider_config.resolve(self.state)
        with patch.object(wrapped.provider, 'complete', return_value={'content': 'fixture', 'tool_calls': [], '_response_models': ['wire']}):
            wrapped.complete([], [])
        self.assertEqual(observer.read(self.state)[0]['providerId'], 'saved')

    def test_session_observations_exclude_other_chats_and_legacy_rows(self):
        self.enable()
        provider = OpenAICompatible(base='https://example.test/v1', model='requested', key='fake')
        first, second = 'a' * 32, 'b' * 32
        for sid in (None, first, second):
            observer.record(self.state, 'test', provider, {'_response_models': ['wire']}, session_id=sid)
        self.assertEqual(len(observer.read(self.state)), 3)
        self.assertEqual([row['sessionId'] for row in observer.read(self.state, first)], [first])
        status, body = plugin.dispatch('GET', ['api', 'model_monitor'], {'session_id': [second]}, {}, {'state_dir': self.state})
        self.assertEqual(status, 200)
        self.assertEqual([row['sessionId'] for row in body['observations']], [second])
        self.assertEqual(plugin.dispatch('GET', ['api', 'model_monitor'], {'session_id': ['../secret']}, {}, {'state_dir': self.state})[0], 400)

    def test_resolved_session_identity_survives_cloning(self):
        from xueness.bundled_plugins.providers import provider_config, providers_api
        self.enable()
        providers_api._handle_save({'state_dir': self.state}, {'id': 'session-test', 'name': 'Test', 'baseUrl': 'https://example.test/v1',
            'model': 'requested', 'apiKey': 'fake', 'protocol': 'openai'})
        wrapped = provider_config.resolve(self.state, 'session-test', session_id='a' * 32)
        clone = copy(wrapped)
        with patch.object(clone.provider, 'complete', return_value={'content': 'fixture', 'tool_calls': [], '_response_models': ['wire']}):
            clone.complete([], [])
        self.assertEqual(observer.read(self.state, 'a' * 32)[0]['requestedModel'], 'requested')

    def test_stream_model_is_captured_from_envelope_for_both_protocols(self):
        metadata = {}
        raw = b'data: {"model":"alias","choices":[{"delta":{"content":"a"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        _read_openai_stream(BytesIO(raw), None, lambda: None, finish_metadata=metadata)
        self.assertEqual(metadata['_response_models'], ['alias'])
        metadata = {}
        raw = b'data: {"type":"message_start","message":{"model":"claude-alias","usage":{}}}\n\ndata: {"type":"message_stop"}\n\n'
        _read_anthropic_stream(BytesIO(raw), None, lambda: None, finish_metadata=metadata)
        self.assertEqual(metadata['_response_models'], ['claude-alias'])

    def test_decorator_preserves_protocol_type_and_isolates_child_clones(self):
        self.enable()
        provider = OpenAICompatible(base='https://example.test/v1', model='parent', key='fake-secret')
        wrapped = observer.wrap(self.state, 'test', provider)
        self.assertIsInstance(wrapped, OpenAICompatible)
        self.assertEqual(wrapped.protocol, 'openai')
        clone = copy(wrapped); clone.model = 'child'
        self.assertEqual(provider.model, 'parent')
        self.assertEqual(clone.model, 'child')
        with patch.object(provider, 'complete', return_value={'content': 'PRIVATE PROMPT RESPONSE', 'tool_calls': [], '_response_models': ['wire']}) as request:
            wrapped.complete([{'role': 'user', 'content': 'PRIVATE PROMPT'}], [])
        self.assertEqual(request.call_count, 1)
        rows = observer.read(self.state)
        self.assertEqual(rows[0]['requestedModel'], 'parent')
        self.assertEqual(rows[0]['returnedModels'], ['wire'])
        raw = observer._path(self.state).read_text(encoding='utf-8')
        self.assertNotIn('PRIVATE', raw); self.assertNotIn('fake-secret', raw)
        observer.clear(self.state); self.assertEqual(observer.read(self.state), [])


if __name__ == '__main__':
    unittest.main()
