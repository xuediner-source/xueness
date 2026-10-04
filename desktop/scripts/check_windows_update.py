"""Exercise the packaged NSIS updater against an isolated loopback feed on Windows."""
from __future__ import annotations

import json
import hashlib
import mimetypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[2]
DESKTOP = ROOT / 'desktop'
FIXTURE = DESKTOP / 'scripts' / 'windows_update_fixture.cjs'
VERSION_PATTERN = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')
SETUP_PATTERN = re.compile(r'^Xueness-\d+\.\d+\.\d+-windows-x64-setup\.exe$')
BLOCKMAP_PATTERN = re.compile(r'^Xueness-\d+\.\d+\.\d+-windows-x64-setup\.exe\.blockmap$')


def next_patch_version(version: str) -> str:
    """Return a stable fixture version newer than the desktop package version."""
    match = VERSION_PATTERN.fullmatch(version)
    if not match:
        raise ValueError(f'Unsupported desktop version for the Windows update fixture: {version!r}')
    major, minor, patch = (int(part) for part in match.groups())
    return f'{major}.{minor}.{patch + 1}'


def make_feed_handler(feed_root: Path, allowed_names: set[str]):
    root = feed_root.resolve()

    class LoopbackFeedHandler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, _format: str, *_args: object) -> None:
            return

        def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            self.serve_file(include_body=True)

        def do_HEAD(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
            self.serve_file(include_body=False)

        def serve_file(self, *, include_body: bool) -> None:
            name = unquote(urlsplit(self.path).path).lstrip('/')
            if (not name or '/' in name or '\\' in name or name not in allowed_names
                    or not (name == 'latest.yml' or SETUP_PATTERN.fullmatch(name)
                            or BLOCKMAP_PATTERN.fullmatch(name))):
                self.send_error(404)
                return
            path = (root / name).resolve()
            if path.parent != root or not path.is_file():
                self.send_error(404)
                return

            size = path.stat().st_size
            start, end, status = 0, size - 1, 200
            range_header = self.headers.get('Range')
            if range_header:
                match = re.fullmatch(r'bytes=(\d*)-(\d*)', range_header.strip())
                if not match:
                    self.send_error(416)
                    return
                left, right = match.groups()
                if left:
                    start = int(left)
                    end = int(right) if right else size - 1
                elif right:
                    suffix_size = int(right)
                    start = max(0, size - suffix_size)
                    end = size - 1
                if size == 0 or start >= size or end < start:
                    self.send_response(416)
                    self.send_header('Content-Range', f'bytes */{size}')
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                end = min(end, size - 1)
                status = 206

            length = end - start + 1 if size else 0
            self.send_response(status)
            self.send_header('Content-Type', mimetypes.guess_type(name)[0] or 'application/octet-stream')
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Length', str(length))
            if status == 206:
                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.end_headers()
            if not include_body:
                return
            try:
                with path.open('rb') as source:
                    source.seek(start)
                    remaining = length
                    while remaining:
                        chunk = source.read(min(64 * 1024, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

    return LoopbackFeedHandler


class LoopbackFeed:
    """A narrowly allowlisted HTTP update feed bound only to 127.0.0.1."""

    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.allowed_names: set[str] = set()
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), make_feed_handler(root, self.allowed_names))
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        host, port = self.server.server_address
        return f'http://{host}:{port}/'

    def start(self) -> None:
        self.thread.start()

    def allow_update_artifacts(self, setup: Path, previous_blockmap: Path | None = None) -> None:
        names = {'latest.yml', setup.name}
        blockmap = setup.with_name(setup.name + '.blockmap')
        if blockmap.is_file():
            names.add(blockmap.name)
        if previous_blockmap and previous_blockmap.is_file():
            names.add(previous_blockmap.name)
        metadata_path = self.root / 'latest.yml'
        if not metadata_path.is_file():
            raise RuntimeError('electron-builder did not create latest.yml for the loopback feed')
        metadata = metadata_path.read_text(encoding='utf-8')
        if setup.name not in metadata or not re.search(r'(?m)^\s*sha512:\s*[A-Za-z0-9+/=]{80,90}\s*$', metadata):
            raise RuntimeError('The generated update feed is missing its installer or SHA-512 metadata')
        self.allowed_names.clear()
        self.allowed_names.update(names)

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)


def run_fixture_builder(output: Path, version: str, feed_url: str, fixture_id: str) -> None:
    output.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ['node', str(FIXTURE), '--build-fixture', str(output), version, feed_url, fixture_id],
        cwd=DESKTOP,
        check=True,
        timeout=900,
    )


def find_setup(output: Path, version: str) -> Path:
    expected = output / f'Xueness-{version}-windows-x64-setup.exe'
    if not expected.is_file():
        raise RuntimeError(f'Expected the NSIS setup artifact was not created: {expected.name}')
    return expected


def isolated_environment(app_data: Path) -> dict[str, str]:
    local_app_data = app_data.parent / 'LocalAppData'
    app_data.mkdir(parents=True, exist_ok=True)
    local_app_data.mkdir(parents=True, exist_ok=True)
    return {
        **os.environ,
        'APPDATA': str(app_data),
        'LOCALAPPDATA': str(local_app_data),
    }


def write_fixture_descriptor(work: Path, app_data: Path, report: Path, expected_version: str) -> Path:
    descriptor = {
        'fixtureRoot': str(work.resolve()),
        'appData': str((app_data / 'user-data').resolve()),
        'report': str(report.resolve()),
        'expectedVersion': expected_version,
    }
    descriptor_path = work / 'update-smoke-config.json'
    descriptor_path.write_text(json.dumps(descriptor, indent=2) + '\n', encoding='utf-8')
    return descriptor_path


def read_log_tail(path: Path, limit: int = 40_000) -> str:
    try:
        return path.read_text(encoding='utf-8', errors='replace')[-limit:]
    except OSError:
        return '<updater log is unavailable>'


def run_seed(executable: Path, work: Path, env: dict[str, str], report: Path) -> dict[str, object]:
    """Keep seed diagnostics even when Electron fails before writing its report."""
    log_path = work / 'seed-process.log'
    with log_path.open('w', encoding='utf-8', errors='replace') as log:
        process = subprocess.Popen(
            [str(executable), '--seed', '--enable-logging', f'--log-file={work / "seed-electron.log"}'],
            cwd=work, env=env, stdout=log, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
        timed_out = False
        try:
            process.wait(timeout=90)
        except subprocess.TimeoutExpired:
            timed_out = True
            process.kill()
            process.wait(timeout=10)
        log.flush()
    diagnostics = {'executable': str(executable.resolve()), 'pid': process.pid,
                   'exitCode': process.returncode, 'timedOut': timed_out}
    (work / 'seed-process.json').write_text(json.dumps(diagnostics, indent=2) + '\n', encoding='utf-8')
    if timed_out or process.returncode != 0 or not report.is_file():
        raise RuntimeError(
            f'Baseline --seed failed: {diagnostics}; report={read_log_tail(report)}; '
            f'process log:\n{read_log_tail(log_path)}; '
            f'Electron log:\n{read_log_tail(work / "seed-electron.log")}; '
            f'runtime log:\n{read_log_tail(work / "fixture-runtime.jsonl")}'
        )
    return json.loads(report.read_text(encoding='utf-8'))


def fixture_registration(fixture_id: str) -> str | None:
    """Fail closed if NSIS would reuse a registration outside this rehearsal."""
    import winreg
    locations = []
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in (winreg.KEY_WOW64_32KEY, winreg.KEY_WOW64_64KEY):
            try:
                with winreg.OpenKey(hive, rf'Software\{fixture_id}', 0, winreg.KEY_READ | view) as key:
                    locations.append(winreg.QueryValueEx(key, 'InstallLocation')[0])
            except FileNotFoundError:
                continue
    if not locations:
        return None
    if len({str(Path(location).resolve()).casefold() for location in locations}) != 1:
        raise RuntimeError(f'Conflicting fixture NSIS registrations: {locations}')
    return locations[0]


def fixture_identity_exists(fixture_id: str) -> bool:
    import winreg
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in (winreg.KEY_WOW64_32KEY, winreg.KEY_WOW64_64KEY):
            for name in (rf'Software\{fixture_id}',
                         rf'Software\Microsoft\Windows\CurrentVersion\Uninstall\{fixture_id}'):
                try:
                    with winreg.OpenKey(hive, name, 0, winreg.KEY_READ | view):
                        return True
                except FileNotFoundError:
                    continue
    return False


def native_installer_cache(fixture_id: str) -> Path:
    """NSIS uses the Windows known folder, ignoring LOCALAPPDATA overrides."""
    import ctypes
    if str(uuid.UUID(fixture_id)) != fixture_id or uuid.UUID(fixture_id).version != 4:
        raise RuntimeError('Only a disposable UUID4 fixture cache may be accessed.')
    folder = ctypes.create_unicode_buffer(32768)
    if ctypes.windll.shell32.SHGetFolderPathW(None, 0x1C, None, 0, folder) != 0:
        raise RuntimeError('Cannot resolve the native LocalAppData folder for fixture cleanup.')
    parent = Path(folder.value).resolve()
    cache = parent / f'xueness-update-smoke-{fixture_id}-updater'
    resolved = cache.resolve()
    # Windows packaged shells can virtualize LocalAppData into a Packages
    # descendant. Require containment and the exact run name in either view.
    if cache.is_symlink() or parent not in resolved.parents or resolved.name != cache.name:
        raise RuntimeError('Refusing a redirected fixture installer cache.')
    if cache.exists() and getattr(cache.stat(), 'st_file_attributes', 0) & 0x400:  # FILE_ATTRIBUTE_REPARSE_POINT
        raise RuntimeError('Refusing a reparse point fixture installer cache.')
    return resolved


def cleanup_installer_cache(work: Path, fixture_id: str) -> None:
    cache = native_installer_cache(fixture_id)
    if not cache.exists():
        return
    # Prove ownership by content as well as the UUID4 directory name. Never
    # recursively remove a directory in the user's actual LocalAppData.
    installer = cache / 'installer.exe'
    if installer.exists():
        if installer.is_symlink() or getattr(installer.stat(), 'st_file_attributes', 0) & 0x400:
            raise RuntimeError('Refusing a redirected fixture cached installer.')
        digest = hashlib.sha256(installer.read_bytes()).digest()
        packages = [path for folder in ('base-build', 'loopback-feed')
                    for path in (work / folder).glob('Xueness-*-windows-x64-setup.exe')]
        if not any(hashlib.sha256(path.read_bytes()).digest() == digest for path in packages):
            raise RuntimeError('The cached installer does not belong to this fixture.')
        installer.unlink()
    cache.rmdir()  # Unknown files must remain intact and make cleanup fail.
    (work / 'native-cache-cleanup.json').write_text(json.dumps({
        'cache': str(cache), 'removed': True,
    }, indent=2) + '\n', encoding='utf-8')


def cleanup_fixture(work: Path, install_root: Path, fixture_id: str, env: dict[str, str]) -> None:
    """Stop/uninstall only executables and registration owned by this run."""
    if install_root.resolve().parent != work.resolve():
        raise RuntimeError('Refusing cleanup outside the fixture evidence directory.')
    cleanup_script = r'''
param([string]$fixtureRoot)
$prefix = [IO.Path]::GetFullPath($fixtureRoot).TrimEnd('\') + '\'
Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
} | ForEach-Object {
    $fixturePid = $_.ProcessId
    try { Stop-Process -Id $fixturePid -Force -ErrorAction Stop }
    catch { if (Get-Process -Id $fixturePid -ErrorAction SilentlyContinue) { throw } }
}
'''
    cleanup_path = work / 'cleanup.ps1'
    cleanup_path.write_text(cleanup_script, encoding='utf-8')
    subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                    '-File', str(cleanup_path), str(work.resolve())], check=True, timeout=30,
                   capture_output=True, env=env)
    registered = fixture_registration(fixture_id)
    if registered is None:
        if fixture_identity_exists(fixture_id):
            raise RuntimeError('A stale fixture uninstall registration needs inspection.')
        cleanup_installer_cache(work, fixture_id)
        return
    if Path(registered).resolve() != install_root.resolve():
        raise RuntimeError(f'Refusing to uninstall a different registered location: {registered}')
    uninstaller = install_root / f'Uninstall xueness-update-smoke-{fixture_id}.exe'
    if not uninstaller.is_file() or uninstaller.resolve().parent != install_root.resolve():
        raise RuntimeError('The fixture-owned uninstaller is missing or redirected.')
    result = subprocess.run([str(uninstaller), '/S', '/currentuser', f'_?={install_root}'],
                            cwd=work, env=env, capture_output=True, timeout=120, check=False)
    removed = not fixture_identity_exists(fixture_id)
    (work / 'cleanup.json').write_text(json.dumps({
        'uninstaller': str(uninstaller), 'exitCode': result.returncode,
        'registrationRemoved': removed,
    }, indent=2) + '\n', encoding='utf-8')
    if result.returncode != 0 or not removed:
        raise RuntimeError(f'Fixture uninstall failed: exit={result.returncode}, registrationRemoved={removed}')
    cleanup_installer_cache(work, fixture_id)


def preserved_data_hashes(app_data: Path) -> dict[str, str]:
    return {name: hashlib.sha256((app_data / 'user-data' / name).read_bytes()).hexdigest()
            for name in ('configs/desktop.json', 'sessions/fixture-session.json')}


def run_windows_update_smoke() -> None:
    if os.name != 'nt':
        raise RuntimeError('The real NSIS updater rehearsal runs only on Windows CI.')

    package = json.loads((DESKTOP / 'package.json').read_text(encoding='utf-8'))
    base_version = str(package.get('version', ''))
    update_version = next_patch_version(base_version)
    evidence_root = DESKTOP / 'update-smoke-evidence'
    evidence_root.mkdir(exist_ok=True)
    # Retain logs, reports and synthetic packages on success AND failure.
    temp = tempfile.mkdtemp(prefix='xueness-nsis-update-', dir=evidence_root)
    print(f'Windows updater evidence: {temp}', flush=True)
    work = Path(temp)
    fixture_id = str(uuid.uuid4())
    base_build = work / 'base-build'
    feed_root = work / 'loopback-feed'
    install_root = work / 'installed-app'
    report = work / 'update-report.json'
    app_data = work / 'isolated-appdata'
    env = isolated_environment(app_data)
    write_fixture_descriptor(work, app_data, report, update_version)
    feed = LoopbackFeed(feed_root)
    feed.start()
    try:
        if fixture_identity_exists(fixture_id) or native_installer_cache(fixture_id).exists():
            raise RuntimeError('Refusing to install over an existing fixture registration.')
        run_fixture_builder(base_build, base_version, feed.url, fixture_id)
        base_setup = find_setup(base_build, base_version)
        install_root.mkdir(parents=True)

        # Install the older NSIS package into a fresh, disposable location.
        installed = subprocess.run(
            [str(base_setup), '/S', f'/D={install_root}'],
            cwd=work,
            env=env,
            capture_output=True,
            text=True,
            timeout=240,
            check=False,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
        (work / 'initial-install.json').write_text(json.dumps({
            'setup': str(base_setup), 'exitCode': installed.returncode,
            'installRoot': str(install_root), 'fixtureId': fixture_id,
            'stdout': installed.stdout, 'stderr': installed.stderr,
        }, indent=2) + '\n', encoding='utf-8')
        if installed.returncode != 0:
            raise RuntimeError(f'Initial NSIS installation failed with exit code {installed.returncode}.')
        executable = install_root / f'xueness-update-smoke-{fixture_id}.exe'
        if not executable.is_file():
            raise RuntimeError(f'The installed NSIS fixture did not contain {executable}.')
        registered_location = fixture_registration(fixture_id)
        if not registered_location or Path(registered_location).resolve() != install_root.resolve():
            raise RuntimeError(f'NSIS registered a different installation directory: {registered_location}')
        descriptor = json.loads((work / 'update-smoke-config.json').read_text(encoding='utf-8'))
        runtime_fixture_root = executable.resolve().parent.parent
        if (Path(descriptor.get('fixtureRoot', '')).resolve() != runtime_fixture_root
                or Path(descriptor.get('appData', '')).resolve() != (app_data / 'user-data').resolve()
                or Path(descriptor.get('report', '')).resolve() != report.resolve()):
            raise RuntimeError(
                'The installed updater fixture descriptor does not resolve beside the install directory '
                'to the isolated app data and report paths.'
            )

        seed_result = run_seed(executable, work, env, report)
        (work / 'seed-report.json').write_text(json.dumps(seed_result, indent=2) + '\n', encoding='utf-8')
        if seed_result.get('stage') != 'seeded' or seed_result.get('version') != base_version:
            raise RuntimeError(f'Unexpected baseline fixture result: {seed_result}')
        seed_hashes = preserved_data_hashes(app_data)

        report.unlink()
        run_fixture_builder(feed_root, update_version, feed.url, fixture_id)
        update_setup = find_setup(feed_root, update_version)
        previous_blockmap = base_setup.with_name(base_setup.name + '.blockmap')
        if previous_blockmap.is_file():
            shutil.copy2(previous_blockmap, feed_root / previous_blockmap.name)
        feed.allow_update_artifacts(update_setup, previous_blockmap)

        # This starts the installed app's production UpdateCoordinator and
        # electron-updater. The generated app-update.yml points only at the
        # loopback feed; electron-updater's SHA-512 verification stays on.
        updater_log_path = work / 'updater-process.log'
        with updater_log_path.open('w', encoding='utf-8', errors='replace') as updater_log:
            updater_process = subprocess.Popen(
                [str(executable), '--update', '--enable-logging', f'--log-file={work / "update-electron.log"}'], cwd=work, env=env,
                stdout=updater_log, stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
            deadline = time.monotonic() + 300
            latest: dict[str, object] = {}
            while time.monotonic() < deadline:
                if report.is_file():
                    try:
                        latest = json.loads(report.read_text(encoding='utf-8'))
                    except (OSError, json.JSONDecodeError):
                        latest = {}
                    if latest.get('stage') == 'error':
                        raise RuntimeError(f'Packaged in-app update failed: {latest}')
                    if latest.get('stage') == 'verified':
                        break
                if updater_process.poll() is not None and not latest:
                    raise RuntimeError(
                        'Installed updater process exited early '
                        f'({updater_process.returncode}); log tail:\n{read_log_tail(updater_log_path)}'
                    )
                time.sleep(0.25)
            else:
                updater_log.flush()
                raise RuntimeError(
                    'Timed out waiting for the installed NSIS update: '
                    f'{latest}; updater_process_exit={updater_process.poll()}; '
                    f'log tail:\n{read_log_tail(updater_log_path)}'
                )

        if (latest.get('version') != update_version or latest.get('preserved') is not True
                or latest.get('config') != {
                    'channel': 'stable', 'theme': 'dark', 'fixture': 'desktop-update-preserve'
                }
                or latest.get('session') != {
                    'id': 'windows-update-fixture-session',
                    'messages': [{'role': 'user', 'text': 'preserve this isolated session'}],
                }):
            raise RuntimeError(f'Updated NSIS fixture did not preserve data: {latest}')
        after_hashes = preserved_data_hashes(app_data)
        (work / 'data-preservation.json').write_text(json.dumps({
            'before': seed_hashes, 'after': after_hashes, 'unchanged': seed_hashes == after_hashes,
        }, indent=2) + '\n', encoding='utf-8')
        if after_hashes != seed_hashes:
            raise RuntimeError('The isolated configuration/session bytes changed during updating.')
        print(f'PASS: stage=verified preserved=true; installed NSIS {base_version} downloaded and installed {update_version} via loopback; isolated config and session survived', flush=True)
    finally:
        primary_failure = sys.exc_info()[0] is not None
        feed.close()
        try:
            cleanup_fixture(work, install_root, fixture_id, env)
        except Exception as cleanup_error:
            (work / 'cleanup-error.txt').write_text(str(cleanup_error) + '\n', encoding='utf-8')
            if not primary_failure:
                raise
            print(f'Fixture cleanup also failed; retained evidence at {work}: {cleanup_error}', file=sys.stderr)

if __name__ == '__main__':
    try:
        run_windows_update_smoke()
    except Exception as error:
        print(f'Windows NSIS update smoke failed: {error}', file=sys.stderr)
        raise
