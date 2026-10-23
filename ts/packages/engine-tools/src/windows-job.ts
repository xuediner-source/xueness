/**
 * One Windows job object per host process for the exec tool's children.
 *
 * `taskkill /T /F` walks the tree at kill time, so it misses a grandchild that
 * was reparented and never runs at all when the host dies without reaching its
 * exit hook (crash, `TerminateProcess`, power loss). A job object with
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` makes the kernel end every assigned
 * process when the host's handle closes, including on an abnormal exit.
 *
 * One job holds every child of this host and is never closed explicitly: it
 * lives as long as the process, so a background grandchild that outlives its
 * parent (the `detachedBackground` case) is not killed early. Per-child
 * killing stays `killTree`'s job. Nested jobs are supported since Windows 8,
 * so a host that already runs inside a job still works.
 */
import koffi from "koffi";

const KILL_ON_JOB_CLOSE = 0x2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
/** `IsProcessInJob` needs query access, not the terminate right `assign` uses. */
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

let cached: ReturnType<typeof load> | undefined;

function load() {
  const kernel = koffi.load("kernel32.dll");
  const basic = koffi.struct("XuenessJobBasicLimits", {
    PerProcessUserTimeLimit: "int64",
    PerJobUserTimeLimit: "int64",
    LimitFlags: "uint32",
    MinimumWorkingSetSize: "uintptr_t",
    MaximumWorkingSetSize: "uintptr_t",
    ActiveProcessLimit: "uint32",
    Affinity: "uintptr_t",
    PriorityClass: "uint32",
    SchedulingClass: "uint32",
  });
  const counters = koffi.struct("XuenessJobIoCounters", {
    ReadOperationCount: "uint64",
    WriteOperationCount: "uint64",
    OtherOperationCount: "uint64",
    ReadTransferCount: "uint64",
    WriteTransferCount: "uint64",
    OtherTransferCount: "uint64",
  });
  const extended = koffi.struct("XuenessJobExtendedLimits", {
    BasicLimitInformation: basic,
    IoInfo: counters,
    ProcessMemoryLimit: "uintptr_t",
    JobMemoryLimit: "uintptr_t",
    PeakProcessMemoryUsed: "uintptr_t",
    PeakJobMemoryUsed: "uintptr_t",
  });
  return {
    extended,
    create: kernel.func("__stdcall", "CreateJobObjectW", "uintptr_t", ["void *", "void *"]),
    setInfo: kernel.func("__stdcall", "SetInformationJobObject", "int", ["uintptr_t", "int", koffi.pointer(extended), "uint32"]),
    assign: kernel.func("__stdcall", "AssignProcessToJobObject", "int", ["uintptr_t", "uintptr_t"]),
    inJob: kernel.func("__stdcall", "IsProcessInJob", "int", ["uintptr_t", "uintptr_t", koffi.out(koffi.pointer("int"))]),
    openProcess: kernel.func("__stdcall", "OpenProcess", "uintptr_t", ["uint32", "int", "uint32"]),
    close: kernel.func("__stdcall", "CloseHandle", "int", ["uintptr_t"]),
    error: kernel.func("uint32 __stdcall GetLastError()"),
  };
}

const api = (): ReturnType<typeof load> => (cached ??= load());
type Handle = number | bigint;
const invalid = (handle: Handle): boolean =>
  !handle || BigInt(handle) === 0xffffffffffffffffn || BigInt(handle) === 0xffffffffn;

export interface WindowsJob {
  /** Put a freshly spawned child (and, through it, its future descendants) in the job. */
  assign(pid: number): boolean;
  /** Whether `pid` is currently in this job; for tests and diagnostics. */
  contains(pid: number): boolean;
}

let hostJob: WindowsJob | null | undefined;

/**
 * The host-wide job, created on first use. Null on POSIX, or when the job
 * cannot be created (the exec tool then keeps relying on `killTree`).
 */
export function hostWindowsJob(): WindowsJob | null {
  if (hostJob !== undefined) return hostJob;
  hostJob = process.platform === "win32" ? createJob() : null;
  return hostJob;
}

function createJob(): WindowsJob | null {
  let a: ReturnType<typeof load>;
  try {
    a = api();
  } catch {
    // koffi is an optional capability: no job object, no crash.
    return null;
  }
  const handle: Handle = a.create(null, null);
  if (invalid(handle)) return null;
  const limits = {
    BasicLimitInformation: {
      PerProcessUserTimeLimit: 0, PerJobUserTimeLimit: 0, LimitFlags: KILL_ON_JOB_CLOSE,
      MinimumWorkingSetSize: 0, MaximumWorkingSetSize: 0, ActiveProcessLimit: 0,
      Affinity: 0, PriorityClass: 0, SchedulingClass: 0,
    },
    IoInfo: {
      ReadOperationCount: 0, WriteOperationCount: 0, OtherOperationCount: 0,
      ReadTransferCount: 0, WriteTransferCount: 0, OtherTransferCount: 0,
    },
    ProcessMemoryLimit: 0, JobMemoryLimit: 0, PeakProcessMemoryUsed: 0, PeakJobMemoryUsed: 0,
  };
  try {
    if (!a.setInfo(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, limits, koffi.sizeof(a.extended))) {
      a.close(handle);
      return null;
    }
  } catch {
    a.close(handle);
    return null;
  }
  return {
    assign(pid: number): boolean {
      if (!Number.isInteger(pid) || pid <= 0) return false;
      const processHandle: Handle = a.openProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
      // The child already exited: nothing to contain.
      if (invalid(processHandle)) return false;
      try {
        return a.assign(handle, processHandle) !== 0;
      } catch {
        return false;
      } finally {
        a.close(processHandle);
      }
    },
    contains(pid: number): boolean {
      if (!Number.isInteger(pid) || pid <= 0) return false;
      const processHandle: Handle = a.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      if (invalid(processHandle)) return false;
      try {
        const result: number[] = [0];
        if (!a.inJob(processHandle, handle, result)) return false;
        return result[0] === 1;
      } catch {
        return false;
      } finally {
        a.close(processHandle);
      }
    },
  };
}
