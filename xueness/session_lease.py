"""Cross-process locks for a session.

``lease`` is the nonblocking single-writer lock for a whole turn. ``journal_lock``
is a separate, short, blocking lock around one durable read or write of that
session's journal. They use different files on purpose. On this platform a
second ``flock`` of the same file waits, and closing one descriptor must not
be what releases the other; nesting the journal write on the run-lease file
would either time out or drop the turn lock.

Both open the lock file and then check it. A path check before the open is
not the guard: on Windows ``O_NOFOLLOW`` is 0, so a symlink or junction
swapped in between ``lstat`` and ``open`` would be followed. POSIX opens the
lock directory with ``O_DIRECTORY | O_NOFOLLOW`` and opens the lock file
relative to that descriptor. Windows opens the directory without following
its own reparse point, creates the lock file relative to that handle, then
rejects a reparse point or a non-regular file using the handle's attributes
and ``fstat``.

The multi-window file lock and the atomic rename it protects follow the
approach in ZCode ``packages/services/src/fs/atomicFileUtils.ts`` and
``packages/shared/src/node/atomicFileLock.ts`` (Apache-2.0). The lock is the
open descriptor: process exit releases it, and the lock file is not deleted
out from under a waiter.
"""
from contextlib import contextmanager
import errno
import os
import stat
import time

from . import file_lock as fcntl

_LOCK_TIMEOUT_SECONDS = 8.0


_FILE_ATTRIBUTE_DIRECTORY = 0x10
_FILE_ATTRIBUTE_REPARSE_POINT = 0x400
_DIRECTORY_LINK_ERRNOS = frozenset({errno.ELOOP, errno.ENOTDIR})
_FILE_LINK_ERRNOS = frozenset({errno.ELOOP, errno.ENOTDIR, errno.EISDIR})


def _acquire_exclusive(fd, timeout):
    """Wait until ``fd`` holds an exclusive lock, or raise ``TimeoutError``.

    Non-blocking attempts keep a same-thread re-entry from sleeping forever
    on a lock this thread already holds. A crash closes ``fd`` and releases
    the lock without an explicit unlock.
    """
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout < 0:
        raise ValueError('invalid lock timeout')
    deadline = time.monotonic() + timeout
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError('timed out waiting for a file lock') from None
            time.sleep(min(0.02, remaining))


@contextmanager
def exclusive_lock(directory, name, *, timeout=_LOCK_TIMEOUT_SECONDS):
    """Block for the named lock, using the same open path as ``lease``."""
    fd = _open_session_lock(directory, name)
    try:
        _acquire_exclusive(fd, timeout)
        yield
    finally:
        os.close(fd)


@contextmanager
def lease(store, sid):
    store._path(sid)
    directory = store.directory / '.locks'
    fd = _open_session_lock(directory, sid + '.lock')
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


@contextmanager
def journal_lock(store, sid, *, timeout=_LOCK_TIMEOUT_SECONDS):
    """Serialize one journal read or write. Not the run lease.

    Callers that already hold ``lease`` can take this lock. It must not be
    entered again on the same thread while that entry is still active.
    """
    store._path(sid)
    with exclusive_lock(store.directory / '.locks', sid + '.journal.lock', timeout=timeout):
        yield


def _lock_name(name: str) -> None:
    if (not isinstance(name, str) or not name or name in {'.', '..'}
            or os.path.basename(name) != name or '/' in name or '\\' in name
            or '\0' in name):
        raise ValueError('invalid session lock')


def _open_session_lock(directory, name: str) -> int:
    _lock_name(name)
    directory.mkdir(exist_ok=True, mode=0o700)
    if os.name == 'nt':
        return _open_session_lock_windows(directory, name)
    return _open_session_lock_posix(directory, name)


def _open_session_lock_posix(directory, name: str) -> int:
    nofollow = getattr(os, 'O_NOFOLLOW', 0)
    directory_flag = getattr(os, 'O_DIRECTORY', 0)
    if not nofollow or not directory_flag or os.open not in getattr(os, 'supports_dir_fd', ()):
        raise OSError('platform cannot open a session lock without following a link')
    dir_flags = os.O_RDONLY | directory_flag | nofollow | getattr(os, 'O_CLOEXEC', 0)
    try:
        dir_fd = os.open(os.fspath(directory), dir_flags)
    except OSError as exc:
        if exc.errno in _DIRECTORY_LINK_ERRNOS:
            raise ValueError('invalid lock directory') from exc
        raise
    fd = None
    try:
        if not stat.S_ISDIR(os.fstat(dir_fd).st_mode):
            raise ValueError('invalid lock directory')
        file_flags = (os.O_CREAT | os.O_RDWR | nofollow
                      | getattr(os, 'O_CLOEXEC', 0) | getattr(os, 'O_NONBLOCK', 0))
        try:
            fd = os.open(name, file_flags, 0o600, dir_fd=dir_fd)
        except OSError as exc:
            if exc.errno in _FILE_LINK_ERRNOS:
                raise ValueError('invalid session lock') from exc
            raise
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('invalid session lock')
        opened = fd
        fd = None
        return opened
    finally:
        if fd is not None:
            os.close(fd)
        os.close(dir_fd)


def _open_session_lock_windows(directory, name: str) -> int:
    """Open ``name`` under a directory handle that was not followed.

    ``O_NOFOLLOW`` cannot close the check-then-open window here. The directory
    handle is the root of the relative create, so replacing the directory name
    after this open cannot redirect the lock file.
    """
    directory_handle = None
    file_handle = None
    fd = None
    try:
        directory_handle = _win32_open_directory(os.fspath(directory))
        directory_attributes = _win32_attributes(directory_handle)
        if (directory_attributes & _FILE_ATTRIBUTE_REPARSE_POINT
                or not directory_attributes & _FILE_ATTRIBUTE_DIRECTORY):
            raise ValueError('invalid lock directory')
        file_handle = _win32_create_relative(directory_handle, name)
        file_attributes = _win32_attributes(file_handle)
        if (file_attributes & _FILE_ATTRIBUTE_REPARSE_POINT
                or file_attributes & _FILE_ATTRIBUTE_DIRECTORY):
            raise ValueError('invalid session lock')
        fd = _win32_fd(file_handle)
        file_handle = None
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('invalid session lock')
        opened = fd
        fd = None
        return opened
    finally:
        if fd is not None:
            os.close(fd)
        if file_handle is not None:
            _close_handle(file_handle)
        if directory_handle is not None:
            _close_handle(directory_handle)


def _invalid_handle(handle) -> bool:
    if not handle:
        return True
    import ctypes
    return handle == ctypes.c_void_p(-1).value


def _win32_open_directory(path: str):
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                       ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    create.restype = wintypes.HANDLE
    file_list_directory = 0x0001
    file_add_file = 0x0002
    file_traverse = 0x0020
    file_read_attributes = 0x0080
    synchronize = 0x00100000
    share_all = 0x0001 | 0x0002 | 0x0004
    open_existing = 3
    backup_semantics = 0x02000000
    open_reparse = 0x00200000
    handle = create(
        str(path),
        file_list_directory | file_add_file | file_traverse | file_read_attributes | synchronize,
        share_all, None, open_existing, backup_semantics | open_reparse, None)
    if _invalid_handle(handle):
        raise ctypes.WinError(ctypes.get_last_error(), 'session lock directory could not be opened')
    return handle


def _win32_attributes(handle) -> int:
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    get_info = kernel.GetFileInformationByHandleEx
    get_info.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    get_info.restype = wintypes.BOOL

    class FILE_ATTRIBUTE_TAG_INFO(ctypes.Structure):
        _fields_ = [('FileAttributes', wintypes.DWORD),
                    ('ReparseTag', wintypes.DWORD)]

    info = FILE_ATTRIBUTE_TAG_INFO()
    # FileAttributeTagInfo is information class 9. OPEN_REPARSE_POINT makes
    # this describe the link itself instead of the target it would follow.
    if not get_info(handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
        raise ctypes.WinError(ctypes.get_last_error(),
                              'session lock handle attributes could not be read')
    return int(info.FileAttributes)


def _win32_create_relative(directory_handle, name: str):
    import ctypes
    from ctypes import wintypes
    ntdll = ctypes.WinDLL('ntdll', use_last_error=True)
    nt_create = ntdll.NtCreateFile
    nt_create.restype = wintypes.DWORD

    class UNICODE_STRING(ctypes.Structure):
        _fields_ = [('Length', wintypes.USHORT),
                    ('MaximumLength', wintypes.USHORT),
                    ('Buffer', wintypes.LPWSTR)]

    class OBJECT_ATTRIBUTES(ctypes.Structure):
        _fields_ = [('Length', wintypes.ULONG),
                    ('RootDirectory', wintypes.HANDLE),
                    ('ObjectName', ctypes.POINTER(UNICODE_STRING)),
                    ('Attributes', wintypes.ULONG),
                    ('SecurityDescriptor', ctypes.c_void_p),
                    ('SecurityQualityOfService', ctypes.c_void_p)]

    class IO_STATUS_BLOCK(ctypes.Structure):
        _fields_ = [('Pointer', ctypes.c_void_p),
                    ('Information', ctypes.c_size_t)]

    nt_create.argtypes = [
        ctypes.POINTER(wintypes.HANDLE), wintypes.DWORD,
        ctypes.POINTER(OBJECT_ATTRIBUTES), ctypes.POINTER(IO_STATUS_BLOCK),
        ctypes.c_void_p, wintypes.ULONG, wintypes.ULONG, wintypes.ULONG,
        wintypes.ULONG, ctypes.c_void_p, wintypes.ULONG]

    name_buffer = ctypes.create_unicode_buffer(name)
    unicode_name = UNICODE_STRING()
    byte_length = len(name) * 2
    unicode_name.Length = byte_length
    unicode_name.MaximumLength = byte_length + 2
    unicode_name.Buffer = ctypes.cast(name_buffer, wintypes.LPWSTR)
    attributes = OBJECT_ATTRIBUTES()
    attributes.Length = ctypes.sizeof(OBJECT_ATTRIBUTES)
    attributes.RootDirectory = directory_handle
    attributes.ObjectName = ctypes.pointer(unicode_name)
    attributes.Attributes = 0x40  # OBJ_CASE_INSENSITIVE
    status_block = IO_STATUS_BLOCK()
    file_handle = wintypes.HANDLE()
    generic_read_write = 0x80000000 | 0x40000000
    share_all = 0x0001 | 0x0002 | 0x0004
    file_open_if = 3
    file_attribute_normal = 0x80
    file_non_directory = 0x40
    file_open_reparse = 0x200000
    synchronous = 0x20
    status = nt_create(
        ctypes.byref(file_handle), generic_read_write, ctypes.byref(attributes),
        ctypes.byref(status_block), None, file_attribute_normal, share_all,
        file_open_if, file_non_directory | file_open_reparse | synchronous, None, 0)
    if status & 0x80000000 or _invalid_handle(file_handle.value):
        raise OSError(None, 'session lock file could not be opened relative to its directory',
                      None, status)
    return file_handle.value


def _win32_fd(handle) -> int:
    import msvcrt
    return msvcrt.open_osfhandle(int(handle), os.O_BINARY)


def _close_handle(handle) -> None:
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    close = kernel.CloseHandle
    close.argtypes = [wintypes.HANDLE]
    close.restype = wintypes.BOOL
    close(handle)
