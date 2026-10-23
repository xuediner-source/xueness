/** Handle-based Windows primitives. No helper process or pathname reopen. */
import koffi from "koffi";
import { PyValueError } from "@xueness/contracts";
import { PyOSError } from "./errors.ts";

let cached: ReturnType<typeof load> | undefined;
function load() {
  const kernel = koffi.load("kernel32.dll");
  const nt = koffi.load("ntdll.dll");
  const advapi = koffi.load("advapi32.dll");
  // Node exports libuv's descriptor conversion. A different CRT's descriptor
  // table is not Node's table and _get_osfhandle there can fail-fast the process.
  const node = koffi.load(null);
  const unicode = koffi.struct({ Length: "uint16", MaximumLength: "uint16", Buffer: "str16" });
  const attributes = koffi.struct({ Length: "uint32", RootDirectory: "uintptr_t", ObjectName: koffi.pointer(unicode), Attributes: "uint32", SecurityDescriptor: "void *", SecurityQualityOfService: "void *" });
  const io = koffi.struct({ Pointer: "void *", Information: "uintptr_t" });
  const overlap = koffi.struct({ Internal: "uintptr_t", InternalHigh: "uintptr_t", Offset: "uint32", OffsetHigh: "uint32", hEvent: "uintptr_t" });
  return {
    attributes,
    create: kernel.func("__stdcall", "CreateFileW", "uintptr_t", ["str16", "uint32", "uint32", "void *", "uint32", "uint32", "uintptr_t"]),
    info: kernel.func("int __stdcall GetFileInformationByHandleEx(uintptr_t, int, _Out_ void *, uint32)"),
    close: kernel.func("int __stdcall CloseHandle(uintptr_t)"),
    reopen: kernel.func("uintptr_t __stdcall ReOpenFile(uintptr_t, uint32, uint32, uint32)"),
    error: kernel.func("uint32 __stdcall GetLastError()"),
    localFree: kernel.func("void * __stdcall LocalFree(void *)"),
    createRelative: nt.func("__stdcall", "NtCreateFile", "uint32", [koffi.out(koffi.pointer("uintptr_t")), "uint32", koffi.pointer(attributes), koffi.out(koffi.pointer(io)), "void *", "uint32", "uint32", "uint32", "uint32", "void *", "uint32"]),
    dosError: nt.func("uint32 __stdcall RtlNtStatusToDosError(uint32)"),
    lock: kernel.func("__stdcall", "LockFileEx", "int", ["uintptr_t", "uint32", "uint32", "uint32", "uint32", koffi.pointer(overlap)]),
    osHandle: node.func("intptr_t uv_get_osfhandle(int)"),
    getSecurity: advapi.func("uint32 __stdcall GetSecurityInfo(uintptr_t, int, uint32, _Out_ void **, _Out_ void **, _Out_ void **, _Out_ void **, _Out_ void **)"),
    sidText: advapi.func("int __stdcall ConvertSidToStringSidW(void *, _Out_ void **)"),
    fromSddl: advapi.func("int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16, uint32, _Out_ void **, _Out_ uint32 *)"),
    getDacl: advapi.func("int __stdcall GetSecurityDescriptorDacl(void *, _Out_ int *, _Out_ void **, _Out_ int *)"),
    setSecurity: advapi.func("uint32 __stdcall SetSecurityInfo(uintptr_t, int, uint32, void *, void *, void *, void *)"),
    control: advapi.func("int __stdcall GetSecurityDescriptorControl(void *, _Out_ uint16 *, _Out_ uint32 *)"),
  };
}
const api = () => cached ??= load();
type Handle = number | bigint;
const invalid = (h: Handle) => BigInt(h) === -1n || BigInt(h) === 0xffffffffffffffffn || BigInt(h) === 0xffffffffn || !h;
function failure(message: string, code = api().error() as number): never {
  const error = new PyOSError(`${message} (Windows error ${code})`);
  Object.assign(error, { winerror: code, code: code === 5 ? "EACCES" : "EIO" });
  throw error;
}
function attributes(handle: Handle): number {
  const buffer = Buffer.alloc(8);
  if (!api().info(handle, 9, buffer, buffer.length)) failure("session lock handle attributes could not be read");
  return buffer.readUInt32LE(0);
}

/** NtCreateFile anchors the child in an already-open directory, as Python does. */
export function openWindowsLock(directory: string, name: string): { tryLock(): boolean; close(): void } {
  const a = api();
  const parent: Handle = a.create(directory, 0x001000a3, 7, null, 3, 0x02200000, 0);
  if (invalid(parent)) failure("session lock directory could not be opened");
  let file: Handle = 0;
  try {
    const tag = attributes(parent);
    if ((tag & 0x400) || !(tag & 0x10)) throw new PyValueError("invalid lock directory");
    const output: Handle[] = [0];
    const status: number = a.createRelative(output, 0xc0100000, {
      Length: koffi.sizeof(a.attributes), RootDirectory: parent,
      ObjectName: { Length: name.length * 2, MaximumLength: name.length * 2 + 2, Buffer: name },
      Attributes: 0x40, SecurityDescriptor: null, SecurityQualityOfService: null,
    }, {}, null, 0x80, 7, 3, 0x200060, null, 0);
    if (status >= 0x80000000) failure("session lock file could not be opened relative to its directory", a.dosError(status));
    file = output[0]!;
    if (invalid(file)) failure("invalid session lock handle");
    if (attributes(file) & (0x400 | 0x10)) throw new PyValueError("invalid session lock");
  } catch (error) {
    if (file && !invalid(file)) a.close(file);
    throw error;
  } finally {
    a.close(parent);
  }
  let closed = false;
  return {
    tryLock() {
      if (closed) throw new PyOSError("session lock is closed");
      if (a.lock(file, 3, 0, 1, 0, { Internal: 0, InternalHigh: 0, Offset: 0, OffsetHigh: 0, hEvent: 0 })) return true;
      const code: number = a.error();
      if (code === 33 || code === 158) return false;
      failure("session lock failed", code);
    },
    close() { if (!closed) { closed = true; a.close(file); } },
  };
}

/** Protect the open descriptor before the caller writes any private bytes. */
export function protectWindowsFile(fd: number): void {
  const a = api();
  const handle: Handle = a.osHandle(fd);
  if (invalid(handle)) failure("private file has an invalid handle");
  const security: Handle = a.reopen(handle, 0x00060000, 7, 0);
  if (invalid(security)) failure("ReOpenFile failed");
  try { protectWindowsHandle(security, false); }
  finally { a.close(security); }
}

/** Protect a newly created sidecar directory, refusing a reparse-point handle. */
export function protectWindowsDirectory(path: string): void {
  const a = api();
  const handle: Handle = a.create(path, 0x00060080, 7, null, 3, 0x02200000, 0);
  if (invalid(handle)) failure("private directory could not be opened");
  try {
    const tag = attributes(handle);
    if ((tag & 0x400) || !(tag & 0x10)) throw new PyValueError("invalid private directory");
    protectWindowsHandle(handle, true);
  } finally { a.close(handle); }
}

export function protectWindowsHandle(handle: Handle, directory: boolean): void {
  const a = api();
  const owner: (bigint | null)[] = [null], original: (bigint | null)[] = [null], descriptor: (bigint | null)[] = [null];
  try {
    let code: number = a.getSecurity(handle, 1, 1, owner, null, null, null, original);
    if (code) failure("GetSecurityInfo could not read object owner", code);
    if (!owner[0]) failure("GetSecurityInfo returned no owner SID");
    const text: (bigint | null)[] = [null];
    if (!a.sidText(owner[0], text)) failure("ConvertSidToStringSidW failed");
    let sddl: string;
    try {
      const sid: string = koffi.decode.string16(text[0]);
      const inherit = directory ? "OICI" : "";
      sddl = `D:P(A;${inherit};FA;;;${sid})(A;${inherit};FA;;;SY)(A;${inherit};FA;;;BA)`;
    } finally { if (text[0]) a.localFree(text[0]); }
    if (!a.fromSddl(sddl, 1, descriptor, null)) failure("ConvertStringSecurityDescriptorToSecurityDescriptorW failed");
    const present = [0], defaulted = [0], dacl: (bigint | null)[] = [null];
    if (!a.getDacl(descriptor[0], present, dacl, defaulted) || !present[0] || !dacl[0]) failure("private object descriptor has no explicit DACL");
    code = a.setSecurity(handle, 1, 0x80000004, null, null, dacl[0], null);
    if (code) failure("SetSecurityInfo could not protect private object", code);
    const verified: (bigint | null)[] = [null], actualDacl: (bigint | null)[] = [null];
    code = a.getSecurity(handle, 1, 4, null, null, actualDacl, null, verified);
    if (code) failure("GetSecurityInfo could not verify private DACL", code);
    try {
      const flags = [0], revision = [0];
      if (!actualDacl[0] || !a.control(verified[0], flags, revision) || !(flags[0]! & 0x1000)) failure("private DACL is not protected from inheritance");
    } finally { if (verified[0]) a.localFree(verified[0]); }
  } finally {
    if (descriptor[0]) a.localFree(descriptor[0]);
    if (original[0]) a.localFree(original[0]);
  }
}
