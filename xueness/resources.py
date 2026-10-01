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
"""
import json
import os
import re
import tempfile
import threading
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


def _resources_root(ctx: dict) -> Path:
    state_dir = ctx.get("state_dir")
    if state_dir is None:
        raise ValueError("state_dir missing from context")
    root = (Path(state_dir) / "resources").resolve()
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
    if target.is_symlink():
        raise ValueError("resource kind must not be a symlink")
    if not _within(target, root):
        raise ValueError("resource kind escapes the state root")
    return target


def _item_path(ctx: dict, kind: str, rid: str) -> Path:
    kind_dir = _kind_dir(ctx, kind)
    path = kind_dir / (rid + ".json")
    # ``rid`` is whitelisted (no separators, not ``.``/``..``), so the remaining
    # escape hatch is a pre-existing symlink at that name.
    if path.is_symlink():
        raise ValueError("resource id must not be a symlink")
    if path.parent != kind_dir:
        raise ValueError("resource id escapes its kind directory")
    return path


def _atomic_write_json(path: Path, item: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".resource-", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(item, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
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
    if path.is_symlink():
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
        if path.is_symlink():
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
                if entry.is_symlink() or not entry.is_file():
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
        if not path.exists() or path.is_symlink() or not path.is_file():
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
