"""Exercise the packaged NSIS updater against an isolated loopback feed on Windows."""
from __future__ import annotations

import json
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


def run_fixture_builder(output: Path, version: str, feed_url: str) -> None:
    output.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ['node', str(FIXTURE), '--build-fixture', str(output), version, feed_url],
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


def run_windows_update_smoke() -> None:
    if os.name != 'nt':
        raise RuntimeError('The real NSIS updater rehearsal runs only on Windows CI.')

    package = json.loads((DESKTOP / 'package.json').read_text(encoding='utf-8'))
    base_version = str(package.get('version', ''))
    update_version = next_patch_version(base_version)
    with tempfile.TemporaryDirectory(prefix='xueness-nsis-update-') as temp:
        work = Path(temp)
        base_build = work / 'base-build'
        feed_root = work / 'loopback-feed'
        install_root = work / 'installed-app'
        report = work / 'update-report.json'
        app_data = work / 'isolated-appdata'
        write_fixture_descriptor(work, app_data, report, update_version)
        feed = LoopbackFeed(feed_root)
        feed.start()
        try:
            run_fixture_builder(base_build, base_version, feed.url)
            base_setup = find_setup(base_build, base_version)
            install_root.mkdir(parents=True)
            env = isolated_environment(app_data)

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
            if installed.returncode != 0:
                raise RuntimeError(f'Initial NSIS installation failed with exit code {installed.returncode}.')
            executable = install_root / 'Xueness.exe'
            if not executable.is_file():
                raise RuntimeError('The installed NSIS fixture did not contain Xueness.exe.')
            descriptor = json.loads((work / 'update-smoke-config.json').read_text(encoding='utf-8'))
            runtime_fixture_root = executable.resolve().parent.parent
            if (Path(descriptor.get('fixtureRoot', '')).resolve() != runtime_fixture_root
                    or Path(descriptor.get('appData', '')).resolve() != (app_data / 'user-data').resolve()
                    or Path(descriptor.get('report', '')).resolve() != report.resolve()):
                raise RuntimeError(
                    'The installed updater fixture descriptor does not resolve beside the install directory '
                    'to the isolated app data and report paths.'
                )

            seeded = subprocess.run(
                [str(executable), '--seed'], cwd=work, env=env, capture_output=True,
                text=True, timeout=90, check=False,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
            if seeded.returncode != 0 or not report.is_file():
                detail = report.read_text(encoding='utf-8') if report.is_file() else seeded.stderr[-2000:]
                raise RuntimeError(f'Could not seed isolated desktop data: {detail}')
            seed_result = json.loads(report.read_text(encoding='utf-8'))
            if seed_result.get('stage') != 'seeded' or seed_result.get('version') != base_version:
                raise RuntimeError(f'Unexpected baseline fixture result: {seed_result}')

            report.unlink()
            run_fixture_builder(feed_root, update_version, feed.url)
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
                    [str(executable), '--update'], cwd=work, env=env,
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
            print(f'PASS: installed NSIS {base_version} downloaded and installed {update_version} via loopback; isolated config and session survived')
        finally:
            feed.close()


if __name__ == '__main__':
    try:
        run_windows_update_smoke()
    except Exception as error:
        print(f'Windows NSIS update smoke failed: {error}', file=sys.stderr)
        raise
