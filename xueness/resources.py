"""Generic resource repository (Stage 2 contract, section 2).

One CRUD implementation shared by six resource kinds
(``skills`` / ``commands`` / ``hooks`` / ``mcp`` / ``subagents`` / ``plugins``).

Storage layout::

    <state_dir>/resources/<kind>/<id>.json

Routes handled (everything else returns ``None`` so the caller can try the
next module)::

    GET    /api/resources/<kind>        -> {"items": [...], "capability": {...}}
    POST   /api/resources/<kind>        -> {"item": {...}}
    DELETE /api/resources/<kind>/<id>   -> {"ok": true, "id": "<id>"}

Standard library only. Identifiers are regex-whitelisted and every write is
jailed under ``<state_dir>/resources/<kind>`` and done atomically
(``tempfile.mkstemp`` + ``fsync`` + ``os.replace``).
Atomic JSON state files are owner-private by default: POSIX mode ``0600`` or a
protected Windows DACL granting full control only to the file owner, SYSTEM,
and local Administrators. Pass ``private=False`` only for data that is meant
to be readable outside those principals.
"""
import json
import os
import re
import stat
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

KINDS = ("skills", "commands", "hooks", "mcp", "subagents", "plugins")

ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

# Dot-only names satisfy the regex but are traversal/parent markers, not ids.
RESERVED_IDS = frozenset({".", ".."})

# Shared in-process lock for resource CRUD and SDK marketplace installation.
# Plugin manifests use the same resources/plugins/<id>.json namespace, so both
# writers must serialize to keep create-only checks and SDK installs atomic with
# respect to one another.
_LOCK = threading.RLock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _valid_id(rid) -> bool:
    """Regex whitelist plus explicit rejection of ``.``, ``..``, ``/`` and empty."""
    if not isinstance(rid, str):
        return False
    if rid == "" or rid in RESERVED_IDS:
        return False
    if ".." in rid or "/" in rid or "\\" in rid:
        return False
    return ID_PATTERN.match(rid) is not None


def _within(child: Path, parent: Path) -> bool:
    return child == parent or parent in child.parents


def _is_link(path: Path) -> bool:
    """Refuse symbolic links and Windows reparse points at storage boundaries.

    Junctions are not reported by Path.is_symlink(). Inspect the entry itself
    before resolve(), which would otherwise turn a redirected jail into its
    own apparently valid root. Uninspectable entries fail closed.
    """
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    except OSError:
        return True
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & 0x400)


def _resources_root(ctx: dict) -> Path:
    state_dir = ctx.get("state_dir")
    if state_dir is None:
        raise ValueError("state_dir missing from context")
    state = Path(state_dir)
    root = state / "resources"
    if _is_link(state) or _is_link(root):
        raise ValueError("resource root must not be a link or reparse point")
    root = root.resolve()
    return root


def _kind_dir(ctx: dict, kind: str) -> Path:
    """``<state_dir>/resources/<kind>``, jailed under the resources root.

    A symlinked kind directory is refused: ``resolve()`` would otherwise move
    the whole jail elsewhere while the containment check still passed.
    """
    root = _resources_root(ctx)
    if kind not in KINDS:
        raise ValueError("unknown kind")
    target = root / kind
    if _is_link(target):
        raise ValueError("resource kind must not be a link or reparse point")
    if not _within(target, root):
        raise ValueError("resource kind escapes the state root")
    return target


def _item_path(ctx: dict, kind: str, rid: str) -> Path:
    kind_dir = _kind_dir(ctx, kind)
    path = kind_dir / (rid + ".json")
    # ``rid`` is whitelisted (no separators, not ``.``/``..``), so the remaining
    # escape hatch is a pre-existing symlink at that name.
    if _is_link(path):
        raise ValueError("resource id must not be a symlink")
    if path.parent != kind_dir:
        raise ValueError("resource id escapes its kind directory")
    return path


def _protect_private_file(fd: int) -> None:
    """Lock a newly-created private file before writing any sensitive bytes.

    POSIX files receive owner-only read/write mode. Windows files need an ACL,
    because chmod only controls the read-only attribute there. ReOpenFile is
    used to acquire READ_CONTROL and WRITE_DAC for the already-open file
    object; this avoids reopening a path that could be replaced between the
    original create and the ACL update. The resulting DACL is protected from
    inheritance and grants full access only to the actual owner, SYSTEM, and
    local Administrators. Any API failure is fatal so callers never write a
    secret to a file with an unverified ACL.

    This helper belongs in the shared resource-storage layer because provider,
    OAuth, and network credentials all use atomic JSON replacement.
    """
    if os.name != "nt":
        mode = stat.S_IRUSR | stat.S_IWUSR
        fchmod = getattr(os, "fchmod", None)
        if fchmod is not None:
            fchmod(fd, mode)
        elif os.chmod in getattr(os, "supports_fd", set()):
            os.chmod(fd, mode)
        else:
            raise OSError("platform cannot protect a private file descriptor")
        return

    import ctypes
    import msvcrt
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    reopen_file = kernel32.ReOpenFile
    reopen_file.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                            wintypes.DWORD, wintypes.DWORD]
    reopen_file.restype = wintypes.HANDLE
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = [wintypes.HANDLE]
    close_handle.restype = wintypes.BOOL

    original_handle = wintypes.HANDLE(msvcrt.get_osfhandle(fd))
    # READ_CONTROL and WRITE_DAC: FILE_SHARE_READ | FILE_SHARE_WRITE |
    # FILE_SHARE_DELETE. The handle is tied to the open file object, not a path.
    READ_CONTROL = 0x00020000
    WRITE_DAC = 0x00040000
    FILE_SHARE_ALL = 0x00000001 | 0x00000002 | 0x00000004
    security_handle = reopen_file(original_handle, READ_CONTROL | WRITE_DAC,
                                  FILE_SHARE_ALL, 0)
    invalid_handle = ctypes.c_void_p(-1).value
    if not security_handle or security_handle == invalid_handle:
        raise ctypes.WinError(ctypes.get_last_error(), "ReOpenFile failed")

    try:
        _protect_private_windows_handle(security_handle, directory=False)
    finally:
        close_handle(security_handle)


def _protect_private_directory(path: Path) -> None:
    """Protect an existing directory and make its future children private.

    POSIX opens the directory itself without following its final path entry and
    applies mode 0700 through that descriptor. Windows opens the existing entry
    with reparse-point inspection enabled, verifies the opened object is a real
    directory, then installs a protected owner/SYSTEM/Administrators DACL whose
    inheritable ACEs protect children created later. This never creates or
    resolves the path; all failures are fatal to callers before they write data.
    """
    if os.name != "nt":
        directory_flag = getattr(os, "O_DIRECTORY", None)
        nofollow_flag = getattr(os, "O_NOFOLLOW", None)
        if directory_flag is None or nofollow_flag is None:
            raise OSError("platform cannot securely open a private directory")
        flags = os.O_RDONLY | directory_flag | nofollow_flag
        flags |= getattr(os, "O_CLOEXEC", 0)
        fd = os.open(os.fspath(path), flags)
        try:
            if not stat.S_ISDIR(os.fstat(fd).st_mode):
                raise NotADirectoryError(os.fspath(path))
            fchmod = getattr(os, "fchmod", None)
            if fchmod is None:
                raise OSError("platform cannot protect a private directory descriptor")
            fchmod(fd, stat.S_IRWXU)
        finally:
            os.close(fd)
        return

    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create_file = kernel32.CreateFileW
    create_file.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                            ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD,
                            wintypes.HANDLE]
    create_file.restype = wintypes.HANDLE
    get_file_info = kernel32.GetFileInformationByHandleEx
    get_file_info.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                              wintypes.DWORD]
    get_file_info.restype = wintypes.BOOL
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = [wintypes.HANDLE]
    close_handle.restype = wintypes.BOOL

    READ_CONTROL = 0x00020000
    WRITE_DAC = 0x00040000
    FILE_READ_ATTRIBUTES = 0x00000080
    FILE_SHARE_ALL = 0x00000001 | 0x00000002 | 0x00000004
    OPEN_EXISTING = 3
    FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
    FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
    FILE_ATTRIBUTE_DIRECTORY = 0x00000010
    FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400

    handle = create_file(
        str(path), READ_CONTROL | WRITE_DAC | FILE_READ_ATTRIBUTES,
        FILE_SHARE_ALL, None, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, None,
    )
    invalid_handle = ctypes.c_void_p(-1).value
    if not handle or handle == invalid_handle:
        raise ctypes.WinError(ctypes.get_last_error(), "CreateFileW failed")

    class FILE_ATTRIBUTE_TAG_INFO(ctypes.Structure):
        _fields_ = [("FileAttributes", wintypes.DWORD),
                    ("ReparseTag", wintypes.DWORD)]

    try:
        info = FILE_ATTRIBUTE_TAG_INFO()
        # FileAttributeTagInfo is value 9. OPEN_REPARSE_POINT ensures a link
        # entry itself is inspected rather than silently opening its target.
        if not get_file_info(handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
            raise ctypes.WinError(ctypes.get_last_error(),
                                  "GetFileInformationByHandleEx failed")
        if not info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY:
            raise NotADirectoryError(os.fspath(path))
        if info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT:
            raise OSError("private directory must not be a reparse point")
        _protect_private_windows_handle(handle, directory=True)
    finally:
        close_handle(handle)


def _protect_private_windows_handle(handle, *, directory: bool) -> None:
    """Set and verify the private protected DACL on an already-open handle."""
    import ctypes
    from ctypes import wintypes

    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    local_free = kernel32.LocalFree
    local_free.argtypes = [ctypes.c_void_p]
    local_free.restype = ctypes.c_void_p

    get_security = advapi32.GetSecurityInfo
    get_security.argtypes = [
        wintypes.HANDLE, ctypes.c_int, wintypes.DWORD,
        ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(ctypes.c_void_p),
    ]
    get_security.restype = wintypes.DWORD
    convert_sddl = advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW
    convert_sddl.argtypes = [wintypes.LPCWSTR, wintypes.DWORD,
                             ctypes.POINTER(ctypes.c_void_p),
                             ctypes.POINTER(wintypes.DWORD)]
    convert_sddl.restype = wintypes.BOOL
    get_dacl = advapi32.GetSecurityDescriptorDacl
    get_dacl.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.BOOL),
                         ctypes.POINTER(ctypes.c_void_p),
                         ctypes.POINTER(wintypes.BOOL)]
    get_dacl.restype = wintypes.BOOL
    sid_to_string = advapi32.ConvertSidToStringSidW
    sid_to_string.argtypes = [ctypes.c_void_p,
                              ctypes.POINTER(wintypes.LPWSTR)]
    sid_to_string.restype = wintypes.BOOL
    get_descriptor_control = advapi32.GetSecurityDescriptorControl
    get_descriptor_control.argtypes = [ctypes.c_void_p,
                                       ctypes.POINTER(wintypes.WORD),
                                       ctypes.POINTER(wintypes.DWORD)]
    get_descriptor_control.restype = wintypes.BOOL
    set_security = advapi32.SetSecurityInfo
    set_security.argtypes = [
        wintypes.HANDLE, ctypes.c_int, wintypes.DWORD,
        ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
    ]
    set_security.restype = wintypes.DWORD

    descriptor = ctypes.c_void_p()
    owner_descriptor = ctypes.c_void_p()
    owner = ctypes.c_void_p()
    try:
        # OWNER_SECURITY_INFORMATION. GetSecurityInfo returns a descriptor
        # whose storage is released with LocalFree.
        error = get_security(handle, 1, 0x00000001, ctypes.byref(owner), None,
                             None, None, ctypes.byref(owner_descriptor))
        if error:
            raise OSError(error, "GetSecurityInfo could not read object owner")
        if not owner.value:
            raise OSError("GetSecurityInfo returned no owner SID")

        owner_text = wintypes.LPWSTR()
        if not sid_to_string(owner, ctypes.byref(owner_text)):
            raise ctypes.WinError(ctypes.get_last_error(),
                                  "ConvertSidToStringSidW failed")
        try:
            # D:P blocks inherited parent ACEs. OICI lets all three trusted
            # principals govern files and directories created under this
            # directory. The actual object owner is read from the handle.
            inherit = "OICI" if directory else ""
            sddl = (f"D:P(A;{inherit};FA;;;{owner_text.value})"
                    f"(A;{inherit};FA;;;SY)(A;{inherit};FA;;;BA)")
        finally:
            local_free(ctypes.cast(owner_text, ctypes.c_void_p))

        if not convert_sddl(sddl, 1, ctypes.byref(descriptor), None):
            raise ctypes.WinError(ctypes.get_last_error(),
                                  "ConvertStringSecurityDescriptorToSecurityDescriptorW failed")
        dacl_present = wintypes.BOOL()
        dacl_defaulted = wintypes.BOOL()
        dacl = ctypes.c_void_p()
        if not get_dacl(descriptor, ctypes.byref(dacl_present),
                        ctypes.byref(dacl), ctypes.byref(dacl_defaulted)):
            raise ctypes.WinError(ctypes.get_last_error(),
                                  "GetSecurityDescriptorDacl failed")
        if not dacl_present.value or not dacl.value:
            raise OSError("private object descriptor has no explicit DACL")

        # DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION.
        # SetSecurityInfo also propagates these inheritable ACEs to existing
        # unprotected children, and new children inherit them by default.
        error = set_security(handle, 1, 0x00000004 | 0x80000000,
                             None, None, dacl, None)
        if error:
            raise OSError(error, "SetSecurityInfo could not protect private object")

        # Read the actual object descriptor back before any caller can write.
        verified = ctypes.c_void_p()
        verified_dacl = ctypes.c_void_p()
        error = get_security(handle, 1, 0x00000004,
                             None, None, ctypes.byref(verified_dacl), None,
                             ctypes.byref(verified))
        if error:
            raise OSError(error, "GetSecurityInfo could not verify private DACL")
        try:
            if not verified_dacl.value:
                raise OSError("private file DACL verification returned no ACL")
            control = wintypes.WORD()
            revision = wintypes.DWORD()
            if not get_descriptor_control(verified, ctypes.byref(control),
                                         ctypes.byref(revision)):
                raise ctypes.WinError(ctypes.get_last_error(),
                                      "GetSecurityDescriptorControl failed")
            if not control.value & 0x1000:  # SE_DACL_PROTECTED
                raise OSError("private DACL is not protected from inheritance")
        finally:
            if verified:
                local_free(verified)
    finally:
        if descriptor:
            local_free(descriptor)
        if owner_descriptor:
            local_free(owner_descriptor)


_REPLACE_SHARING_WINERRORS = frozenset({5, 32, 33})


def replace_file(source, destination, *, before_replace=None):
    """Atomically replace ``destination``, retrying brief Windows sharing collisions.

    Antivirus, indexers, and open readers can deny ReplaceFile (winerror 5, 32,
    or 33) for a moment. Those errors are retried for at most half a second.
    Other platforms and every other error fail immediately. ``before_replace``,
    when given, runs before every attempt, including the first, and may raise
    to stop without another rename. Callers still remove the temporary file
    when this raises, so a failed replace keeps the previous record.
    """
    deadline = time.monotonic() + .5
    while True:
        if before_replace is not None:
            before_replace()
        try:
            os.replace(source, destination)
            return
        except OSError as error:
            remaining = deadline - time.monotonic()
            if (os.name != "nt" or getattr(error, "winerror", None) not in _REPLACE_SHARING_WINERRORS
                    or remaining <= 0):
                raise
            time.sleep(min(.01, remaining))


def _atomic_write_json(path: Path, item: dict, *, private: bool = True) -> None:
    """Atomically replace JSON, protecting the temporary file before writes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".resource-", dir=str(path.parent))
    try:
        if private:
            try:
                _protect_private_file(fd)
            except BaseException:
                try:
                    os.close(fd)
                except OSError:
                    pass
                raise
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(item, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        replace_file(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    # Durability of the rename itself.
    try:
        dir_fd = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except OSError:
        pass


def _load_item(path: Path):
    """Read one item, refusing symlinks (``O_NOFOLLOW``) so an unrelated file
    cannot be echoed back through the API."""
    if _is_link(path):
        return None
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(str(path), flags)
    except OSError:
        return None
    try:
        with os.fdopen(fd, "r", encoding="utf-8") as stream:
            item = json.load(stream)
    except (OSError, ValueError):
        return None
    if not isinstance(item, dict) or "id" not in item:
        return None
    return item


def _list_items(ctx: dict, kind: str) -> list:
    kind_dir = _kind_dir(ctx, kind)
    if not kind_dir.is_dir():
        return []
    items = []
    for path in sorted(kind_dir.glob("*.json")):
        if _is_link(path):
            continue
        item = _load_item(path)
        if item is not None:
            items.append(item)
    items.sort(key=lambda entry: str(entry.get("id", "")))
    return items


def _capability() -> dict:
    return {"userScopeAvailable": True}


def _handle_get(ctx: dict, parts: list, kind: str):
    if len(parts) != 3:
        return None
    return 200, {"items": _list_items(ctx, kind), "capability": _capability()}


def _handle_post(ctx: dict, parts: list, kind: str, data):
    if len(parts) != 3:
        return None
    if not isinstance(data, dict):
        return 400, {"error": "request body must be a JSON object"}
    rid = data.get("id")
    if not _valid_id(rid):
        return 400, {"error": "invalid resource id"}
    create_only = data.get("createOnly", False)
    if type(create_only) is not bool:
        return 400, {"error": "createOnly must be a boolean"}
    try:
        path = _item_path(ctx, kind, rid)
    except ValueError:
        return 400, {"error": "invalid resource id"}
    now = _now()
    with _LOCK:
        # The existence check and write share the same lock. Do not rely on a
        # browser-side catalog check for imports, which can be stale or race.
        if create_only and path.exists():
            return 409, {"error": "resource already exists: %s" % rid}
        existing = _load_item(path) if path.exists() else None
        created = now
        if existing and isinstance(existing.get("createdAt"), str):
            created = existing["createdAt"]
        extra = {k: v for k, v in data.items()
                 if k not in ("id", "createdAt", "updatedAt", "createOnly")}
        item = {"id": rid, "createdAt": created, "updatedAt": now}
        item.update(extra)
        try:
            _atomic_write_json(path, item)
        except OSError as exc:
            return 400, {"error": "could not persist resource: %s" % exc.strerror}
    return 200, {"item": item}


def _handle_patch(ctx: dict, parts: list, kind: str, data):
    """Merge fields into an existing item.

    A full overwrite would be dangerous here: the UI toggles a skill's
    ``enabled`` flag and would otherwise drop the stored ``body`` /
    ``description``. Only keys present in the request are replaced.
    """
    if len(parts) != 4:
        return None
    if not isinstance(data, dict):
        return 400, {"error": "request body must be a JSON object"}
    rid = parts[3]
    if not _valid_id(rid):
        return 400, {"error": "invalid resource id"}
    if "id" in data and data["id"] != rid:
        return 400, {"error": "id in body must match the path"}
    try:
        path = _item_path(ctx, kind, rid)
    except ValueError:
        return 400, {"error": "invalid resource id"}
    with _LOCK:
        existing = _load_item(path) if path.exists() else None
        if existing is None:
            return 404, {"error": "resource not found: %s" % rid}
        item = dict(existing)
        for key, value in data.items():
            if key in ("id", "createdAt", "updatedAt"):
                continue
            item[key] = value
        item["id"] = rid
        item["createdAt"] = existing.get("createdAt", _now())
        item["updatedAt"] = _now()
        try:
            _atomic_write_json(path, item)
        except OSError as exc:
            return 400, {"error": "could not persist resource: %s" % exc.strerror}
    return 200, {"item": item}


def _handle_put(ctx: dict, parts: list, kind: str, data):
    """Replace the whole list for one kind (the UI saves hooks as a full set).

    Validation happens **before** any write: a single bad item leaves the
    stored set untouched rather than half-replaced. Items absent from the
    new list are deleted.
    """
    if len(parts) != 3:
        return None
    if not isinstance(data, dict):
        return 400, {"error": "request body must be a JSON object"}
    items = data.get("items")
    if not isinstance(items, list):
        return 400, {"error": "items must be an array"}

    seen: set = set()
    planned: list = []
    for item in items:
        if not isinstance(item, dict):
            return 400, {"error": "each item must be a JSON object"}
        rid = item.get("id")
        if not _valid_id(rid):
            return 400, {"error": "invalid resource id: %r" % (rid,)}
        if rid in seen:
            return 400, {"error": "duplicate resource id: %s" % rid}
        seen.add(rid)
        planned.append((rid, item))

    now = _now()
    try:
        kind_dir = _kind_dir(ctx, kind)
    except ValueError as exc:
        return 400, {"error": str(exc)}

    written: list = []
    with _LOCK:
        # Read existing createdAt values first so an update keeps its origin stamp.
        for rid, item in planned:
            try:
                path = _item_path(ctx, kind, rid)
            except ValueError as exc:
                return 400, {"error": str(exc)}
            existing = _load_item(path) if path.exists() else None
            created = now
            if existing and isinstance(existing.get("createdAt"), str):
                created = existing["createdAt"]
            record = {k: v for k, v in item.items() if k not in ("createdAt", "updatedAt")}
            record["id"] = rid
            record["createdAt"] = created
            record["updatedAt"] = now
            try:
                _atomic_write_json(path, record)
            except OSError as exc:
                return 400, {"error": "could not persist resource: %s" % (exc.strerror or exc)}
            written.append(record)

        # Drop anything no longer in the set (skipping symlinks and directories).
        if kind_dir.is_dir():
            for entry in sorted(kind_dir.glob("*.json")):
                if _is_link(entry) or not entry.is_file():
                    continue
                if entry.stem in seen:
                    continue
                try:
                    os.unlink(entry)
                except OSError:
                    pass

    written.sort(key=lambda entry: str(entry.get("id", "")))
    return 200, {"items": written}


def _handle_delete(ctx: dict, parts: list, kind: str):
    if len(parts) != 4:
        return None
    rid = parts[3]
    if not _valid_id(rid):
        return 400, {"error": "invalid resource id"}
    try:
        path = _item_path(ctx, kind, rid)
    except ValueError:
        return 400, {"error": "invalid resource id"}
    with _LOCK:
        if not path.exists() or _is_link(path) or not path.is_file():
            return 404, {"error": "resource not found: %s" % rid}
        try:
            os.unlink(path)
        except FileNotFoundError:
            return 404, {"error": "resource not found: %s" % rid}
        except OSError:
            # e.g. the name is a directory, not a regular file.
            return 400, {"error": "resource not deletable: %s" % rid}
    return 200, {"ok": True, "id": rid}


def dispatch(method: str, parts: list, query: dict, data: dict, ctx: dict):
    """Handle ``/api/resources/...``; return ``(status, payload)`` or ``None``."""
    if not isinstance(parts, list) or len(parts) < 2:
        return None
    if parts[0] != "api" or parts[1] != "resources":
        return None
    if len(parts) < 3:
        return None

    kind = parts[2]
    if kind not in KINDS:
        return 404, {"error": "unknown resource kind: %s" % kind}

    verb = method.upper() if isinstance(method, str) else ""
    try:
        if verb == "GET":
            return _handle_get(ctx, parts, kind)
        if verb == "POST":
            return _handle_post(ctx, parts, kind, data)
        if verb == "PATCH":
            return _handle_patch(ctx, parts, kind, data)
        if verb == "PUT":
            return _handle_put(ctx, parts, kind, data)
        if verb == "DELETE":
            return _handle_delete(ctx, parts, kind)
    except ValueError as exc:
        # Jail violations (symlinked kind dir, escaping id) are client-shaped
        # problems: 400 rather than escaping as an unhandled server error.
        return 400, {"error": str(exc)}
    return None
