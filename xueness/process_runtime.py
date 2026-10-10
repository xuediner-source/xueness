"""Prepare OS runtime variables and DLL search rules for external programs.

PyInstaller's Windows DLL directory is process global. All plugin launchers
share this short critical section, restoring it before waiting for children.
Permission checks and plugin switches remain responsibilities of the caller.

Owned-process cleanup also lives here so Windows and macOS do not grow a
second platform helper. ``host_platform_family`` is the stable host name
(``macos``, ``windows``, ``linux``) for that helper. Plugins that only need
to label the machine call it instead of copying ``sys.platform`` branches.
POSIX (including macOS) signals the session started
with ``start_new_session`` via ``killpg``. Windows uses ``taskkill /T /F``.
Kill-on-close Job Objects stay in the desktop host and the MCP plugin; they
cover processes that outlive a single ``Popen`` handle. Tree signals are sent
only to a process this helper still holds or to a pid the caller recorded
from that launch. A reaped pid is not signaled again.

The shape follows ZCode ``packages/services/src/process/processTreeTerminator.ts``
and ``packages/services/src/process/windowsTaskkillRunner.ts`` (Apache-2.0):
graceful group signal, then force, and no scan of unrelated system processes.
"""
import atexit
import os
import signal
import subprocess
import sys
import threading
import time
import weakref


def host_platform_family(platform=None):
    """Return ``macos``, ``windows``, ``linux``, ``unknown``, or a raw name.

    macOS is decided before Windows. ``darwin`` contains the letters ``win``,
    so a substring check would label a Mac as Windows. The same order is what
    the frontend ``resolveHostPlatform`` helper uses. ``sys.platform`` is the
    default. Pass an explicit value only in tests or when the caller already
    read the process platform once. Never classify a string a client sent.
    """
    raw = sys.platform if platform is None else platform
    if not isinstance(raw, str):
        return 'unknown'
    text = raw.strip().lower()
    if not text:
        return 'unknown'
    if text == 'darwin' or text.startswith('mac'):
        return 'macos'
    if text.startswith('win'):
        return 'windows'
    if text.startswith('linux'):
        return 'linux'
    return text


_lock = threading.RLock()
# Identity of the real subprocess.run. Callers and tests patch the subprocess
# module attribute; comparing against that live attribute would treat the mock
# as the real runner and spawn a process anyway.
_SUBPROCESS_RUN = subprocess.run
_owned_lock = threading.Lock()
_owned = weakref.WeakSet()
_group_leaders = set()
_tree_kill = threading.local()


class ProcessCancelled(subprocess.SubprocessError):
    """An owned child was stopped because the caller asked to cancel it."""

    def __init__(self, cmd, timeout=None, output=None, stderr=None):
        super().__init__('child process cancelled')
        self.cmd = cmd
        self.timeout = timeout
        self.stdout = output
        self.stderr = stderr


def _in_tree_kill():
    return bool(getattr(_tree_kill, 'on', False))


def note_owned_process(proc, *, group=False):
    """Remember a process so gateway exit can stop it without a PID scan."""
    pid = getattr(proc, 'pid', None)
    if not isinstance(pid, int) or pid <= 1 or pid == os.getpid():
        return
    try:
        with _owned_lock:
            _owned.add(proc)
            if group and os.name != 'nt':
                _group_leaders.add(pid)
    except TypeError:
        if group and os.name != 'nt':
            with _owned_lock:
                _group_leaders.add(pid)


def forget_owned_process(proc):
    pid = getattr(proc, 'pid', None)
    with _owned_lock:
        try:
            _owned.discard(proc)
        except TypeError:
            pass
        if isinstance(pid, int):
            _group_leaders.discard(pid)


def _leader(pid, group):
    if os.name == 'nt' or not isinstance(pid, int) or pid <= 1:
        return False
    if group is not None:
        return bool(group)
    with _owned_lock:
        return pid in _group_leaders


def _returncode(proc):
    code = getattr(proc, 'returncode', None)
    return code if isinstance(code, int) else None


def _pid_alive(pid):
    """Whether pid exists. This must not signal or reap it.

    Windows ``os.kill(pid, 0)`` calls TerminateProcess, so a liveness check
    would kill the process it is asking about. Real Windows uses OpenProcess.
    A test that only changes ``os.name`` still uses the POSIX probe, because
    this host has no Windows kernel to query.
    """
    if not isinstance(pid, int) or pid <= 1 or pid == os.getpid():
        return False
    if os.name == 'nt' and sys.platform == 'win32':
        try:
            return _windows_pid_alive(pid)
        except (OSError, AttributeError):
            return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def _windows_pid_alive(pid):
    import ctypes
    from ctypes import wintypes
    query = 0x1000  # PROCESS_QUERY_LIMITED_INFORMATION
    still_active = 259
    access_denied = 5
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    open_process = kernel.OpenProcess
    open_process.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    open_process.restype = wintypes.HANDLE
    handle = open_process(query, False, pid)
    if not handle:
        return ctypes.get_last_error() == access_denied
    try:
        get_code = kernel.GetExitCodeProcess
        get_code.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        get_code.restype = wintypes.BOOL
        code = wintypes.DWORD()
        if not get_code(handle, ctypes.byref(code)):
            return True
        return code.value == still_active
    finally:
        close = kernel.CloseHandle
        close.argtypes = [wintypes.HANDLE]
        close.restype = wintypes.BOOL
        close(handle)


def process_running(proc):
    """Whether proc still exists, without reaping it.

    ``Popen.poll`` collects the zombie and frees the pid. Callers that still
    need to signal the process group must not poll first.
    """
    if proc is None or _returncode(proc) is not None:
        return False
    isalive = getattr(proc, 'isalive', None)
    if callable(isalive):
        try:
            return bool(isalive())
        except OSError:
            return False
    pid = getattr(proc, 'pid', None)
    if isinstance(pid, int) and pid > 1:
        return _pid_alive(pid)
    return True


def _signal_group(pid, sig):
    # killpg(pid) is only safe when pid is a session leader we created.
    # A non-integer, or a pid that was already reaped, must not be interpolated
    # into a signal or a taskkill argv.
    if os.name == 'nt' or not isinstance(pid, int) or pid <= 1 or pid == os.getpid():
        return
    try:
        os.killpg(pid, sig)
    except (ProcessLookupError, PermissionError, OSError):
        pass


def _signal_direct(proc, sig, *, force=False):
    if force or sig == getattr(signal, 'SIGKILL', None):
        method = getattr(proc, 'kill', None)
    else:
        method = getattr(proc, 'terminate', None)
    if callable(method):
        try:
            method()
            return
        except OSError:
            pass
    pid = getattr(proc, 'pid', None)
    if isinstance(pid, int) and 1 < pid < 2**32 and pid != os.getpid():
        try:
            os.kill(pid, sig if os.name != 'nt' else signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            pass


def _wait_proc(proc, grace):
    if _returncode(proc) is not None:
        return True
    isalive = getattr(proc, 'isalive', None)
    if callable(isalive):
        try:
            if not isalive():
                return True
        except OSError:
            return True
    wait = getattr(proc, 'wait', None)
    if not callable(wait):
        return not process_running(proc)
    try:
        wait(timeout=max(0, grace))
    except subprocess.TimeoutExpired:
        return False
    except Exception:
        return _returncode(proc) is not None
    return True


def _taskkill(pid):
    """Run ``taskkill /T /F`` for one integer pid. Never through a shell.

    The recursion guard makes taskkill itself a leaf: its own ``run_external``
    must not try to tree-kill taskkill. Callers that only need the signal
    (the Windows terminal) use this directly so a POSIX unit test can observe
    the argv without pretending the host kernel is Windows.
    """
    if _in_tree_kill():
        return
    _tree_kill.on = True
    try:
        try:
            run_external(
                subprocess.run,
                ['taskkill.exe', '/PID', str(pid), '/T', '/F'],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
            )
        except (OSError, subprocess.SubprocessError):
            pass
    finally:
        _tree_kill.on = False


def _windows_tree(pid):
    """Force-kill a Windows process tree. The pid must be an int we launched."""
    if os.name != 'nt' or not isinstance(pid, int) or not 1 < pid < 2**32:
        return
    _taskkill(pid)


def signal_process_tree(pid):
    """Send the Windows tree-kill signal and return without waiting on the tree.

    POSIX callers use ``terminate_process_tree``. A non-integer pid is refused
    so a string can never be interpolated into the taskkill argv. This does
    not consult ``os.name``: the Windows terminal helper is the only caller,
    and its tests assert the argv on every host.
    """
    if not isinstance(pid, int) or not 1 < pid < 2**32 or pid == os.getpid():
        raise ValueError('invalid process id')
    _taskkill(pid)


def terminate_process_tree(proc, *, group=None, grace=2.0, sig=None):
    """Stop proc and descendants when it leads a session we created.

    Returns True when the direct process is no longer running. An already
    reaped process is left alone so a recycled pid cannot be killed.
    """
    if proc is None:
        return True
    if _returncode(proc) is not None:
        return True
    pid = getattr(proc, 'pid', None)
    leader = _leader(pid, group)
    if os.name == 'nt':
        if isinstance(pid, int):
            _windows_tree(pid)
        else:
            _signal_direct(proc, signal.SIGTERM)
    else:
        first = signal.SIGTERM if sig is None else sig
        if leader and isinstance(pid, int):
            _signal_group(pid, first)
        elif first not in (signal.SIGTERM, signal.SIGKILL) and isinstance(pid, int):
            try:
                os.kill(pid, first)
            except (ProcessLookupError, PermissionError, OSError):
                _signal_direct(proc, signal.SIGTERM)
        else:
            _signal_direct(proc, signal.SIGKILL if first == signal.SIGKILL else signal.SIGTERM)
    if _wait_proc(proc, grace):
        return True
    if os.name == 'nt':
        # Windows has no signal.SIGKILL. Popen.kill is the native fallback
        # when taskkill failed or the process did not stop within grace.
        _signal_direct(proc, signal.SIGTERM, force=True)
    elif leader and isinstance(pid, int) and _returncode(proc) is None:
        _signal_group(pid, signal.SIGKILL)
    else:
        _signal_direct(proc, signal.SIGKILL)
    return _wait_proc(proc, grace)


def terminate_pid(pid, *, group=False, grace=1.0):
    """Signal a recorded child pid. Refuse anything that is not a real pid."""
    if not isinstance(pid, int) or not 1 < pid < 2**32 or pid == os.getpid():
        return False
    if os.name == 'nt':
        _windows_tree(pid)
    elif group:
        _signal_group(pid, signal.SIGTERM)
    else:
        try:
            os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            return True
    deadline = time.monotonic() + max(0, grace)
    while time.monotonic() < deadline:
        if not _pid_alive(pid):
            return True
        time.sleep(0.05)
    if not _pid_alive(pid):
        return True
    if os.name == 'nt':
        _windows_tree(pid)
    elif group:
        _signal_group(pid, signal.SIGKILL)
    else:
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            return True
    return False


def release_owned_processes():
    """Stop processes this interpreter still owns. Used when a gateway exits."""
    with _owned_lock:
        procs = list(_owned)
    for proc in procs:
        try:
            if _returncode(proc) is None and process_running(proc):
                terminate_process_tree(proc, grace=1.0)
        except (OSError, subprocess.SubprocessError):
            pass
        finally:
            forget_owned_process(proc)


atexit.register(release_owned_processes)

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
    """Use UTF-8 with replacement for text pipes on every host.

    Locale encodings such as GBK/cp936 otherwise change what the same bytes
    mean on Windows and macOS. An explicit ``encoding`` is left alone. An
    explicit ``errors`` value (including ``strict``) is not overwritten;
    omitted ``errors`` becomes ``replace`` even when the caller set the encoding.
    """
    if kwargs.get('text') or kwargs.get('universal_newlines'):
        kwargs.setdefault('encoding', 'utf-8')
        kwargs.setdefault('errors', 'replace')


def windows_oem_encoding():
    """Console OEM code page. Only Windows publishes one."""
    if os.name != 'nt':
        raise OSError('OEM code page is a Windows console property')
    import ctypes
    return f'cp{int(ctypes.windll.kernel32.GetOEMCP())}'


def decode_subprocess_output(value):
    """Decode captured subprocess bytes without raising.

    UTF-8 (BOM stripped) with ``errors='replace'`` on every host, so the same
    bytes mean the same text on Windows and macOS. A UTF-16 BOM is honored
    because those bytes are not UTF-8 text. Callers that need a strict
    encoding pass ``errors`` to the subprocess themselves.
    """
    if isinstance(value, str):
        return value
    if not value:
        return ''
    if value.startswith((b'\xff\xfe', b'\xfe\xff')):
        return value.decode('utf-16', errors='replace')
    return value.decode('utf-8-sig', errors='replace')


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


def _owned_run(*popen_args, tree, **kwargs):
    """Run one argv with Popen so a timeout can stop the process tree.

    The DLL search lock, when it is needed, is held only while creating the
    process. Waiting and tree termination happen after it is restored.
    """
    check = kwargs.pop('check', False)
    timeout = kwargs.pop('timeout', None)
    capture = kwargs.pop('capture_output', False)
    input_value = kwargs.pop('input', None)
    cancel = kwargs.pop('cancel', None)
    group = False
    if tree and os.name != 'nt' and 'start_new_session' not in kwargs:
        kwargs['start_new_session'] = True
        group = True
    elif tree and os.name != 'nt' and kwargs.get('start_new_session'):
        group = True
    if capture:
        if kwargs.get('stdout') is not None or kwargs.get('stderr') is not None:
            raise ValueError('capture_output cannot be combined with stdout/stderr')
        kwargs.update(stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if input_value is not None:
        if kwargs.get('stdin') is not None:
            raise ValueError('input cannot be combined with stdin')
        kwargs['stdin'] = subprocess.PIPE
    pipe_encoding = pipe_errors = None
    if os.name == 'nt' and (kwargs.get('text') or kwargs.get('universal_newlines')
                           or kwargs.get('encoding') or kwargs.get('errors')):
        # Windows Popen decodes in background reader threads. A strict decode
        # error there is only printed; communicate() can return None as success.
        # Collect bytes and decode in this caller so failures reach the gate.
        pipe_encoding = kwargs.pop('encoding', None) or 'utf-8'
        pipe_errors = kwargs.pop('errors', None) or 'strict'
        kwargs['text'] = False
        kwargs['universal_newlines'] = False
        if input_value is not None:
            if not isinstance(input_value, str):
                raise TypeError('text-mode input must be a string')
            input_value = input_value.encode(pipe_encoding, pipe_errors)
    with spawn_external(subprocess.Popen, *popen_args, **kwargs) as proc:
        if tree:
            note_owned_process(proc, group=group)
        try:
            try:
                stdout, stderr = _communicate(proc, input_value, timeout, cancel if tree else None)
                if pipe_encoding is not None:
                    def decode_pipe(value):
                        if not isinstance(value, bytes):
                            return value
                        return value.decode(pipe_encoding, pipe_errors).replace('\r\n', '\n').replace('\r', '\n')
                    stdout, stderr = decode_pipe(stdout), decode_pipe(stderr)
            except subprocess.TimeoutExpired as exc:
                _stop_run(proc, group=group and tree, tree=tree)
                exc.stdout, exc.stderr = _drain(proc)
                raise
            except ProcessCancelled as exc:
                _stop_run(proc, group=group and tree, tree=tree)
                exc.stdout, exc.stderr = _drain(proc)
                raise
            except BaseException:
                _stop_run(proc, group=group and tree, tree=tree)
                raise
        finally:
            if tree:
                forget_owned_process(proc)
        if check and proc.returncode:
            raise subprocess.CalledProcessError(proc.returncode, proc.args, stdout, stderr)
        return subprocess.CompletedProcess(proc.args, proc.returncode, stdout, stderr)


def _stop_run(proc, *, group, tree):
    if not tree:
        try:
            proc.kill()
        except OSError:
            pass
        return
    terminate_process_tree(proc, group=group, grace=2.0)


def _drain(proc):
    try:
        return proc.communicate(timeout=2)
    except subprocess.TimeoutExpired as drained:
        return drained.stdout, drained.stderr
    except UnicodeError:
        # A strict encoding on a partial pipe must not hide the timeout or
        # cancellation that already stopped the process.
        return None, None


def _communicate(proc, input_value, timeout, cancel):
    if not callable(cancel):
        return proc.communicate(input_value, timeout=timeout)
    deadline = None if timeout is None else time.monotonic() + timeout
    while True:
        try:
            stop = bool(cancel())
        except Exception:
            stop = False
        if stop:
            raise ProcessCancelled(proc.args, timeout)
        remaining = None if deadline is None else deadline - time.monotonic()
        if remaining is not None and remaining <= 0:
            raise subprocess.TimeoutExpired(proc.args, timeout)
        slice_timeout = 0.1 if remaining is None else min(0.1, max(remaining, 0))
        try:
            return proc.communicate(input_value, timeout=slice_timeout)
        except subprocess.TimeoutExpired as exc:
            input_value = None
            if deadline is not None and time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(
                    proc.args, timeout, output=exc.stdout, stderr=exc.stderr) from None


def run_external(factory, *args, **kwargs):
    configure_subprocess_text(kwargs)
    _prepare_environment(kwargs)
    # taskkill is a leaf. Running it through the tree-kill path would recurse.
    if _in_tree_kill():
        if os.name == 'nt' and getattr(sys, 'frozen', False) and factory is _SUBPROCESS_RUN:
            return _owned_run(*args, tree=False, **kwargs)
        if os.name == 'nt' and getattr(sys, 'frozen', False):
            return spawn_external(factory, *args, **kwargs)
        return factory(*args, **kwargs)
    if factory is _SUBPROCESS_RUN or (os.name == 'nt' and getattr(sys, 'frozen', False)):
        return _owned_run(*args, tree=True, **kwargs)
    return factory(*args, **kwargs)
