"""desktop.host_capability: platform probe and one-time tickets, default off.

The probe reuses process_runtime.host_platform_family and
write_lock.host_paths_ignore_case. Windows and macOS are mocked. A consumed
ticket does not replace the desktop token or CSRF.
"""
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from xueness import process_runtime, web, write_lock
from xueness.bundled_plugins.desktop import host, host_capability
from xueness.bundled_plugins.desktop.plugin import dispatch as plugin_dispatch
from xueness.bundled_plugins.settings import workspaces_api
from xueness.bundled_plugins.settings.settings_store import save_settings
from xueness.plugin_runtime import dispatch_http, set_enabled


TOKEN = 'a' * 32
OTHER = 'b' * 32
STATUS_KEYS = {
    'desktop', 'platform', 'version', 'frozen', 'dataDirectory', 'nativeDirectoryPicker',
}
CAPABILITY_KEYS = {
    'desktopHost', 'nativeDirectoryPicker', 'nativeWorkspacePicker',
    'nativePermissionBridge', 'frozen', 'hostOriginCsrf', 'desktopContinuous',
    'websocketRpc', 'processResourceTelemetry', 'hostCapabilityTicket',
    'caseInsensitivePaths',
}
PROBE = ['api', 'desktop', 'host-capability']
CONSUME = ['api', 'desktop', 'host-capability', 'consume']


def _enable(ctx, enabled=True):
    save_settings(ctx['state_dir'], {
        'general': {host_capability.SETTINGS_KEY: enabled},
    })


class StoreTests(unittest.TestCase):
    def test_issue_consume_once_and_replay_and_expiry_are_distinct(self):
        now = [1_000]
        store = host_capability.HostCapabilityStore(
            now=lambda: now[0], ttl_ms=1_000, create_capability=lambda: TOKEN)
        issued = store.issue()
        self.assertEqual(issued['capability'], TOKEN)
        self.assertEqual(issued['expiresAt'], 2_000)
        now[0] = 1_999
        self.assertTrue(store.consume(TOKEN))
        self.assertFalse(store.consume(TOKEN))
        self.assertEqual(store.live_count(), 0)

        now[0] = 5_000
        issued = store.issue()
        self.assertEqual(issued['expiresAt'], 6_000)
        now[0] = 6_000
        self.assertFalse(store.consume(TOKEN))
        now[0] = 5_000
        self.assertFalse(store.consume(TOKEN))
        self.assertEqual(store.live_count(), 0)

    def test_malformed_values_are_rejected_without_storage(self):
        store = host_capability.HostCapabilityStore(create_capability=lambda: 'short')
        with self.assertRaises(ValueError):
            store.issue()
        self.assertEqual(store.live_count(), 0)
        self.assertFalse(store.consume(None))
        self.assertFalse(store.consume(''))
        self.assertFalse(store.consume('short'))
        self.assertFalse(store.consume(TOKEN + ' '))
        with self.assertRaises(ValueError):
            host_capability.HostCapabilityStore(ttl_ms=True)
        with self.assertRaises(ValueError):
            host_capability.HostCapabilityStore(max_live=False)

    def test_full_store_refuses_a_new_token_and_purge_frees_the_slot(self):
        now = [0]
        seq = {'n': 0}

        def create():
            seq['n'] += 1
            return f'{seq["n"]:032d}'

        store = host_capability.HostCapabilityStore(
            now=lambda: now[0], ttl_ms=1_000, max_live=1, create_capability=create)
        first = store.issue()
        self.assertIsNone(store.issue())
        self.assertEqual(store.live_count(), 1)
        now[0] = 1_000
        second = store.issue()
        self.assertIsNotNone(second)
        self.assertNotEqual(second['capability'], first['capability'])
        self.assertEqual(store.live_count(), 1)
        self.assertFalse(store.consume(first['capability']))
        self.assertTrue(store.consume(second['capability']))

    def test_same_token_refreshes_one_slot_instead_of_growing(self):
        now = [0]
        store = host_capability.HostCapabilityStore(
            now=lambda: now[0], ttl_ms=1_000, max_live=1, create_capability=lambda: TOKEN)
        self.assertEqual(store.issue()['expiresAt'], 1_000)
        now[0] = 500
        refreshed = store.issue()
        self.assertEqual(refreshed['expiresAt'], 1_500)
        self.assertEqual(store.live_count(), 1)
        self.assertTrue(store.consume(TOKEN))

    def test_concurrent_consume_succeeds_once(self):
        store = host_capability.HostCapabilityStore(
            now=lambda: 0, ttl_ms=5_000, create_capability=lambda: TOKEN)
        store.issue()
        barrier = threading.Barrier(8)
        results = []
        lock = threading.Lock()

        def worker():
            barrier.wait()
            ok = store.consume(TOKEN)
            with lock:
                results.append(ok)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)
        self.assertEqual(results.count(True), 1)
        self.assertEqual(store.live_count(), 0)

    def test_default_token_is_urlsafe_and_unique(self):
        store = host_capability.HostCapabilityStore(now=lambda: 0)
        first = store.issue()['capability']
        second = store.issue()['capability']
        self.assertNotEqual(first, second)
        self.assertRegex(first, r'^[A-Za-z0-9_-]{16,128}$')
        self.assertGreaterEqual(len(first), 43)


class PlatformTests(unittest.TestCase):
    def test_family_checks_macos_before_the_win_inside_darwin(self):
        self.assertEqual(process_runtime.host_platform_family('darwin'), 'macos')
        self.assertEqual(process_runtime.host_platform_family('Darwin'), 'macos')
        self.assertEqual(process_runtime.host_platform_family('MacIntel'), 'macos')
        self.assertEqual(process_runtime.host_platform_family('win32'), 'windows')
        self.assertEqual(process_runtime.host_platform_family('Win32'), 'windows')
        self.assertEqual(process_runtime.host_platform_family('windows'), 'windows')
        self.assertEqual(process_runtime.host_platform_family('linux'), 'linux')
        self.assertEqual(process_runtime.host_platform_family('Linux'), 'linux')
        self.assertEqual(process_runtime.host_platform_family(''), 'unknown')
        self.assertEqual(process_runtime.host_platform_family('   '), 'unknown')
        self.assertEqual(process_runtime.host_platform_family(None),
                         process_runtime.host_platform_family())
        self.assertEqual(process_runtime.host_platform_family(12), 'unknown')
        self.assertEqual(process_runtime.host_platform_family('freebsd'), 'freebsd')
        self.assertNotEqual(process_runtime.host_platform_family('darwin'), 'windows')

    def test_picker_name_uses_the_same_helper_on_windows_and_macos(self):
        for platform_name, family in (('win32', 'windows'), ('darwin', 'macos'), ('linux', 'linux')):
            with self.subTest(platform=platform_name), \
                    mock.patch.object(process_runtime.sys, 'platform', platform_name):
                self.assertEqual(process_runtime.host_platform_family(), family)
                self.assertEqual(workspaces_api._platform_name(), family)

    def test_case_folding_predicate_matches_the_lock_on_each_platform(self):
        with self.subTest(platform='darwin'), \
                mock.patch.object(write_lock.sys, 'platform', 'darwin'), \
                mock.patch.object(write_lock.os, 'name', 'posix'):
            self.assertTrue(write_lock.host_paths_ignore_case())
            self.assertEqual(write_lock._fold_host_path('Notes'), write_lock._fold_host_path('notes'))
        with self.subTest(platform='win32'), \
                mock.patch.object(write_lock.os, 'name', 'nt'), \
                mock.patch.object(write_lock.sys, 'platform', 'win32'):
            self.assertTrue(write_lock.host_paths_ignore_case())
        with self.subTest(platform='linux'), \
                mock.patch.object(write_lock.sys, 'platform', 'linux'), \
                mock.patch.object(write_lock.os, 'name', 'posix'):
            self.assertFalse(write_lock.host_paths_ignore_case())
            self.assertNotEqual(write_lock._fold_host_path('Notes'), write_lock._fold_host_path('notes'))


class _Ctx(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.ctx = web.build_context(base / 'state', base / 'runs', base / 'project',
                                     allow_real=False, csrf='test-csrf-token')
        self.addCleanup(lambda: host_capability.forget_store(self.ctx))

    def _dispatch(self, method, parts, data=None, query=None, ctx=None):
        return host_capability.dispatch(
            method, parts, query if query is not None else {}, data if data is not None else {},
            self.ctx if ctx is None else ctx)


class DispatchTests(_Ctx):
    def test_flag_off_answers_400_and_does_not_store_or_change_status(self):
        status = plugin_dispatch('GET', ['api', 'desktop', 'status'], {}, {}, self.ctx)
        code, payload = self._dispatch('GET', PROBE)
        self.assertEqual(code, 400)
        self.assertEqual(payload, {
            'error': host_capability.NOT_ENABLED_ERROR,
            'feature': host_capability.FEATURE_ID,
        })
        self.assertIsNone(host_capability.peek_store(self.ctx))
        code, payload = self._dispatch('POST', PROBE, {})
        self.assertEqual(code, 400)
        self.assertIsNone(host_capability.peek_store(self.ctx))
        code, payload = self._dispatch('POST', CONSUME, {'capability': TOKEN})
        self.assertEqual(code, 400)
        self.assertEqual(self._dispatch('GET', CONSUME)[0], 405)
        again = plugin_dispatch('GET', ['api', 'desktop', 'status'], {}, {}, self.ctx)
        self.assertEqual(status, again)
        self.assertEqual(set(again[1]), STATUS_KEYS)

    def test_non_boolean_does_not_enable(self):
        save_settings(self.ctx['state_dir'], {'general': {host_capability.SETTINGS_KEY: 'true'}})
        self.assertFalse(host_capability.enabled(self.ctx))
        self.assertEqual(self._dispatch('GET', PROBE)[0], 400)
        self.assertFalse(host_capability.enabled(None))
        self.assertFalse(host_capability.enabled({}))

    def test_probe_shape_matches_on_windows_and_macos(self):
        _enable(self.ctx, True)
        shapes = {}
        original_ignore = write_lock.host_paths_ignore_case
        for platform_name, family, os_name, ignore in (
            ('win32', 'windows', 'nt', True),
            ('darwin', 'macos', 'posix', True),
            ('linux', 'linux', 'posix', False),
        ):
            # Patch os.name only inside the predicate. Leaving it as "nt" for
            # the whole request makes pathlib build a WindowsPath and refuse
            # to resolve the state directory on this host.
            def ignore_case(_os_name=os_name, _platform_name=platform_name):
                with mock.patch.object(os, 'name', _os_name), \
                        mock.patch.object(write_lock.sys, 'platform', _platform_name):
                    return original_ignore()

            with self.subTest(platform=platform_name), \
                    mock.patch.object(host.sys, 'platform', platform_name), \
                    mock.patch.object(write_lock, 'host_paths_ignore_case', ignore_case), \
                    mock.patch.object(workspaces_api.shutil, 'which',
                                      return_value='/usr/bin/osascript') as which:
                code, payload = self._dispatch(
                    'GET', PROBE, query={'platform': ['win32'], 'family': ['macos']})
                self.assertEqual(code, 200, payload)
                self.assertEqual(payload['schema'], host_capability.SCHEMA)
                self.assertEqual(payload['feature'], host_capability.FEATURE_ID)
                self.assertEqual(payload['platform'], {'raw': platform_name, 'family': family})
                self.assertEqual(set(payload['capabilities']), CAPABILITY_KEYS)
                caps = payload['capabilities']
                self.assertEqual(caps['caseInsensitivePaths'], ignore)
                self.assertEqual(caps['nativeWorkspacePicker'], {
                    'available': family == 'macos', 'platform': family,
                })
                self.assertFalse(caps['desktopContinuous'])
                self.assertFalse(caps['websocketRpc'])
                self.assertFalse(caps['processResourceTelemetry'])
                self.assertTrue(caps['hostCapabilityTicket'])
                self.assertTrue(caps['hostOriginCsrf'])
                self.assertNotIn('dataDirectory', json.dumps(payload))
                self.assertNotIn('capability', payload)
                if family == 'macos':
                    which.assert_called()
                else:
                    which.assert_not_called()
                shapes[family] = set(payload)
        self.assertEqual(shapes['windows'], shapes['macos'])
        self.assertEqual(shapes['linux'], shapes['macos'])

    def test_issue_is_empty_body_only_and_consume_is_one_time(self):
        _enable(self.ctx, True)
        code, payload = self._dispatch('POST', PROBE, {'capability': TOKEN})
        self.assertEqual(code, 400, payload)
        self.assertIsNone(host_capability.peek_store(self.ctx))
        code, payload = self._dispatch('POST', PROBE, {})
        self.assertEqual(code, 200, payload)
        self.assertFalse(payload['grantsAccess'])
        token = payload['capability']
        self.assertNotIn(token, json.dumps({k: v for k, v in payload.items() if k != 'capability'}))
        code, payload = self._dispatch('POST', CONSUME, {'capability': token})
        self.assertEqual(code, 200, payload)
        self.assertTrue(payload['accepted'])
        self.assertFalse(payload['grantsAccess'])
        self.assertNotIn('trusted_host', self.ctx)
        code, payload = self._dispatch('POST', CONSUME, {'capability': token})
        self.assertEqual(code, 401, payload)
        self.assertNotIn(token, json.dumps(payload))

    def test_mismatch_does_not_burn_the_live_ticket(self):
        _enable(self.ctx, True)
        now = [10_000]
        store = host_capability.HostCapabilityStore(
            now=lambda: now[0], ttl_ms=30_000, create_capability=lambda: TOKEN,
            server_id='ab' * 16)
        host_capability.bind_store(self.ctx, store)
        issued = self._dispatch('POST', PROBE, {})[1]
        self.assertEqual(issued['expiresAt'], 40_000)
        self.ctx['handler'] = SimpleNamespace(headers={host_capability.HEADER: TOKEN})
        code, payload = self._dispatch('POST', CONSUME, {'capability': OTHER})
        self.assertEqual(code, 400, payload)
        self.assertEqual(store.live_count(), 1)
        code, payload = self._dispatch('POST', CONSUME, {})
        self.assertEqual(code, 200, payload)
        now[0] = 50_000
        refreshed = store.issue()
        self.assertEqual(refreshed['expiresAt'], 80_000)
        now[0] = 80_000
        self.assertEqual(self._dispatch('POST', CONSUME, {'capability': TOKEN})[0], 401)
        self.assertEqual(store.live_count(), 0)

    def test_header_only_consume_and_unknown_token_are_401_not_400(self):
        _enable(self.ctx, True)
        code, payload = self._dispatch('POST', CONSUME, {'capability': TOKEN})
        self.assertEqual(code, 401, payload)
        self.assertIsNone(host_capability.peek_store(self.ctx))
        code, payload = self._dispatch('POST', CONSUME, {'capability': 'short'})
        self.assertEqual(code, 400, payload)
        issued = self._dispatch('POST', PROBE, {})[1]
        self.ctx['handler'] = SimpleNamespace(
            headers={host_capability.HEADER: issued['capability']})
        self.assertEqual(self._dispatch('POST', CONSUME, {})[0], 200)

    def test_disabling_during_issue_burns_the_token(self):
        _enable(self.ctx, True)

        def create():
            _enable(self.ctx, False)
            return 'd' * 32

        host_capability.bind_store(self.ctx, host_capability.HostCapabilityStore(
            now=lambda: 0, ttl_ms=30_000, create_capability=create, server_id='cd' * 16))
        code, payload = self._dispatch('POST', PROBE, {})
        self.assertEqual(code, 400, payload)
        self.assertNotIn('capability', payload)
        self.assertEqual(host_capability.peek_store(self.ctx).live_count(), 0)
        _enable(self.ctx, True)
        self.assertEqual(self._dispatch('POST', CONSUME, {'capability': 'd' * 32})[0], 401)

    def test_stores_do_not_cross_state_directories(self):
        other_temp = tempfile.TemporaryDirectory()
        self.addCleanup(other_temp.cleanup)
        other_base = Path(other_temp.name)
        other = web.build_context(other_base / 'state', other_base / 'runs', other_base / 'project',
                                  allow_real=False, csrf='test-csrf-token')
        self.addCleanup(lambda: host_capability.forget_store(other))
        _enable(self.ctx, True)
        _enable(other, True)
        issued = self._dispatch('POST', PROBE, {})[1]
        token = issued['capability']
        code, _payload = host_capability.dispatch(
            'POST', CONSUME, {}, {'capability': token}, other)
        self.assertEqual(code, 401)
        self.assertEqual(self._dispatch('POST', CONSUME, {'capability': token})[0], 200)

    def test_bad_generator_stores_nothing(self):
        _enable(self.ctx, True)
        host_capability.bind_store(self.ctx, host_capability.HostCapabilityStore(
            create_capability=lambda: 'short', server_id='ef' * 16))
        code, payload = self._dispatch('POST', PROBE, {})
        self.assertEqual(code, 500, payload)
        self.assertEqual(host_capability.peek_store(self.ctx).live_count(), 0)
        self.assertNotIn('short', json.dumps(payload))

    def test_existing_desktop_routes_stay_unscoped(self):
        _enable(self.ctx, True)
        code, status = plugin_dispatch('GET', ['api', 'desktop', 'status'], {}, {}, self.ctx)
        self.assertEqual(code, 200)
        self.assertEqual(set(status), STATUS_KEYS)
        code, permissions = plugin_dispatch(
            'GET', ['api', 'desktop', 'permissions'], {}, {}, self.ctx)
        self.assertEqual(code, 200, permissions)
        self.assertIn('permissions', permissions)
        self.assertNotIn('schema', permissions)
        routed = dispatch_http('GET', PROBE, {}, {}, self.ctx)
        self.assertEqual(routed[0], 200)
        self.assertEqual(routed[1]['feature'], host_capability.FEATURE_ID)


class HttpTests(_Ctx):
    def setUp(self):
        super().setUp()
        self.server = web.create_server(0, self.ctx)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self._stop)
        self.base = f'http://127.0.0.1:{self.server.server_address[1]}'

    def _stop(self):
        self.server.shutdown()
        self.server.server_close()

    def _request(self, method, path, body=None, csrf='test-csrf-token', headers=None):
        header = {'Content-Type': 'application/json'}
        if headers:
            header.update(headers)
        if csrf is not None and method != 'GET':
            header['X-CSRF-Token'] = csrf
        if body is None and method != 'GET':
            data = b'{}'
        elif body is None:
            data = None
        else:
            data = json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, headers=header, method=method)
        try:
            with urllib.request.urlopen(req, timeout=10) as response:
                raw = response.read()
                return response.status, json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            try:
                payload = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                payload = {'error': raw.decode('utf-8', 'replace')}
            return exc.code, payload

    def test_csrf_origin_and_desktop_token_still_gate_the_new_routes(self):
        _enable(self.ctx, True)
        self.assertEqual(self._request('POST', '/api/desktop/host-capability', {}, csrf=None)[0], 403)
        code, payload = self._request(
            'GET', '/api/desktop/host-capability', headers={'Origin': 'http://evil.example'})
        self.assertEqual(code, 403, payload)
        self.assertIn('host not permitted', payload['error'])
        self.ctx['desktop_token'] = '12' * 32
        code, payload = self._request('GET', '/api/desktop/host-capability')
        self.assertEqual(code, 403, payload)
        code, payload = self._request(
            'GET', '/api/desktop/host-capability',
            headers={host_capability.HEADER: TOKEN})
        self.assertEqual(code, 403, payload)
        code, payload = self._request(
            'POST', '/api/desktop/host-capability', {},
            headers={'X-Xueness-Desktop-Token': self.ctx['desktop_token']})
        self.assertEqual(code, 200, payload)
        self.assertFalse(payload['grantsAccess'])
        token = payload['capability']
        code, payload = self._request(
            'POST', '/api/desktop/host-capability/consume', {'capability': token})
        self.assertEqual(code, 403, payload)
        code, payload = self._request(
            'POST', '/api/desktop/host-capability/consume', {'capability': token},
            headers={'X-Xueness-Desktop-Token': self.ctx['desktop_token']})
        self.assertEqual(code, 200, payload)
        self.assertFalse(payload['grantsAccess'])
        status = self._request(
            'GET', '/api/desktop/status',
            headers={'X-Xueness-Desktop-Token': self.ctx['desktop_token']})[1]
        self.assertEqual(set(status), STATUS_KEYS)
        self.assertNotIn(token, json.dumps(status))

    def test_ticket_is_not_written_beside_settings(self):
        _enable(self.ctx, True)
        token = self._request('POST', '/api/desktop/host-capability', {})[1]['capability']
        blob = b''
        for path in Path(self.temp.name).rglob('*'):
            if path.is_file():
                blob += path.read_bytes()
        self.assertNotIn(token.encode(), blob)
        self.assertIn(host_capability.SETTINGS_KEY.encode(), blob)

    def test_settings_round_trip_and_disabled_plugin(self):
        code, payload = self._request('POST', '/api/settings/general', {
            'values': {host_capability.SETTINGS_KEY: 'true'},
        })
        self.assertEqual(code, 400, payload)
        self.assertEqual(self._request('GET', '/api/desktop/host-capability')[0], 400)
        code, payload = self._request('POST', '/api/settings/general', {
            'values': {host_capability.SETTINGS_KEY: True},
        })
        self.assertEqual(code, 200, payload)
        with mock.patch.object(host.sys, 'platform', 'linux'):
            probe = self._request('GET', '/api/desktop/host-capability?platform=win32')[1]
        self.assertEqual(probe['platform'], {'raw': 'linux', 'family': 'linux'})
        self.assertEqual(self._request('PUT', '/api/desktop/host-capability', {})[0], 405)
        self.assertEqual(self._request('GET', '/api/desktop/host-capability/nope')[0], 404)
        set_enabled(self.ctx['state_dir'], 'desktop', False)
        self.assertEqual(self._request('GET', '/api/desktop/host-capability')[0], 403)
        set_enabled(self.ctx['state_dir'], 'desktop', True)
        self.assertEqual(self._request('GET', '/api/desktop/host-capability')[0], 200)

    def test_full_store_is_429_and_a_consumed_slot_can_be_reused(self):
        _enable(self.ctx, True)
        seq = {'n': 0}

        def create():
            seq['n'] += 1
            return f'{seq["n"]:032d}'

        host_capability.bind_store(self.ctx, host_capability.HostCapabilityStore(
            now=lambda: 0, ttl_ms=30_000, max_live=1, create_capability=create,
            server_id='11' * 16))
        first = self._request('POST', '/api/desktop/host-capability', {})
        self.assertEqual(first[0], 200, first[1])
        second = self._request('POST', '/api/desktop/host-capability', {})
        self.assertEqual(second[0], 429, second[1])
        self.assertNotIn('capability', second[1])
        consumed = self._request('POST', '/api/desktop/host-capability/consume',
                                 {'capability': first[1]['capability']})
        self.assertEqual(consumed[0], 200, consumed[1])
        third = self._request('POST', '/api/desktop/host-capability', {})
        self.assertEqual(third[0], 200, third[1])
