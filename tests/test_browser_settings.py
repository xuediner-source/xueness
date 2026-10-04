import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from xueness.bundled_plugins.browser import settings_api
from xueness.plugin_runtime import dispatch_http, set_enabled


class BrowserSettingsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.state = self.base / 'state'
        self.state.mkdir()
        self.profile = self.state / 'browser-profile'
        self.ctx = {'state_dir': self.state, 'running': set(), 'lock': threading.Lock()}
        self.shutdown = patch('xueness.bundled_plugins.browser.plugin.shutdown')
        self.stopped = self.shutdown.start()
        self.addCleanup(self.shutdown.stop)

    def call(self, method='GET', payload=None):
        return settings_api.dispatch(method, ['api','browser','data'], {}, payload or {}, self.ctx)

    def seed(self):
        cache = self.profile / 'Default' / 'Cache'
        cache.mkdir(parents=True)
        (cache / 'data').write_text('cache')
        (self.profile / 'Default' / 'Cookies').write_text('session fixture')

    def test_profile_metadata_does_not_launch_browser_or_expose_content(self):
        self.assertEqual(self.call(), (200, {'profilePresent': False}))
        self.seed()
        self.assertEqual(self.call(), (200, {'profilePresent': True}))
        self.stopped.assert_not_called()

    def test_cache_clear_preserves_login_data_and_other_process_profiles(self):
        self.seed()
        other = self.state / 'browser-profile-other'
        other.mkdir()
        (other / 'Cache').write_text('other process')
        self.assertEqual(self.call('POST', {'operation': 'cache'}), (200, {'ok': True}))
        self.assertFalse((self.profile / 'Default' / 'Cache').exists())
        self.assertEqual((self.profile / 'Default' / 'Cookies').read_text(), 'session fixture')
        self.assertTrue((other / 'Cache').is_file())
        self.stopped.assert_called_once_with(self.state)

    def test_all_requires_explicit_confirmation_and_no_running_tasks(self):
        self.seed()
        self.assertEqual(self.call('POST', {'operation': 'all'})[0], 400)
        self.ctx['running'].add('running-fixture')
        self.assertEqual(self.call('POST', {'operation': 'all', 'confirmed': True})[0], 409)
        self.assertTrue(self.profile.exists())
        self.stopped.assert_not_called()
        self.ctx['running'].clear()
        self.assertEqual(self.call('POST', {'operation': 'all', 'confirmed': True}), (200, {'ok': True}))
        self.assertFalse(self.profile.exists())

    def test_symlinked_profile_and_cache_parent_cannot_clear_outside_data(self):
        outside = self.base / 'outside'
        outside.mkdir()
        (outside / 'Cache').mkdir()
        (outside / 'Cache' / 'keep').write_text('outside fixture')
        self.profile.mkdir()
        with patch('xueness.bundled_plugins.browser.profiles._link', side_effect=lambda path: path == self.profile):
            self.assertEqual(self.call('POST', {'operation':'all','confirmed':True})[0], 400)
        (self.profile / 'Default').mkdir()
        with patch.object(settings_api, '_link', side_effect=lambda path: path == self.profile/'Default'):
            self.assertEqual(self.call('POST', {'operation':'cache'})[0], 400)
        self.assertEqual((outside / 'Cache' / 'keep').read_text(), 'outside fixture')
        self.stopped.assert_not_called()

    def test_clear_all_removes_only_generated_import_backups(self):
        self.seed()
        backup = self.state / ('browser-import-old-' + 'a'*32)
        backup.mkdir()
        (backup/'Cookies').write_text('old fixture')
        unrelated = self.state/'browser-import-old-personal'
        unrelated.mkdir()
        self.assertEqual(self.call('POST', {'operation':'all','confirmed':True}), (200, {'ok': True}))
        self.assertFalse(backup.exists())
        self.assertTrue(unrelated.exists())

    def test_runtime_reports_actual_host_and_desktop_plugin_state(self):
        set_enabled(self.state, 'browser', True)
        with patch('xueness.bundled_plugins.browser.runtime.browser_runtime', return_value={'available':True,'browser':'Chrome','reason':None}) as probe:
            route = ['api','browser','runtime']
            status, value = dispatch_http('GET', route, {}, {}, self.ctx)
            self.assertEqual(status, 200)
            self.assertFalse(value['desktop'])
            self.assertFalse(value['importEnabled'])
            self.ctx['desktop_token'] = 'fixture-token'
            self.assertTrue(dispatch_http('GET', route, {}, {}, self.ctx)[1]['importEnabled'])
            set_enabled(self.state, 'desktop', False)
            self.assertFalse(dispatch_http('GET', route, {}, {}, self.ctx)[1]['importEnabled'])
            set_enabled(self.state, 'browser', False)
            probe.reset_mock()
            self.assertEqual(dispatch_http('GET', route, {}, {}, self.ctx)[0], 403)
            probe.assert_not_called()

    def test_runtime_route_obeys_plugin_gate(self):
        self.assertEqual(dispatch_http('GET', ['api','browser','data'], {}, {}, self.ctx)[0], 403)
        set_enabled(self.state, 'browser', True)
        self.assertEqual(dispatch_http('GET', ['api','browser','data'], {}, {}, self.ctx), (200, {'profilePresent': False}))


if __name__ == '__main__':
    unittest.main()
