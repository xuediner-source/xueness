"""CLI ownership and HTTP imports enforce the same reviewed source boundary."""
import base64
from contextlib import redirect_stdout, redirect_stderr
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tests.test_external_package_store import archive
from tests.test_external_package_binding import Ed25519PrivateKey, serialization
from xueness.cli import main
from xueness import plugin_runtime
from xueness.bundled_plugins.extensions import package_store, package_trust


class ExternalPackageEntrypointsTests(unittest.TestCase):
    def test_cli_install_grants_rollback_and_disabled_owner(self):
        with tempfile.TemporaryDirectory() as temp:
            state, source = Path(temp) / 'state', Path(temp) / 'package.zip'
            data, sha = archive()
            source.write_bytes(data)

            def call(*arguments):
                stdout, stderr = io.StringIO(), io.StringIO()
                with redirect_stdout(stdout), redirect_stderr(stderr):
                    code = main(['--state', str(state), 'extension-package', *arguments])
                return code, json.loads(stdout.getvalue()) if code == 0 else stderr.getvalue()

            self.assertEqual(call('review', str(source))[1]['archiveSha256'], sha)
            self.assertFalse(call('install', str(source), '--sha256', sha)[1]['enabled'])
            self.assertEqual(call('enable', 'fixture-tool', '--sha256', sha)[0], 1)
            self.assertTrue(call('enable', 'fixture-tool', '--sha256', sha, '--grant', 'command')[1]['enabled'])
            next_data, next_sha = archive('2.0.0')
            source.write_bytes(next_data)
            self.assertFalse(call('upgrade', str(source), '--sha256', next_sha)[1]['enabled'])
            rolled = call('rollback', 'fixture-tool', '--sha256', sha)[1]
            self.assertEqual(rolled['archiveSha256'], sha)
            self.assertFalse(rolled['enabled'])
            plugin_runtime.set_enabled(state, 'extensions', False)
            self.assertEqual(call('list')[0], 1)

    @unittest.skipIf(Ed25519PrivateKey is None, 'optional Ed25519 verifier is unavailable')
    def test_http_requires_pinned_signed_https_import_and_never_takes_local_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp) / 'state'
            data, sha = archive()
            private = Ed25519PrivateKey.generate()
            public = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
            package_trust.add_key(state, 'fixture', base64.b64encode(public).decode(), hashlib.sha256(public).hexdigest())
            signature = {'keyId': 'fixture', 'signature': base64.b64encode(
                private.sign(package_trust.DOMAIN + sha.encode())).decode()}
            parts = ['api', 'plugins', 'packages', 'install']
            ctx = {'state_dir': state}
            with patch('xueness.bundled_plugins.extensions.package_download.download', return_value=data) as download:
                rejected = plugin_runtime.dispatch_http('POST', parts, {},
                    {'url': str(Path(temp) / 'private.zip'), 'sha256': sha, 'signature': signature}, ctx)
                self.assertEqual(rejected[0], 400)
                download.assert_not_called()
                rejected = plugin_runtime.dispatch_http('POST', parts, {},
                    {'url': 'https://packages.example.test/tool.zip', 'sha256': '0' * 64, 'signature': signature}, ctx)
                self.assertEqual(rejected[0], 400)
                download.assert_not_called()
                accepted = plugin_runtime.dispatch_http('POST', parts, {},
                    {'url': 'https://packages.example.test/tool.zip', 'sha256': sha, 'signature': signature}, ctx)
                self.assertEqual(accepted[0], 200, accepted)
                self.assertFalse(accepted[1]['enabled'])
                self.assertEqual(package_store.review(state, 'fixture-tool')['receipt']['provenance']['kind'], 'ed25519')
                self.assertEqual(download.call_count, 1)
                plugin_runtime.set_enabled(state, 'extensions', False)
                self.assertEqual(plugin_runtime.dispatch_http('POST', parts, {}, {}, ctx)[0], 403)
                self.assertEqual(download.call_count, 1)


if __name__ == '__main__':
    unittest.main()
