"""Read-only memory-track API for the Xueness settings UI.

Exposes the three curated memory tracks (``memory`` / ``user`` / ``key``) as
metadata only — never their contents. Path resolution is reused verbatim from
:mod:`xueness.memory` so the API and the runtime loader can never disagree
about where a track lives.

The module is **strictly read-only**: nothing under the memory root is ever
created, opened for writing, or modified. The memory root comes from the
``XUENESS_MEMORY_ROOT`` environment variable; when it is unset the endpoint
answers with an empty track list instead of failing, so a fresh install with no
memory store configured still renders the settings page.

Contract (docs/stage2-contract.md §5):

    GET /api/memory/tracks ->
        {"tracks": [{"name": "memory"|"user"|"key",
                     "path": str, "bytes": n, "present": bool}]}
"""
from __future__ import annotations

import os
from pathlib import Path

from ...memory import track_paths

MEMORY_ROOT_ENV = "XUENESS_MEMORY_ROOT"

# Fixed track order, matching the injection order of xueness.memory.load().
TRACK_NAMES = ("memory", "user", "key")


def memory_root() -> Path | None:
    """Configured memory root, or ``None`` when the env var is unset/blank."""
    raw = os.environ.get(MEMORY_ROOT_ENV)
    if raw is None:
        return None
    raw = raw.strip()
    if not raw:
        return None
    return Path(raw)


def resolve_cwd(ctx: dict) -> str:
    """Canonical cwd used for the project hash.

    Prefers the injected ``ctx["memory_cwd"]`` (deterministic and testable),
    falling back to the resolved project directory.
    """
    cwd = ctx.get("memory_cwd")
    if cwd:
        return str(cwd)
    return str(ctx.get("project_dir", ""))


def track_entries(ctx: dict) -> list[dict]:
    """Metadata for the three tracks; ``[]`` when no memory root is set."""
    root = memory_root()
    if root is None:
        return []
    paths = track_paths(root, resolve_cwd(ctx))
    tracks = []
    for name in TRACK_NAMES:
        path = Path(paths[name])
        present = False
        size = 0
        try:
            if path.is_file():
                present = True
                size = int(path.stat().st_size)
        except OSError:
            # Unreadable/vanished file: report as absent rather than failing.
            present = False
            size = 0
        tracks.append({
            "name": name,
            "path": str(path),
            "bytes": size,
            "present": present,
        })
    return tracks


def dispatch(method: str, parts: list[str], query: dict, data: dict, ctx: dict):
    """Handle ``GET /api/memory/tracks``; return ``None`` for anything else."""
    if method != "GET":
        return None
    if list(parts) != ["api", "memory", "tracks"]:
        return None
    return 200, {"tracks": track_entries(ctx)}
