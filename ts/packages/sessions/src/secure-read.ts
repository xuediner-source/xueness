/** Shared handle-anchored bounded regular-file reads beneath one directory. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join, normalize } from "node:path";
import koffi from "koffi";

function windowsRead(root: string, parts: string[], maximum: number, singleLink: boolean): { raw: Buffer; size: number } | null {
  for (const part of parts) if (part.includes(":") || /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)) return null;
  const kernel = koffi.load("kernel32.dll");
  const create = kernel.func("uintptr_t __stdcall CreateFileW(str16, uint32, uint32, void *, uint32, uint32, uintptr_t)");
  const finalPath = kernel.func("uint32 __stdcall GetFinalPathNameByHandleW(uintptr_t, void *, uint32, uint32)");
  const info = kernel.func("int __stdcall GetFileInformationByHandleEx(uintptr_t, int, void *, uint32)");
  const size = kernel.func("int __stdcall GetFileSizeEx(uintptr_t, _Out_ int64 *)");
  const read = kernel.func("int __stdcall ReadFile(uintptr_t, void *, uint32, _Out_ uint32 *, void *)");
  const close = kernel.func("int __stdcall CloseHandle(uintptr_t)");
  let handle: number | bigint | null = null;
  try {
    for (let index = 0; index <= parts.length; index += 1) if (lstatSync(join(root, ...parts.slice(0, index))).isSymbolicLink()) return null;
    const candidate = join(root, ...parts);
    handle = create(candidate, 0x80000000, 7, null, 3, 0x02200000, 0);
    if (!handle || [-1n, 0xffffffffffffffffn, 0xffffffffn].includes(BigInt(handle))) { handle = null; return null; }
    const attributes = Buffer.alloc(8);
    if (!info(handle, 9, attributes, attributes.length) || attributes.readUInt32LE(0) & (0x400 | 0x10)) return null;
    if (singleLink) { const standard = Buffer.alloc(24); if (!info(handle, 1, standard, standard.length) || standard.readUInt32LE(16) !== 1) return null; }
    const pathBuffer = Buffer.alloc(32768 * 2);
    const length: number = finalPath(handle, pathBuffer, 32768, 0);
    if (!length || length >= 32768) return null;
    let actual = pathBuffer.toString("utf16le", 0, length * 2);
    if (actual.startsWith("\\\\?\\UNC\\")) actual = "\\\\" + actual.slice(8);
    else if (actual.startsWith("\\\\?\\")) actual = actual.slice(4);
    if (normalize(actual).toLowerCase() !== normalize(candidate).toLowerCase()) return null;
    const fileSize: (number | bigint)[] = [0];
    if (!size(handle, fileSize)) return null;
    const raw = Buffer.alloc(maximum); let offset = 0;
    while (offset < maximum) {
      const count = [0]; if (!read(handle, raw.subarray(offset), maximum - offset, count, null)) return null;
      if (!count[0]) break; offset += count[0];
    }
    return { raw: raw.subarray(0, offset), size: Number(fileSize[0]) };
  } catch { return null; }
  finally { if (handle !== null) close(handle); }
}

function posixRead(root: string, parts: string[], maximum: number, singleLink: boolean): { raw: Buffer; size: number } | null {
  if (!["linux", "darwin"].includes(process.platform)) return null;
  if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY) return null;
  const closeOnExec = process.platform === "darwin" ? 0x1000000 : 0x80000;
  const library = koffi.load(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : null);
  const openAt = library.func("int openat(int, str, int, ...)");
  const descriptors: number[] = [];
  try {
    let parent = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); descriptors.push(parent);
    for (const part of parts.slice(0, -1)) {
      parent = openAt(parent, part, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | closeOnExec);
      if (parent < 0) return null; descriptors.push(parent);
    }
    const fd: number = openAt(parent, parts.at(-1), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExec);
    if (fd < 0) return null; descriptors.push(fd);
    const stat = fstatSync(fd); if (!stat.isFile() || singleLink && stat.nlink !== 1) return null;
    const raw = Buffer.alloc(maximum); let offset = 0;
    while (offset < maximum) { const count = readSync(fd, raw, offset, maximum - offset, null); if (!count) break; offset += count; }
    return { raw: raw.subarray(0, offset), size: stat.size };
  } catch { return null; }
  finally { for (const fd of descriptors.reverse()) closeSync(fd); }
}

export function readRegularBeneath(root: string, relative: string, maximum: number, singleLink = false): { raw: Buffer; size: number } | null {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 64 * 1024 * 1024) throw new RangeError("invalid bounded file read");
  const parts = relative.split("/");
  if (!parts.length || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) return null;
  return process.platform === "win32" ? windowsRead(root, parts, maximum, singleLink) : posixRead(root, parts, maximum, singleLink);
}
