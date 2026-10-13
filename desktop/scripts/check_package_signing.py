"""Verify the pinned signing dependency; record build facts without app state."""
import argparse
import importlib.metadata
import json
from pathlib import Path
import platform
import re
import sys

ROOT = Path(__file__).resolve().parents[2]


def check():
    requirement = (ROOT/'desktop/requirements-package-signing.txt').read_text(encoding='utf-8')
    pinned = re.findall(r'^cryptography==([^\s;]+)\s*$', requirement, re.MULTILINE)
    if len(pinned) != 1:
        raise RuntimeError('Expected exactly one pinned cryptography version')
    version = importlib.metadata.version('cryptography')
    if version != pinned[0]:
        raise RuntimeError(f'Package-signing dependency differs from pin: {version} != {pinned[0]}')
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.backends.openssl.backend import backend
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    private_key = Ed25519PrivateKey.generate()
    message = b'Xueness native package-signing dependency check'
    signature = private_key.sign(message)
    private_key.public_key().verify(signature, message)
    try:
        private_key.public_key().verify(signature, message+b' altered')
    except InvalidSignature:
        pass
    else:
        raise RuntimeError('Ed25519 did not reject an altered message')
    machine = platform.machine().lower()
    architecture = {'amd64': 'x64', 'x86_64': 'x64', 'aarch64': 'arm64'}.get(machine, machine)
    dependencies = {}
    for dependency in ('cryptography', 'cffi', 'pyinstaller', 'pyinstaller-hooks-contrib'):
        try:
            dependencies[dependency] = importlib.metadata.version(dependency)
        except importlib.metadata.PackageNotFoundError:
            continue
    return {'platform': sys.platform, 'architecture': architecture,
            'python': platform.python_version(), 'cryptography': version,
            'openssl': backend.openssl_version_text(),
            'dependencies': dependencies,
            'ed25519ValidSignature': True, 'ed25519AlteredSignatureRejected': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path)
    arguments = parser.parse_args()
    report = check()
    if arguments.report:
        arguments.report.parent.mkdir(parents=True, exist_ok=True)
        arguments.report.write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')
    print(f"PASS: pinned cryptography {report['cryptography']} Ed25519 on {report['platform']}/{report['architecture']}")


if __name__ == '__main__':
    main()
