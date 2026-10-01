"""Workspace listing and safe file previews owned by the files plugin."""
from __future__ import annotations

import base64
from pathlib import Path

from ...builtin_tools import _walk_files, path_in

MAX_TREE_FILES = 200
MAX_FILE_PREVIEW = 32000


def workspace_files(root: Path, *, max_tree_files=MAX_TREE_FILES, walk_files=None) -> dict:
    """Read-only workspace index. Skips symlink escapes and symlink directories."""
    root = root.resolve()
    files = []
    truncated = False
    walker = _walk_files if walk_files is None else walk_files
    for resolved in walker(root, root):
        rel = resolved.relative_to(root).as_posix()
        try:
            size = resolved.stat().st_size
        except OSError:
            continue
        files.append({"path": rel, "size": size})
        if len(files) >= max_tree_files:
            truncated = True
            break
    files.sort(key=lambda item: item["path"])
    return {"files": files, "truncated": truncated, "count": len(files)}


def workspace_preview(root: Path, relative: str, *, max_file_preview=MAX_FILE_PREVIEW,
                      path_resolver=None) -> dict:
    """Read a small UTF-8 text file inside the workspace. No writes."""
    if not isinstance(relative, str) or not relative.strip() or len(relative) > 1024:
        raise ValueError("path must be a relative workspace path")
    target = (path_in if path_resolver is None else path_resolver)(root, relative.strip())
    if not target.is_file():
        raise ValueError("not a file")
    size = target.stat().st_size
    if size > 1_000_000:
        raise ValueError("file too large")
    raw = target.read_bytes()[: max_file_preview + 1]
    if b"\0" in raw[:4096]:
        raise ValueError("binary file")
    text = raw.decode("utf-8")
    return {"path": relative.strip(), "size": size,
            "truncated": size > max_file_preview,
            "text": text[:max_file_preview]}


# Inline binary-preview whitelist: suffix -> (mime, byte cap).
BINARY_PREVIEW_SUFFIXES = {
    ".docx": ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", 8_000_000),
    ".xlsx": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", 8_000_000),
    ".pptx": ("application/vnd.openxmlformats-officedocument.presentationml.presentation", 8_000_000),
    ".png": ("image/png", 2_000_000),
    ".jpg": ("image/jpeg", 2_000_000),
    ".jpeg": ("image/jpeg", 2_000_000),
    ".gif": ("image/gif", 2_000_000),
    ".webp": ("image/webp", 2_000_000),
    ".pdf": ("application/pdf", 4_000_000),
    ".mp3": ("audio/mpeg", 8_000_000),
    ".wav": ("audio/wav", 8_000_000),
    ".ogg": ("audio/ogg", 8_000_000),
    ".mp4": ("video/mp4", 8_000_000),
    ".webm": ("video/webm", 8_000_000),
}
IMAGE_PREVIEW_SUFFIXES = {
    suffix: mime for suffix, (mime, _cap) in BINARY_PREVIEW_SUFFIXES.items()
    if mime.startswith("image/")
}
MAX_IMAGE_PREVIEW = 2_000_000


def workspace_binary_preview(root: Path, relative: str, *, suffixes=None,
                             path_resolver=None) -> dict:
    """Read a whitelisted binary file inside the workspace as a data URL."""
    if not isinstance(relative, str) or not relative.strip() or len(relative) > 1024:
        raise ValueError("path must be a relative workspace path")
    stripped = relative.strip()
    suffix = Path(stripped).suffix.lower()
    if suffix in ('.doc', '.xls', '.ppt', '.docm', '.xlsm', '.pptm'):
        raise ValueError('Legacy or macro-enabled Office formats are not supported; save a non-macro DOCX, XLSX, or PPTX copy.')
    spec = (BINARY_PREVIEW_SUFFIXES if suffixes is None else suffixes).get(suffix)
    if spec is None:
        raise ValueError("not a previewable file")
    mime, cap = spec
    target = (path_in if path_resolver is None else path_resolver)(root, stripped)
    if not target.is_file():
        raise ValueError("not a file")
    size = target.stat().st_size
    if size > cap:
        raise ValueError("file too large")
    if suffix in (".docx", ".xlsx", ".pptx"):
        from ...office_preview import preview
        try:
            office = preview(target)
        except Exception:
            raise ValueError("invalid or oversized Office document") from None
        return {"path": stripped, "size": size,
                "truncated": office["truncated"], "office": office}
    data_url = "data:%s;base64,%s" % (mime, base64.b64encode(target.read_bytes()).decode("ascii"))
    if mime.startswith("image/"):
        return {"path": stripped, "size": size, "truncated": False,
                "image": data_url}
    return {"path": stripped, "size": size, "truncated": False,
            "embed": {"mime": mime, "dataUrl": data_url}}


def workspace_image_preview(root: Path, relative: str, *, suffixes=None,
                             path_resolver=None) -> dict:
    """Back-compat alias: serves every whitelisted binary preview kind."""
    return workspace_binary_preview(root, relative, suffixes=suffixes,
                                    path_resolver=path_resolver)
