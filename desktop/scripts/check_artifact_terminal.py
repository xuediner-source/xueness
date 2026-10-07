"""Recheck the immutable native Windows package with the latest regression gates."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
REPO = 'xuediner-source/xueness'
VALIDATION_FILES = {
    '.github/workflows/windows-runtime-check.yml',
    'desktop/scripts/check_backend.py',
    'desktop/scripts/check_artifact_terminal.py',
}


def main():
    run_id = os.environ['XUENESS_ARTIFACT_RUN']
    if os.name != 'nt' or not run_id.isascii() or not run_id.isdecimal():
        raise ValueError('expected a native Windows installer build run')
    run = json.loads(subprocess.check_output([
        'gh', 'run', 'view', run_id, '--repo', REPO,
        '--json', 'headSha,conclusion,workflowName,url']))
    if run['conclusion'] != 'success' or run['workflowName'] != 'Desktop installers':
        raise ValueError('only a successful native installer build can be verified')
    differences = subprocess.check_output([
        'git', 'diff', '--name-only', run['headSha'], 'HEAD'], cwd=ROOT, text=True).splitlines()
    if not set(differences) <= VALIDATION_FILES:
        raise ValueError('product source differs from the compiled installer: '+str(differences))
    with tempfile.TemporaryDirectory(prefix='xueness-native-artifact-') as temporary:
        data = Path(temporary)
        subprocess.run(['gh','run','download',run_id,'--repo',REPO,
                        '--name','Xueness-windows-x64','--dir',str(data/'download')],check=True)
        archive = data/'download'/'Xueness-0.1.5-windows-x64-portable.zip'
        expected = dict((row.split('  ',1)[1], row.split('  ',1)[0])
                        for row in (data/'download'/'SHA256SUMS.txt').read_text().splitlines())[archive.name]
        with archive.open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        if actual != expected:
            raise ValueError('native package checksum mismatch')
        unpacked = data/'unpacked'
        with zipfile.ZipFile(archive) as source:
            for row in source.infolist():
                name = Path(row.filename)
                if name.is_absolute() or '..' in name.parts or ':' in row.filename:
                    raise ValueError('unexpected native archive path')
            source.extractall(unpacked)
        executables = list(unpacked.rglob('resources/backend/xueness-backend.exe'))
        if len(executables) != 1:
            raise ValueError('expected one native backend in the installer')
        executable = executables[0]
        assets = executable.parent.parent/'webapp'
        if not (assets/'index.html').is_file():
            raise ValueError('native workbench is missing')
        # Replace only this disposable CI checkout's generated workbench.
        shutil.rmtree(ROOT/'webapp/dist', ignore_errors=True)
        shutil.copytree(assets,ROOT/'webapp/dist')
        for mode in ([], ['--force-exit']):
            subprocess.run([sys.executable, str(ROOT/'desktop/scripts/check_backend.py'),
                            '--executable',str(executable),*mode],check=True,cwd=ROOT)
        print('PASS: immutable Windows installer backend, interrupt/resume, lifecycle, and forced shutdown; '
              'build source '+run['headSha']+'; '+run['url'],flush=True)


if __name__ == '__main__':
    main()
