"""Portable advisory byte-range locks for shared kernel state.

POSIX keeps flock semantics. Windows uses LockFileEx on the same byte range,
including shared/nonblocking acquisition. Closing a descriptor releases it.
"""
import errno
import os

LOCK_SH, LOCK_EX, LOCK_NB, LOCK_UN = 1, 2, 4, 8


def flock(file, operation):
    fd = file if isinstance(file, int) else file.fileno()
    if os.name != 'nt':
        import fcntl
        return fcntl.flock(fd, operation)
    import ctypes
    import msvcrt
    from ctypes import wintypes
    class Overlapped(ctypes.Structure):
        _fields_ = [('Internal', ctypes.c_size_t), ('InternalHigh', ctypes.c_size_t),
                    ('Offset', wintypes.DWORD), ('OffsetHigh', wintypes.DWORD), ('hEvent', wintypes.HANDLE)]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    handle = wintypes.HANDLE(msvcrt.get_osfhandle(fd))
    overlapped = Overlapped()
    if operation & LOCK_UN:
        function = kernel.UnlockFileEx
        function.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(Overlapped)]
        ok = function(handle, 0, 1, 0, ctypes.byref(overlapped))
    else:
        function = kernel.LockFileEx
        function.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(Overlapped)]
        flags = (2 if operation & LOCK_EX else 0) | (1 if operation & LOCK_NB else 0)
        ok = function(handle, flags, 0, 1, 0, ctypes.byref(overlapped))
    if not ok:
        error = ctypes.get_last_error()
        if error in (33, 158):
            raise BlockingIOError(errno.EWOULDBLOCK, 'lock is held by another process')
        raise ctypes.WinError(error)
