"""Permission endpoints stay behind desktop ownership and never invent grants."""
import http.client
import io
import json
import re
import tempfile
import threading
import time
import unittest
from pathlib import Path

from xueness import plugin_runtime
from xueness.web import build_context, create_server
from xueness.bundled_plugins.desktop.bridge import DesktopBridge
from xueness.bundled_plugins.desktop.permissions import bind_permissions


PERMISSION_ROWS = [
    {'id': 'accessibility', 'status': 'not-determined', 'canRequest': True},
    {'id': 'screen', 'status': 'denied', 'canRequest': True},
    {'id': 'fullDisk', 'status': 'unknown', 'canRequest': True},
    {'id': 'microphone', 'status': 'granted', 'canRequest': False},
]


class BridgeFixture:
    def __init__(self):
        self.requests = []
        self.response = None

    def request(self, message, **kwargs):
        self.requests.append((message, kwargs))
        if self.response is not None:
            return self.response
        return {'id': 'a' * 32, 'state': {'platform': 'darwin', 'permissions': PERMISSION_ROWS}}


class DesktopPermissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.ctx = build_context(root / 'state', root / 'runs', root, allow_real=False)
        self.ctx['desktop_token'] = 'a' * 64
        self.bridge = BridgeFixture()
        bind_permissions(self.ctx, self.bridge)
        self.server = create_server(0, self.ctx)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
        self.tmp.cleanup()

    def request(self, method, path, body=None, authenticated=True, csrf=True):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_address[1], timeout=5)
        headers = {'Content-Type': 'application/json'}
        if authenticated:
            headers['X-Xueness-Desktop-Token'] = 'a' * 64
        if csrf:
            headers['X-CSRF-Token'] = self.ctx['csrf']
        connection.request(method, path, None if body is None else json.dumps(body), headers)
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_status_uses_private_status_action_and_validates_native_snapshot(self):
        status, snapshot = self.request('GET', '/api/desktop/permissions')
        self.assertEqual(status, 200)
        self.assertEqual(snapshot['platform'], 'darwin')
        self.assertEqual(snapshot['permissions'], PERMISSION_ROWS)
        self.assertEqual(len(self.bridge.requests), 1)
        message, options = self.bridge.requests[0]
        self.assertEqual(message, {'type': 'permissions', 'action': 'status'})
        self.assertEqual(options['timeout'], 30)

    def test_request_body_is_exact_and_consent_is_an_explicit_private_action(self):
        self.assertEqual(self.request('POST', '/api/desktop/permissions/request', {'permission': 'microphone', 'prompt': True})[0], 400)
        self.assertEqual(self.request('POST', '/api/desktop/permissions/request', {'permission': 'camera'})[0], 400)
        self.assertFalse(self.bridge.requests)

        status, snapshot = self.request('POST', '/api/desktop/permissions/request', {'permission': 'microphone'})
        self.assertEqual(status, 200)
        self.assertEqual(snapshot['permissions'], PERMISSION_ROWS)
        message, options = self.bridge.requests[0]
        self.assertEqual(message, {'type': 'permissions', 'action': 'request', 'permission': 'microphone'})
        self.assertEqual(options['timeout'], 600)

    def test_post_still_requires_csrf_and_desktop_host_token(self):
        self.assertEqual(self.request('POST', '/api/desktop/permissions/request', {'permission': 'screen'}, csrf=False)[0], 403)
        self.assertEqual(self.request('POST', '/api/desktop/permissions/request', {'permission': 'screen'}, authenticated=False)[0], 403)
        self.assertFalse(self.bridge.requests)

    def test_policy_endpoint_is_private_and_reports_only_an_effective_desktop_plugin(self):
        self.assertEqual(self.request('GET', '/api/desktop/permissions/policy', authenticated=False)[0], 403)
        status, policy = self.request('GET', '/api/desktop/permissions/policy')
        self.assertEqual((status, policy), (200, {'enabled': True}))
        self.assertFalse(self.bridge.requests)

        plugin_runtime.set_enabled(self.ctx['state_dir'], 'desktop', False)
        status, _ = self.request('GET', '/api/desktop/permissions/policy')
        self.assertEqual(status, 403)
        status, _ = self.request('GET', '/api/desktop/permissions')
        self.assertEqual(status, 403)
        status, _ = self.request('POST', '/api/desktop/permissions/request', {'permission': 'screen'})
        self.assertEqual(status, 403)
        self.assertFalse(self.bridge.requests)

    def test_web_mode_reports_unsupported_without_claiming_os_grants(self):
        self.ctx.pop('desktop_token')
        status, snapshot = self.request('GET', '/api/desktop/permissions')
        self.assertEqual(status, 200)
        self.assertTrue(all(row['status'] == 'unsupported' and row['canRequest'] is False
                            for row in snapshot['permissions']))
        status, _ = self.request('POST', '/api/desktop/permissions/request', {'permission': 'microphone'})
        self.assertEqual(status, 403)
        self.assertFalse(self.bridge.requests)

    def test_malformed_native_result_is_rejected(self):
        self.bridge.response = {'id': 'bad', 'state': {'platform': 'darwin', 'permissions': PERMISSION_ROWS}}
        status, body = self.request('GET', '/api/desktop/permissions')
        self.assertEqual(status, 503)
        self.assertEqual(body, {'error': 'invalid desktop permission response'})

        self.bridge.response = {
            'id': 'a' * 32,
            'state': {'platform': 'darwin', 'permissions': [dict(PERMISSION_ROWS[0], status=[])]+PERMISSION_ROWS[1:]},
        }
        status, _ = self.request('GET', '/api/desktop/permissions')
        self.assertEqual(status, 503)

    def test_python_private_pipe_emits_exact_status_shape_and_matches_reply_id(self):
        stream = io.StringIO()
        bridge = DesktopBridge(stream)
        bind_permissions(self.ctx, bridge)
        response = []
        worker = threading.Thread(target=lambda: response.append(self.request('GET', '/api/desktop/permissions')))
        worker.start()
        deadline = time.monotonic() + 2
        while not stream.getvalue() and time.monotonic() < deadline:
            time.sleep(.005)
        self.assertTrue(stream.getvalue())
        request = json.loads(stream.getvalue())
        self.assertEqual(set(request), {'type', 'id', 'action'})
        self.assertEqual(request['type'], 'permissions')
        self.assertEqual(request['action'], 'status')
        self.assertRegex(request['id'], re.compile(r'^[a-f0-9]{32}$'))
        bridge.receive({'id': request['id'], 'state': {'platform': 'darwin', 'permissions': PERMISSION_ROWS}})
        worker.join(2)
        bridge.close()
        self.assertFalse(worker.is_alive())
        self.assertEqual(response, [(200, {'platform': 'darwin', 'permissions': PERMISSION_ROWS})])
