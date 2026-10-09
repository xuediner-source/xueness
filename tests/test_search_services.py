"""Search routing, wire contracts, credential isolation and failure behavior."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
from xueness import plugin_runtime
from xueness.tool_contract import bind_execution
from xueness.bundled_plugins.network import search_services as adapters, search_settings as settings, settings_api, tooling
from xueness.bundled_plugins.network.transport import NetworkError


class Gate:
    def check(self, *args):
        raise PermissionError('approval required')


class SearchServiceTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.directory = tempfile.TemporaryDirectory()
        self.state = self.directory.name
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(self.env.stop)

    def configure(self, provider, key='fixture-search-key', **extra):
        return settings.update_settings(self.state, {'searchProvider': provider,
            **({'searchKey': key} if provider != 'searxng' else {'searchEndpoint': 'https://search.example/search'}), **extra})

    def test_switch_preserves_keys_and_custom_addresses(self):
        self.configure('brave', 'brave-fixture', searchEndpoint='https://brave.example/search')
        self.configure('tavily', 'tavily-fixture', searchEndpoint='https://tavily.example/search')
        values = settings.update_settings(self.state, {'searchProvider': 'brave', 'searchKey': ''})
        self.assertEqual(settings.resolve_config(self.state)[:2], ('https://brave.example/search', 'brave-fixture'))
        self.assertTrue(values['searchServices']['tavily']['hasSavedSearchKey'])
        settings.update_settings(self.state, {'searchProvider': 'tavily'})
        self.assertEqual(settings.resolve_config(self.state)[:2], ('https://tavily.example/search', 'tavily-fixture'))
        self.assertNotIn('tavily-fixture', json.dumps(values))
        self.assertNotIn('brave-fixture', json.dumps(values))
        self.assertNotIn('fixture', Path(self.state, 'network/settings.json').read_text())

    def test_clear_is_scoped_and_searxng_never_clears_tavily(self):
        self.configure('brave', 'brave-fixture')
        self.configure('tavily', 'tavily-fixture')
        self.configure('searxng', clearSearchKey=True)
        self.assertTrue(settings.get_settings(self.state)['searchServices']['tavily']['hasSearchKey'])
        settings.update_settings(self.state, {'searchProvider': 'tavily', 'clearSearchKey': True})
        values = settings.get_settings(self.state)
        self.assertFalse(values['hasSearchKey'])
        self.assertTrue(values['searchServices']['brave']['hasSearchKey'])

    def test_old_brave_configuration_migrates(self):
        path = Path(self.state, 'network'); path.mkdir()
        (path / 'settings.json').write_text(json.dumps({'searchEndpoint': 'https://old.example/query'}))
        (path / 'search-key.json').write_text(json.dumps({'apiKey': 'old-key'}))
        self.assertEqual(settings.resolve_service_config(self.state), ('brave', 'https://old.example/query', 'old-key', ''))
        self.configure('tavily')
        settings.update_settings(self.state, {'searchProvider': 'brave'})
        self.assertEqual(settings.resolve_config(self.state)[:2], ('https://old.example/query', 'old-key'))

    def test_environment_key_is_bound_to_provider(self):
        with patch.dict(os.environ, {'XUENESS_SEARCH_KEY': 'generic-brave-key'}):
            values = self.configure('tavily', key='')
            self.assertFalse(values['hasSearchKey'])
            self.assertTrue(values['searchServices']['brave']['hasEnvironmentSearchKey'])
            with self.assertRaises(NetworkError) as failure: settings.resolve_config(self.state)
            self.assertEqual(failure.exception.error_code, 'search_key_missing')
        with patch.dict(os.environ, {'XUENESS_TAVILY_SEARCH_KEY': 'tavily-env-key'}):
            self.assertEqual(settings.resolve_config(self.state)[1], 'tavily-env-key')

    def test_tavily_key_is_not_sent_to_image_service(self):
        self.configure('tavily', 'tavily-fixture')
        with self.assertRaises(NetworkError) as failure: settings.resolve_image_search_config(self.state)
        self.assertEqual(failure.exception.error_code, 'image_search_key_missing')
        self.configure('brave', 'image-brave-fixture')
        settings.update_settings(self.state, {'searchProvider': 'tavily'})
        self.assertEqual(settings.resolve_image_search_config(self.state)[1], 'image-brave-fixture')

    def test_invalid_provider_and_unsafe_endpoint_rejected(self):
        for values in ({'searchProvider': 'invented'}, {'searchProvider': []},
                       {'searchEndpoint': 'http://127.0.0.1:8080/search'},
                       {'searchEndpoint': 'https://user:pass@search.example/search'},
                       {'searchEndpoint': 'https://search.example/search?api_key=secret'}):
            with self.subTest(values=values), self.assertRaises(ValueError): settings.update_settings(self.state, values)

    def test_tavily_post_bearer_basic_and_unified_results(self):
        self.configure('tavily')
        payload = {'results': [{'title': '来源', 'url': 'https://example.com/source', 'content': '实际摘要'}], 'usage': {'credits': 1}}
        with patch.object(adapters, 'post_json', return_value=(payload, 'configured_doh')) as request, patch.object(adapters, 'fetch') as get:
            result = tooling.search('中文搜索', state_dir=self.state)
        args = request.call_args.args
        self.assertEqual(args[0], 'https://api.tavily.com/search')
        self.assertEqual(args[2], {'Authorization': 'Bearer fixture-search-key'})
        self.assertEqual(args[1]['search_depth'], 'basic')
        for name in ('auto_parameters', 'include_raw_content', 'include_answer'): self.assertFalse(args[1][name])
        self.assertEqual(args[1]['max_results'], 5)
        self.assertNotIn('api_key', args[1])
        self.assertEqual(result['output'][0]['description'], '实际摘要')
        self.assertEqual(result['usage']['credits'], 1)
        self.assertFalse(result['provenance']['urlsVerified'])
        self.assertEqual(result['dnsSource'], 'configured_doh'); get.assert_not_called()

    def test_brave_get_contract_preserved(self):
        self.configure('brave')
        with patch.object(adapters, 'fetch', return_value={'output': json.dumps({'web': {'results': [
                {'title': 'Brave', 'url': 'https://example.com', 'description': 'snippet'}]}})}) as request:
            result = tooling.search('hello world', state_dir=self.state)
        self.assertEqual(parse_qs(urlsplit(request.call_args.args[0]).query), {'q': ['hello world'], 'count': ['5']})
        self.assertEqual(request.call_args.args[1]['X-Subscription-Token'], 'fixture-search-key')
        self.assertEqual(result['searchProvider'], 'brave')

    def test_searxng_requires_no_key_and_sends_no_credentials(self):
        self.configure('tavily', 'never-send-this'); self.configure('searxng')
        with patch.object(adapters, 'fetch', return_value={'output': json.dumps({'results': [
                {'title': 'SearXNG', 'url': 'https://example.com', 'content': 'snippet'}]})}) as request:
            result = tooling.search('free search', state_dir=self.state)
        self.assertEqual(parse_qs(urlsplit(request.call_args.args[0]).query), {'q': ['free search'], 'format': ['json']})
        self.assertEqual(request.call_args.args[1], {'Accept': 'application/json'})
        self.assertNotIn('never-send-this', repr(request.call_args))
        self.assertEqual(result['output'][0]['description'], 'snippet')

    def test_auth_and_quota_errors_are_actionable_without_retries(self):
        self.configure('tavily')
        for status, code in ((401, 'search_access_denied'), (432, 'search_quota_exhausted'), (433, 'search_quota_exhausted')):
            with self.subTest(status=status), patch.object(adapters, 'post_json', side_effect=NetworkError(
                    'http_permanent', False, 'do not expose raw response', http_status=status)) as request:
                with self.assertRaises(NetworkError) as failure: tooling.search('query', state_dir=self.state)
                self.assertEqual(failure.exception.error_code, code)
                self.assertFalse(failure.exception.retryable)
                self.assertNotIn('raw response', failure.exception.user_reason); request.assert_called_once()

    def test_temporary_error_is_not_automatically_retried(self):
        self.configure('tavily')
        with patch.object(adapters, 'post_json', side_effect=NetworkError('http_temporary', True, '稍后重试', http_status=429)) as request:
            with self.assertRaises(NetworkError) as failure: tooling.search('query', state_dir=self.state)
        self.assertTrue(failure.exception.retryable); request.assert_called_once()

    def test_result_limits_and_secret_redaction(self):
        rows = [{'url': 'https://example.com/?token=secret-fixture', 'title': 'bad', 'content': 'bad'},
                {'url': 'https://example.com/?token=%73ecret-fixture', 'title': 'bad', 'content': 'bad'},
                {'url': 'https://user:secret@example.com', 'title': 'bad', 'content': 'bad'}]
        rows += [{'title': 'x' * 400, 'url': f'https://example.com/{i}', 'content': 'y' * 2000} for i in range(10)]
        result = adapters.normalize({'results': rows, 'answer': 'secret-fixture'}, 'tavily', 'query', 'secret-fixture')
        self.assertEqual(len(result['output']), 5)
        self.assertTrue(all(len(r['title']) == 300 and len(r['description']) == 1000 for r in result['output']))
        self.assertNotIn('secret-fixture', json.dumps(result)); self.assertNotIn('answer', result)

    def test_bad_response_is_not_successful_empty_search(self):
        for provider in adapters.PROVIDERS:
            for payload in ([], {}, {'results': 'bad'}, {'error': 'credential failure'}):
                with self.subTest(provider=provider, payload=payload), self.assertRaises(NetworkError):
                    adapters.normalize(payload, provider, 'query')
        self.assertEqual(adapters.normalize({'results': []}, 'tavily', 'query')['output'], [])

    def test_gate_denial_prevents_request(self):
        self.configure('tavily')
        with bind_execution(state_dir=self.state), patch.object(adapters, 'post_json') as request:
            with self.assertRaises(PermissionError): tooling._search(Path('.'), Gate(), {'query': 'query'}, {}, 'call')
        request.assert_not_called()

    def test_disabled_plugin_blocks_diagnostic(self):
        plugin_runtime.set_enabled(self.state, 'network', False)
        with patch.object(adapters, 'post_json') as request:
            status, _ = plugin_runtime.dispatch_http('POST', ['api', 'network', 'diagnostics'], {},
                                                      {'operation': 'search'}, {'state_dir': self.state})
        self.assertEqual(status, 403); request.assert_not_called()

    def test_diagnostic_uses_same_adapter(self):
        self.configure('tavily')
        with patch.object(adapters, 'post_json', return_value=({'results': []}, 'system')) as request:
            status, body = settings_api.dispatch('POST', ['api', 'network', 'diagnostics'], {},
                                                {'operation': 'search'}, {'state_dir': self.state})
        self.assertEqual(status, 200); self.assertTrue(body['ok']); request.assert_called_once()

    def test_standard_and_lightweight_execute_the_same_web_search(self):
        from types import SimpleNamespace
        from xueness.core import Store, Gate as RunGate, run
        self.configure('tavily')
        root = Path(self.state, 'workspace'); root.mkdir()
        store = Store(Path(self.state))
        for profile, protocol in (('standard', 'native'), ('lightweight', 'json')):
            with self.subTest(profile=profile):
                session = store.new('Find a web source', root)
                session['discovered_tools'] = ['web_search']
                call = {'id': 'search-call', 'type': 'function', 'function': {'name': 'web_search', 'arguments': '{"query":"fixture search"}'}}
                replies = iter([{'content': json.dumps({'tool': 'web_search', 'arguments': {'query': 'fixture search'}})}
                    if protocol == 'json' else {'content': '', 'tool_calls': [call]},
                    {'content': json.dumps({'answer': 'Found a source.', 'evidence': []}) if protocol == 'json'
                     else json.dumps({'summary': 'Found a source.', 'evidence': []})}])
                provider = SimpleNamespace(runtime_profile=profile, tool_calling=protocol, context_window=65536,
                    max_output_tokens=2048, compatibility={}, complete=lambda messages, tools: next(replies))
                with patch.object(adapters, 'post_json', return_value=({'results': [
                        {'title':'source','url':'https://example.com/source','content':'snippet'}]}, 'system')) as request:
                    result = run(session, store, provider, RunGate(root, allow_network=True), max_steps=2)
                search_results = [r for r in result.get('results', {}).values() if r.get('searchProvider') == 'tavily']
                self.assertEqual(len(search_results), 1)
                self.assertTrue(search_results[0]['ok']); request.assert_called_once()


if __name__ == '__main__': unittest.main()
