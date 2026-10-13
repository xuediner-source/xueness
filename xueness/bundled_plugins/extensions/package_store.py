"""Inert, hash-confirmed source packages for the external MCP launcher.

Installation only verifies and copies bytes. It never imports a package, invokes
its runtime, installs dependencies, or runs an installation hook. Each immutable
version has a complete file receipt; switching the small current pointer is the
only upgrade/rollback operation. Uninstall keeps receipts and source versions.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import threading
import unicodedata
import uuid
import zipfile
import zlib

from ... import file_lock
from ...plugin_runtime import require_enabled
from ...resources import (_atomic_write_json, _is_link,
                          _protect_private_directory, _protect_private_file)

MANIFEST_NAME = "xueness-package.json"
STORE_DIRECTORY = "external-packages"
MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
MAX_EXPANDED_BYTES = 64 * 1024 * 1024
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_FILES = 512
MAX_JSON_BYTES = 256 * 1024
MAX_HISTORY = 32
MAX_PACKAGES = 64
MAX_VERSIONS = 32
_ID = re.compile(r"[a-z][a-z0-9-]{0,63}\Z")
_VERSION = re.compile(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?\Z")
_HASH = re.compile(r"[0-9a-f]{64}\Z")
_DEVICE = re.compile(r"(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?\Z", re.I)
_MANIFEST_FIELDS = {"apiVersion", "id", "version", "transport", "runtime",
                    "entrypoint", "capabilities"}
_CAPABILITIES = {"command", "network", "filesystem-write"}
_THREAD_LOCK = threading.RLock()


class PackagePathError(ValueError):
    """A link or special filesystem object is an unsafe storage boundary."""


def _now():
    return datetime.now(timezone.utc).isoformat()


def _identifier(value):
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise ValueError("invalid external package id")
    return value


def _version(value):
    if (not isinstance(value, str) or len(value) > 80
            or not _VERSION.fullmatch(value) or ".." in value):
        raise ValueError("invalid external package version")
    return value


def _sha(value):
    if not isinstance(value, str) or not _HASH.fullmatch(value.lower()):
        raise ValueError("expected_sha256 must be a full 64-character SHA-256")
    return value.lower()


def _relative_path(value):
    if (not isinstance(value, str) or not value or len(value) > 240
            or "\\" in value or value.startswith("/")
            or unicodedata.normalize("NFC", value) != value):
        raise ValueError("unsafe package path")
    parts = value.split("/")
    for part in parts:
        if (not part or part in {".", ".."} or len(part) > 80
                or part.endswith((".", " ")) or _DEVICE.fullmatch(part)
                or any(ord(c) < 32 or c in '<>:"|?*' for c in part)):
            raise ValueError("unsafe package path: " + value)
    return PurePosixPath(value).as_posix()


def validate_manifest(document):
    """Validate the closed source-package schema; return a detached document."""
    if not isinstance(document, dict) or set(document) != _MANIFEST_FIELDS:
        raise ValueError("source package manifest has missing or unknown fields")
    if type(document["apiVersion"]) is not int or document["apiVersion"] != 1:
        raise ValueError("unsupported source package apiVersion")
    _identifier(document["id"])
    _version(document["version"])
    if not isinstance(document["transport"], str) or document["transport"] not in {"mcp-stdio", "acp-stdio"}:
        raise ValueError("source packages require mcp-stdio or acp-stdio transport")
    runtime = document["runtime"]
    if not isinstance(runtime, str) or runtime not in {"python", "node"}:
        raise ValueError("source package runtime must be python or node")
    entrypoint = _relative_path(document["entrypoint"])
    extensions = {".py"} if runtime == "python" else {".js", ".mjs", ".cjs"}
    if PurePosixPath(entrypoint).suffix.lower() not in extensions:
        raise ValueError("entrypoint must be a source file for its declared runtime")
    capabilities = document["capabilities"]
    if (not isinstance(capabilities, list) or not capabilities
            or any(not isinstance(c, str) or c not in _CAPABILITIES for c in capabilities)
            or len(set(capabilities)) != len(capabilities) or "command" not in capabilities):
        raise ValueError("capabilities must contain command and only known unique permissions")
    return {**document, "capabilities": list(capabilities)}


def _json(data):
    if len(data) > MAX_JSON_BYTES:
        raise ValueError("package JSON exceeds limit")

    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate package JSON key")
            result[key] = value
        return result

    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=unique,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError("invalid JSON constant")))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("invalid package JSON") from exc


def _check_path(path):
    """Inspect every lexical ancestor before any resolution or filesystem use."""
    path = Path(os.path.abspath(os.fspath(path)))
    for entry in [*reversed(path.parents), path]:
        if _is_link(entry):
            raise PackagePathError("package storage/source must not contain links or reparse points")
    return path


def _directory(path, *, create=False):
    path = _check_path(path)
    if create and not path.exists():
        missing = []
        current = path
        while not current.exists():
            missing.append(current)
            current = current.parent
        if not current.is_dir():
            raise ValueError("package storage parent is not a directory")
        for entry in reversed(missing):
            entry.mkdir()
            _protect_private_directory(entry)
    if path.exists() and not path.is_dir():
        raise ValueError("package storage is not a directory")
    _check_path(path)
    return path


def _read_file(path, limit):
    path = _check_path(path)
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or getattr(info, "st_nlink", 1) != 1:
            raise PackagePathError("package file must be a regular file without hard links")
        if info.st_size > limit:
            raise ValueError("package file exceeds limit")
        data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError("package file exceeds limit")
        return data


def _archive_bytes(source):
    if isinstance(source, bytes):
        data = source
        if len(data) > MAX_ARCHIVE_BYTES:
            raise ValueError("package archive exceeds limit")
        return data
    return _read_file(Path(source), MAX_ARCHIVE_BYTES)


def _inspect_archive(source, expected_sha256=None):
    data = _archive_bytes(source)
    archive_hash = hashlib.sha256(data).hexdigest()
    if expected_sha256 is not None and archive_hash != _sha(expected_sha256):
        raise ValueError("package archive SHA-256 does not match the confirmed hash")
    files = {}
    seen = {}
    total = 0
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if not entries or len(entries) > MAX_FILES:
                raise ValueError("package archive entry limit exceeded")
            for entry in entries:
                if entry.orig_filename != entry.filename:
                    raise ValueError("package ZIP has a truncated or NUL-containing filename")
                name = _relative_path(entry.filename[:-1] if entry.is_dir() else entry.filename)
                key = name.casefold()
                if key in seen:
                    raise ValueError("duplicate or case-colliding package path")
                seen[key] = (name, entry.is_dir())
                mode = entry.external_attr >> 16
                file_type = stat.S_IFMT(mode)
                if ((entry.external_attr & 0x400) or file_type not in {0, stat.S_IFREG, stat.S_IFDIR}
                        or (file_type == stat.S_IFDIR) != entry.is_dir() and file_type != 0
                        or entry.flag_bits & 1):
                    raise ValueError("package archive contains a link, special file, or encrypted entry")
                if (entry.file_size > MAX_FILE_BYTES or entry.file_size < 0
                        or entry.compress_size < 0
                        or (entry.file_size > 1024 * 1024 and entry.file_size > max(1, entry.compress_size) * 200)):
                    raise ValueError("package archive file or compression limit exceeded")
                total += entry.file_size
                if total > MAX_EXPANDED_BYTES:
                    raise ValueError("package archive expansion limit exceeded")
                if entry.is_dir():
                    if entry.file_size != 0:
                        raise ValueError("package directory contains data")
                    continue
                with archive.open(entry) as stream:
                    contents = stream.read(MAX_FILE_BYTES + 1)
                if len(contents) != entry.file_size or len(contents) > MAX_FILE_BYTES:
                    raise ValueError("package archive file size mismatch")
                files[name] = contents
            for name, _ in list(seen.values()):
                parts = name.split("/")
                for length in range(1, len(parts)):
                    ancestor = seen.get("/".join(parts[:length]).casefold())
                    if ancestor is not None and not ancestor[1]:
                        raise ValueError("package file collides with a directory")
                # Implicit directory spellings must not collide either (a/b and A/c).
                for length in range(1, len(parts)):
                    prefix = "/".join(parts[:length])
                    other = seen.get(prefix.casefold())
                    if other and other[0] != prefix:
                        raise ValueError("case-colliding package directory")
                    seen.setdefault(prefix.casefold(), (prefix, True))
    except (zipfile.BadZipFile, zlib.error, RuntimeError, NotImplementedError, OSError) as exc:
        raise ValueError("invalid or unsupported package ZIP") from exc
    if MANIFEST_NAME not in files:
        raise ValueError("package ZIP must contain root xueness-package.json")
    manifest = validate_manifest(_json(files[MANIFEST_NAME]))
    if manifest["entrypoint"] not in files:
        raise ValueError("package entrypoint is missing")
    receipts = [{"path": name, "size": len(contents), "sha256": hashlib.sha256(contents).hexdigest()}
                for name, contents in sorted(files.items())]
    return {"apiVersion": 1, "manifest": manifest, "archiveSha256": archive_hash,
            "files": receipts, "archiveBytes": len(data), "expandedBytes": total}, files


def review_archive(source, *, expected_sha256=None):
    """Read-only bounded ZIP review, optionally requiring a caller-confirmed hash."""
    return _inspect_archive(source, expected_sha256)[0]


def _root(state_dir, *, create=False):
    require_enabled(state_dir, "extensions")
    state = _directory(state_dir, create=create)
    root = _directory(state / STORE_DIRECTORY, create=create)
    if create:
        _protect_private_directory(root)
    return root


@contextmanager
def _locked(state_dir):
    with _THREAD_LOCK:
        root = _root(state_dir, create=True)
        lock_path = _check_path(root / ".store.lock")
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            _protect_private_file(fd)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or getattr(info, "st_nlink", 1) != 1:
                raise ValueError("package lock must be a regular private file")
            with os.fdopen(fd, "a+b") as stream:
                fd = None
                file_lock.flock(stream, file_lock.LOCK_EX)
                try:
                    _root(state_dir)
                    yield root
                finally:
                    file_lock.flock(stream, file_lock.LOCK_UN)
        finally:
            if fd is not None:
                os.close(fd)


def _reference(document):
    if not isinstance(document, dict) or set(document) != {"version", "archiveSha256"}:
        raise ValueError("invalid package version reference")
    return {"version": _version(document["version"]), "archiveSha256": _sha(document["archiveSha256"])}


def _package_dir(root, package_id, *, create=False):
    return _directory(root / _identifier(package_id), create=create)


def _pointer(root, package_id):
    package = _package_dir(root, package_id)
    path = _check_path(package / "current.json")
    if not path.exists():
        return {"apiVersion": 1, "id": package_id, "active": None, "history": [],
                "enabled": False, "grants": []}
    document = _json(_read_file(path, MAX_JSON_BYTES))
    if (not isinstance(document, dict)
            or set(document) != {"apiVersion", "id", "active", "history", "enabled", "grants"}
            or type(document["apiVersion"]) is not int or document["apiVersion"] != 1
            or document["id"] != package_id or not isinstance(document["history"], list)
            or len(document["history"]) > MAX_HISTORY or type(document["enabled"]) is not bool
            or not isinstance(document["grants"], list)
            or any(not isinstance(c, str) or c not in _CAPABILITIES for c in document["grants"])
            or len(set(document["grants"])) != len(document["grants"])
            or (document["active"] is None and document["enabled"])
            or (not document["enabled"] and document["grants"])):
        raise ValueError("invalid package current pointer")
    if document["active"] is not None:
        document["active"] = _reference(document["active"])
    document["history"] = [_reference(row) for row in document["history"]]
    return document


def _save_pointer(root, pointer, active):
    active = _reference(active) if active is not None else None
    history = list(pointer["history"])
    previous = pointer["active"]
    if previous is not None and previous != active:
        history = [row for row in history if row != previous] + [previous]
    if active is not None:
        history = [row for row in history if row != active]
    document = {**pointer, "active": active, "history": history[-MAX_HISTORY:],
                "enabled": False, "grants": []}
    path = _check_path(_package_dir(root, pointer["id"]) / "current.json")
    _atomic_write_json(path, document)
    return document


def _version_dir(root, package_id, reference, *, create=False):
    reference = _reference(reference)
    package = _package_dir(root, package_id, create=create)
    versions = _directory(package / "versions", create=create)
    if versions.exists():
        for existing in versions.iterdir():
            _directory(existing)
            _version(existing.name)
            if existing.name.casefold() == reference["version"].casefold() and existing.name != reference["version"]:
                raise ValueError("case-colliding installed package version")
    version = _directory(versions / reference["version"], create=create)
    return _directory(version / reference["archiveSha256"], create=False)


def _source_files(source):
    """Inventory the jailed tree without following any directory/file link."""
    _directory(source)
    if not source.exists():
        raise ValueError("installed package source is missing")
    pending = [source]
    files = {}
    seen = set()
    entries = 0
    total = 0
    while pending:
        folder = pending.pop()
        _check_path(folder)
        for path in folder.iterdir():
            _check_path(path)
            entries += 1
            if entries > MAX_FILES * 2:
                raise ValueError("installed package entry limit exceeded")
            relative = _relative_path(path.relative_to(source).as_posix())
            key = relative.casefold()
            if key in seen:
                raise ValueError("installed package has colliding paths")
            seen.add(key)
            if path.is_dir():
                pending.append(path)
            else:
                data = _read_file(path, MAX_FILE_BYTES)
                total += len(data)
                if total > MAX_EXPANDED_BYTES or len(files) >= MAX_FILES:
                    raise ValueError("installed package size limit exceeded")
                files[relative] = data
    return files


def _review_version(root, package_id, reference):
    reference = _reference(reference)
    version = _version_dir(root, package_id, reference)
    if not version.exists():
        raise ValueError("installed package version is missing")
    receipt = _json(_read_file(version / "receipt.json", MAX_JSON_BYTES))
    if (not isinstance(receipt, dict)
            or set(receipt) != {"apiVersion", "manifest", "archiveSha256", "files", "installedAt", "source", "provenance"}
            or type(receipt["apiVersion"]) is not int or receipt["apiVersion"] != 1
            or receipt["archiveSha256"] != reference["archiveSha256"]
            or not isinstance(receipt["installedAt"], str) or len(receipt["installedAt"]) > 64
            or not isinstance(receipt["source"], str) or len(receipt["source"]) > 1024
            or not isinstance(receipt["files"], list) or not receipt["files"]
            or len(receipt["files"]) > MAX_FILES):
        raise ValueError("invalid installed package receipt")
    manifest = validate_manifest(receipt["manifest"])
    _provenance(receipt["provenance"])
    if manifest["id"] != package_id or manifest["version"] != reference["version"]:
        raise ValueError("installed package identity mismatch")
    original, _ = _inspect_archive(version / "archive.zip", reference["archiveSha256"])
    if original["manifest"] != manifest or original["files"] != receipt["files"]:
        raise ValueError("installed package receipt differs from the confirmed archive")
    expected = {}
    for row in receipt["files"]:
        if (not isinstance(row, dict) or set(row) != {"path", "size", "sha256"}
                or type(row["size"]) is not int or not 0 <= row["size"] <= MAX_FILE_BYTES):
            raise ValueError("invalid installed package file receipt")
        name = _relative_path(row["path"])
        if name in expected:
            raise ValueError("duplicate installed package receipt")
        expected[name] = {**row, "sha256": _sha(row["sha256"])}
    source = _directory(version / "source")
    actual = _source_files(source)
    if set(actual) != set(expected):
        raise ValueError("installed package files differ from receipt")
    for name, data in actual.items():
        row = expected[name]
        if len(data) != row["size"] or hashlib.sha256(data).hexdigest() != row["sha256"]:
            raise ValueError("installed package file integrity mismatch: " + name)
    if MANIFEST_NAME not in actual or validate_manifest(_json(actual[MANIFEST_NAME])) != manifest:
        raise ValueError("installed package manifest differs from receipt")
    if manifest["entrypoint"] not in actual:
        raise ValueError("installed package entrypoint is missing")
    return {"id": package_id, "version": manifest["version"],
            "archiveSha256": reference["archiveSha256"], "manifest": manifest,
            "root": str(source), "entrypoint": str(source / manifest["entrypoint"]),
            "receipt": receipt, "valid": True}


def _find_reference(root, package_id, archive_sha256):
    archive_sha256 = _sha(archive_sha256)
    versions = _directory(_package_dir(root, package_id) / "versions")
    if not versions.exists():
        raise ValueError("package has no installed versions")
    found = []
    for version in versions.iterdir():
        _version(version.name)
        _directory(version)
        candidate = _directory(version / archive_sha256)
        if candidate.exists():
            found.append({"version": version.name, "archiveSha256": archive_sha256})
    if len(found) != 1:
        raise ValueError("package archive version is missing or ambiguous")
    return found[0]


def _write_bytes(path, data):
    path = _check_path(path)
    _directory(path.parent, create=True)
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        _protect_private_file(fd)
        with os.fdopen(fd, "wb") as stream:
            fd = None
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        if fd is not None:
            os.close(fd)


def _cleanup_staging(stage, root):
    """Delete only this generated staging tree, never an operator-supplied path."""
    stage = _check_path(stage)
    root = _check_path(root)
    if stage.parent != root or not stage.name.startswith(".staging-"):
        return
    if not stage.exists():
        return
    pending = [stage]
    directories = []
    try:
        while pending:
            folder = pending.pop()
            _check_path(folder)
            directories.append(folder)
            for path in folder.iterdir():
                _check_path(path)
                if path.is_dir():
                    pending.append(path)
                else:
                    path.unlink()
        for folder in reversed(directories):
            folder.rmdir()
    except (OSError, ValueError):
        # A moved/changed staging tree is retained for inspection, never followed.
        pass


def _provenance(document):
    if document is None:
        return {"kind": "sha256-pin"}
    if (not isinstance(document, dict) or not isinstance(document.get("kind"), str)
            or document.get("kind") not in {"sha256-pin", "ed25519"}):
        raise ValueError("invalid source package provenance")
    fields = {"kind"} if document["kind"] == "sha256-pin" else {"kind", "keyId", "signature", "fingerprint"}
    if set(document) != fields:
        raise ValueError("invalid source package provenance fields")
    if any(not isinstance(value, str) or not value or len(value) > 4096
           or any(ord(c) < 32 for c in value) for value in document.values()):
        raise ValueError("invalid source package provenance text")
    if len(json.dumps(document, ensure_ascii=False).encode("utf-8")) > 8192:
        raise ValueError("source package provenance exceeds limit")
    return dict(document)


def _install(state_dir, source, *, expected_sha256, source_label=None, package_id=None, provenance=None, upgrade=False):
    confirmed = _sha(expected_sha256)
    require_enabled(state_dir, "extensions")
    archive_data = _archive_bytes(source)
    reviewed, files = _inspect_archive(archive_data, confirmed)
    manifest = reviewed["manifest"]
    if package_id is not None and _identifier(package_id) != manifest["id"]:
        raise ValueError("upgrade archive has a different package id")
    label = source_label if source_label is not None else ("local-bytes" if isinstance(source, bytes) else str(source))
    if not isinstance(label, str) or len(label) > 1024 or any(ord(c) < 32 for c in label):
        raise ValueError("invalid package source label")
    package_id = manifest["id"]
    provenance = _provenance(provenance)
    reference = {"version": manifest["version"], "archiveSha256": confirmed}
    # Close transports before taking the store lock: an in-flight MCP policy
    # check may itself be reading this store, so waiting under that lock would
    # deadlock process cleanup.
    from ..mcp.package_binding import close_package
    close_package(state_dir, package_id)
    with _locked(state_dir) as root:
        packages = [p for p in root.iterdir() if p.name != ".store.lock" and not p.name.startswith(".staging-")]
        if not (root / package_id).exists() and len(packages) >= MAX_PACKAGES:
            raise ValueError("external package count limit exceeded")
        pointer = _pointer(root, package_id)
        if upgrade and pointer["active"] is None:
            raise ValueError("upgrade requires an installed active package")
        if not upgrade and pointer["active"] is not None and pointer["active"] != reference:
            raise ValueError("package is already installed; use upgrade")
        destination = _version_dir(root, package_id, reference, create=True)
        if destination.exists():
            result = _review_version(root, package_id, reference)
        else:
            version_count = sum(len(list(p.iterdir())) for p in (root / package_id / "versions").iterdir()
                                if p.is_dir() and not _is_link(p))
            if version_count >= MAX_VERSIONS:
                raise ValueError("external package version limit exceeded")
            stage = root / (".staging-" + uuid.uuid4().hex)
            _directory(stage, create=True)
            try:
                source_dir = _directory(stage / "source", create=True)
                _write_bytes(stage / "archive.zip", archive_data)
                for name, data in files.items():
                    _write_bytes(source_dir / name, data)
                receipt = {"apiVersion": 1, "manifest": manifest, "archiveSha256": confirmed,
                           "files": reviewed["files"], "installedAt": _now(), "source": label,
                           "provenance": provenance}
                _atomic_write_json(stage / "receipt.json", receipt)
                _check_path(destination)
                if destination.exists():
                    raise ValueError("package version appeared while installing")
                os.rename(stage, destination)
                result = _review_version(root, package_id, reference)
            finally:
                _cleanup_staging(stage, root)
        require_enabled(state_dir, "extensions")
        updated = _save_pointer(root, pointer, reference)
        return {**result, "active": updated["active"], "history": updated["history"],
                "enabled": updated["enabled"], "grants": updated["grants"]}


def install(state_dir, source, *, expected_sha256, source_label=None, provenance=None):
    """Install inert local ZIP/bytes only after exact archive SHA-256 confirmation."""
    return _install(state_dir, source, expected_sha256=expected_sha256, source_label=source_label,
                    provenance=provenance)


def upgrade(state_dir, source, *, expected_sha256, source_label=None, package_id=None, provenance=None):
    return _install(state_dir, source, expected_sha256=expected_sha256,
                    source_label=source_label, package_id=package_id, provenance=provenance, upgrade=True)


def review(state_dir, package_id, *, archive_sha256=None):
    """Verify every installed source byte before displaying/launching a package."""
    package_id = _identifier(package_id)
    with _locked(state_dir) as root:
        pointer = _pointer(root, package_id)
        reference = (_find_reference(root, package_id, archive_sha256) if archive_sha256 is not None
                     else pointer["active"])
        if reference is None:
            raise ValueError("package has no active installed version")
        result = _review_version(root, package_id, reference)
        if (reference == pointer["active"] and pointer["enabled"]
                and set(pointer["grants"]) != set(result["manifest"]["capabilities"])):
            raise ValueError("installed package grants do not match declared capabilities")
        return {**result, "active": pointer["active"], "history": pointer["history"],
                "enabled": pointer["enabled"], "grants": pointer["grants"]}


def resolved_package(state_dir, package_id):
    return review(state_dir, package_id)


def rollback(state_dir, package_id, *, archive_sha256=None):
    require_enabled(state_dir, "extensions")
    package_id = _identifier(package_id)
    from ..mcp.package_binding import close_package
    close_package(state_dir, package_id)
    with _locked(state_dir) as root:
        pointer = _pointer(root, package_id)
        if archive_sha256 is None:
            if not pointer["history"]:
                raise ValueError("package has no rollback history")
            reference = pointer["history"][-1]
        else:
            reference = _find_reference(root, package_id, archive_sha256)
            if reference not in pointer["history"]:
                raise ValueError("rollback target is not an installed history version")
        result = _review_version(root, package_id, reference)
        updated = _save_pointer(root, pointer, reference)
        return {**result, "active": updated["active"], "history": updated["history"],
                "enabled": updated["enabled"], "grants": updated["grants"]}


def uninstall(state_dir, package_id):
    require_enabled(state_dir, "extensions")
    package_id = _identifier(package_id)
    from ..mcp.package_binding import close_package
    close_package(state_dir, package_id)
    with _locked(state_dir) as root:
        pointer = _pointer(root, package_id)
        if pointer["active"] is None:
            raise ValueError("package has no active installed version")
        updated = _save_pointer(root, pointer, None)
        return {"id": package_id, "active": None, "history": updated["history"],
                "enabled": False, "grants": [], "uninstalled": True}


def set_enabled(state_dir, package_id, enabled, *, expected_sha256, grants=()):
    """Enable only the exact reviewed archive and exact declared permissions."""
    require_enabled(state_dir, "extensions")
    package_id = _identifier(package_id)
    confirmed = _sha(expected_sha256)
    if type(enabled) is not bool or not isinstance(grants, (list, tuple)):
        raise ValueError("invalid external package enable request")
    if (any(not isinstance(c, str) or c not in _CAPABILITIES for c in grants)
            or len(set(grants)) != len(grants)):
        raise ValueError("invalid external package permission grants")
    from ..mcp.package_binding import close_package
    close_package(state_dir, package_id)
    with _locked(state_dir) as root:
        pointer = _pointer(root, package_id)
        if pointer["active"] is None or pointer["active"]["archiveSha256"] != confirmed:
            raise ValueError("package activation SHA-256 does not match active version")
        result = (_review_version(root, package_id, pointer["active"]) if enabled
                  else {"id": package_id, "version": pointer["active"]["version"],
                        "archiveSha256": confirmed})
        if enabled and set(grants) != set(result["manifest"]["capabilities"]):
            raise ValueError("package activation requires its exact declared capabilities")
        if enabled:
            from .package_trust import verify_receipt
            verify_receipt(state_dir, result['receipt'], confirmed)
        updated = {**pointer, "enabled": enabled, "grants": list(grants) if enabled else []}
        _atomic_write_json(_check_path(_package_dir(root, package_id) / "current.json"), updated)
        return {**result, "active": updated["active"], "history": updated["history"],
                "enabled": enabled, "grants": updated["grants"]}


def list_packages(state_dir):
    root = _root(state_dir)
    if not root.exists():
        return []
    with _locked(state_dir) as root:
        rows = []
        for package in sorted(root.iterdir()):
            if package.name == ".store.lock" or package.name.startswith(".staging-"):
                continue
            package_id = _identifier(package.name)
            _directory(package)
            pointer = _pointer(root, package_id)
            valid = True
            safe_error = None
            try:
                result = (_review_version(root, package_id, pointer["active"])
                          if pointer["active"] is not None else {})
                if pointer["enabled"] and set(pointer["grants"]) != set(result["manifest"]["capabilities"]):
                    raise ValueError("installed package grants do not match declared capabilities")
            except PackagePathError:
                raise
            except (ValueError, OSError):
                # One corrupt source/receipt must not hide independent healthy packages
                # or the pointer-only recovery actions. Never expose file contents or paths.
                result = {}
                valid = False
                safe_error = "installed package failed integrity verification"
            reference = pointer["active"] or {}
            rows.append({"id": package_id, "version": reference.get("version"),
                         "archiveSha256": reference.get("archiveSha256"),
                         "manifest": result.get("manifest"), "active": pointer["active"],
                         "history": pointer["history"], "installed": pointer["active"] is not None,
                         "enabled": pointer["enabled"], "grants": pointer["grants"],
                         "valid": valid, **({"safeError": safe_error} if safe_error else {})})
            if len(rows) > MAX_PACKAGES:
                raise ValueError("external package count limit exceeded")
        return rows
