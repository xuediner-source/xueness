"""Release staging cannot accept native builds missing runtime transport gates."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('desktop_release_gates',
    Path(__file__).resolve().parents[1]/'tools/stage_desktop_release.py')
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


def jobs():
    common = ['Check feature ownership and focused native parity',
              'Verify package-signing dependency and record native versions',
              'Freeze the native backend', 'Verify frozen runtime transport',
              'Verify packaged Electron workbench', 'Upload native runtime transport evidence']
    return [{'name': 'build ('+target+')', 'conclusion': 'success',
             'steps': [{'name': step, 'conclusion': 'success'}
                       for step in common+(['Verify public GitHub Windows installer download']
                                           if target == 'windows-x64' else [])]}
            for target in ('windows-x64', 'macos-x64', 'macos-arm64')]


class NativeReleaseGatesTests(unittest.TestCase):
    def test_all_native_targets_and_transport_gates_are_required(self):
        self.assertEqual(release.validate_native_jobs(jobs()), 'focused')
        for gate in ('Verify frozen runtime transport',
                     'Verify packaged Electron workbench',
                     'Upload native runtime transport evidence'):
            candidates = jobs()
            candidates[1]['steps'] = [step for step in candidates[1]['steps'] if step['name'] != gate]
            with self.assertRaisesRegex(ValueError, 'required native gate did not pass'):
                release.validate_native_jobs(candidates)

    def test_successful_duplicate_platform_does_not_replace_missing_platform(self):
        candidates = jobs()
        candidates[2]['name'] = candidates[1]['name']
        with self.assertRaisesRegex(ValueError, 'exactly one native build job'):
            release.validate_native_jobs(candidates)

    def test_native_evidence_must_match_actual_platform_and_pass(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            signing = {'platform': 'darwin', 'architecture': 'x64', 'cryptography': '50.0.2',
                       'ed25519ValidSignature': True, 'ed25519AlteredSignatureRejected': True}
            runtime = {'platform': 'darwin', 'architecture': 'x64', 'status': 'passed',
                       'checks': {'piLite': {'passed': True}}}
            for name, report in [('package-signing.json', signing),
                                 ('frozen-runtime-transport.json', runtime),
                                 ('packaged-runtime-transport.json', runtime)]:
                (directory/name).write_text(json.dumps(report), encoding='utf-8')
            self.assertEqual(len(release.validate_native_evidence(directory, 'macos-x64')), 3)
            with self.assertRaisesRegex(ValueError, 'platform differs'):
                release.validate_native_evidence(directory, 'macos-arm64')
            runtime['status'] = 'failed'
            (directory/'packaged-runtime-transport.json').write_text(json.dumps(runtime), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'did not pass'):
                release.validate_native_evidence(directory, 'macos-x64')
