"""Native-only isolated diagnostics for ConPTY console event delivery."""
import base64
import ctypes
from ctypes import wintypes as w
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time


def send(pid, method):
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    for name, args, result in (
        ('FreeConsole', [], w.BOOL), ('AttachConsole', [w.DWORD], w.BOOL),
        ('SetConsoleCtrlHandler', [ctypes.c_void_p, w.BOOL], w.BOOL),
        ('GenerateConsoleCtrlEvent', [w.DWORD, w.DWORD], w.BOOL),
        ('GetConsoleProcessList', [ctypes.POINTER(w.DWORD), w.DWORD], w.DWORD),
        ('CreateFileW', [w.LPCWSTR, w.DWORD, w.DWORD, ctypes.c_void_p, w.DWORD, w.DWORD, w.HANDLE], w.HANDLE),
        ('GetConsoleMode', [w.HANDLE, ctypes.POINTER(w.DWORD)], w.BOOL),
        ('CloseHandle', [w.HANDLE], w.BOOL)):
        f = getattr(k, name); f.argtypes = args; f.restype = result
    k.FreeConsole()
    if not k.AttachConsole(pid):
        raise ctypes.WinError(ctypes.get_last_error())
    processes = (w.DWORD*256)(); n=k.GetConsoleProcessList(processes, 256)
    h=k.CreateFileW('CONIN$', 0xC0000000, 3, None, 3, 0, None)
    mode=w.DWORD(); mode_ok=k.GetConsoleMode(h, ctypes.byref(mode))
    report={'method': method,'pid':pid,'consolePids':list(processes)[:n], 'mode':mode.value,'modeOk':bool(mode_ok)}
    os.write(1, (json.dumps(report)+'\n').encode())
    try:
        if method=='event':
            k.SetConsoleCtrlHandler(None, True)
            if not k.GenerateConsoleCtrlEvent(0,0): raise ctypes.WinError(ctypes.get_last_error())
        elif method=='keys':
            class Key(ctypes.Structure):
                _fields_=[('down',w.BOOL),('repeat',w.WORD),('vk',w.WORD),('scan',w.WORD),('char',w.WCHAR),('control',w.DWORD)]
            class Input(ctypes.Structure):
                _fields_=[('type',w.WORD),('key',Key)]
            assert ctypes.sizeof(Input)==20
            records=(Input*4)(Input(1,Key(1,1,17,29,'\0',8)),Input(1,Key(1,1,67,46,'\x03',8)),
                              Input(1,Key(0,1,67,46,'\x03',8)),Input(1,Key(0,1,17,29,'\0',0)))
            f=k.WriteConsoleInputW; f.argtypes=[w.HANDLE,ctypes.POINTER(Input),w.DWORD,ctypes.POINTER(w.DWORD)]; f.restype=w.BOOL
            count=w.DWORD()
            if not f(h,records,4,ctypes.byref(count)): raise ctypes.WinError(ctypes.get_last_error())
        time.sleep(.1)
    finally:
        k.CloseHandle(h); k.FreeConsole()


def probe(method):
    from xueness.bundled_plugins.terminal.windows import WindowsTerminal
    with tempfile.TemporaryDirectory() as temp:
        term=WindowsTerminal(Path(temp),'probe')
        try:
            def output():
                return base64.b64decode(term.read(0)['data']).decode(errors='replace')
            def wait(text, seconds=5):
                end=time.monotonic()+seconds
                while time.monotonic()<end:
                    if text in output(): return True
                    time.sleep(.03)
                return False
            term.proc.write("$r='PROBE';Write-Output ($r+'_READY');Write-Output ('INPUT='+[Console]::TreatControlCAsInput)\r")
            ready=wait('PROBE_READY')
            term.proc.write("$r='PROBE';Write-Output ($r+'_RUNNING');Start-Sleep -Seconds 30\r")
            running=wait('PROBE_RUNNING')
            if method=='raw':
                term.proc.write('\x03'); native=None
            else:
                p=subprocess.run([sys.executable, str(Path(__file__).resolve()), '--send',str(term.proc.pid),method],
                                  capture_output=True,timeout=5,creationflags=subprocess.CREATE_NO_WINDOW)
                native={'code':p.returncode,'stdout':p.stdout.decode(errors='replace'),'stderr':p.stderr.decode(errors='replace')}
            term.proc.write("$r='PROBE';Write-Output ($r+'_AFTER')\r")
            after=wait('PROBE_AFTER')
            value=output(); plain=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '',value)
            print(json.dumps({'method':method,'ready':ready,'running':running,'after':after,'native':native,
                              'tail':plain[-1200:]}),flush=True)
        finally:
            term.close()


if __name__=='__main__':
    if sys.argv[1:] and sys.argv[1]=='--send':
        send(int(sys.argv[2]),sys.argv[3])
    elif os.name=='nt':
        for method in ('raw','event','keys'): probe(method)
