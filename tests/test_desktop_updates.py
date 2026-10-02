import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from xueness.web import build_context, create_server
from xueness.bundled_plugins.updates.desktop_updates import bind_desktop


class BridgeFixture:
    def __init__(self):
        self.requests, self.policies = [], []
    def send(self, message):
        self.policies.append(message)
    def request(self, message, **kwargs):
        self.requests.append(message)
        return {'state': {'phase': 'current', 'currentVersion': '0.1.1', 'canInstall': False, 'canDownload': False}}


class DesktopUpdateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.ctx = build_context(root / 'state', root / 'runs', root, allow_real=False)
        self.ctx['desktop_token'] = 'a' * 64
        self.bridge = BridgeFixture()
        bind_desktop(self.ctx, self.bridge)
        self.server = create_server(0, self.ctx)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(2)
        self.tmp.cleanup()
    def request(self, path, data=None, authenticated=True):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_address[1], timeout=4)
        headers = {'Content-Type': 'application/json', 'X-CSRF-Token': self.ctx['csrf']}
        if authenticated: headers['X-Xueness-Desktop-Token'] = 'a' * 64
        connection.request('POST' if data is not None else 'GET', path, None if data is None else json.dumps(data), headers)
        response = connection.getresponse(); result = response.status, json.loads(response.read()); connection.close()
        return result
    def test_private_update_routes_and_disable_cancel_policy(self):
        self.assertEqual(self.request('/api/updates/status', authenticated=False)[0], 403)
        self.assertFalse(self.bridge.requests)
        self.assertEqual(self.request('/api/updates/status')[0], 200)
        self.assertEqual(self.request('/api/plugins/updates', {'enabled': False})[0], 200)
        count = len(self.bridge.requests)
        self.assertEqual(self.request('/api/updates/check', {})[0], 403)
        self.assertEqual(len(self.bridge.requests), count)
        self.assertFalse(self.bridge.policies[-1]['enabled'])
    def test_settings_toggle_is_host_policy_not_an_arbitrary_feed(self):
        self.assertEqual(self.request('/api/updates/settings', {'autoDownload': False})[0], 200)
        self.assertFalse(self.bridge.policies[-1]['autoDownload'])
        self.assertEqual(self.request('/api/updates/settings', {'autoDownload': 1})[0], 400)
        self.assertEqual(self.request('/api/updates/check', {'url': 'https://evil.example'})[0], 400)
        self.assertEqual(self.request('/api/updates/install', {'version': '../bad.exe'})[0], 400)
    def test_busy_task_prevents_install_and_idle_closes_new_admission(self):
        self.ctx['running'].add('running')
        self.assertEqual(self.request('/api/updates/prepare-install', {})[0], 409)
        self.assertFalse(self.ctx.get('admission_closed'))
        self.ctx['running'].clear()
        self.assertEqual(self.request('/api/updates/prepare-install', {})[0], 200)
        self.assertTrue(self.ctx['admission_closed'])
        self.assertEqual(self.request('/api/sessions', {'task': 'new work'})[0], 503)
    def test_open_installer_only_check_keeps_backend_admission_open(self):
        self.assertEqual(self.request('/api/updates/prepare-install', {'checkOnly': 1})[0], 400)
        self.assertEqual(self.request('/api/updates/prepare-install', {'checkOnly': True})[0], 200)
        self.assertFalse(self.ctx.get('admission_closed'))
        self.assertEqual(self.request('/api/updates/settings', {'autoDownload': False})[0], 200)
    def test_other_inflight_mutation_prevents_restart_without_cancelling_it(self):
        self.ctx['active_mutations'] = {'already-running': '/api/workflows/start'}
        self.assertEqual(self.request('/api/updates/prepare-install', {})[0], 409)
        self.assertFalse(self.ctx.get('admission_closed'))
