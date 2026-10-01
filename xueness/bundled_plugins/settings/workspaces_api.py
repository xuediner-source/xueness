"""Workspace preferences and host-authorized roots.

The web directory browser remains limited to operator-configured roots. On
macOS, a same-machine native folder chooser can explicitly register one
existing project directory; only its OS-returned path is added to that set.
"""
from __future__ import annotations

import ipaddress
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path

from ...process_runtime import run_external
from . import settings_store

_MAX_RECENT = 10
_MAX_SELECTED_ROOTS = 100
_WORKSPACE_SECTION = "workspace"
_BROAD_TEMP_ROOT = Path("/tmp").resolve()
_SESSION_DIR_RE = re.compile(r"[0-9a-f]{32}\Z")
_NATIVE_PICKER_LOCK = threading.Lock()
_PICKER_CANCELLED = "__XUENESS_NATIVE_PICKER_CANCELLED__"
_PICKER_TIMEOUT_SECONDS = 600

# The selected path is passed as osascript's argv, never interpolated into this
# program. That keeps quotes, shell characters and AppleScript syntax in a
# directory name from becoming code.
_MACOS_PICKER_SCRIPT = r'''on run argv
    try
        if (count of argv) > 0 then
            set initialLocation to POSIX file (item 1 of argv) as alias
            set selectedFolder to choose folder with prompt "Choose a project folder" default location initialLocation
        else
            set selectedFolder to choose folder with prompt "Choose a project folder"
        end if
        return POSIX path of selectedFolder
    on error errorMessage number errorNumber
        if errorNumber is -128 then
            return "__XUENESS_NATIVE_PICKER_CANCELLED__"
        end if
        error errorMessage number errorNumber
    end try
end run'''


def _plugin_access(ctx: dict) -> bool:
    """Workspace preference reads require both owning features to be active."""
    try:
        from ... import plugin_runtime
        state_dir = ctx["state_dir"]
        return (plugin_runtime.is_enabled(state_dir, "settings")
                and plugin_runtime.is_enabled(state_dir, "sessions"))
    except (KeyError, OSError, ValueError):
        return False


def allowed_roots(ctx: dict) -> tuple[Path, ...]:
    """Canonical workspace roots, including explicit native-picker grants."""
    values = [*ctx.get("workspace_roots", ()), ctx.get("project_dir"), ctx.get("web_runs")]
    values.extend(selected_roots(ctx))
    result: list[Path] = []
    seen: set[str] = set()
    for value in values:
        if value is None:
            continue
        try:
            root = Path(value).expanduser().resolve(strict=True)
            if not root.is_dir() or root in (_BROAD_TEMP_ROOT, Path("/").resolve()):
                continue
        except (OSError, RuntimeError, TypeError, ValueError):
            continue
        key = str(root)
        if key not in seen:
            seen.add(key)
            result.append(root)
    return tuple(result)


def _platform_name() -> str:
    if sys.platform == "darwin":
        return "macos"
    if sys.platform.startswith("win"):
        return "windows"
    if sys.platform.startswith("linux"):
        return "linux"
    return sys.platform or "unknown"


def native_picker_capability() -> dict:
    """Describe native picker support without opening a dialog."""
    platform_name = _platform_name()
    executable = shutil.which("osascript") if platform_name == "macos" else None
    return {"available": bool(executable), "platform": platform_name}


def selected_roots(ctx: dict) -> tuple[Path, ...]:
    """Load only canonical, live, narrow roots previously returned by the OS."""
    if not _plugin_access(ctx):
        return ()
    rows = _workspace_config(ctx).get("selectedRoots", [])
    if not isinstance(rows, list):
        return ()
    roots: list[Path] = []
    seen: set[str] = set()
    for raw in rows[:_MAX_SELECTED_ROOTS]:
        if not isinstance(raw, str) or not raw or len(raw) > 4096:
            continue
        try:
            candidate = Path(raw)
            if not candidate.is_absolute():
                continue
            resolved = candidate.resolve(strict=True)
            # The stored value is already canonical. If an ancestor was later
            # replaced by a symlink, do not silently expand the saved grant.
            if str(resolved) != str(candidate) or not resolved.is_dir():
                continue
            if _is_too_broad_native_root(resolved):
                continue
        except (OSError, RuntimeError, TypeError, ValueError):
            continue
        key = str(resolved)
        if key not in seen:
            seen.add(key)
            roots.append(resolved)
    return tuple(roots)


def _is_too_broad_native_root(path: Path) -> bool:
    """Reject filesystem/system anchors instead of granting whole-machine access."""
    try:
        home = Path.home().resolve(strict=True)
        temporary = Path(tempfile.gettempdir()).resolve(strict=True)
        if path in {Path("/").resolve(), _BROAD_TEMP_ROOT, temporary, home}:
            return True
        # POSIX roots and first-level system directories contain unrelated
        # projects. Mounted volume roots are broad even when nested below /.
        system_locations = {Path(v).resolve() for k, v in os.environ.items()
                            if k.upper() in ('SYSTEMROOT', 'PROGRAMFILES', 'PROGRAMFILES(X86)') and v}
        if (os.name == 'nt' and (path == Path(path.anchor) or path in system_locations)):
            return True
        if (os.name != 'nt' and len(path.parts) <= 2) or path.is_mount():
            return True
    except (OSError, RuntimeError, ValueError):
        return True
    return False


def _is_loopback_request(ctx: dict) -> bool:
    """Fail closed unless the native-dialog request came from a local peer."""
    handler = ctx.get("handler")
    address = getattr(handler, "client_address", None)
    if not isinstance(address, (tuple, list)) or not address:
        return False
    host = address[0]
    if not isinstance(host, str):
        return False
    # Drop an IPv6 zone suffix before handing the literal to ipaddress.
    host = host.split("%", 1)[0]
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _choose_native_directory(initial_root: str | None = None) -> str | None:
    """Show the macOS folder chooser; return its POSIX path or None on cancel."""
    capability = native_picker_capability()
    if not capability["available"]:
        raise NotImplementedError("native directory picker is unavailable")
    args = [shutil.which("osascript") or "osascript", "-e", _MACOS_PICKER_SCRIPT]
    if initial_root is not None:
        args.append(initial_root)
    try:
        # This lock serializes native dialogs only. In particular, no settings
        # persistence lock is held while waiting for operator interaction.
        with _NATIVE_PICKER_LOCK:
            completed = run_external(
                subprocess.run,
                args,
                check=False,
                capture_output=True,
                text=True,
                timeout=_PICKER_TIMEOUT_SECONDS,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
            )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("native directory picker failed") from exc
    if completed.returncode != 0:
        raise RuntimeError("native directory picker failed")
    output = completed.stdout
    # osascript appends one line terminator. Remove exactly one so a legal
    # directory name ending in a newline remains intact.
    if output.endswith("\r\n"):
        output = output[:-2]
    elif output.endswith("\n"):
        output = output[:-1]
    if output == _PICKER_CANCELLED:
        return None
    return output


def _validate_native_selection(ctx: dict, value) -> Path:
    """Validate an OS-returned directory before it becomes a persistent grant."""
    if not isinstance(value, str) or not value or len(value) > 4096 or "\0" in value:
        raise ValueError("native picker did not return a valid directory")
    candidate = Path(value)
    if not candidate.is_absolute():
        raise ValueError("native picker did not return an absolute directory")
    try:
        selected = candidate.resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        raise ValueError("selected directory is no longer available") from None
    if not selected.is_dir():
        raise ValueError("selected path is not a directory")
    if _is_too_broad_native_root(selected):
        raise ValueError("choose a project directory, not a broad system location")
    if not os.access(selected, os.W_OK | os.X_OK):
        raise ValueError("selected directory is not writable")
    return selected


def _register_native_selection(ctx: dict, selected: Path) -> None:
    """Persist a native-returned directory as an explicit workspace grant."""
    path_text = str(selected)
    selected_now = selected_roots(ctx)
    if path_text not in {str(root) for root in selected_now} and len(selected_now) >= _MAX_SELECTED_ROOTS:
        raise ValueError("native workspace limit reached")

    def update(settings):
        config = settings.get(_WORKSPACE_SECTION, {})
        if not isinstance(config, dict):
            config = {}
        rows = config.get("selectedRoots", [])
        if not isinstance(rows, list):
            rows = []
        canonical = []
        seen = set()
        for raw in rows[:_MAX_SELECTED_ROOTS]:
            if not isinstance(raw, str):
                continue
            try:
                root = Path(raw)
                resolved = root.resolve(strict=True)
                if (not root.is_absolute() or str(root) != str(resolved)
                        or not resolved.is_dir() or _is_too_broad_native_root(resolved)):
                    continue
            except (OSError, RuntimeError, ValueError):
                continue
            key = str(resolved)
            if key not in seen:
                seen.add(key)
                canonical.append(key)
        if path_text not in seen:
            if len(canonical) >= _MAX_SELECTED_ROOTS:
                raise ValueError("native workspace limit reached")
            canonical.append(path_text)
        config["selectedRoots"] = canonical
        config["recentDirectories"] = _recent_with_directory(
            config.get("recentDirectories", []), selected
        )
        settings[_WORKSPACE_SECTION] = config

    # Commit only after the OS dialog closes and its returned path validates.
    settings_store.update_settings(ctx["state_dir"], update)


def _resolve_allowed(ctx: dict, value, *, writable: bool = False) -> Path:
    if not isinstance(value, (str, os.PathLike)):
        raise ValueError("workspace root must be an allowed existing directory")
    raw = os.fspath(value)
    if not isinstance(raw, str) or not raw.strip() or len(raw) > 4096:
        raise ValueError("workspace root must be an allowed existing directory")
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise ValueError("workspace root must be an absolute path")
    try:
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        raise ValueError("workspace root must be an allowed existing directory") from None
    roots = allowed_roots(ctx)
    if not any(resolved == root or resolved.is_relative_to(root) for root in roots):
        if resolved in (_BROAD_TEMP_ROOT, Path("/").resolve()):
            raise ValueError("workspace root is too broad; choose an existing project directory")
        launch_path = shlex.quote(str(resolved))
        raise ValueError(
            "workspace root is outside the configured workspace roots; "
            f"restart Xueness Web with --workspace-root {launch_path} to allow this existing directory"
        )
    if not resolved.is_dir():
        raise ValueError("workspace root must be a directory")
    if writable and not os.access(resolved, os.W_OK | os.X_OK):
        raise ValueError("workspace root is not writable")
    return resolved


def _workspace_config(ctx: dict) -> dict:
    settings = settings_store.load_settings(ctx["state_dir"])
    config = settings.get(_WORKSPACE_SECTION, {})
    return config if isinstance(config, dict) else {}


def get_default_root(ctx: dict) -> Path:
    """Return the saved default only while its owning plugins remain enabled."""
    roots = allowed_roots(ctx)
    if not roots:
        raise ValueError("no configured workspace roots are available")
    if _plugin_access(ctx):
        configured = _workspace_config(ctx).get("defaultRoot")
        if configured is not None:
            try:
                return _resolve_allowed(ctx, configured, writable=True)
            except ValueError:
                pass
    project = ctx.get("project_dir")
    if project is not None:
        try:
            return _resolve_allowed(ctx, project, writable=True)
        except ValueError:
            pass
    for root in roots:
        if os.access(root, os.W_OK | os.X_OK):
            return root
    return roots[0]


def _label(path: Path) -> str:
    return path.name or str(path)


def _is_isolated_session_root(ctx: dict, path: Path) -> bool:
    """Exclude generated web-runs/<session-id> directories from workspace recents."""
    try:
        parent = Path(ctx["web_runs"]).resolve(strict=True)
        return path.parent == parent and _SESSION_DIR_RE.fullmatch(path.name) is not None
    except (KeyError, OSError, RuntimeError, TypeError, ValueError):
        return False


def _recent_rows(ctx: dict) -> list[dict]:
    recent = _workspace_config(ctx).get("recentDirectories", [])
    if not isinstance(recent, list):
        return []
    rows: list[dict] = []
    seen: set[str] = set()
    for item in recent[:100]:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            continue
        try:
            path = _resolve_allowed(ctx, item["path"])
        except ValueError:
            continue
        if _is_isolated_session_root(ctx, path):
            continue
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        last_used = item.get("lastUsed")
        rows.append({"path": key, "label": _label(path),
                     "lastUsed": last_used if isinstance(last_used, str) else ""})
        if len(rows) >= _MAX_RECENT:
            break
    return rows


def remember_directory(ctx: dict, value) -> None:
    """Record a successful workspace use without changing the allowlist."""
    if not _plugin_access(ctx):
        return
    try:
        path = _resolve_allowed(ctx, value)
    except ValueError:
        return
    if _is_isolated_session_root(ctx, path):
        return

    def update(settings):
        config = settings.get(_WORKSPACE_SECTION, {})
        if not isinstance(config, dict):
            config = {}
        config["recentDirectories"] = _recent_with_directory(
            config.get("recentDirectories", []), path
        )
        settings[_WORKSPACE_SECTION] = config

    settings_store.update_settings(ctx["state_dir"], update)


def _recent_with_directory(recent, path: Path) -> list[dict]:
    if not isinstance(recent, list):
        recent = []
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    path_text = str(path)
    updated = [{"path": path_text, "lastUsed": now}]
    for item in recent:
        if (isinstance(item, dict) and isinstance(item.get("path"), str)
                and item["path"] != path_text):
            updated.append(item)
        if len(updated) >= _MAX_RECENT:
            break
    return updated


def _picker(ctx: dict, query: dict, default_root: Path) -> dict:
    roots = allowed_roots(ctx)
    value = query.get("path") if isinstance(query, dict) else None
    if isinstance(value, list):
        value = value[0] if value else None
    if value in (None, ""):
        target = default_root
    else:
        target = _resolve_allowed(ctx, value)
    include_hidden = query.get("includeHidden", False) if isinstance(query, dict) else False
    if isinstance(include_hidden, list):
        include_hidden = include_hidden[0] if include_hidden else False
    if isinstance(include_hidden, str):
        include_hidden = include_hidden.strip().lower() in ("1", "true", "yes", "on")
    from ..files.directory_api import list_level
    listing = list_level(roots, str(target), bool(include_hidden),
                         int(ctx.get("max_entries") or 1000), include_files=True)
    entries = []
    for item in listing.get("entries", []):
        try:
            entry_path = Path(item["path"])
            resolved = entry_path.resolve(strict=True)
            if not any(resolved == root or resolved.is_relative_to(root) for root in roots):
                continue
        except (KeyError, OSError, RuntimeError, ValueError):
            continue
        entries.append({"name": item["name"], "path": item["path"],
                        "type": item["type"],
                        "isSymlink": item.get("isSymbolicLink") is True})
    current = Path(listing["path"])
    parent_path = current.parent
    parent = (str(parent_path) if parent_path != current
              and any(parent_path == root or parent_path.is_relative_to(root) for root in roots)
              else None)
    return {"path": str(current), "parent": parent, "entries": entries,
            "truncated": bool(listing.get("truncated"))}


def _summary(ctx: dict, query: dict) -> dict:
    default_root = get_default_root(ctx)
    roots = [{"path": str(root), "label": _label(root)} for root in allowed_roots(ctx)]
    return {"defaultRoot": str(default_root), "allowedRoots": roots,
            "recentDirectories": _recent_rows(ctx),
            "picker": _picker(ctx, query, default_root)}


def dispatch(method: str, parts: list, query: dict, data: dict, ctx: dict):
    if not isinstance(parts, (list, tuple)) or tuple(parts[:2]) != ("api", "workspaces"):
        return None
    if not _plugin_access(ctx):
        return 403, {"error": "workspace settings require enabled settings and sessions plugins"}
    method = (method or "").upper()
    if tuple(parts) == ("api", "workspaces", "native-picker"):
        capability = native_picker_capability()
        desktop_chooser = ctx.get('desktop_choose_directory')
        if callable(desktop_chooser):
            from ... import plugin_runtime
            capability = {'available': plugin_runtime.is_enabled(ctx['state_dir'], 'desktop'),
                          'platform': _platform_name()}
        if method == "GET":
            # The dialog belongs to the server host. Do not advertise it to a
            # remote client that cannot safely interact with that desktop.
            if not _is_loopback_request(ctx):
                return 200, {**capability, "available": False}
            return 200, capability
        if method != "POST":
            return 405, {"error": "method not allowed"}
        # Host and same-origin checks run in Handler._guard. Also require the
        # actual peer to be local: a remote browser must never summon a dialog
        # on the server's desktop, even when the server opted into remote bind.
        if not _is_loopback_request(ctx):
            return 403, {"error": "native directory picker is local-only"}
        if not capability["available"]:
            return 501, {"error": "native directory picker is unavailable", **capability}
        if not isinstance(data, dict) or set(data) not in (set(), {"initialRoot"}):
            return 400, {"error": "expected an optional initialRoot"}
        initial_root = None
        if "initialRoot" in data:
            try:
                initial_root = str(_resolve_allowed(ctx, data["initialRoot"], writable=True))
            except ValueError as exc:
                return 400, {"error": str(exc)}
        else:
            try:
                initial_root = str(get_default_root(ctx))
            except ValueError:
                # No configured default is a valid case; macOS opens the
                # chooser at its normal location and the returned choice is
                # still independently validated below.
                pass
        try:
            selected = desktop_chooser(initial_root) if callable(desktop_chooser) else _choose_native_directory(initial_root)
        except NotImplementedError:
            return 501, {"error": "native directory picker is unavailable", **capability}
        except RuntimeError:
            return 500, {"error": "native directory picker failed"}
        # A dialog can outlive a settings change. Do not grant a returned path
        # after its owner/dependencies have been disabled in another request.
        if not _plugin_access(ctx) or (callable(desktop_chooser) and not plugin_runtime.is_enabled(ctx['state_dir'], 'desktop')):
            return 403, {"error": "directory picker plugin was disabled"}
        if selected is None:
            return 200, {"cancelled": True}
        try:
            selected_root = _validate_native_selection(ctx, selected)
            _register_native_selection(ctx, selected_root)
            return 200, {"root": str(selected_root)}
        except ValueError as exc:
            return 400, {"error": str(exc)}
        except OSError:
            return 500, {"error": "cannot save workspace preference"}
    if tuple(parts) == ("api", "workspaces"):
        if method != "GET":
            return 405, {"error": "method not allowed"}
        try:
            return 200, _summary(ctx, query or {})
        except ValueError as exc:
            return 400, {"error": str(exc)}
        except OSError:
            return 500, {"error": "workspace settings unavailable"}
    if len(parts) != 3 or parts[2] not in ("default", "confirm"):
        return 404, {"error": "workspace route not found"}
    if method != "POST":
        return 405, {"error": "method not allowed"}
    if not isinstance(data, dict) or set(data) != {"root"}:
        return 400, {"error": "expected root"}
    try:
        root = _resolve_allowed(ctx, data.get("root"), writable=True)
    except ValueError as exc:
        return 400, {"error": str(exc)}
    try:
        if parts[2] == "default":
            settings = settings_store.load_settings(ctx["state_dir"])
            config = settings.get(_WORKSPACE_SECTION, {})
            if not isinstance(config, dict):
                config = {}
            config["defaultRoot"] = str(root)
            settings[_WORKSPACE_SECTION] = config
            settings_store.save_settings(ctx["state_dir"], settings)
        # Confirmation records use only; it never alters allowedRoots.
        if parts[2] == "default":
            def update_default(settings):
                config = settings.get(_WORKSPACE_SECTION, {})
                if not isinstance(config, dict):
                    config = {}
                config["defaultRoot"] = str(root)
                config["recentDirectories"] = _recent_with_directory(
                    config.get("recentDirectories", []), root
                )
                settings[_WORKSPACE_SECTION] = config

            settings_store.update_settings(ctx["state_dir"], update_default)
            return 200, {"root": str(root), **_summary(ctx, {})}
        remember_directory(ctx, root)
        return 200, {"root": str(root)}
    except OSError:
        return 500, {"error": "cannot save workspace preference"}
