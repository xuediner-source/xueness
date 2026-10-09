"""Prepare OS runtime variables and DLL search rules for external programs.

PyInstaller's Windows DLL directory is process global. All plugin launchers
share this short critical section, restoring it before waiting for children.
Permission checks and plugin switches remain responsibilities of the caller.
"""
import os
import subprocess
import sys
import threading

_lock = threading.RLock()

# Windows/.NET startup needs these public OS and profile paths even when a
# plugin deliberately omits provider keys and other private environment data.
WINDOWS_ENV_KEYS = frozenset('''PATH SYSTEMROOT SYSTEMDRIVE WINDIR TEMP TMP COMSPEC PATHEXT
USERPROFILE APPDATA LOCALAPPDATA HOMEDRIVE HOMEPATH USERNAME USERDOMAIN COMPUTERNAME
OS NUMBER_OF_PROCESSORS PROCESSOR_ARCHITECTURE PROGRAMDATA ALLUSERSPROFILE PUBLIC
PROGRAMFILES PROGRAMFILES(X86) PROGRAMW6432 COMMONPROGRAMFILES COMMONPROGRAMFILES(X86)
COMMONPROGRAMW6432 PSMODULEPATH PSMODULEANALYSISCACHEPATH'''.split())


def windows_environment(env):
    result = dict(env)
    supplied = {key.upper() for key in result}
    for key, value in os.environ.items():
        if key.upper() in WINDOWS_ENV_KEYS and key.upper() not in supplied:
            result[key] = value
    return result


def _prepare_environment(kwargs):
    if os.name == 'nt' and kwargs.get('env') is not None:
        kwargs['env'] = windows_environment(kwargs['env'])


def configure_subprocess_text(kwargs):
    """Use UTF-8 for text pipes on every host.

    Locale encodings such as GBK/cp936 otherwise change what the same bytes
    mean. An explicit ``encoding`` is left alone, and an explicit ``errors``
    value (including ``strict``) is not overwritten.
    """
    if (kwargs.get('text') or kwargs.get('universal_newlines')) and 'encoding' not in kwargs:
        kwargs['encoding'] = 'utf-8'
        kwargs.setdefault('errors', 'replace')


def windows_oem_encoding():
    """Console OEM code page. Only Windows publishes one."""
    if os.name != 'nt':
        raise OSError('OEM code page is a Windows console property')
    import ctypes
    return f'cp{int(ctypes.windll.kernel32.GetOEMCP())}'


def decode_subprocess_output(value):
    """Decode captured bytes the way a console would, without raising.

    UTF-8 (with or without BOM) and UTF-16 BOM win. Anything else uses the
    Windows OEM code page when this process is Windows, and UTF-8 replacement
    on every other host.
    """
    if isinstance(value, str):
        return value
    if not value:
        return ''
    if value.startswith((b'\xff\xfe', b'\xfe\xff')):
        return value.decode('utf-16', errors='replace')
    try:
        return value.decode('utf-8-sig')
    except UnicodeDecodeError:
        if os.name == 'nt':
            return value.decode(windows_oem_encoding(), errors='replace')
        return value.decode('utf-8', errors='replace')


def spawn_external(factory, *args, **kwargs):
    configure_subprocess_text(kwargs)
    _prepare_environment(kwargs)
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
    configure_subprocess_text(kwargs)
    _prepare_environment(kwargs)
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
