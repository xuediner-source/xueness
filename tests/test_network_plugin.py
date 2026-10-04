"""Isolated network plugin safety, persistence and API regressions."""
import json
import os
from pathlib import Path
import socket
import stat
import tempfile
import unittest
from unittest.mock import patch

from tests.secret_permissions import assert_secret_file_private
from xueness import plugin_runtime
from xueness.bundled_plugins.network import search_model, search_settings, settings_api, tooling, transport
from xueness.tool_contract import bind_execution


class _Gate:
    web_approval_gate = False

    def __init__(self, error=None):
        self.error = error
        self.calls = []

    def check(self, kind, subject, call_id=None):
        self.calls.append((kind, subject, call_id))
        if self.error:
            raise self.error


class _Response:
    def __init__(self, status=200, body=b"", content_type="application/dns-json"):
        self.status = status
        self.body = body
        self.headers = {"Content-Type": content_type}

    def getheader(self, key, default=""):
        return self.headers.get(key, default)

    def read(self, size=-1):
        return self.body[:size]


class _Connection:
    requests = []
    responses = []

    def __init__(self, host, address, port=443, timeout=transport.REQUEST_TIMEOUT):
        self.host = host
        self.address = address
        self.port = port
        self.timeout = timeout

    def request(self, method, path, body=None, headers=None):
        type(self).requests.append((self.host, self.address, method, path, headers, self.timeout, body))

    def getresponse(self):
        return type(self).responses.pop(0)

    def close(self):
        pass


class NetworkTransportTests(unittest.TestCase):
    def tearDown(self):
        _Connection.requests = []
        _Connection.responses = []

    @staticmethod
    def _dns_rows(host, addresses):
        family = 2
        return [(family, 1, 6, "", (ip, 443)) for ip in addresses]

    def test_fakeip_uses_only_explicit_doh_and_pins_public_answers(self):
        def resolve(host, *args, **kwargs):
            values = ["198.18.0.1"] if host == "target.example" else ["1.1.1.1"]
            return self._dns_rows(host, values)

        _Connection.responses = [
            _Response(body=json.dumps({"Status": 0, "Answer": [{"type": 1, "data": "8.8.8.8"}]}).encode()),
            _Response(body=json.dumps({"Status": 0, "Answer": [{"type": 28, "data": "2001:4860:4860::8888"}]}).encode()),
        ]
        with patch.object(transport.socket, "getaddrinfo", side_effect=resolve), \
                patch.object(transport, "_PinnedHTTPS", _Connection):
            addresses, source = transport.resolve_public("target.example", "https://resolver.example/dns-query")
        self.assertEqual(source, "configured_doh")
        self.assertEqual(addresses, ["2001:4860:4860::8888", "8.8.8.8"])
        self.assertEqual([row[1] for row in _Connection.requests], ["1.1.1.1", "1.1.1.1"])
        self.assertTrue(all("name=target.example" in row[3] for row in _Connection.requests))
        self.assertTrue(all(row[4]["Accept"] == "application/dns-json" for row in _Connection.requests))
        self.assertTrue(all(row[5] == transport.DNS_TIMEOUT for row in _Connection.requests))

    def test_fakeip_without_configured_doh_is_a_permanent_structured_error(self):
        with patch.object(transport.socket, "getaddrinfo",
                          return_value=self._dns_rows("target.example", ["198.18.0.2"])), \
                patch.object(transport, "_doh_addresses") as doh:
            with self.assertRaises(transport.NetworkError) as caught:
                transport.resolve_public("target.example")
        doh.assert_not_called()
        result = caught.exception.as_result()
        self.assertEqual(result["error_code"], "fakeip_dns_blocked")
        self.assertFalse(result["retryable"])
        self.assertIn("公开 DoH", result["user_reason"])

    def test_dns_name_failures_are_permanent_but_temporary_resolver_failures_can_retry(self):
        cases = ((socket.EAI_NONAME, "dns_name_not_found", False),
                 (socket.EAI_AGAIN, "dns_resolution_temporary", True))
        for code, expected, retryable in cases:
            with self.subTest(code=code), patch.object(
                    transport.socket, "getaddrinfo", side_effect=socket.gaierror(code, "test")):
                with self.assertRaises(transport.NetworkError) as caught:
                    transport.resolve_public("missing.example")
            self.assertEqual(caught.exception.error_code, expected)
            self.assertEqual(caught.exception.retryable, retryable)

    def test_doh_nxdomain_is_permanent_and_malformed_status_is_rejected(self):
        for payload, expected, retryable in (({"Status": 3}, "dns_name_not_found", False),
                                             ({"Status": False}, "doh_response_invalid", False)):
            with self.subTest(payload=payload):
                _Connection.responses = [_Response(body=json.dumps(payload).encode())]
                with patch.object(transport, "_system_addresses", return_value=["1.1.1.1"]), \
                        patch.object(transport, "_PinnedHTTPS", _Connection):
                    with self.assertRaises(transport.NetworkError) as caught:
                        transport._doh_addresses("missing.example", "https://resolver.example/dns-query")
                self.assertEqual(caught.exception.error_code, expected)
                self.assertEqual(caught.exception.retryable, retryable)

    def test_private_or_mixed_system_answers_never_fall_back_to_doh(self):
        for addresses in (["10.2.3.4"], ["198.18.0.4", "8.8.8.8"]):
            with self.subTest(addresses=addresses), \
                    patch.object(transport.socket, "getaddrinfo",
                                 return_value=self._dns_rows("target.example", addresses)), \
                    patch.object(transport, "_doh_addresses") as doh:
                with self.assertRaises(transport.NetworkError) as caught:
                    transport.resolve_public("target.example", "https://resolver.example/dns-query")
                doh.assert_not_called()
                self.assertEqual(caught.exception.error_code, "ssrf_blocked")
                self.assertFalse(caught.exception.retryable)

    def test_invalid_and_private_urls_are_blocked_before_connect(self):
        for url, code in (("http://example.com", "invalid_url"),
                          ("https://user:pass@example.com", "invalid_url"),
                          ("https://@example.com", "invalid_url"),
                          ("https://example.com/line\nbreak", "invalid_url"),
                          ("https://example.com\\private", "invalid_url"),
                          ("https://example.com:8443", "invalid_url")):
            with self.subTest(url=url), patch.object(transport.socket, "getaddrinfo") as resolver:
                with self.assertRaises(transport.NetworkError) as caught:
                    transport.fetch(url)
                self.assertEqual(caught.exception.error_code, code)
                resolver.assert_not_called()
        with patch.object(transport.socket, "getaddrinfo",
                          return_value=self._dns_rows("localhost", ["127.0.0.1"])), \
                patch.object(transport, "_PinnedHTTPS") as connection:
            with self.assertRaises(transport.NetworkError) as caught:
                transport.fetch("https://localhost/")
        self.assertEqual(caught.exception.error_code, "ssrf_blocked")
        connection.assert_not_called()

    def test_all_dns_answers_must_be_public_even_if_one_is_public(self):
        with patch.object(transport.socket, "getaddrinfo",
                          return_value=self._dns_rows("mixed.example", ["8.8.8.8", "192.168.1.9"])), \
                patch.object(transport, "_PinnedHTTPS") as connection:
            with self.assertRaises(transport.NetworkError) as caught:
                transport.fetch("https://mixed.example/")
        self.assertEqual(caught.exception.error_code, "ssrf_blocked")
        connection.assert_not_called()

    def test_http_temporary_and_permanent_statuses_are_classified(self):
        for status, code, retryable in ((429, "http_temporary", True), (503, "http_temporary", True),
                                        (404, "http_permanent", False), (302, "http_permanent", False)):
            with self.subTest(status=status):
                _Connection.responses = [_Response(status=status, content_type="text/plain")]
                with patch.object(transport, "resolve_public", return_value=(["8.8.8.8"], "system")), \
                        patch.object(transport, "_PinnedHTTPS", _Connection):
                    with self.assertRaises(transport.NetworkError) as caught:
                        transport.fetch("https://example.com/")
                self.assertEqual(caught.exception.error_code, code)
                self.assertEqual(caught.exception.retryable, retryable)
                self.assertEqual(caught.exception.http_status, status)

    def test_gate_refusal_propagates_before_any_network_request(self):
        denied = PermissionError("web_fetch requires explicit approval")
        gate = _Gate(denied)
        gate.web_approval_gate = True
        with patch.object(tooling, "fetch") as network:
            with self.assertRaises(PermissionError) as caught:
                tooling._fetch(Path("."), gate, {"url": "https://example.com"}, {}, "call-1")
        self.assertIs(caught.exception, denied)
        self.assertEqual(gate.calls, [("web_fetch", "https://example.com", "call-1")])
        network.assert_not_called()

    def test_network_tool_failure_shape_keeps_dns_reason_separate_from_gate(self):
        gate = _Gate()
        failure = transport.NetworkError("ssrf_blocked", False,
                                          "目标解析到非公网地址，已按 SSRF 安全规则阻止请求。")
        with tempfile.TemporaryDirectory() as state, bind_execution(state_dir=state), \
                patch.object(tooling, "fetch", side_effect=failure):
            result = tooling._fetch(Path("."), gate, {"url": "https://example.com"}, {}, "call-1")
        self.assertEqual(result["error"], "ssrf_blocked")
        self.assertEqual(result["error_code"], "ssrf_blocked")
        self.assertFalse(result["retryable"])
        self.assertIn("目标解析", result["user_reason"])

    def test_missing_search_key_is_permanent_and_does_not_connect(self):
        with tempfile.TemporaryDirectory() as state, bind_execution(state_dir=state), \
                patch.object(tooling, "fetch") as network:
            result = tooling._search(Path("."), _Gate(), {"query": "test query"}, {}, "call-2")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error_code"], "search_key_missing")
        self.assertFalse(result["retryable"])
        self.assertIn("保存服务密钥", result["user_reason"])
        network.assert_not_called()

    def test_web_search_routes_only_to_selected_search_model(self):
        with tempfile.TemporaryDirectory() as state, bind_execution(state_dir=state):
            search_settings.update_settings(state, {
                "searchMode": "model",
                "searchModelEndpoint": "https://models.example/v1/chat/completions",
                "searchModel": "web-researcher",
                "searchModelKey": "isolated-key",
            })
            model_result = {"ok": True, "sourceType": "search_model", "provenance": {"urlsVerified": False}}
            with patch.object(search_model, "search", return_value=model_result) as model_search, \
                    patch.object(tooling, "search") as service_search:
                result = tooling._search(Path("."), _Gate(), {"query": "test query"}, {}, "call-3")
        self.assertIs(result, model_result)
        model_search.assert_called_once_with("test query", state_dir=state)
        service_search.assert_not_called()


class NetworkSettingsTests(unittest.TestCase):
    def test_settings_save_without_fchmod_closes_and_replaces_temp_file(self):
        with tempfile.TemporaryDirectory() as state, patch.dict(os.__dict__):
            os.__dict__.pop("fchmod", None)
            search_settings.update_settings(state, {"dohEndpoint": "https://1.1.1.1/dns-query"})
            directory = Path(state) / "network"
            saved = json.loads((directory / "settings.json").read_text())
            self.assertEqual(saved["dohEndpoint"], "https://1.1.1.1/dns-query")
            self.assertEqual(list(directory.glob(".network-*")), [])

    def test_secret_is_separate_private_and_never_returned(self):
        with tempfile.TemporaryDirectory() as state:
            returned = search_settings.update_settings(state, {
                "searchEndpoint": "https://search.example/v1/search",
                "dohEndpoint": "https://resolver.example/dns-query",
                "searchKey": "never-return-this-secret",
            })
            self.assertTrue(returned["hasSearchKey"])
            self.assertTrue(returned["hasSavedSearchKey"])
            self.assertNotIn("never-return-this-secret", json.dumps(returned))
            directory = Path(state) / "network"
            secret_path = directory / "search-key.json"
            secret = json.loads(secret_path.read_text())
            self.assertEqual(secret["apiKey"], "never-return-this-secret")
            assert_secret_file_private(self, secret_path)
            if os.name != "nt":
                self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
            self.assertNotIn("apiKey", json.loads((directory / "settings.json").read_text()))

    def test_secret_keeps_existing_key_on_blank_save_and_explicit_clear_removes_it(self):
        with tempfile.TemporaryDirectory() as state:
            search_settings.update_settings(state, {"searchKey": "keep-me"})
            search_settings.update_settings(state, {"searchEndpoint": "https://search.example/query", "searchKey": ""})
            self.assertEqual(search_settings.resolve_config(state)[1], "keep-me")
            search_settings.update_settings(state, {"clearSearchKey": True})
            self.assertFalse(search_settings.get_settings(state)["hasSavedSearchKey"])

    def test_nonpublic_or_credential_bearing_endpoints_are_rejected(self):
        for field, value in (("searchEndpoint", "http://search.example"),
                             ("searchEndpoint", "https://u:p@search.example/query"),
                             ("searchEndpoint", "https://search.example:444/query"),
                             ("searchEndpoint", "https://127.0.0.1/v1/search"),
                             ("searchEndpoint", "https://localhost/v1/search"),
                             ("dohEndpoint", "https://resolver.example/dns-query?name=example.com"),
                             ("dohEndpoint", "https://u:p@resolver.example/dns-query"),
                             ("dohEndpoint", "https://[::1]/dns-query"),
                             ("searchModelEndpoint", "https://192.168.1.7/v1/chat/completions")):
            with self.subTest(field=field, value=value), tempfile.TemporaryDirectory() as state:
                with self.assertRaises(ValueError):
                    search_settings.update_settings(state, {field: value})

    def test_settings_api_does_not_run_diagnostics_on_read(self):
        with tempfile.TemporaryDirectory() as state, \
                patch.object(settings_api, "probe_dns") as probe, \
                patch.object(settings_api, "search") as search:
            status, body = settings_api.dispatch("GET", ["api", "network", "settings"], {}, {},
                                                 {"state_dir": state})
        self.assertEqual(status, 200)
        self.assertEqual(body["settings"]["searchEndpoint"], search_settings._DEFAULT_SEARCH_ENDPOINT)
        probe.assert_not_called()
        search.assert_not_called()

    def test_plugin_route_is_owned_and_disable_blocks_network_settings(self):
        with tempfile.TemporaryDirectory() as state:
            self.assertEqual(plugin_runtime.route_owner(["api", "network", "settings"]), "network")
            status, _ = plugin_runtime.dispatch_http("GET", ["api", "network", "settings"], {}, {},
                                                     {"state_dir": state})
            self.assertEqual(status, 200)
            plugin_runtime.set_enabled(state, "network", False)
            status, _ = plugin_runtime.dispatch_http("POST", ["api", "network", "settings"], {}, {},
                                                     {"state_dir": state})
            self.assertEqual(status, 403)

    def test_diagnostics_are_explicit_and_return_only_bounded_status(self):
        with tempfile.TemporaryDirectory() as state:
            with patch.object(settings_api, "probe_dns", return_value={
                    "host": "search.example", "addressCount": 2, "dnsSource": "configured_doh"}) as probe:
                status, body = settings_api.dispatch("POST", ["api", "network", "diagnostics"], {},
                                                     {"operation": "dns"}, {"state_dir": state})
            self.assertEqual(status, 200)
            self.assertEqual(body, {"ok": True, "operation": "dns", "host": "search.example",
                                    "addressCount": 2, "dnsSource": "configured_doh",
                                    "message": "目标 DNS 解析正常；未连接搜索服务或模型接口。"})
            probe.assert_called_once()
            status, body = settings_api.dispatch("POST", ["api", "network", "diagnostics"], {},
                                                 {"operation": "other"}, {"state_dir": state})
            self.assertEqual(status, 400)
            self.assertNotIn("secret", json.dumps(body))

    def test_search_model_settings_are_separate_and_credentials_are_private(self):
        with tempfile.TemporaryDirectory() as state:
            provider_dir = Path(state) / "providers"
            provider_dir.mkdir()
            provider_path = provider_dir / "primary.json"
            provider_path.write_text('{"apiKey":"main-model-secret","model":"primary"}')
            values = search_settings.update_settings(state, {
                "searchMode": "model",
                "searchModelEndpoint": "https://models.example/v1/chat/completions",
                "searchModel": "web-researcher",
                "searchModelKey": "search-model-secret",
            })
            self.assertEqual(search_settings.resolve_search_model_config(state)[:2],
                             ("https://models.example/v1/chat/completions", "web-researcher"))
            self.assertTrue(values["hasSearchModelKey"])
            self.assertNotIn("search-model-secret", json.dumps(values))
            self.assertEqual(json.loads(provider_path.read_text()),
                             {"apiKey": "main-model-secret", "model": "primary"})
            key_path = Path(state) / "network" / "search-model-key.json"
            self.assertEqual(json.loads(key_path.read_text())["apiKey"], "search-model-secret")
            assert_secret_file_private(self, key_path)
            if os.name != "nt":
                self.assertEqual(stat.S_IMODE((Path(state) / "network").stat().st_mode), 0o700)
            search_settings.update_settings(state, {"searchModelKey": ""})
            self.assertEqual(search_settings.resolve_search_model_config(state)[2], "search-model-secret")
            search_settings.update_settings(state, {"clearSearchModelKey": True})
            self.assertFalse(search_settings.get_settings(state)["hasSavedSearchModelKey"])
            self.assertFalse(key_path.exists())

    def test_search_model_uses_pinned_public_post_and_labels_sources_unverified(self):
        with tempfile.TemporaryDirectory() as state:
            search_settings.update_settings(state, {
                "searchMode": "model",
                "searchModelEndpoint": "https://models.example/v1/chat/completions",
                "searchModel": "web-researcher",
                "searchModelKey": "independent-search-secret",
            })
            body = {"choices": [{"message": {"content": json.dumps({
                "summary": "candidate links",
                "sources": [
                    {"title": "Public result", "url": "https://news.example/item?q=1", "snippet": "candidate"},
                    {"title": "Private result", "url": "https://127.0.0.1/", "snippet": "must be dropped"},
                ],
            })}}]}
            _Connection.responses = [_Response(body=json.dumps(body).encode(), content_type="application/json")]
            with patch.object(transport.socket, "getaddrinfo",
                              return_value=NetworkTransportTests._dns_rows("models.example", ["8.8.8.8"])), \
                    patch.object(transport, "_PinnedHTTPS", _Connection):
                result = search_model.search("find public references", state_dir=state)
            self.assertEqual(result["sourceType"], "search_model")
            self.assertEqual(result["provenance"]["networkAccess"], "unverified")
            self.assertFalse(result["provenance"]["urlsVerified"])
            self.assertEqual(len(result["output"]), 1)
            self.assertEqual(result["output"][0]["urlCheck"], "https_syntax_only")
            self.assertFalse(result["output"][0]["verified"])
            self.assertIn("未验证模型是否访问互联网", result["notice"])
            request = _Connection.requests[0]
            self.assertEqual(request[0], "models.example")
            self.assertEqual(request[1], "8.8.8.8")
            self.assertEqual(request[2:4], ("POST", "/v1/chat/completions"))
            self.assertEqual(request[4]["Authorization"], "Bearer independent-search-secret")
            self.assertNotIn("independent-search-secret", request[6].decode("utf-8"))
            self.assertEqual(json.loads(request[6])["model"], "web-researcher")

    def test_search_model_free_text_never_becomes_search_evidence(self):
        with tempfile.TemporaryDirectory() as state:
            search_settings.update_settings(state, {
                "searchMode": "model",
                "searchModelEndpoint": "https://models.example/v1/chat/completions",
                "searchModel": "web-researcher",
                "searchModelKey": "search-secret",
            })
            with patch.object(search_model, "post_json", return_value=({
                    "choices": [{"message": {"content": "Here are five current facts."}}]}, "system")):
                with self.assertRaises(transport.NetworkError) as caught:
                    search_model.search("a current event", state_dir=state)
            result = caught.exception.as_result()
            self.assertEqual(result["error_code"], "search_model_response_invalid")
            self.assertFalse(result["retryable"])
            self.assertIn("不会把自由文本", result["user_reason"])


if __name__ == "__main__":
    unittest.main()
