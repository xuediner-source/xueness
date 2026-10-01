"""Restore OS DLL search rules only while spawning external programs.

PyInstaller's Windows DLL directory is process global. All plugin launchers
share this short critical section, restoring it before waiting for children.
Permission checks and plugin switches remain responsibilities of the caller.
"""
import os
import subprocess
import sys
import threading

_lock = threading.RLock()


def spawn_external(factory, *args, **kwargs):
    if os.name != 'nt' or not getattr(sys, 'frozen', False):
        return factory(*args, **kwargs)
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    get_directory = kernel.GetDllDirectoryW
    get_directory.argtypes = [wintypes.DWORD, wintypes.LPWSTR]
    get_directory.restype = wintypes.DWORD
    set_directory = kernel.SetDllDirectoryW
    set_directory.argtypes = [wintypes.LPCWSTR]
    set_directory.restype = wintypes.BOOL
    with _lock:
        buffer = ctypes.create_unicode_buffer(32768)
        size = get_directory(len(buffer), buffer)
        if size >= len(buffer):
            raise OSError('DLL search directory exceeds supported length')
        original = buffer.value or None
        if not set_directory(None):
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return factory(*args, **kwargs)
        finally:
            if not set_directory(original):
                raise ctypes.WinError(ctypes.get_last_error())


def run_external(factory, *args, **kwargs):
    if os.name != 'nt' or not getattr(sys, 'frozen', False):
        return factory(*args, **kwargs)
    check = kwargs.pop('check', False)
    timeout = kwargs.pop('timeout', None)
    capture = kwargs.pop('capture_output', False)
    input_value = kwargs.pop('input', None)
    if capture:
        if kwargs.get('stdout') is not None or kwargs.get('stderr') is not None:
            raise ValueError('capture_output cannot be combined with stdout/stderr')
        kwargs.update(stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if input_value is not None:
        if kwargs.get('stdin') is not None:
            raise ValueError('input cannot be combined with stdin')
        kwargs['stdin'] = subprocess.PIPE
    with spawn_external(subprocess.Popen, *args, **kwargs) as proc:
        try:
            stdout, stderr = proc.communicate(input_value, timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            proc.kill()
            exc.stdout, exc.stderr = proc.communicate()
            raise
        except BaseException:
            proc.kill()
            raise
        if check and proc.returncode:
            raise subprocess.CalledProcessError(proc.returncode, proc.args, stdout, stderr)
        return subprocess.CompletedProcess(proc.args, proc.returncode, stdout, stderr)
