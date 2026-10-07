"""Send a console interrupt from an isolated helper, never from the host console."""
import os
from pathlib import Path
import subprocess
import sys


def _owned_pid(pid):
    if type(pid) is not int or not 0 < pid < 2**32:
        raise ValueError('invalid owned terminal process')
    return pid


def interrupt(pid):
    """Launch only the fixed helper for the caller's live, owned ConPTY PID.

    CTRL_C_EVENT cannot target an arbitrary PID. A separate process attaches to
    this terminal's console before sending group 0; the server stays detached
    and its other terminal consoles receive no signal.
    """
    _owned_pid(pid)
    argv = ([sys.executable, '--worker', 'terminal-interrupt', str(pid)]
            if getattr(sys, 'frozen', False) else
            [sys.executable, str(Path(__file__).resolve()), str(pid)])
    env = {k: v for k, v in os.environ.items() if k.upper() in
           ('PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC')}
    from ...process_runtime import run_external
    try:
        run_external(subprocess.run, argv, env=env,
                     creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                     capture_output=True, timeout=5, check=True)
    except subprocess.SubprocessError as exc:
        raise OSError('Windows terminal interrupt failed') from exc



def _send(pid):
    """Child-only Win32 calls: never change the host's process-global console."""
    _owned_pid(pid)
    if os.name != 'nt':
        raise OSError('console interrupts require Windows')
    import ctypes
    from ctypes import wintypes
    import time
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    free = kernel.FreeConsole
    free.argtypes, free.restype = [], wintypes.BOOL
    attach = kernel.AttachConsole
    attach.argtypes, attach.restype = [wintypes.DWORD], wintypes.BOOL
    ignore = kernel.SetConsoleCtrlHandler
    ignore.argtypes, ignore.restype = [ctypes.c_void_p, wintypes.BOOL], wintypes.BOOL
    generate = kernel.GenerateConsoleCtrlEvent
    generate.argtypes, generate.restype = [wintypes.DWORD, wintypes.DWORD], wintypes.BOOL
    free()
    if not attach(pid):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        if not ignore(None, True) or not generate(0, 0):
            raise ctypes.WinError(ctypes.get_last_error())
        # Let the asynchronous control event reach the attached shell before
        # detaching. This delay is bounded and applies only to an actual Ctrl+C.
        time.sleep(.1)
    finally:
        free()


if __name__ == '__main__':
    if len(sys.argv) != 2 or not sys.argv[1].isascii() or not sys.argv[1].isdecimal():
        raise SystemExit('expected an owned terminal process ID')
    _send(int(sys.argv[1]))
