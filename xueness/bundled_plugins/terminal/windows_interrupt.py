"""Send a console interrupt from an isolated helper, never from the host console."""
import base64
import os
from pathlib import Path
import subprocess


_SCRIPT = r'''$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class XuenessTerminalInterrupt {
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GenerateConsoleCtrlEvent(uint signal, uint group);
    public static void Send(uint pid) {
        FreeConsole();
        if (!AttachConsole(pid)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            if (!SetConsoleCtrlHandler(IntPtr.Zero, true)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (!GenerateConsoleCtrlEvent(0, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
            System.Threading.Thread.Sleep(100);
        } finally { FreeConsole(); }
    }
}
'@
[XuenessTerminalInterrupt]::Send('''


def interrupt(pid):
    """The caller supplies only its live, owned ConPTY shell PID.

    CTRL_C_EVENT cannot target an arbitrary PID. A separate process attaches to
    this terminal's console before sending group 0; the server stays detached
    and its other terminal consoles receive no signal. The fixed helper also
    works in the frozen app without invoking the backend executable as Python.
    """
    if type(pid) is not int or not 0 < pid < 2**32:
        raise ValueError('invalid owned terminal process')
    env = {k: v for k, v in os.environ.items() if k.upper() in
           ('PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC')}
    system_root = next((v for k, v in env.items() if k.upper() == 'SYSTEMROOT'), None)
    if not system_root:
        raise OSError('Windows system directory is unavailable')
    helper = Path(system_root)/'System32'/'WindowsPowerShell'/'v1.0'/'powershell.exe'
    command = base64.b64encode((_SCRIPT + str(pid) + ')').encode('utf-16le')).decode('ascii')
    from ...process_runtime import run_external
    run_external(subprocess.run, [str(helper), '-NoLogo', '-NoProfile', '-NonInteractive',
                                 '-EncodedCommand', command], env=env,
                 creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
                 capture_output=True, timeout=5, check=True)
