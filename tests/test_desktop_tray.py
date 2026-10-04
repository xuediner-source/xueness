"""Actual HTTP tray entry: authentication, plugin ownership and fixed asset only."""
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from tests.fs_link_helpers import make_symlink
from xueness import plugin_runtime, web


class DesktopTrayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.ctx = web.build_context(base/'state', base/'runs', base, allow_real=False)
        self.assets = base/'assets'
        self.assets.mkdir()
        self.page = b'<!doctype html><title>Tray fixture</title>'
        (self.assets/'tray.html').write_bytes(self.page)
        self.ctx.update(webapp_dir=self.assets, desktop_token='a'*64)
        self.server = web.create_server(0, self.ctx)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}'

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def request(self, path='/api/desktop/tray', token='a'*64):
        return urllib.request.urlopen(urllib.request.Request(self.url+path, headers={'X-Xueness-Desktop-Token': token}), timeout=5)

    def assert_status(self, expected, **kwargs):
        with self.assertRaises(urllib.error.HTTPError) as raised:
            self.request(**kwargs)
        self.assertEqual(raised.exception.code, expected)
        raised.exception.close()

    def test_tray_serves_the_built_page_as_html_only_to_its_authenticated_host(self):
        with self.request() as response:
            self.assertEqual(response.headers.get_content_type(), 'text/html')
            self.assertEqual(response.read(), self.page)
        self.assert_status(403, token='wrong')
        self.ctx.pop('desktop_token')
        self.assert_status(403)

    def test_disabled_desktop_blocks_tray_but_sessions_disabled_still_allows_exit_menu(self):
        plugin_runtime.set_enabled(self.ctx['state_dir'], 'sessions', False)
        with self.request() as response:
            self.assertEqual(response.read(), self.page)
        plugin_runtime.set_enabled(self.ctx['state_dir'], 'desktop', False)
        self.assert_status(403)

    def test_missing_page_is_explicit_and_extra_paths_are_not_served(self):
        (self.assets/'tray.html').unlink()
        self.assert_status(503)
        for path in ['/api/desktop/tray/other.html', '/api/desktop/tray/../secret', '/tray.html']:
            self.assert_status(404, path=path)

    def test_fixed_page_symlink_cannot_escape_to_unrelated_files(self):
        outside = self.assets.parent/'secret.html'
        outside.write_text('must not expose', encoding='utf-8')
        target = self.assets/'tray.html'
        target.unlink()
        make_symlink(target, outside)
        self.assert_status(404)
