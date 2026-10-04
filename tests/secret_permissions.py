"""Platform-aware assertions for files and directories that hold secrets."""
import ctypes
import os
import stat
from ctypes import wintypes


def assert_secret_file_private(test_case, path, *, require_protected=True):
    """Assert POSIX mode 0600 or a Windows DACL limited to trusted owners.

    ``require_protected=False`` is for ordinary Windows files whose private
    DACL is inherited from an already-protected parent directory.
    """
    if os.name != "nt":
        test_case.assertEqual(0o600, stat.S_IMODE(os.stat(path).st_mode))
        return
    _assert_secret_windows_acl(
        test_case, path, directory=False, require_protected=require_protected)


def assert_secret_directory_private(test_case, path, *, require_protected=True):
    """Assert POSIX mode 0700 or an inheritable protected Windows DACL."""
    if os.name != "nt":
        if require_protected:
            test_case.assertEqual(0o700, stat.S_IMODE(os.stat(path).st_mode))
        return
    _assert_secret_windows_acl(
        test_case, path, directory=True, require_protected=require_protected)


def _assert_secret_windows_acl(test_case, path, *, directory, require_protected):
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    get_security = advapi32.GetNamedSecurityInfoW
    get_security.argtypes = [
        wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD,
        ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p),
    ]
    get_security.restype = wintypes.DWORD
    get_ace = advapi32.GetAce
    get_ace.argtypes = [ctypes.c_void_p, wintypes.DWORD,
                        ctypes.POINTER(ctypes.c_void_p)]
    get_ace.restype = wintypes.BOOL
    sid_to_string = advapi32.ConvertSidToStringSidW
    sid_to_string.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
    sid_to_string.restype = wintypes.BOOL
    get_descriptor_control = advapi32.GetSecurityDescriptorControl
    get_descriptor_control.argtypes = [ctypes.c_void_p,
                                       ctypes.POINTER(wintypes.WORD),
                                       ctypes.POINTER(wintypes.DWORD)]
    get_descriptor_control.restype = wintypes.BOOL
    local_free = kernel32.LocalFree
    local_free.argtypes = [ctypes.c_void_p]
    local_free.restype = ctypes.c_void_p

    class ACL(ctypes.Structure):
        _fields_ = [("revision", ctypes.c_ubyte), ("sbz1", ctypes.c_ubyte),
                    ("size", ctypes.c_ushort), ("ace_count", ctypes.c_ushort),
                    ("sbz2", ctypes.c_ushort)]

    class ACE_HEADER(ctypes.Structure):
        _fields_ = [("ace_type", ctypes.c_ubyte), ("ace_flags", ctypes.c_ubyte),
                    ("ace_size", ctypes.c_ushort)]

    owner, dacl, descriptor = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
    # SE_FILE_OBJECT; only read the owner and DACL. This inspection does not
    # change any security settings.
    result = get_security(str(path), 1, 0x1 | 0x4, ctypes.byref(owner), None,
                          ctypes.byref(dacl), None, ctypes.byref(descriptor))
    if result:
        raise OSError(result, f"GetNamedSecurityInfoW failed with Win32 error {result}")
    try:
        test_case.assertTrue(owner.value, "secret object has no ACL owner")
        test_case.assertTrue(dacl.value, "secret object has a null or missing DACL")
        owner_string = _sid_text(sid_to_string, local_free, owner)
        control = wintypes.WORD()
        revision = wintypes.DWORD()
        if not get_descriptor_control(descriptor, ctypes.byref(control),
                                      ctypes.byref(revision)):
            raise ctypes.WinError(ctypes.get_last_error())
        if require_protected:
            test_case.assertTrue(control.value & 0x1000,
                                 "secret object DACL inherits parent entries")

        acl = ctypes.cast(dacl, ctypes.POINTER(ACL)).contents
        trusted_sids = {owner_string, "S-1-5-18", "S-1-5-32-544"}
        generic_all = 0x10000000
        file_all_access = 0x001F01FF
        allowed_ace_types = {0, 5, 9, 11}
        allowed_sids = set()
        for index in range(acl.ace_count):
            ace = ctypes.c_void_p()
            test_case.assertTrue(get_ace(dacl, index, ctypes.byref(ace)),
                                 f"could not inspect secret ACL entry {index}")
            header = ctypes.cast(ace, ctypes.POINTER(ACE_HEADER)).contents
            test_case.assertIn(
                header.ace_type, allowed_ace_types,
                f"secret object has unexpected ACE type {header.ace_type}",
            )
            if directory:
                test_case.assertEqual(
                    header.ace_flags & 0x03, 0x03,
                    "directory ACE must inherit to files and child directories",
                )
            mask = ctypes.c_uint32.from_address(ace.value + 4).value
            sid_offset = 8
            if header.ace_type in {5, 11}:
                object_flags = ctypes.c_uint32.from_address(ace.value + 8).value
                sid_offset = 12 + (16 if object_flags & 0x1 else 0) + (16 if object_flags & 0x2 else 0)
            sid = ctypes.c_void_p(ace.value + sid_offset)
            sid_text = _sid_text(sid_to_string, local_free, sid)
            test_case.assertIn(
                sid_text, trusted_sids,
                f"secret object grants access to unexpected SID {sid_text}",
            )
            allowed_sids.add(sid_text)
            test_case.assertTrue(
                mask & generic_all or mask & file_all_access == file_all_access,
                f"secret object grants less than full control to trusted SID {sid_text}",
            )
        test_case.assertEqual(
            trusted_sids, allowed_sids,
            "secret object must grant full control to owner, SYSTEM, and Administrators",
        )
    finally:
        local_free(descriptor)


def _sid_text(sid_to_string, local_free, sid):
    value = wintypes.LPWSTR()
    if not sid_to_string(sid, ctypes.byref(value)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return value.value
    finally:
        local_free(ctypes.cast(value, ctypes.c_void_p))
