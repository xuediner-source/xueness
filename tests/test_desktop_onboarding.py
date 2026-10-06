import os
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from xueness import plugin_runtime, web
from xueness.bundled_plugins.onboarding import desktop_setup


class DesktopOnboardingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.state = Path(self.temporary.name) / 'state'
        self.state.mkdir()
        self.ctx = {'state_dir': self.state, 'desktop_token': 'test-host'}

    def request(self, method='GET', data=None):
        return plugin_runtime.dispatch_http(method, ['api', 'onboarding', 'desktop'], {}, data or {}, self.ctx)

    def test_first_launch_is_saved_privately_and_only_for_this_state(self):
        self.assertEqual(self.request(), (200, {'completed': False, 'version': 1}))
        self.assertFalse((self.state/'desktop-onboarding.json').exists())
        self.assertEqual(self.request('POST', {'completed': True}), (200, {'completed': True, 'version': 1}))
        self.assertTrue(self.request()[1]['completed'])
        if os.name != 'nt':
            self.assertEqual((self.state/'desktop-onboarding.json').stat().st_mode & 0o777, 0o600)
        other = dict(self.ctx, state_dir=Path(self.temporary.name)/'other')
        self.assertFalse(desktop_setup.dispatch('GET', ['api', 'onboarding', 'desktop'], {}, other)[1]['completed'])

    def test_requires_native_host_and_both_plugins(self):
        self.ctx.pop('desktop_token')
        self.assertEqual(self.request()[0], 403)
        self.ctx['desktop_token'] = 'test-host'
        for plugin in ('desktop', 'onboarding', 'providers'):
            plugin_runtime.set_enabled(self.state, plugin, False)
            with patch.object(desktop_setup, '_load', side_effect=AssertionError('disabled read')):
                self.assertEqual(self.request()[0], 403)
                self.assertEqual(self.request('POST', {'completed': True})[0], 403)
            plugin_runtime.set_enabled(self.state, plugin, True)

    def test_rejects_unknown_fields_reset_and_wrong_methods(self):
        for data in ({'completed': False}, {'completed': 1}, {'completed': True, 'permission': 'fullDisk'}, {}):
            self.assertEqual(self.request('POST', data)[0], 400)
        self.assertEqual(self.request('DELETE')[0], 405)
        self.assertIsNone(desktop_setup.dispatch('GET', ['api', 'onboarding', 'elsewhere'], {}, self.ctx))

    def test_rejects_symlinks_malformed_and_oversized_state(self):
        path = self.state/'desktop-onboarding.json'
        outside = Path(self.temporary.name)/'outside'
        outside.write_text('preserve')
        path.symlink_to(outside)
        self.assertEqual(self.request()[0], 400)
        self.assertEqual(self.request('POST', {'completed': True})[0], 400)
        self.assertEqual(outside.read_text(), 'preserve')
        path.unlink()
        for raw in ('{}', '{"completed":true,"version":true}', 'x' * 4097):
            path.write_text(raw)
            self.assertEqual(self.request()[0], 400)
        path.unlink()
        linked = Path(self.temporary.name)/'linked'
        linked.symlink_to(self.state, target_is_directory=True)
        self.ctx['state_dir'] = linked
        self.assertEqual(self.request('POST', {'completed': True})[0], 400)

    def test_write_failure_does_not_mark_complete_or_touch_model_state(self):
        sentinel = self.state/'providers.json'
        sentinel.write_text('owner configuration')
        with patch.object(desktop_setup, '_atomic_write_json', side_effect=OSError('disk full')):
            self.assertEqual(self.request('POST', {'completed': True})[0], 400)
        self.assertFalse(self.request()[1]['completed'])
        self.assertEqual(sentinel.read_text(), 'owner configuration')

    def test_real_http_completion_requires_host_token_origin_csrf_and_plugin(self):
        root = Path(self.temporary.name)
        (self.state/'plugin-state.json').write_text(json.dumps({
            'apiVersion': 1, 'enabled': {pid: pid in ('onboarding', 'desktop', 'providers')
                                      for pid in plugin_runtime.PLUGIN_IDS}}))
        ctx = web.build_context(self.state, root/'runs', root)
        ctx['desktop_token'] = 'a' * 64
        ctx['allow_real'] = False
        server = web.create_server(0, ctx, '127.0.0.1')
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = 'http://127.0.0.1:' + str(server.server_address[1])
        def request(method='GET', headers=None, path='/api/onboarding/desktop'):
            req = urllib.request.Request(origin + path, method=method,
                data=json.dumps({'completed': True}).encode() if method == 'POST' else None,
                headers=headers or {})
            try:
                with urllib.request.urlopen(req, timeout=5) as result:
                    return result.status, json.load(result)
            except urllib.error.HTTPError as exc:
                with exc:
                    return exc.code, json.load(exc)
        try:
            self.assertEqual(request()[0], 403)
            headers = {'X-Xueness-Desktop-Token': ctx['desktop_token'], 'Origin': origin,
                       'Content-Type': 'application/json'}
            self.assertFalse(request(headers=headers)[1]['completed'])
            self.assertEqual(request('POST', headers)[0], 403)
            headers['X-CSRF-Token'] = request(headers=headers, path='/api/csrf')[1]['csrfToken']
            self.assertEqual(request('POST', dict(headers, Origin='https://example.com'))[0], 403)
            self.assertEqual(request('POST', headers), (200, {'completed': True, 'version': 1}))
            plugin_runtime.set_enabled(self.state, 'onboarding', False)
            self.assertEqual(request('POST', headers)[0], 403)
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=5)
            if ctx.get('terminals'):
                ctx['terminals'].close()
