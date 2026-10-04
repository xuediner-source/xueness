"""Nonblocking cross-process single-writer lease for a session."""
from contextlib import contextmanager
from . import file_lock as fcntl
from .resources import _is_link
import os


@contextmanager
def lease(store, sid):
    store._path(sid)
    directory = store.directory / '.locks'
    if _is_link(directory):
        raise ValueError('invalid lock directory')
    directory.mkdir(exist_ok=True, mode=0o700)
    lock_path = directory / (sid + '.lock')
    if _is_link(lock_path):
        raise ValueError('invalid session lock')
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)
