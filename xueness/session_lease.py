"""Nonblocking cross-process single-writer lease for a session."""
from contextlib import contextmanager
from . import file_lock as fcntl
import os


@contextmanager
def lease(store, sid):
    store._path(sid)
    directory = store.directory / '.locks'
    if directory.is_symlink():
        raise ValueError('invalid lock directory')
    directory.mkdir(exist_ok=True, mode=0o700)
    lock_path = directory / (sid + '.lock')
    if lock_path.is_symlink():
        raise ValueError('invalid session lock')
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)
