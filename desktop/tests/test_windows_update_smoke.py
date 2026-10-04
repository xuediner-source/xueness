"""Fast contract checks for the Windows-only installed-update harness."""
from http.server import ThreadingHTTPServer
from pathlib import Path
import json
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from desktop.scripts.check_windows_update import (
    make_feed_handler,
    next_patch_version,
    write_fixture_descriptor,
)


class WindowsUpdateSmokeTests(unittest.TestCase):
    def test_next_patch_is_stable_and_strictly_newer(self):
        self.assertEqual(next_patch_version('0.1.1'), '0.1.2')
        self.assertEqual(next_patch_version('2.9.99'), '2.9.100')
        for version in ('0.1.1-beta.1', 'v0.1.1', '01.2.3', '1.2'):
            with self.subTest(version=version), self.assertRaises(ValueError):
                next_patch_version(version)

    def test_fixture_descriptor_persists_isolated_paths_outside_installed_app(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app_data = root / 'isolated-appdata'
            report = root / 'update-report.json'
            descriptor_path = write_fixture_descriptor(root, app_data, report, '0.1.3')
            descriptor = json.loads(descriptor_path.read_text(encoding='utf-8'))

            self.assertEqual(descriptor_path, root / 'update-smoke-config.json')
            self.assertEqual(descriptor['fixtureRoot'], str(root.resolve()))
            self.assertEqual(descriptor['appData'], str((app_data / 'user-data').resolve()))
            self.assertEqual(descriptor['report'], str(report.resolve()))
            self.assertEqual(descriptor['expectedVersion'], '0.1.3')

    def test_loopback_feed_serves_allowlisted_assets_and_byte_ranges_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            asset = 'Xueness-0.1.2-windows-x64-setup.exe'
            (root / 'latest.yml').write_text('version: 0.1.2\n', encoding='utf-8')
            (root / asset).write_bytes(b'0123456789')
            allowed = {'latest.yml', asset}
            server = ThreadingHTTPServer(('127.0.0.1', 0), make_feed_handler(root, allowed))
            server.daemon_threads = True
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(server.server_close)
            self.addCleanup(thread.join, 3)
            self.addCleanup(server.shutdown)
            base = f'http://127.0.0.1:{server.server_address[1]}/'

            with urlopen(base + 'latest.yml', timeout=2) as response:
                self.assertIn(b'version: 0.1.2', response.read())
            request = Request(base + asset, headers={'Range': 'bytes=2-5'})
            with urlopen(request, timeout=2) as response:
                self.assertEqual(response.status, 206)
                self.assertEqual(response.headers['Content-Range'], 'bytes 2-5/10')
                self.assertEqual(response.read(), b'2345')
            with self.assertRaises(HTTPError) as error:
                urlopen(base + '%2e%2e/secret.txt', timeout=2)
            self.assertEqual(error.exception.code, 404)
            error.exception.close()


if __name__ == '__main__':
    unittest.main()
