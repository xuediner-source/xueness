"""Stage verified native artifacts on GitHub; publishing remains a separate action."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def command(*args):
    return subprocess.check_output(list(args), cwd=ROOT, text=True)


def digest(path, algorithm='sha256'):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, algorithm)


def main():
    run_id = os.environ['XUENESS_BUILD_RUN']
    if not run_id.isascii() or not run_id.isdecimal():
        raise ValueError('expected a native build run ID')
    sha = command('git', 'rev-parse', 'HEAD').strip()
    run = json.loads(command('gh', 'run', 'view', run_id, '--json',
                            'headSha,status,conclusion,workflowName,jobs,url'))
    if (run['headSha'] != sha or run['conclusion'] != 'success'
            or run['status'] != 'completed' or run['workflowName'] != 'Desktop installers'):
        raise ValueError('only the successful native build of this exact commit may be staged')
    jobs = run['jobs']
    targets = ('windows-x64', 'macos-x64', 'macos-arm64')
    if len(jobs) != 3 or any(job['conclusion'] != 'success' for job in jobs):
        raise ValueError('all three native build jobs must succeed')
    for target in targets:
        job = next(job for job in jobs if target in job['name'])
        required = ['Check feature ownership and portable backend behavior',
                    'Freeze and exercise the actual backend', 'Verify packaged Electron workbench']
        if target == 'windows-x64':
            required += ['Exercise the installed NSIS in-app update path',
                         'Verify public GitHub Windows installer download']
        for step in required:
            if next(row for row in job['steps'] if row['name'] == step)['conclusion'] != 'success':
                raise ValueError('required native gate did not pass: '+step)
    if command('git', 'status', '--porcelain').strip():
        raise ValueError('source tree is not clean')
    from xueness import __version__ as version
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('only a stable desktop version may be staged')
    tag = 'v'+version
    existing = subprocess.run(['gh','release','view',tag,'--json','id'],cwd=ROOT,
                              capture_output=True,text=True)
    if existing.returncode == 0 or 'release not found' not in existing.stderr:
        raise ValueError('release already exists or its absence could not be verified')
    subprocess.run([sys.executable, 'tools/prepare_release.py'],cwd=ROOT,check=True)
    with tempfile.TemporaryDirectory(prefix='xueness-stage-release-') as temporary:
        staging = Path(temporary)
        out = staging/'assets'
        out.mkdir()
        directories = []
        expected = {f'Xueness-{version}-{target}.{ext}'
                    for target in ('macos-arm64', 'macos-x64') for ext in ('dmg', 'zip')}
        expected.update({f'Xueness-{version}-windows-x64-setup.exe',
                         f'Xueness-{version}-windows-x64-portable.zip'})
        for target in ('macos-arm64', 'macos-x64', 'windows-x64'):
            directory = staging/target
            subprocess.run(['gh','run','download',run_id,'--name','Xueness-'+target,
                            '--dir',str(directory)],cwd=ROOT,check=True)
            directories.append(directory)
            checked = set()
            for row in (directory/'SHA256SUMS.txt').read_text().splitlines():
                checksum, name = row.split('  ', 1)
                if name != Path(name).name or digest(directory/name).hexdigest() != checksum:
                    raise ValueError('native artifact checksum mismatch: '+name)
                checked.add(name)
            for name in expected:
                if (directory/name).exists() and name not in checked:
                    raise ValueError('installer is missing its native checksum: '+name)
            for path in directory.iterdir():
                if path.name.startswith('Xueness-'+version+'-') and path.suffix in ('.exe','.zip','.dmg','.blockmap'):
                    if (out/path.name).exists():
                        raise ValueError('duplicate native asset: '+path.name)
                    shutil.copy2(path, out/path.name)
        actual = {p.name for p in out.iterdir() if p.suffix in ('.exe','.zip','.dmg')}
        if actual != expected:
            raise ValueError('native installer set is incomplete: '+str(actual))
        yaml_paths = [directories[0]/'latest-mac.yml', directories[1]/'latest-mac.yml',
                      directories[2]/'latest.yml']
        load = "const fs=require('fs'),y=require('./desktop/node_modules/js-yaml');process.stdout.write(JSON.stringify(process.argv.slice(1).map(p=>y.load(fs.readFileSync(p,'utf8')))));"
        feeds = json.loads(command('node','-e',load,*map(str,yaml_paths)))
        for feed in feeds:
            if feed['version'] != version:
                raise ValueError('update feed version mismatch')
            for entry in feed['files']:
                name = entry['url']
                if name != Path(name).name or name not in expected:
                    raise ValueError('unexpected update asset')
                asset = out/name
                if (asset.stat().st_size != entry['size'] or
                        base64.b64encode(digest(asset,'sha512').digest()).decode() != entry['sha512']):
                    raise ValueError('update feed integrity mismatch: '+name)
        mac = {**feeds[0], 'files': feeds[0]['files']+feeds[1]['files']}
        dump = "const fs=require('fs'),y=require('./desktop/node_modules/js-yaml');process.stdout.write(y.dump(JSON.parse(fs.readFileSync(0,'utf8')),{lineWidth:-1}));"
        (out/'latest-mac.yml').write_bytes(subprocess.check_output(
            ['node','-e',dump],input=json.dumps(mac).encode(),cwd=ROOT))
        shutil.copy2(yaml_paths[2],out/'latest.yml')
        source = ROOT/'release'/f'xueness-{version}-source.tar.gz'
        manifest = json.loads((ROOT/'release/manifest.json').read_text())
        if manifest['version'] != version or digest(source).hexdigest() != manifest['archiveSha256']:
            raise ValueError('source archive integrity mismatch')
        shutil.copy2(source,out/source.name)
        shutil.copy2(ROOT/'release/manifest.json',out/'source-manifest.json')
        plugins = [json.loads(p.read_text()) for p in sorted((ROOT/'xueness/bundled_plugins').glob('*/manifest.json'))]
        info = {'version':version,'sourceCommit':sha,'buildSourceCommit':sha,
                'desktopBuildRun':run['url'],'plugins':len(plugins),
                'features':sum(len(p['features']) for p in plugins),
                'nativePlatforms':list(targets),'windowsInstalledUpdateSmoke':'passed',
                'frozenTerminalInterruptResumeAndCleanup':'passed',
                'liveModelPerformanceMeasured':False,
                'artifacts':[{'name':p.name,'bytes':p.stat().st_size,'sha256':digest(p).hexdigest()}
                             for p in sorted(out.iterdir())]}
        (out/'build-info.json').write_text(json.dumps(info,indent=2)+'\n')
        (out/'SHA256SUMS.txt').write_text(''.join(f'{digest(p).hexdigest()}  {p.name}\n' for p in sorted(out.iterdir())))
        notes = ROOT/'docs'/f'release-{version}.md'
        subprocess.run(['gh','release','create',tag,'--draft','--target',sha,
                        '--title','Xueness '+version,'--notes-file',str(notes),
                        *[str(p) for p in sorted(out.iterdir())]],cwd=ROOT,check=True)
        remote = json.loads(command('gh','release','view',tag,'--json','isDraft,assets,url'))
        if not remote['isDraft'] or {a['name']:a['size'] for a in remote['assets']} != {p.name:p.stat().st_size for p in out.iterdir()}:
            raise ValueError('uploaded draft assets differ from verified staging')
        print('PASS: draft release staged with verified source, native installers, feeds and checksums: '+remote['url'])


if __name__ == '__main__':
    sys.path.insert(0,str(ROOT))
    main()
