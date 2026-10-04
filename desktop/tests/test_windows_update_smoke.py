"""Fast contract checks for the Windows-only installed-update harness."""
from http.server import ThreadingHTTPServer
import os
from pathlib import Path
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from types import SimpleNamespace
from unittest.mock import patch

from desktop.scripts.check_windows_update import (
    cleanup_installer_cache,
    fixture_identity_exists,
    fixture_registration,
    make_feed_handler,
    next_patch_version,
    run_seed,
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

    def test_run_seed_timeout_kills_and_waits_while_retaining_diagnostics(self):
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            executable = work / 'installed-app' / 'xueness-update-smoke-fixture.exe'
            report = work / 'update-report.json'
            (work / 'seed-electron.log').write_text('electron startup breadcrumb\n', encoding='utf-8')
            (work / 'fixture-runtime.jsonl').write_text('fixture runtime breadcrumb\n', encoding='utf-8')
            calls = []

            class TimedOutProcess:
                pid = 4321
                returncode = None

                def wait(self, timeout):
                    calls.append(('wait', timeout))
                    if timeout == 90:
                        self.stdout.write('baseline fixture reached process startup\n')
                        self.stdout.flush()
                        raise subprocess.TimeoutExpired([str(executable), '--seed'], timeout)
                    self.returncode = -9

                def kill(self):
                    calls.append(('kill',))

            process = TimedOutProcess()

            def fake_popen(_args, **kwargs):
                process.stdout = kwargs['stdout']
                return process

            with patch('desktop.scripts.check_windows_update.subprocess.Popen', side_effect=fake_popen) as popen:
                with self.assertRaises(RuntimeError) as raised:
                    run_seed(executable, work, {'APPDATA': str(work / 'appdata')}, report)

            self.assertEqual(calls, [('wait', 90), ('kill',), ('wait', 10)])
            command = popen.call_args.args[0]
            self.assertEqual(command[0], str(executable))
            self.assertIn('--seed', command)
            self.assertIn('--enable-logging', command)

            diagnostics = json.loads((work / 'seed-process.json').read_text(encoding='utf-8'))
            self.assertEqual(diagnostics['executable'], str(executable.resolve()))
            self.assertEqual(diagnostics['pid'], 4321)
            self.assertEqual(diagnostics['exitCode'], -9)
            self.assertTrue(diagnostics['timedOut'])

            message = str(raised.exception)
            self.assertIn(str(executable.resolve()).replace('\\', '\\\\'), message)
            self.assertIn("'exitCode': -9", message)
            self.assertIn('baseline fixture reached process startup', message)
            self.assertIn('electron startup breadcrumb', message)
            self.assertIn('fixture runtime breadcrumb', message)
            self.assertTrue((work / 'seed-process.log').is_file())
            self.assertTrue((work / 'seed-electron.log').is_file())
            self.assertTrue((work / 'fixture-runtime.jsonl').is_file())

    @unittest.skipUnless(os.name == 'nt', 'NSIS registration uses the Windows registry')
    def test_fixture_registration_detects_existing_run_guid(self):
        fixture_id = '12345678-1234-4abc-8def-1234567890ab'
        with tempfile.TemporaryDirectory() as temporary:
            install_location = str(Path(temporary) / 'existing-fixture-install')
            opened = []

            class RegistryKey:
                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    return False

            def open_key(hive, subkey, reserved, access):
                opened.append((hive, subkey, reserved, access))
                if hive == fake_winreg.HKEY_CURRENT_USER and access == (
                    fake_winreg.KEY_READ | fake_winreg.KEY_WOW64_64KEY
                ):
                    return RegistryKey()
                raise FileNotFoundError

            fake_winreg = SimpleNamespace(
                HKEY_CURRENT_USER=object(),
                HKEY_LOCAL_MACHINE=object(),
                KEY_READ=1,
                KEY_WOW64_32KEY=0x0200,
                KEY_WOW64_64KEY=0x0100,
                REG_SZ=1,
                OpenKey=open_key,
                QueryValueEx=lambda _key, value: (install_location if value == 'InstallLocation' else None, 1),
            )

            with patch.dict(sys.modules, {'winreg': fake_winreg}):
                registered = fixture_registration(fixture_id)

            self.assertEqual(registered, install_location)
            self.assertEqual(len(opened), 4)
            self.assertTrue(all(item[1] == rf'Software\{fixture_id}' for item in opened))

    def test_fixture_identity_exists_detects_stale_uninstall_registration(self):
        fixture_id = '12345678-1234-4abc-8def-1234567890ab'
        uninstall_key = rf'Software\Microsoft\Windows\CurrentVersion\Uninstall\{fixture_id}'
        opened = []

        class RegistryKey:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        def open_key(hive, subkey, reserved, access):
            opened.append((hive, subkey, reserved, access))
            if hive == fake_winreg.HKEY_CURRENT_USER and subkey == uninstall_key:
                return RegistryKey()
            raise FileNotFoundError

        fake_winreg = SimpleNamespace(
            HKEY_CURRENT_USER=object(),
            HKEY_LOCAL_MACHINE=object(),
            KEY_READ=1,
            KEY_WOW64_32KEY=0x0200,
            KEY_WOW64_64KEY=0x0100,
            OpenKey=open_key,
        )

        with patch.dict(sys.modules, {'winreg': fake_winreg}):
            self.assertTrue(fixture_identity_exists(fixture_id))

        self.assertEqual(opened[0][1], rf'Software\{fixture_id}')
        self.assertEqual(opened[1][1], uninstall_key)

    def test_cleanup_installer_cache_removes_a_hash_matching_fixture_installer(self):
        fixture_id = '12345678-1234-4abc-8def-1234567890ab'
        installer_bytes = b'this run synthetic setup package'
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            package_dir = work / 'base-build'
            package_dir.mkdir()
            package = package_dir / 'Xueness-0.1.2-windows-x64-setup.exe'
            package.write_bytes(installer_bytes)
            cache = work / 'native-local-appdata' / f'xueness-update-smoke-{fixture_id}-updater'
            cache.mkdir(parents=True)
            (cache / 'installer.exe').write_bytes(installer_bytes)

            with patch('desktop.scripts.check_windows_update.native_installer_cache', return_value=cache):
                cleanup_installer_cache(work, fixture_id)

            self.assertFalse(cache.exists())
            cleanup = json.loads((work / 'native-cache-cleanup.json').read_text(encoding='utf-8'))
            self.assertEqual(cleanup, {'cache': str(cache), 'removed': True})

    def test_cleanup_installer_cache_preserves_mismatched_and_unknown_content(self):
        fixture_id = '12345678-1234-4abc-8def-1234567890ab'
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            package_dir = work / 'base-build'
            package_dir.mkdir()
            package = package_dir / 'Xueness-0.1.2-windows-x64-setup.exe'
            package.write_bytes(b'known synthetic setup package')
            cache = work / 'native-local-appdata' / f'xueness-update-smoke-{fixture_id}-updater'
            cache.mkdir(parents=True)
            cached_installer = cache / 'installer.exe'
            cached_installer.write_bytes(b'unknown installer bytes')

            with patch('desktop.scripts.check_windows_update.native_installer_cache', return_value=cache):
                with self.assertRaisesRegex(RuntimeError, 'does not belong to this fixture'):
                    cleanup_installer_cache(work, fixture_id)

            self.assertEqual(cached_installer.read_bytes(), b'unknown installer bytes')
            self.assertTrue(cache.is_dir())

            cached_installer.write_bytes(package.read_bytes())
            unknown_file = cache / 'other-cache-data.bin'
            unknown_file.write_bytes(b'preserve this unrecognized cache data')
            with patch('desktop.scripts.check_windows_update.native_installer_cache', return_value=cache):
                with self.assertRaises(OSError):
                    cleanup_installer_cache(work, fixture_id)

            self.assertFalse(cached_installer.exists())
            self.assertEqual(unknown_file.read_bytes(), b'preserve this unrecognized cache data')
            self.assertTrue(cache.is_dir())

    def test_cleanup_installer_cache_preserves_reparse_point_installer_cross_platform(self):
        fixture_id = '12345678-1234-4abc-8def-1234567890ab'
        installer_bytes = b'this run synthetic setup package'
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            package_dir = work / 'base-build'
            package_dir.mkdir()
            (package_dir / 'Xueness-0.1.2-windows-x64-setup.exe').write_bytes(installer_bytes)
            cache = work / 'native-local-appdata' / f'xueness-update-smoke-{fixture_id}-updater'
            cache.mkdir(parents=True)
            installer = cache / 'installer.exe'
            installer.write_bytes(installer_bytes)

            original_stat = Path.stat

            class StatWithReparseAttribute:
                def __init__(self, original):
                    self.original = original
                    self.st_file_attributes = 0x400  # FILE_ATTRIBUTE_REPARSE_POINT

                def __getattr__(self, name):
                    return getattr(self.original, name)

            def stat_with_reparse_attribute(path, *args, **kwargs):
                result = original_stat(path, *args, **kwargs)
                if path == installer:
                    # Keep real st_mode so exists() and is_symlink() continue
                    # to observe an ordinary file while Windows metadata is mocked.
                    return StatWithReparseAttribute(result)
                return result

            with patch('desktop.scripts.check_windows_update.native_installer_cache', return_value=cache):
                with patch.object(Path, 'stat', new=stat_with_reparse_attribute):
                    self.assertTrue(installer.exists())
                    self.assertFalse(installer.is_symlink())
                    with self.assertRaisesRegex(RuntimeError, 'redirected fixture cached installer'):
                        cleanup_installer_cache(work, fixture_id)

            self.assertEqual(installer.read_bytes(), installer_bytes)
            self.assertTrue(cache.is_dir())

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
