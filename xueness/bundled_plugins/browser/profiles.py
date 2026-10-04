"""User-confirmed Chrome data copies into a separate persistent browser profile."""
import csv
import errno
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid

from ...resources import _is_link, _protect_private_directory, _protect_private_file

PROFILE_ID = re.compile(r'^(Default|Profile [0-9]{1,4})$')
COPY_PATHS = ('Bookmarks', 'History', 'History-journal', 'Cookies', 'Cookies-journal',
              'Network/Cookies', 'Network/Cookies-journal', 'Local Storage', 'IndexedDB', 'Session Storage')
MAX_COPY_BYTES = 256 * 1024 * 1024
# Counts files and directories visited inside the approved copy list.
MAX_COPY_FILES = 10000
MAX_LOCAL_STATE_BYTES = 8 * 1024 * 1024
MAX_DIRECTORY_DEPTH = 256


class ProfileError(ValueError):
    pass


def _is_link_info(info):
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400)


def _link(path):
    return _is_link_info(path.lstat())


def _signature(info):
    """Metadata used to detect replaced or modified files and directories."""
    return (stat.S_IFMT(info.st_mode), getattr(info, 'st_dev', 0),
            getattr(info, 'st_ino', 0), info.st_size,
            getattr(info, 'st_mtime_ns', int(info.st_mtime * 1_000_000_000)),
            getattr(info, 'st_ctime_ns', int(info.st_ctime * 1_000_000_000)))


def _matches_open_file_signature(info, expected):
    """Compare an opened file with lstat metadata across platform APIs.

    Windows reports creation time for ``lstat``'s ctime and last-change time
    for an opened handle's ``fstat`` ctime. Compare stable identity, size, and
    modification time across those APIs, then keep the full lstat signature
    checks before and after the read to detect source changes.
    """
    actual = _signature(info)
    return actual[:5] == expected[:5] if os.name == 'nt' else actual == expected


def managed_profile(state_dir):
    raw_state = Path(state_dir)
    if _is_link(raw_state):
        raise ProfileError('profile_invalid')
    state = raw_state.resolve()
    path = state/'browser-profile'
    if (path.exists() or path.is_symlink()) and (_link(path) or not path.is_dir()):
        raise ProfileError('profile_invalid')
    if path.resolve().parent != state:
        raise ProfileError('profile_invalid')
    return path


def chrome_root():
    if sys.platform == 'win32':
        local = os.environ.get('LOCALAPPDATA')
        return Path(local)/'Google/Chrome/User Data' if local else None
    if sys.platform == 'darwin':
        return Path.home()/'Library/Application Support/Google/Chrome'
    return Path.home()/'.config/google-chrome'


def _checked_chrome_root(root):
    if root is None:
        return None
    root = Path(root)
    try:
        if _link(root):
            return None
        resolved = root.resolve(strict=True)
        return resolved if resolved.is_dir() else None
    except (OSError, RuntimeError):
        return None


def _posix_directory_flags():
    return (os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) |
            getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0))


def _posix_file_flags():
    return os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0)


def _open_posix_directory(path):
    """Open an absolute directory one component at a time without following links."""
    absolute = Path(path).resolve(strict=True)
    fd = os.open(absolute.anchor, _posix_directory_flags())
    try:
        for part in absolute.parts[1:]:
            next_fd = os.open(part, _posix_directory_flags(), dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def _relative_parts(relative):
    if isinstance(relative, (tuple, list)):
        parts = tuple(relative)
    else:
        value = str(relative)
        if os.name == 'nt':
            value = value.replace('\\', '/')
        parts = PurePosixPath(value).parts
    if not parts or any(not isinstance(part, str) or part in ('', '.', '..') or
                        '/' in part or '\x00' in part or ':' in part or
                        (os.name == 'nt' and '\\' in part) for part in parts):
        raise ProfileError('source_invalid')
    return parts


def _open_posix_parent(root, parts):
    if not parts:
        raise ProfileError('source_invalid')
    fd = _open_posix_directory(root)
    try:
        for part in parts[:-1]:
            try:
                next_fd = os.open(part, _posix_directory_flags(), dir_fd=fd)
            except FileNotFoundError:
                os.close(fd)
                return None
            except OSError as error:
                if error.errno in (errno.ELOOP, errno.ENOTDIR):
                    raise ProfileError('source_invalid') from None
                raise
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        if fd >= 0:
            os.close(fd)
        raise


def _source_info(root, relative):
    """Read lstat metadata beneath the Chrome root without traversing links."""
    parts = _relative_parts(relative)
    if os.name == 'nt':
        current = Path(root)
        for index, part in enumerate(parts):
            current = current / part
            try:
                info = current.lstat()
            except FileNotFoundError:
                return None
            if _is_link_info(info):
                raise ProfileError('source_invalid')
            if index < len(parts) - 1 and not stat.S_ISDIR(info.st_mode):
                raise ProfileError('source_invalid')
        return info

    parent_fd = _open_posix_parent(root, parts)
    if parent_fd is None:
        return None
    try:
        try:
            info = os.stat(parts[-1], dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            return None
        if _is_link_info(info):
            raise ProfileError('source_invalid')
        return info
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            raise ProfileError('source_invalid') from None
        raise
    finally:
        os.close(parent_fd)


def _open_posix_directory_beneath(root, parts):
    fd = _open_posix_directory(root)
    try:
        for part in parts:
            next_fd = os.open(part, _posix_directory_flags(), dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def _read_file(root, path, maximum, expected_signature=None):
    """Read one regular file without following links or exceeding its byte cap."""
    relative = path.relative_to(root)
    parts = _relative_parts(relative.as_posix())
    before = _source_info(root, parts)
    if before is None or not stat.S_ISREG(before.st_mode):
        raise ProfileError('source_invalid')
    if expected_signature is not None and _signature(before) != expected_signature:
        raise ProfileError('source_busy')

    if os.name == 'nt':
        from ..files.windows_paths import open_regular_file
        opened = open_regular_file(root, PurePosixPath(*parts).as_posix())
        if opened is None:
            raise ProfileError('source_busy')
        fd, info = opened
    else:
        parent_fd = _open_posix_parent(root, parts)
        if parent_fd is None:
            raise ProfileError('source_busy')
        try:
            fd = os.open(parts[-1], _posix_file_flags(), dir_fd=parent_fd)
        except OSError as error:
            if error.errno in (errno.ELOOP, errno.ENOENT, errno.ENOTDIR):
                raise ProfileError('source_busy') from None
            raise
        finally:
            os.close(parent_fd)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            os.close(fd)
            raise ProfileError('source_invalid')

    if expected_signature is not None and not _matches_open_file_signature(info, expected_signature):
        os.close(fd)
        raise ProfileError('source_busy')
    if info.st_size > maximum:
        os.close(fd)
        raise ProfileError('profile_too_large')
    with os.fdopen(fd, 'rb') as stream:
        data = stream.read(maximum + 1)
    if len(data) > maximum:
        raise ProfileError('profile_too_large')
    if len(data) != info.st_size:
        raise ProfileError('source_busy')
    if expected_signature is not None:
        after = _source_info(root, parts)
        if after is None or _signature(after) != expected_signature:
            raise ProfileError('source_busy')
    return data


def chrome_profiles(root=None):
    root = _checked_chrome_root(chrome_root() if root is None else root)
    if root is None:
        return []
    names = {}
    local_state = root/'Local State'
    if local_state.exists() or local_state.is_symlink():
        try:
            raw = _read_file(root, local_state, MAX_LOCAL_STATE_BYTES)
            value = json.loads(raw)
            names = value.get('profile', {}).get('info_cache', {}) if isinstance(value, dict) else {}
        except (OSError, ValueError, AttributeError):
            names = {}
    if not isinstance(names, dict):
        names = {}
    rows = []
    visited = 0
    for path in root.iterdir():
        visited += 1
        if visited > MAX_COPY_FILES:
            raise ProfileError('profile_too_large')
        if not PROFILE_ID.fullmatch(path.name):
            continue
        try:
            info = path.lstat()
        except FileNotFoundError:
            continue
        if not stat.S_ISDIR(info.st_mode) or _is_link_info(info):
            continue
        label = names.get(path.name, {})
        name = label.get('name') if isinstance(label, dict) else None
        name = re.sub(r'[\x00-\x1f\x7f]', '', name).strip()[:80] if isinstance(name, str) else path.name
        rows.append({'id': path.name, 'name': name or path.name})
    return sorted(rows, key=lambda row: row['id'])[:50]


def chrome_running():
    from ...process_runtime import spawn_external
    if sys.platform == 'win32':
        result = spawn_external(subprocess.run, ['tasklist.exe', '/FI', 'IMAGENAME eq chrome.exe', '/FO', 'CSV', '/NH'],
                                capture_output=True, text=True, timeout=5, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if result.returncode != 0:
            raise ProfileError('source_busy')
        return any(row and row[0].lower() == 'chrome.exe' for row in csv.reader(io.StringIO(result.stdout)))
    root = chrome_root()
    if root is not None:
        try:
            lock = Path(root)/'SingletonLock'
            if lock.is_symlink():
                return True
        except OSError:
            raise ProfileError('source_busy') from None
    result = spawn_external(subprocess.run, ['pgrep', '-x', 'Google Chrome' if sys.platform == 'darwin' else 'chrome'],
                            capture_output=True, timeout=5)
    if result.returncode == 0:
        return True
    if result.returncode == 1:
        return False
    raise ProfileError('source_busy')


def _remove_stage(path, state):
    if path.resolve().parent != state or _link(path):
        raise ProfileError('profile_invalid')
    shutil.rmtree(path)


def _snapshot_sources(root, profile_id):
    """Inventory only approved files and their parent directories under hard limits."""
    records = {}
    seen_directories = set()
    entry_count = 0
    total_bytes = 0

    def remember(parts, info):
        nonlocal entry_count, total_bytes
        if _is_link_info(info):
            raise ProfileError('source_invalid')
        if stat.S_ISDIR(info.st_mode):
            kind = 'directory'
        elif stat.S_ISREG(info.st_mode):
            kind = 'file'
        else:
            raise ProfileError('source_invalid')
        key = PurePosixPath(*parts).as_posix()
        record = (kind, _signature(info))
        previous = records.get(key)
        if previous is not None:
            if previous != record:
                raise ProfileError('source_busy')
            return kind, False
        entry_count += 1
        if entry_count > MAX_COPY_FILES:
            raise ProfileError('profile_too_large')
        if kind == 'file':
            total_bytes += info.st_size
            if total_bytes > MAX_COPY_BYTES:
                raise ProfileError('profile_too_large')
        records[key] = record
        return kind, True

    source_parts = (profile_id,)
    source_info = _source_info(root, source_parts)
    if source_info is None or not stat.S_ISDIR(source_info.st_mode):
        raise ProfileError('source_busy')
    remember(source_parts, source_info)

    def walk_directory(parts):
        key = PurePosixPath(*parts).as_posix()
        if key in seen_directories:
            return
        seen_directories.add(key)
        # Reopen each directory without following links and check it against the
        # signature recorded before any source files were copied.
        stack = [(parts, records[key][1], 0)]
        while stack:
            current_parts, expected, depth = stack.pop()
            if depth > MAX_DIRECTORY_DEPTH:
                raise ProfileError('profile_too_large')
            if os.name == 'nt':
                directory = root.joinpath(*current_parts)
                info = _source_info(root, current_parts)
                if info is None or not stat.S_ISDIR(info.st_mode) or _signature(info) != expected:
                    raise ProfileError('source_busy')
                try:
                    with os.scandir(directory) as iterator:
                        for entry in iterator:
                            name = entry.name
                            child_parts = current_parts + (name,)
                            info = _source_info(root, child_parts)
                            if info is None:
                                raise ProfileError('source_busy')
                            child_kind, added = remember(child_parts, info)
                            if child_kind == 'directory' and added:
                                stack.append((child_parts, _signature(info), depth + 1))
                except OSError:
                    raise ProfileError('source_busy') from None
            else:
                try:
                    directory_fd = _open_posix_directory_beneath(root, current_parts)
                except FileNotFoundError:
                    raise ProfileError('source_busy') from None
                except OSError as error:
                    if error.errno in (errno.ELOOP, errno.ENOTDIR):
                        raise ProfileError('source_invalid') from None
                    raise
                try:
                    info = os.fstat(directory_fd)
                    if not stat.S_ISDIR(info.st_mode) or _signature(info) != expected:
                        raise ProfileError('source_busy')
                    with os.scandir(directory_fd) as iterator:
                        for entry in iterator:
                            name = entry.name
                            child_parts = current_parts + (name,)
                            try:
                                child_info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                            except FileNotFoundError:
                                raise ProfileError('source_busy') from None
                            if _is_link_info(child_info):
                                raise ProfileError('source_invalid')
                            child_kind, added = remember(child_parts, child_info)
                            if child_kind == 'directory' and added:
                                try:
                                    child_fd = os.open(name, _posix_directory_flags(), dir_fd=directory_fd)
                                except OSError as error:
                                    if error.errno in (errno.ELOOP, errno.ENOTDIR, errno.ENOENT):
                                        raise ProfileError('source_busy' if error.errno == errno.ENOENT else 'source_invalid') from None
                                    raise
                                try:
                                    opened_info = os.fstat(child_fd)
                                    if _signature(opened_info) != _signature(child_info):
                                        raise ProfileError('source_busy')
                                finally:
                                    os.close(child_fd)
                                stack.append((child_parts, _signature(child_info), depth + 1))
                finally:
                    os.close(directory_fd)

    for name in COPY_PATHS:
        candidate_parts = (profile_id, *PurePosixPath(name).parts)
        absent = False
        # Include each traversed parent directory in the inventory and entry cap.
        for index in range(2, len(candidate_parts) + 1):
            parts = candidate_parts[:index]
            info = _source_info(root, parts)
            if info is None:
                absent = True
                break
            kind, added = remember(parts, info)
            if index < len(candidate_parts) and kind != 'directory':
                raise ProfileError('source_invalid')
            if index == len(candidate_parts) and kind == 'directory':
                walk_directory(parts)
        if absent:
            continue

    local_state_parts = ('Local State',)
    local_state_info = _source_info(root, local_state_parts)
    if local_state_info is not None:
        kind, _ = remember(local_state_parts, local_state_info)
        if kind != 'file':
            raise ProfileError('source_invalid')
        if local_state_info.st_size > MAX_LOCAL_STATE_BYTES:
            raise ProfileError('profile_too_large')
    return records


def _snapshot_file_records(snapshot, profile_id):
    prefix = profile_id + '/'
    return [(key, record[1]) for key, record in snapshot.items()
            if key.startswith(prefix) and record[0] == 'file']


def _write_private_profile_file(path, data):
    """Create stage data privately before copying any personal bytes."""
    flags = (os.O_WRONLY | os.O_CREAT | os.O_EXCL
             | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0))
    fd = os.open(path, flags, 0o600)
    try:
        _protect_private_file(fd)
        with os.fdopen(fd, 'wb') as stream:
            fd = None
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        if fd is not None:
            os.close(fd)


def import_chrome(state_dir, profile_id, *, recheck=lambda: None):
    """Copy a selected, closed Chrome profile without modifying its source."""
    if not isinstance(profile_id, str) or not PROFILE_ID.fullmatch(profile_id):
        raise ProfileError('profile_not_found')
    if chrome_running():
        raise ProfileError('close_chrome')
    root = _checked_chrome_root(chrome_root())
    if root is None or profile_id not in {row['id'] for row in chrome_profiles(root)}:
        raise ProfileError('profile_not_found')

    if _is_link(Path(state_dir)):
        raise ProfileError('profile_invalid')
    state = Path(state_dir).resolve()
    state.mkdir(parents=True, exist_ok=True)
    destination = managed_profile(state)
    source = root/profile_id
    stage = Path(tempfile.mkdtemp(prefix='browser-import-', dir=state))
    old = None
    try:
        # Chromium/Node create additional files themselves. Their parent must
        # have an inheritable private ACL before imported data enters the tree.
        _protect_private_directory(stage)
        snapshot = _snapshot_sources(root, profile_id)
        total = 0
        local_state_key = 'Local State'
        local_state_record = snapshot.get(local_state_key)
        if local_state_record is not None:
            local_state = root/local_state_key
            raw = _read_file(root, local_state, min(MAX_LOCAL_STATE_BYTES, MAX_COPY_BYTES),
                             expected_signature=local_state_record[1])
            total += len(raw)
            try:
                value = json.loads(raw)
            except (ValueError, UnicodeError):
                raise ProfileError('source_invalid') from None
            if not isinstance(value, dict):
                raise ProfileError('source_invalid')
            # Encrypted keys remain encrypted; account lists and unrelated
            # Local State data never enter the managed browser directory.
            safe = {'profile': {'last_used': 'Default'}}
            if isinstance(value.get('os_crypt'), dict):
                safe['os_crypt'] = value['os_crypt']
            _write_private_profile_file(stage/'Local State', json.dumps(safe).encode('utf-8'))

        for key, signature in sorted(_snapshot_file_records(snapshot, profile_id)):
            source_path = root.joinpath(*PurePosixPath(key).parts)
            data = _read_file(root, source_path, MAX_COPY_BYTES - total,
                              expected_signature=signature)
            total += len(data)
            target = stage/'Default'/Path(*PurePosixPath(key).parts[1:])
            target.parent.mkdir(parents=True, exist_ok=True)
            _write_private_profile_file(target, data)
        (stage/'Default').mkdir(exist_ok=True)

        recheck()
        try:
            current_snapshot = _snapshot_sources(root, profile_id)
        except ProfileError as error:
            if str(error) == 'source_invalid':
                raise
            raise ProfileError('source_busy') from None
        if current_snapshot != snapshot:
            raise ProfileError('source_busy')
        recheck()
        if chrome_running():
            raise ProfileError('close_chrome')
        # Repeat destination validation immediately before the atomic directory swap.
        destination = managed_profile(state)
        if destination.exists():
            # Also protect any prior managed profile retained as a recovery
            # backup, without touching the original Chrome source directory.
            _protect_private_directory(destination)
            old = state/('browser-import-old-' + uuid.uuid4().hex)
            if old.resolve().parent != state:
                raise ProfileError('profile_invalid')
            destination.rename(old)
        try:
            stage.rename(destination)
        except OSError:
            if old is not None:
                old.rename(destination)
                old = None
            raise

        cleanup_pending = False
        if old is not None:
            try:
                _remove_stage(old, state)
                old = None
            except (OSError, ProfileError):
                # The import is already committed. Keep the backup for recovery;
                # the API must report success and let settings offer cleanup.
                cleanup_pending = True
        return {'ok': True, 'profilePresent': True, 'loginMayRequireSignIn': True,
                'cleanupPending': cleanup_pending}
    finally:
        if stage.exists():
            try:
                _remove_stage(stage, state)
            except (OSError, ProfileError):
                pass


def dispatch(method, parts, query, data, ctx):
    if parts != ['api', 'browser', 'profiles']:
        return None
    from ... import plugin_runtime
    if not ctx.get('desktop_token') or not plugin_runtime.is_enabled(ctx['state_dir'], 'desktop'):
        return 403, {'error': 'desktop_required'}
    if method == 'GET':
        try:
            return 200, {'profiles': chrome_profiles()}
        except (OSError, ValueError):
            return 400, {'error': 'source_invalid'}
    if method != 'POST':
        return 405, {'error': 'method not allowed'}
    if set(data) != {'profileId', 'confirmed'} or data.get('confirmed') is not True:
        return 400, {'error': 'confirmation_required'}
    from . import plugin
    try:
        with ctx['lock'], plugin._BROKERS_LOCK:
            if ctx.get('running'):
                return 409, {'error': 'tasks_running'}

            def recheck():
                if (not plugin_runtime.is_enabled(ctx['state_dir'], 'browser') or
                        not plugin_runtime.is_enabled(ctx['state_dir'], 'desktop')):
                    raise ProfileError('plugin_disabled')

            recheck()
            plugin.shutdown(ctx['state_dir'])
            return 200, import_chrome(ctx['state_dir'], data['profileId'], recheck=recheck)
    except ProfileError as error:
        return (409 if str(error) in ('close_chrome', 'source_busy', 'tasks_running') else 400), {'error': str(error)}
    except (OSError, subprocess.SubprocessError):
        return 409, {'error': 'source_busy'}
