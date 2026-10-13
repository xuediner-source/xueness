"""Build a platform-native, self-contained backend; never reads operator state."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import sysconfig

ROOT = Path(__file__).resolve().parents[2]
DESKTOP = ROOT/'desktop'


def write_runtime_manifest(target):
    import importlib.metadata
    sys.path.insert(0, str(ROOT))
    from xueness.plugin_runtime import PLUGIN_IDS
    manifest = {'platform': sys.platform, 'architecture': platform.machine(), 'python': platform.python_version(),
                'packages': {package: importlib.metadata.version(package) for package in (
                    'pyinstaller', 'cryptography', 'cffi', 'tzdata', 'python-docx', 'openpyxl', 'python-pptx', 'pypdf', 'reportlab')},
                'plugins': {ident: hashlib.sha256((ROOT/'xueness/bundled_plugins'/ident/'manifest.json').read_bytes()).hexdigest()
                            for ident in PLUGIN_IDS},
                'files': [{'path': path.relative_to(target).as_posix(), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
                          for path in sorted(target.rglob('*')) if path.is_file() and path.name != 'runtime-manifest.json']}
    (target/'runtime-manifest.json').write_text(json.dumps(manifest, indent=2)+'\n', encoding='utf-8')


def _validate_native_target():
    """Reject cross-platform or cross-architecture frozen runtimes in CI."""
    expected_platform = os.environ.get('XUENESS_BUILD_PLATFORM')
    expected_arch = os.environ.get('XUENESS_BUILD_ARCH')
    actual_platform = {'win32': 'win32', 'darwin': 'darwin'}.get(sys.platform, sys.platform)
    machine = platform.machine().lower()
    actual_arch = {
        'amd64': 'x64', 'x86_64': 'x64', 'x64': 'x64',
        'arm64': 'arm64', 'aarch64': 'arm64',
    }.get(machine, machine)
    supported_arches = {'x64', 'arm64'}
    if expected_platform and expected_platform != actual_platform:
        raise SystemExit(f'Native backend target mismatch: expected {expected_platform}, running on {actual_platform}.')
    if actual_arch not in supported_arches:
        raise SystemExit(f'Unsupported native backend architecture: Python is {actual_arch}; expected x64 or arm64.')
    if expected_arch and expected_arch not in supported_arches:
        raise SystemExit(f'Unsupported native backend architecture target: expected {expected_arch}; use x64 or arm64.')
    if expected_arch and expected_arch != actual_arch:
        raise SystemExit(f'Native backend architecture mismatch: expected {expected_arch}, Python is {actual_arch}.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--python', default=sys.executable)
    args = parser.parse_args()
    if Path(args.python).resolve() != Path(sys.executable).resolve():
        # Validate, collect dependencies/licenses and describe the interpreter
        # actually used to freeze the payload, including Rosetta selections.
        subprocess.run([args.python, str(Path(__file__).resolve())], cwd=ROOT, check=True)
        return
    _validate_native_target()
    subprocess.run([args.python, str(ROOT/'tools/check_plugin_architecture.py')], check=True)
    if not (ROOT/'webapp/dist/index.html').is_file():
        raise SystemExit('Build the Web workbench before preparing the desktop runtime.')
    work = DESKTOP/'.build'
    command = [args.python, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir',
               '--name', 'xueness-backend', '--python-option', 'X utf8', '--distpath', str(work/'dist'),
               '--workpath', str(work/'work'), '--specpath', str(work),
               '--paths', str(ROOT), '--collect-submodules', 'xueness', '--collect-data', 'xueness',
               '--collect-all', 'tzdata', '--collect-all', 'docx',
               '--collect-all', 'openpyxl', '--collect-all', 'pptx',
               '--collect-all', 'pypdf', '--collect-all', 'reportlab',
               '--collect-all', 'cryptography']
    if os.name == 'nt':
        command.extend(['--collect-all', 'winpty'])
    command.append(str(DESKTOP/'entrypoint.py'))
    subprocess.run(command, cwd=ROOT, check=True)
    target = DESKTOP/'runtime/backend'
    if target.exists():
        # Only this script's generated payload is replaceable, never app data.
        if target.resolve() != (DESKTOP.resolve()/'runtime/backend') or target.is_symlink():
            raise SystemExit('Refusing to replace a redirected backend payload directory.')
        shutil.rmtree(target)
    shutil.copytree(work/'dist/xueness-backend', target)
    license_source = next((p for p in (Path(sysconfig.get_path('stdlib'))/'LICENSE.txt',
                           Path(sys.base_prefix)/'LICENSE.txt') if p.is_file()),
                          Path(sysconfig.get_path('stdlib'))/'LICENSE.txt')
    if not license_source.is_file():
        raise SystemExit('Python license text is required for runtime distribution.')
    shutil.copy2(license_source, target/'PYTHON-LICENSE.txt')
    import importlib.metadata
    for package in ('pyinstaller', 'pyinstaller-hooks-contrib', 'pywinpty', 'tzdata',
                    'python-docx', 'openpyxl', 'python-pptx', 'pypdf', 'reportlab',
                    'lxml', 'pillow', 'et-xmlfile', 'cryptography', 'cffi', 'pycparser'):
        try:
            distribution = importlib.metadata.distribution(package)
        except importlib.metadata.PackageNotFoundError:
            continue
        for item in distribution.files or ():
            if ('license' in item.name.lower() or item.name.upper().startswith('COPYING')):
                destination = target/'licenses'/package/Path(str(item)).name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(distribution.locate_file(item), destination)
    openssl_license = os.environ.get('XUENESS_PACKAGE_OPENSSL_LICENSE_PATH')
    if openssl_license:
        source = Path(openssl_license)
        if not source.is_absolute() or not source.is_file() or source.stat().st_size == 0:
            raise SystemExit('Native static OpenSSL license is required for runtime distribution.')
        destination = target/'licenses/openssl/LICENSE.txt'
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    write_runtime_manifest(target)
    print(f'Prepared native desktop backend: {target}')


if __name__ == '__main__':
    main()
