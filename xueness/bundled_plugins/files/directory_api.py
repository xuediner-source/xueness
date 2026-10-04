"""Host-backed directory browsing (the DSH ``browse`` capability, ported).

The Web GUI cannot open an OS folder chooser: a browser has no access to the
host's native dialog, and a container host has no display to render one on.
DeepSeek Harness resolves this by exposing two host-side primitives — list one
directory level, create one child directory — and rendering an in-app browser
over them, so the host screen stays untouched and remote clients work. This
module is the host half of that split.

Routes::

    GET  /api/system                    -> {"homedir": <abs>}
    GET  /api/directory?path=<abs>&includeHidden=1
         -> {path, home, crumbs, entries, truncated}
    POST /api/directory  {"path": <abs>, "name": <segment>}
         -> {"path": <created abs>}

Semantics mirrored from the DSH seam:

* Listings return **directories only**, name-sorted, each carrying an absolute
  path and a host-owned ``hidden`` flag (dot-prefixed on POSIX). Symlinks to
  directories are followed; broken and cyclic links are skipped.
* One level is bounded (``max_entries``, default 1000) and a cut level reports
  ``truncated: true``. The level is streamed through a bounded name-sorted
  window, so memory stays O(max_entries) no matter how many children there are.
* A path must be fully qualified. A relative wire value is refused instead of
  being silently rebased under the host process cwd.
* Creation is non-recursive and accepts exactly one non-blank path segment.

The host supplies separate *list roots* and *create roots*. The Web host allows
the project, configured workspace roots, and server-owned web-runs directory in
both sets, so a session's own workspace stays readable in the file tree. These
fences narrow what the browser may touch; reads and writes inside a session
still pass the workspace jail in ``core.path_in``.

Standard library only.
"""

from __future__ import annotations

import os
import ntpath
import posixpath
from pathlib import Path

DEFAULT_MAX_ENTRIES = 1000

# Closed failure vocabulary, mirrored onto the wire by the client.
UNREADABLE = "directory-unreadable"
EXISTS = "directory-exists"
CREATE_FAILED = "directory-create-failed"


class DirectoryError(Exception):
    """Typed browse failure so callers map business codes without string matching."""

    def __init__(self, code: str, path: str, message: str):
        super().__init__(message)
        self.code = code
        self.path = path
        self.message = message


def fully_qualified(path: str) -> bool:
    """True when ``path`` names one fixed location regardless of process state.

    Use the host's path syntax. A rooted drive-less Windows form (``\\foo``) passes
    ``isabs`` yet still resolves against the process's current drive, so it is
    not treated as fully qualified here.
    """
    if not isinstance(path, str) or not path:
        return False
    if os.name == 'nt':
        drive, tail = ntpath.splitdrive(path)
        return bool(drive) and ntpath.isabs(path) and tail.startswith(('\\', '/'))
    return posixpath.isabs(path) and not path.startswith("//")


def _fence(candidate: Path, roots: tuple[Path, ...]) -> Path:
    """Resolve ``candidate`` and refuse anything outside every root."""
    resolved = candidate.resolve()
    if any(resolved == root or resolved.is_relative_to(root) for root in roots):
        return resolved
    raise DirectoryError(UNREADABLE, str(resolved), f"{resolved} is outside the permitted roots")


def _resolve_target(roots: tuple[Path, ...], path: str | None) -> Path:
    """Resolve a requested directory; absent starts at home, else the browse root."""
    home = Path.home().resolve()
    if path is None or path.strip() == "":
        return home if any(home.is_relative_to(root) for root in roots) else roots[0]
    value = path.strip()
    if not fully_qualified(value):
        raise DirectoryError(UNREADABLE, value, f'cannot list "{value}": not a fully qualified path')
    return _fence(Path(value), roots)


def ancestry_crumbs(target: Path, roots: tuple[Path, ...]) -> list[dict]:
    """Root-to-target ancestor chain, bounded by the permitted roots.

    Every crumb is a jump target, so ancestors above the permitted roots are
    omitted: listing them would offer links the fence then refuses. The topmost
    crumb is the permitted ancestor itself, labelled by its full path.
    """
    resolved_roots = tuple(root.resolve() for root in roots)

    def permitted(candidate: Path) -> bool:
        return any(
            candidate == root or candidate.is_relative_to(root) for root in resolved_roots
        )

    crumbs: list[dict] = []
    current = target
    while True:
        parent = current.parent
        name = str(current) if parent == current else current.name
        crumbs.insert(0, {"name": name, "path": str(current), "hidden": False})
        if parent == current or not permitted(parent):
            return crumbs
        current = parent


def _bounded_insert(window: list, candidate: tuple, keep: int) -> bool:
    """Insert into the name-sorted bounded window; return True on eviction.

    A full window rejects a candidate at or past the tail in one comparison, so
    an oversized level costs O(1) per candidate past the head rather than a
    window scan. Retained candidates are placed by binary search (O(log keep)).
    """
    if len(window) == keep and candidate[0] >= window[-1][0]:
        return True
    lo, hi = 0, len(window)
    while lo < hi:
        mid = (lo + hi) // 2
        if candidate[0] < window[mid][0]:
            hi = mid
        else:
            lo = mid + 1
    window.insert(lo, candidate)
    if len(window) <= keep:
        return False
    window.pop()
    return True


def _classify_entry(target: Path, name: str, is_dir: bool, is_link: bool) -> str | None:
    """Row kind for one dirent: ``directory``/``file``, or None when unenterable.

    Symlinks are followed (a link to a directory is a directory row, a link to
    a file a file row); broken and cyclic links are skipped silently, because
    the browser shows what can be opened and a broken link cannot.
    """
    if is_dir:
        return "directory"
    full = target / name
    if is_link:
        try:
            if full.is_dir():
                return "directory"
            if full.is_file():
                return "file"
        except OSError:
            return None
        return None
    try:
        return "file" if full.is_file() else None
    except OSError:
        return None


def list_level(
    roots: tuple[Path, ...],
    path: str | None = None,
    include_hidden: bool = False,
    max_entries: int = DEFAULT_MAX_ENTRIES,
    include_files: bool = False,
) -> dict:
    """List one directory level under ``roots``.

    ``include_files=False`` (the default) keeps the DSH browse semantics: the
    picker only ever walks directories. The generic file listing opts in, since
    a workspace file tree must show files alongside directories.
    """
    roots = tuple(root.resolve() for root in roots) or (Path("/").resolve(),)
    # Anchor ``home`` the same way ``/api/system`` does: a narrowed scope must
    # not hand the client a root-outside path it can never list.
    raw_home = Path.home().resolve()
    home = raw_home if any(raw_home.is_relative_to(root) for root in roots) else roots[0]
    target = _resolve_target(roots, path)

    keep = max(1, int(max_entries)) + 1
    window: list[tuple[str, str]] = []
    evicted = False
    try:
        with os.scandir(target) as level:
            for dent in level:
                try:
                    is_dir = dent.is_dir(follow_symlinks=False)
                    is_link = dent.is_symlink()
                except OSError:
                    continue
                kind = _classify_entry(target, dent.name, is_dir, is_link)
                if kind is None:
                    continue
                # The picker only walks directories; the generic listing keeps
                # files too. Either way the window holds the name-sorted head.
                if not include_files and kind != "directory":
                    continue
                if _bounded_insert(window, (dent.name, kind), keep):
                    evicted = True
    except OSError as exc:
        raise DirectoryError(UNREADABLE, str(target), f"cannot list {target}: {exc}")

    entries: list[dict] = []
    truncated = evicted
    for name, kind in window:
        hidden = name.startswith(".")
        if hidden and not include_hidden:
            continue
        if len(entries) == max(1, int(max_entries)):
            truncated = True
            break
        full = target / name
        entries.append({
            "name": name,
            "path": str(full),
            "type": kind,
            "hidden": hidden,
            "isSymbolicLink": full.is_symlink(),
        })

    return {
        "path": str(target),
        "home": str(home),
        "crumbs": ancestry_crumbs(target, roots),
        "entries": entries,
        "truncated": truncated,
    }


def create_child(roots: tuple[Path, ...], path: str, name: str) -> str:
    """Create one child directory under an existing parent. Non-recursive."""
    roots = tuple(root.resolve() for root in roots) or (Path("/").resolve(),)
    if not fully_qualified(path or ""):
        raise DirectoryError(CREATE_FAILED, str(path), f'cannot create under "{path}": not a fully qualified path')
    parent = _fence(Path(path), roots)
    if not isinstance(name, str) or name.strip() == "" or name in (".", "..") or "/" in name or "\\" in name:
        raise DirectoryError(CREATE_FAILED, str(parent / str(name)), f'"{name}" is not a single path segment')
    target = _fence(parent / name, roots)
    try:
        # The parent is the directory the browser is showing, so a missing
        # parent is a real failure, not a level to invent.
        os.mkdir(target)
    except FileExistsError:
        raise DirectoryError(EXISTS, str(target), f"{target} already exists")
    except OSError as exc:
        raise DirectoryError(CREATE_FAILED, str(target), f"cannot create {target}: {exc}")
    return str(target)


def _truthy(value) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def _status_for(code: str) -> int:
    return 409 if code == EXISTS else 400


def _first(query: dict, key: str):
    value = (query or {}).get(key)
    if isinstance(value, list):
        return value[0] if value else None
    return value


def dispatch(method: str, parts: list, query: dict, data: dict, ctx: dict):
    """Handle ``/api/system`` and ``/api/directory``; return ``(status, payload)``."""
    if not isinstance(parts, list) or not parts or parts[0] != "api":
        return None
    list_roots = list(ctx.get("list_roots") or (ctx.get("browse_root") or Path("/"),))
    create_roots = list(ctx.get("create_roots") or (ctx.get("browse_root") or Path("/"),))
    # Native picker grants are persisted after startup, so include them on each
    # request instead of freezing the initial list_roots/create_roots snapshot.
    try:
        from ..settings.workspaces_api import allowed_roots
        registered = allowed_roots(ctx)
        list_roots.extend(registered)
        create_roots.extend(registered)
    except (ImportError, KeyError, OSError, RuntimeError, ValueError):
        # Startup roots remain available if workspace preferences are disabled
        # or malformed; no user-selected path is inferred from the request.
        pass
    list_roots = tuple(dict.fromkeys(Path(root).resolve() for root in list_roots))
    create_roots = tuple(dict.fromkeys(Path(root).resolve() for root in create_roots))
    max_entries = int(ctx.get("max_entries") or DEFAULT_MAX_ENTRIES)
    verb = method.upper() if isinstance(method, str) else ""

    if parts == ["api", "system"] and verb == "GET":
        home = Path.home().resolve()
        # The picker starts here, so a narrowed scope must move the anchor with
        # it rather than handing the client a path it cannot list.
        if not any(home.is_relative_to(root.resolve()) for root in list_roots):
            home = list_roots[0].resolve()
        return 200, {"homedir": str(home)}

    if parts != ["api", "directory"]:
        return None

    if verb == "GET":
        try:
            return 200, list_level(
                list_roots,
                _first(query, "path"),
                _truthy(_first(query, "includeHidden")),
                max_entries,
                _truthy(_first(query, "includeFiles")),
            )
        except DirectoryError as exc:
            return _status_for(exc.code), {"error": exc.code, "message": exc.message}

    if verb == "POST":
        if not isinstance(data, dict):
            return 400, {"error": "invalid json body"}
        try:
            created = create_child(create_roots, data.get("path"), data.get("name"))
        except DirectoryError as exc:
            return _status_for(exc.code), {"error": exc.code, "message": exc.message}
        return 200, {"path": created}

    return None
