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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--python', default=sys.executable)
    args = parser.parse_args()
    subprocess.run([args.python, str(ROOT/'tools/check_plugin_architecture.py')], check=True)
    if not (ROOT/'webapp/dist/index.html').is_file():
        raise SystemExit('Build the Web workbench before preparing the desktop runtime.')
    work = DESKTOP/'.build'
    command = [args.python, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir',
               '--name', 'xueness-backend', '--python-option', 'X utf8', '--distpath', str(work/'dist'),
               '--workpath', str(work/'work'), '--specpath', str(work),
               '--paths', str(ROOT), '--collect-submodules', 'xueness', '--collect-data', 'xueness',
               '--collect-all', 'tzdata']
    if os.name == 'nt':
        command.extend(['--collect-all', 'winpty'])
    command.append(str(DESKTOP/'entrypoint.py'))
    subprocess.run(command, cwd=ROOT, check=True)
    target = DESKTOP/'runtime/backend'
    if target.exists():
        # Only this script's generated payload is replaceable, never app data.
        shutil.rmtree(target)
    shutil.copytree(work/'dist/xueness-backend', target)
    license_source = next((p for p in (Path(sysconfig.get_path('stdlib'))/'LICENSE.txt',
                           Path(sys.base_prefix)/'LICENSE.txt') if p.is_file()),
                          Path(sysconfig.get_path('stdlib'))/'LICENSE.txt')
    if not license_source.is_file():
        raise SystemExit('Python license text is required for runtime distribution.')
    shutil.copy2(license_source, target/'PYTHON-LICENSE.txt')
    import importlib.metadata
    for package in ('pyinstaller', 'pyinstaller-hooks-contrib', 'pywinpty', 'tzdata'):
        try:
            distribution = importlib.metadata.distribution(package)
        except importlib.metadata.PackageNotFoundError:
            continue
        for item in distribution.files or ():
            if ('license' in item.name.lower() or item.name.upper().startswith('COPYING')):
                destination = target/'licenses'/package/Path(str(item)).name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(distribution.locate_file(item), destination)
    manifest = {'platform': sys.platform, 'architecture': platform.machine(), 'python': platform.python_version(),
                'files': [{'path': p.relative_to(target).as_posix(), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
                          for p in sorted(target.rglob('*')) if p.is_file()]}
    (target/'runtime-manifest.json').write_text(json.dumps(manifest, indent=2)+'\n', encoding='utf-8')
    print(f'Prepared native desktop backend: {target}')


if __name__ == '__main__':
    main()
