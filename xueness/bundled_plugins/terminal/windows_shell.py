"""Launch a fixed interactive shell without inheriting the host's Ctrl+C ignore flag."""
import os
import subprocess
import sys


def main():
    if os.name != 'nt' or len(sys.argv) != 2:
        raise ValueError('expected a Windows shell profile')
    if __package__:
        from .shells import resolve_shell
        from ...process_runtime import spawn_external
    else:
        from shells import resolve_shell
        # Source launchers run directly so they do not depend on the workspace
        # being the package checkout. Frozen workers use the shared DLL wrapper.
        spawn_external = lambda factory, *a, **kw: factory(*a, **kw)
    shell = resolve_shell(sys.argv[1])
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.DWORD)
    handler = kernel.SetConsoleCtrlHandler
    handler.argtypes = [ctypes.c_void_p, wintypes.BOOL]
    handler.restype = wintypes.BOOL
    # Ignore attributes are inherited; registered handlers are not. Clear the
    # attribute only in this owned console launcher and handle C here so the
    # shell receives it while this process continues waiting for that shell.
    callback = callback_type(lambda event: event == 0)
    if not handler(None, False) or not handler(callback, True):
        raise ctypes.WinError(ctypes.get_last_error())
    argv = [shell]
    if shell.lower().endswith(('powershell.exe', 'pwsh.exe')):
        argv.extend(['-NoLogo', '-NoProfile'])
    try:
        child = spawn_external(subprocess.Popen, argv)
        return child.wait()
    finally:
        handler(callback, False)


if __name__ == '__main__':
    raise SystemExit(main())
