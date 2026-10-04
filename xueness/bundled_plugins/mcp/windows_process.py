"""Windows process-tree ownership for stdio MCP servers.

The initial process is created suspended, assigned to a private Job Object,
and only then resumed. Child processes inherit the job, so closing a client
can terminate a launcher and the interpreter/server it starts as one unit.
"""
from __future__ import annotations

import ctypes
import os
import subprocess
import time
from ctypes import wintypes


_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
_JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1
_JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3
_TH32CS_SNAPTHREAD = 0x00000004
_THREAD_SUSPEND_RESUME = 0x0002
_THREAD_QUERY_LIMITED_INFORMATION = 0x0800
_SYNCHRONIZE = 0x00100000
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_ERROR_NO_MORE_FILES = 18
_ERROR_GEN_FAILURE = 31
_ERROR_INVALID_PARAMETER = 87
_ERROR_INSUFFICIENT_BUFFER = 122
_ERROR_MORE_DATA = 234
_INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
_WAIT_OBJECT_0 = 0
_WAIT_TIMEOUT = 0x00000102
_WAIT_FAILED = 0xFFFFFFFF
_RESUME_FAILED = 0xFFFFFFFF
_JOB_EXIT_WAIT_SECONDS = 5.0


class _BasicLimitInformation(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class _IoCounters(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_longlong),
        ("WriteOperationCount", ctypes.c_longlong),
        ("OtherOperationCount", ctypes.c_longlong),
        ("ReadTransferCount", ctypes.c_longlong),
        ("WriteTransferCount", ctypes.c_longlong),
        ("OtherTransferCount", ctypes.c_longlong),
    ]


class _ExtendedLimitInformation(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _BasicLimitInformation),
        ("IoInfo", _IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class _BasicProcessIdListHeader(ctypes.Structure):
    _fields_ = [
        ("NumberOfAssignedProcesses", wintypes.DWORD),
        ("NumberOfProcessIdsInList", wintypes.DWORD),
    ]


class _BasicAccountingInformation(ctypes.Structure):
    _fields_ = [
        ("TotalUserTime", ctypes.c_longlong),
        ("TotalKernelTime", ctypes.c_longlong),
        ("ThisPeriodTotalUserTime", ctypes.c_longlong),
        ("ThisPeriodTotalKernelTime", ctypes.c_longlong),
        ("TotalPageFaultCount", wintypes.DWORD),
        ("TotalProcesses", wintypes.DWORD),
        ("ActiveProcesses", wintypes.DWORD),
        ("TotalTerminatedProcesses", wintypes.DWORD),
    ]


class _ThreadEntry32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ThreadID", wintypes.DWORD),
        ("th32OwnerProcessID", wintypes.DWORD),
        ("tpBasePri", wintypes.LONG),
        ("tpDeltaPri", wintypes.LONG),
        ("dwFlags", wintypes.DWORD),
    ]


class ProcessTreeJob:
    """A kill-on-close Job Object assigned before the process can run."""

    def __init__(self):
        if os.name != "nt":
            raise OSError("Windows Job Objects are only available on Windows")

        self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._configure_api()
        handle = self._kernel32.CreateJobObjectW(None, None)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        self._handle = handle
        try:
            limits = _ExtendedLimitInformation()
            limits.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not self._kernel32.SetInformationJobObject(
                    self._handle,
                    _JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                    ctypes.byref(limits),
                    ctypes.sizeof(limits)):
                raise ctypes.WinError(ctypes.get_last_error())
        except BaseException:
            self.close()
            raise

    def _configure_api(self):
        kernel32 = self._kernel32
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = [
            wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
        ]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        kernel32.TerminateJobObject.restype = wintypes.BOOL
        kernel32.QueryInformationJobObject.argtypes = [
            wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
        ]
        kernel32.QueryInformationJobObject.restype = wintypes.BOOL
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.IsProcessInJob.argtypes = [
            wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL),
        ]
        kernel32.IsProcessInJob.restype = wintypes.BOOL
        kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        kernel32.Thread32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ThreadEntry32)]
        kernel32.Thread32First.restype = wintypes.BOOL
        kernel32.Thread32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ThreadEntry32)]
        kernel32.Thread32Next.restype = wintypes.BOOL
        kernel32.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenThread.restype = wintypes.HANDLE
        kernel32.GetProcessIdOfThread.argtypes = [wintypes.HANDLE]
        kernel32.GetProcessIdOfThread.restype = wintypes.DWORD
        kernel32.ResumeThread.argtypes = [wintypes.HANDLE]
        kernel32.ResumeThread.restype = wintypes.DWORD
        kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel32.WaitForSingleObject.restype = wintypes.DWORD
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL

    @property
    def _live_handle(self):
        handle = getattr(self, "_handle", None)
        if handle is None or not handle:
            raise RuntimeError("MCP process Job Object is already closed")
        return handle

    def assign_and_resume(self, proc: subprocess.Popen) -> None:
        """Bind the suspended Popen process, then resume its unique first thread."""
        process_handle = getattr(proc, "_handle", None)
        if process_handle is None:
            raise RuntimeError("Popen did not expose a process handle")
        try:
            process_handle = int(process_handle)
        except (TypeError, ValueError, OverflowError) as exc:
            raise RuntimeError("Popen process handle is unavailable") from exc

        if not self._kernel32.AssignProcessToJobObject(
                self._live_handle, wintypes.HANDLE(process_handle)):
            raise ctypes.WinError(ctypes.get_last_error())

        self._resume_primary_thread(proc.pid)

    def _resume_primary_thread(self, process_id: int) -> None:
        if process_id <= 0:
            raise RuntimeError("Popen returned an invalid process id")

        snapshot = self._kernel32.CreateToolhelp32Snapshot(_TH32CS_SNAPTHREAD, 0)
        if not snapshot or snapshot == _INVALID_HANDLE_VALUE:
            raise ctypes.WinError(ctypes.get_last_error())
        thread_handle = None
        try:
            entry = _ThreadEntry32()
            entry.dwSize = ctypes.sizeof(entry)
            matches = []
            ctypes.set_last_error(0)
            found = self._kernel32.Thread32First(snapshot, ctypes.byref(entry))
            if not found:
                error = ctypes.get_last_error()
                if error != _ERROR_NO_MORE_FILES:
                    raise ctypes.WinError(error or _ERROR_GEN_FAILURE)
            while found:
                if entry.th32OwnerProcessID == process_id:
                    matches.append(int(entry.th32ThreadID))
                entry.dwSize = ctypes.sizeof(entry)
                ctypes.set_last_error(0)
                found = self._kernel32.Thread32Next(snapshot, ctypes.byref(entry))
                if not found:
                    error = ctypes.get_last_error()
                    if error != _ERROR_NO_MORE_FILES:
                        raise ctypes.WinError(error or _ERROR_GEN_FAILURE)

            if len(matches) != 1:
                raise RuntimeError(
                    "expected one suspended MCP process thread, found %d" % len(matches)
                )

            thread_handle = self._kernel32.OpenThread(
                _THREAD_SUSPEND_RESUME | _THREAD_QUERY_LIMITED_INFORMATION,
                False,
                matches[0],
            )
            if not thread_handle:
                raise ctypes.WinError(ctypes.get_last_error())
            owner = self._kernel32.GetProcessIdOfThread(thread_handle)
            if owner == 0:
                raise ctypes.WinError(ctypes.get_last_error())
            if owner != process_id:
                raise RuntimeError("MCP primary thread owner changed during launch")

            previous_suspend_count = self._kernel32.ResumeThread(thread_handle)
            if previous_suspend_count == _RESUME_FAILED:
                raise ctypes.WinError(ctypes.get_last_error())
            if previous_suspend_count != 1:
                raise RuntimeError(
                    "expected one initial thread suspension, found %d"
                    % previous_suspend_count
                )
        finally:
            if thread_handle:
                self._kernel32.CloseHandle(thread_handle)
            self._kernel32.CloseHandle(snapshot)

    def _job_process_handles(self) -> list:
        """Open stable handles for every process currently associated with the job."""
        capacity = 16
        while capacity <= 1 << 20:
            size = ctypes.sizeof(_BasicProcessIdListHeader) + (
                capacity * ctypes.sizeof(ctypes.c_size_t)
            )
            buffer = (ctypes.c_ubyte * size)()
            returned = wintypes.DWORD()
            if not self._kernel32.QueryInformationJobObject(
                    self._live_handle,
                    _JOB_OBJECT_BASIC_PROCESS_ID_LIST,
                    ctypes.byref(buffer),
                    size,
                    ctypes.byref(returned)):
                error = ctypes.get_last_error()
                if error in (_ERROR_INSUFFICIENT_BUFFER, _ERROR_MORE_DATA):
                    capacity *= 2
                    continue
                raise ctypes.WinError(error)

            header = ctypes.cast(
                ctypes.byref(buffer), ctypes.POINTER(_BasicProcessIdListHeader)
            ).contents
            assigned = int(header.NumberOfAssignedProcesses)
            count = int(header.NumberOfProcessIdsInList)
            if count < assigned:
                capacity = max(capacity * 2, assigned)
                continue

            process_ids = ctypes.cast(
                ctypes.byref(buffer, ctypes.sizeof(_BasicProcessIdListHeader)),
                ctypes.POINTER(ctypes.c_size_t * count),
            ).contents
            handles = []
            try:
                for process_id in process_ids:
                    handle = self._kernel32.OpenProcess(
                        _SYNCHRONIZE | _PROCESS_QUERY_LIMITED_INFORMATION,
                        False,
                        int(process_id),
                    )
                    if not handle:
                        error = ctypes.get_last_error()
                        if error == _ERROR_INVALID_PARAMETER:
                            # It exited between the job snapshot and OpenProcess.
                            continue
                        raise ctypes.WinError(error)
                    in_job = wintypes.BOOL()
                    if not self._kernel32.IsProcessInJob(
                            handle, self._live_handle, ctypes.byref(in_job)):
                        error = ctypes.get_last_error()
                        self._kernel32.CloseHandle(handle)
                        raise ctypes.WinError(error)
                    if not in_job.value:
                        self._kernel32.CloseHandle(handle)
                        continue
                    handles.append((int(process_id), handle))
                return handles
            except BaseException:
                for _, handle in handles:
                    self._kernel32.CloseHandle(handle)
                raise
        raise RuntimeError("MCP Job Object process list exceeded its safety bound")

    def _active_processes(self) -> int:
        info = _BasicAccountingInformation()
        returned = wintypes.DWORD()
        if not self._kernel32.QueryInformationJobObject(
                self._live_handle,
                _JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
                ctypes.byref(info),
                ctypes.sizeof(info),
                ctypes.byref(returned)):
            raise ctypes.WinError(ctypes.get_last_error())
        return int(info.ActiveProcesses)

    def _wait_for_job_members(self, process_handles, deadline: float) -> bool:
        """Wait for anchored processes and for the job's live member count to drain."""
        known_pids = {pid for pid, _ in process_handles}
        while True:
            # Termination can race with a final child creation. Re-enumerate
            # after TerminateJobObject and add handles for any residual member.
            for pid, handle in self._job_process_handles():
                if pid in known_pids:
                    self._kernel32.CloseHandle(handle)
                else:
                    process_handles.append((pid, handle))
                    known_pids.add(pid)

            all_signaled = True
            for _, handle in process_handles:
                state = self._kernel32.WaitForSingleObject(handle, 0)
                if state == _WAIT_TIMEOUT:
                    all_signaled = False
                elif state != _WAIT_OBJECT_0:
                    raise ctypes.WinError(ctypes.get_last_error())

            if all_signaled and self._active_processes() == 0:
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.01)

    def _wait_for_open_processes(self, process_handles, deadline: float) -> bool:
        """After closing the kill-on-close job, finish waiting on anchored handles."""
        for _, handle in process_handles:
            remaining = max(0, int((deadline - time.monotonic()) * 1000))
            state = self._kernel32.WaitForSingleObject(handle, remaining)
            if state == _WAIT_TIMEOUT:
                return False
            if state != _WAIT_OBJECT_0:
                raise ctypes.WinError(ctypes.get_last_error())
        return True

    def terminate_and_close(self) -> None:
        """Terminate the whole job, wait for each member, then close its handle."""
        handle = getattr(self, "_handle", None)
        if handle is None or not handle:
            return

        process_handles = []
        failure = None
        try:
            process_handles = self._job_process_handles()
            if not self._kernel32.TerminateJobObject(handle, 1):
                raise ctypes.WinError(ctypes.get_last_error())

            deadline = time.monotonic() + _JOB_EXIT_WAIT_SECONDS
            if not self._wait_for_job_members(process_handles, deadline):
                raise TimeoutError("MCP Job Object processes did not exit")
        except Exception as exc:
            failure = exc
        finally:
            # KILL_ON_JOB_CLOSE is the last-resort termination path. If the
            # first wait failed, keep known process handles open and verify
            # their exit after releasing the Job Object.
            self.close()
            if failure is not None:
                try:
                    self._wait_for_open_processes(
                        process_handles,
                        time.monotonic() + _JOB_EXIT_WAIT_SECONDS,
                    )
                except Exception:
                    pass
            for process_handle in process_handles:
                self._kernel32.CloseHandle(process_handle[1])
        if failure is not None:
            raise failure

    def close(self) -> None:
        """Close the Job Object handle once; kill-on-close covers every member."""
        handle = getattr(self, "_handle", None)
        if handle is None or not handle:
            return
        self._handle = None
        self._kernel32.CloseHandle(handle)


def windows_creationflags() -> int:
    """Return the flags required to attach a Windows process before it runs."""
    return (getattr(subprocess, "CREATE_NO_WINDOW", 0)
            | getattr(subprocess, "CREATE_SUSPENDED", 0x00000004))
