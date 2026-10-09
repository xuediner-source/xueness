"""Open workspace guidance on Windows without following reparse points.

Check the actual opened handle path, not a pre-open resolve, so a junction
swap between inspection and CreateFile cannot redirect a read outside root.
"""
import ctypes
from ctypes import wintypes
import os
from pathlib import Path, PurePosixPath
import stat

_RESERVED_BASENAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL", *(f"COM{n}" for n in range(1, 10)), *(f"LPT{n}" for n in range(1, 10))}
)


def windows_relative_alias(relative: str):
    """Return the component Win32 would alias, or None when the relative path is exact.

    Trailing dots and spaces, reserved device names (even with an extension), and
    alternate-data-stream colons refer to a different file than the path spells.
    ``.`` and ``..`` stay with the workspace jail. Other hosts return None: a
    trailing dot is a legal name there.
    """
    if os.name != "nt" or not isinstance(relative, str):
        return None
    for part in relative.replace("\\", "/").split("/"):
        if part in ("", ".", ".."):
            continue
        if ":" in part or part.endswith(" ") or part.endswith("."):
            return part
        if part.split(".", 1)[0].upper() in _RESERVED_BASENAMES:
            return part
    return None


def open_regular_file(root: Path, relative: str):
    if windows_relative_alias(relative):
        return None
    import msvcrt
    parts = PurePosixPath(relative).parts
    if not parts or any(part in ('', '.', '..') or ':' in part or '\\' in part for part in parts):
        return None
    candidate = root.joinpath(*parts)
    handle = None
    fd = None
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                       ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    create.restype = wintypes.HANDLE
    final_path = kernel.GetFinalPathNameByHandleW
    final_path.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
    final_path.restype = wintypes.DWORD
    close = kernel.CloseHandle
    close.argtypes = [wintypes.HANDLE]
    close.restype = wintypes.BOOL
    try:
        for path in [root, *[root.joinpath(*parts[:n]) for n in range(1, len(parts)+1)]]:
            if path.lstat().st_file_attributes & 0x400:  # FILE_ATTRIBUTE_REPARSE_POINT
                return None
        handle = create(str(candidate), 0x80000000, 7, None, 3, 0x02200000, None)
        if handle == ctypes.c_void_p(-1).value:
            handle = None
            return None
        buffer = ctypes.create_unicode_buffer(32768)
        length = final_path(handle, buffer, len(buffer), 0)
        if not length or length >= len(buffer):
            return None
        actual = buffer.value
        if actual.startswith('\\\\?\\UNC\\'):
            actual = '\\\\'+actual[8:]
        elif actual.startswith('\\\\?\\'):
            actual = actual[4:]
        if os.path.normcase(os.path.normpath(actual)) != os.path.normcase(str(candidate)):
            return None
        fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        handle = None  # Descriptor now owns the native handle.
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            return None
        result = fd, info
        fd = None
        return result
    except (OSError, ValueError):
        return None
    finally:
        if fd is not None:
            os.close(fd)
        if handle is not None:
            close(handle)
