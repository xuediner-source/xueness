"""Optional account lifecycle, secret boundaries and actual local streaming."""
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from xueness import plugin_runtime, plugin_sdk
from xueness.bundled_plugins.subscriptions import state, accounts, broker
from xueness.bundled_plugins.providers import provider_config, providers_api
from xueness.bundled_plugins.sessions import composer_api


class SubscriptionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name) / 'state'
        self.addCleanup(broker.shutdown, self.state)

    def enable(self):
        self.assertTrue(plugin_sdk.install_all(self.state, [state.MARKET_MANIFEST])['ok'])
        plugin_runtime.set_enabled(self.state, 'subscriptions', True)

    def test_optional_install_cannot_be_bypassed_by_switch_or_profile(self):
        with self.assertRaisesRegex(ValueError, 'marketplace'):
            plugin_runtime.set_enabled(self.state, 'subscriptions', True)
        plugin_runtime.set_profile(self.state, 'test', {'subscriptions': True})
        self.assertFalse(plugin_runtime.is_enabled(self.state, 'subscriptions'))
        self.assertFalse(broker.running(self.state))
        self.assertFalse((self.state / 'subscriptions').exists())
        self.enable()
        self.assertTrue(plugin_runtime.is_enabled(self.state, 'subscriptions'))
        plugin_runtime.set_enabled(self.state, 'providers', False)
        self.assertFalse(plugin_runtime.is_enabled(self.state, 'subscriptions'))

    def test_marketplace_reserved_packages_are_always_local_and_disabled(self):
        from xueness.bundled_plugins.extensions import marketplace
        with patch.dict(os.environ, {'XUENESS_MARKETPLACE_URL': ''}):
            rows = marketplace.catalog(self.state)
            hub = next(row for row in rows if row['id'] == state.PACKAGE_ID)
            self.assertEqual(hub['source'], 'bundled')
            self.assertFalse(hub['manifest']['enabled'])
            marketplace.install(self.state, hub['id'], hub['sha256'])
        self.assertTrue(state.installed(self.state))
        self.assertFalse(plugin_runtime.is_enabled(self.state, 'subscriptions'))
        with patch.object(marketplace, 'fetch', return_value={'output': json.dumps({'items': []})}):
            with patch.dict(os.environ, {'XUENESS_MARKETPLACE_URL': 'https://example.test/catalog'}):
                rows = marketplace.catalog(self.state)
        self.assertEqual({row['source'] for row in rows}, {'bundled'})
        self.assertEqual(len(rows), 2)

    def test_coverage_and_local_catalog_have_no_worker_or_upstream_io(self):
        self.enable()
        with patch.object(broker, 'Worker', side_effect=AssertionError('unexpected worker')):
            status, payload = accounts.dispatch('GET', ['api', 'subscriptions'], {}, {}, {'state_dir': self.state})
        self.assertEqual(status, 200)
        ids = {row['id'] for row in payload['accounts']}
        self.assertEqual(ids, {'claude', 'codex', 'grok', 'antigravity', 'qwen', 'agnes', 'commandcode', 'qoder'})
        self.assertEqual({row['mode'] for row in payload['accounts']}, {'oauth', 'local'})
        self.assertFalse(any(row['connected'] for row in payload['accounts']))
        self.assertFalse((self.state / 'subscriptions').exists())

    def test_saved_connections_secrets_never_enter_catalog_and_ids_are_stable(self):
        self.enable()
        item = state.definition('qoder')
        accounts.connect(self.state, item, {'accessToken': 'fixture-secret-token', 'userId': 'fixture-secret-user'})
        state.write(self.state, 'public-models.json', {'qoder': {'models': [{'id': 'first'}, {'id': 'second'}]}})
        first = {row['model']: row['id'] for row in state.provider_records(self.state)}
        state.write(self.state, 'public-models.json', {'qoder': {'models': [{'id': 'second', 'apiKey': 'forbidden'}, {'id': 'first'}]}})
        second = {row['model']: row['id'] for row in state.provider_records(self.state)}
        self.assertEqual(first, second)
        public = json.dumps(state.public_accounts(self.state))
        self.assertNotIn('fixture-secret-token', public)
        self.assertNotIn('fixture-secret-user', public)
        self.assertNotIn('forbidden', public)
        records = providers_api._list({'state_dir': self.state})
        self.assertEqual({row['id'] for row in records}, set(first.values()))
        pid = first['first']
        provider = provider_config.resolve(self.state, pid)
        self.assertEqual(provider.model, 'first')
        self.assertEqual(provider.account_id, 'qoder')
        with patch.dict(os.environ, {'XUENESS_API_KEY': '', 'XUENESS_MODEL': '', 'ANTHROPIC_API_KEY': ''}):
            options, _ = composer_api._provider_catalog({'state_dir': self.state})
        self.assertIn(pid, {row['id'] for row in options})
        self.assertNotIn('fixture-secret-token', json.dumps(options))
        plugin_runtime.set_enabled(self.state, 'subscriptions', False)
        self.assertFalse(state.provider_records(self.state))
        with self.assertRaises(ValueError):
            provider.complete([], [])

    def test_only_account_credentials_can_be_saved_or_imported(self):
        self.enable()
        for pid in ('commandcode', 'codex'):
            with self.subTest(pid=pid), self.assertRaises(ValueError):
                accounts.connect(self.state, state.definition(pid), {'key': 'fake'})
        for data in ({'key': 'fake'}, {'accessToken': 'fake'}, {'accessToken': 'fake', 'userId': 'user', 'baseUrl': 'https://example.test'}):
            with self.subTest(data=data), self.assertRaises(ValueError):
                accounts.connect(self.state, state.definition('qoder'), data)
        status, _ = accounts.dispatch('POST', ['api', 'subscriptions', 'codex', 'import'], {}, {'path': 'elsewhere'}, {'state_dir': self.state})
        self.assertEqual(status, 400)
        self.assertFalse(broker.running(self.state))

    def test_removed_api_and_gateway_accounts_cannot_reenter_from_saved_state(self):
        self.enable()
        removed = ('gateway', 'zcode', 'custom-api', 'openai-api', 'anthropic-api', 'kimi-coding', 'minimax-coding', 'openrouter', 'spark', 'ernie')
        old = {pid: {'apiKey': 'PRIVATE-old-key', 'accessToken': 'PRIVATE-old-token', 'baseUrl': 'http://127.0.0.1:8317/v1', 'models': ['old-model']} for pid in removed}
        state.write(self.state, 'connections.json', old)
        state.write(self.state, 'auth.json', old)
        state.write(self.state, 'public-models.json', {pid: {'models': [{'id': 'old-model'}]} for pid in removed})
        before = {name: state.read(self.state, name) for name in ('connections.json', 'auth.json', 'public-models.json')}
        with patch.object(broker, 'Worker', side_effect=AssertionError('unexpected worker')):
            public = state.public_accounts(self.state)
            self.assertTrue(set(removed).isdisjoint({row['id'] for row in public}))
            self.assertFalse(state.provider_records(self.state))
            for pid in removed:
                for method, action in [('POST', 'connect'), ('POST', 'login'), ('POST', 'import'), ('POST', 'set-models'), ('GET', 'status')]:
                    status, _ = accounts.dispatch(method, ['api', 'subscriptions', pid, action], {}, {}, {'state_dir': self.state})
                    self.assertEqual(status, 404, (pid, action))
                with self.assertRaises(ValueError):
                    provider_config.resolve(self.state, state.model_id(pid, 'old-model'))
        self.assertEqual(before, {name: state.read(self.state, name) for name in before})
        self.assertNotIn('PRIVATE-', json.dumps(public))

    def test_commandcode_requires_cli_import_and_qoder_requires_an_account_identity(self):
        self.enable()
        state.write(self.state, 'connections.json', {'commandcode': {'apiKey': 'old-manual-api-key'}, 'qoder': {'accessToken': 'old-token'}})
        rows = {row['id']: row for row in state.public_accounts(self.state)}
        self.assertFalse(rows['commandcode']['connected'])
        self.assertFalse(rows['qoder']['connected'])
        self.assertFalse(state.provider_records(self.state))
        state.write(self.state, 'connections.json', {'commandcode': {'apiKey': 'cli-issued-credential', 'credentialSource': 'cli-login'}, 'qoder': {'accessToken': 'account-token', 'userId': 'account-user'}})
        rows = {row['id']: row for row in state.public_accounts(self.state)}
        self.assertTrue(rows['commandcode']['connected'])
        self.assertTrue(rows['qoder']['connected'])

    def test_credential_rotation_preserves_model_selection_without_accepting_api_fields(self):
        self.enable()
        item = state.definition('qoder')
        accounts.connect(self.state, item, {'accessToken': 'first-token', 'userId': 'account-user'})
        status, _ = accounts.dispatch('POST', ['api', 'subscriptions', 'qoder', 'set-models'], {}, {'models': ['qwen3.8-max']}, {'state_dir': self.state})
        self.assertEqual(status, 200)
        first = state.provider_records(self.state)
        accounts.connect(self.state, item, {'accessToken': 'replacement-token', 'userId': ''})
        self.assertEqual(first, state.provider_records(self.state))
        self.assertEqual(state.read(self.state, 'connections.json')['qoder']['userId'], 'account-user')

    def test_native_errors_and_thread_context_reach_the_run_contract(self):
        from xueness.bundled_plugins.subscriptions.provider import NativeProvider
        from xueness.bundled_plugins.providers.provider import ProviderRequestError, ProviderCallbackError
        self.enable()
        provider = NativeProvider(self.state, {'subscriptionId': 'antigravity', 'model': 'requested', 'baseUrl': 'https://example.test'})
        provider.session_id = 'a' * 32
        for category, status in [('rate_limited', 429), ('authentication_failed', 401), ('invalid_response', None), ('quota_exhausted', 429)]:
            with self.subTest(category=category), patch.object(broker, 'call', side_effect=broker.SubscriptionRequestError('sanitized', {'category': category, 'status': status})):
                with self.assertRaises(ProviderRequestError) as caught:
                    provider.complete([], [])
                self.assertEqual(caught.exception.category, category)
                self.assertEqual(caught.exception.status, status)
        with patch.object(broker, 'call', return_value={'content': 'fixture', 'tool_calls': []}) as request:
            provider.complete([], [])
        self.assertEqual(request.call_args.args[3]['sessionId'], 'a' * 32)
        def emit(*args):
            args[4]({'type': 'content', 'text': 'fixture'})
        def callback(_):
            raise ValueError('private callback data')
        with patch.object(broker, 'call', side_effect=emit), self.assertRaises(ProviderCallbackError) as caught:
            provider.stream([], [], on_delta=callback)
        self.assertNotIn('private', str(caught.exception))

    def test_supplier_metadata_groups_profiles_without_exposing_url_secrets(self):
        first = providers_api.model_supplier_metadata({'baseUrl': 'https://api.example.test/v1?token=PRIVATE'})
        second = providers_api.model_supplier_metadata({'baseUrl': 'https://user:PRIVATE@api.example.test/v2'})
        self.assertEqual(first['supplierId'], second['supplierId'])
        self.assertEqual(first['supplierName'], 'api.example.test')
        self.assertNotIn('PRIVATE', json.dumps(first))
        subscription = providers_api.model_supplier_metadata({'source': 'subscription', 'subscriptionId': 'antigravity'})
        self.assertEqual(subscription['supplierName'], 'Google Antigravity')

    def test_unknown_quota_is_not_zero_and_public_cache_is_whitelisted(self):
        value = state.public_quota({'supported': True, 'checkedAt': 5, 'apiKey': 'secret', 'windows': [{'kind': 'weekly', 'usedPercent': None, 'accessToken': 'secret'}]})
        self.assertFalse(value['supported'])
        self.assertEqual(value['windows'], [])
        value = state.public_quota({'supported': True, 'checkedAt': 5, 'windows': [{'kind': 'weekly', 'usedPercent': 0, 'resetsAt': 1000}]})
        self.assertEqual(value['windows'][0]['usedPercent'], 0)

    def test_real_worker_streams_only_to_local_fixture_and_stops_on_disable(self):
        self.enable()
        seen = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                seen.append((self.path, payload))
                if payload['model'] == 'rate-limit-fixture':
                    self.send_response(429); self.end_headers()
                    self.wfile.write(b'{"error":"PRIVATE UPSTREAM BODY"}')
                    return
                self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
                events = [{'model': 'fixture-reported', 'choices': [{'delta': {'content': 'hello '}}]},
                          {'model': 'fixture-reported', 'choices': [{'delta': {'content': 'world'}, 'finish_reason': 'stop'}]},
                          {'choices': [], 'usage': {'prompt_tokens': 12, 'completion_tokens': 2, 'total_tokens': 14}}]
                for event in events:
                    self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
                self.wfile.write(b'data: [DONE]')
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        state.write(self.state, 'auth.json', {'qwen': {'accessToken': 'fake-access', 'refreshToken': 'fake-refresh',
                    'expiresAt': time.time() * 1000 + 3600_000, 'baseUrl': f'http://127.0.0.1:{server.server_port}/v1'}})
        pid = state.model_id('qwen', 'coder-model')
        provider = provider_config.resolve(self.state, pid)
        deltas = []
        result = provider.stream([{'role': 'user', 'content': 'fixture only'}], [], on_delta=deltas.append)
        self.assertEqual(result['content'], 'hello world')
        self.assertEqual(''.join(deltas), result['content'])
        self.assertEqual(result['_response_models'], ['fixture-reported'])
        self.assertEqual(result['_usage']['total_tokens'], 14)
        self.assertEqual(len(seen), 1)
        from xueness.bundled_plugins.providers.provider import ProviderRequestError
        provider.model = 'rate-limit-fixture'
        with self.assertRaises(ProviderRequestError) as caught:
            provider.complete([{'role': 'user', 'content': 'fixture only'}], [])
        self.assertEqual(caught.exception.category, 'rate_limited')
        self.assertEqual(caught.exception.status, 429)
        self.assertNotIn('PRIVATE', str(caught.exception))
        self.assertTrue(broker.running(self.state))
        worker = broker._WORKERS[str(self.state.absolute())]
        plugin_runtime.set_enabled(self.state, 'subscriptions', False)
        deadline = time.monotonic() + 5
        while worker.process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertIsNotNone(worker.process.poll())
        self.assertFalse(broker.running(self.state))


if __name__ == '__main__':
    unittest.main()
