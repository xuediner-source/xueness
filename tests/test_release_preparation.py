"""Release hygiene: real assigned secrets are rejected without URL false positives."""
import importlib.util
from pathlib import Path
import sys
import unittest

spec = importlib.util.spec_from_file_location('xueness_release_preparation', Path(__file__).resolve().parents[1] / 'tools' / 'prepare_release.py')
release = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = release
spec.loader.exec_module(release)


class ReleaseSecretScanTests(unittest.TestCase):
    def test_reference_urls_are_not_assigned_secrets(self):
        content = b'[authorization](https://example.invalid/spec/authorization) and [transport](https://example.invalid/spec/transports)'
        self.assertEqual(release._scan_secret_payload('docs/current.md', content), [])

    def test_json_and_environment_assignment_are_rejected_without_value_echo(self):
        secret = 'opaque' + 'A' * 30
        for content in ['{"apiKey": "' + secret + '"}', 'API_KEY = "' + secret + '"']:
            findings = release._scan_secret_payload('xueness/config.py', content.encode())
            self.assertTrue(findings)
            with self.assertRaises(release.ReleasePreparationError) as error:
                release._raise_for_findings(findings)
            self.assertNotIn(secret, str(error.exception))
            self.assertIn('xueness/config.py', str(error.exception))

    def test_explicit_test_placeholders_are_allowed_only_in_tests(self):
        dummy = b'API_KEY = "sk-test-only-placeholder-secret-key"'
        self.assertEqual(release._scan_secret_payload('tests/fixture.py', dummy), [])
        self.assertTrue(release._scan_secret_payload('xueness/config.py', dummy))
        unmarked = b'API_KEY = "sk-' + b'A' * 32 + b'"'
        self.assertTrue(release._scan_secret_payload('tests/fixture.py', unmarked))
