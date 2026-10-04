"""Filesystem-link fixtures with explicit Windows capability handling.

File symbolic links and directory junctions are different Windows reparse
mechanisms. Tests that promise to exercise a symbolic link must create a real
symbolic link or report that this process lacks the capability; a hard link is
never an equivalent fixture.
"""
from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path


_FILE_ATTRIBUTE_REPARSE_POINT = 0x400


def make_symlink(link: str | os.PathLike[str], target: str | os.PathLike[str], *,
                 target_is_directory: bool = False) -> None:
    """Create an actual symbolic link, skipping only unavailable Windows privilege.

    All errors other than WinError 1314 on Windows remain test failures. This
    keeps malformed paths, ACL mistakes, and unrelated I/O errors visible.
    """
    link_path = Path(link)
    target_path = Path(target)
    try:
        link_path.symlink_to(target_path, target_is_directory=target_is_directory)
    except OSError as exc:
        if os.name == "nt" and getattr(exc, "winerror", None) == 1314:
            raise unittest.SkipTest(
                "real symbolic-link capability unavailable: Windows returned "
                "WinError 1314 (SeCreateSymbolicLinkPrivilege is not available)"
            ) from exc
        raise
    except NotImplementedError as exc:
        if os.name == "nt":
            raise unittest.SkipTest(
                "real symbolic-link capability unavailable: this Windows filesystem "
                "does not implement symbolic links"
            ) from exc
        raise


def is_reparse_point(path: str | os.PathLike[str]) -> bool:
    """Return whether ``path`` itself has Windows FILE_ATTRIBUTE_REPARSE_POINT."""
    try:
        return bool(Path(path).lstat().st_file_attributes & _FILE_ATTRIBUTE_REPARSE_POINT)
    except (AttributeError, FileNotFoundError, OSError):
        return False


def make_directory_junction(link: str | os.PathLike[str],
                            target: str | os.PathLike[str]) -> Path:
    """Create a real Windows directory junction with ``mklink /J``.

    The caller must use a fresh link path and an existing directory target on
    the same local volume. Failure to create the junction is a capability skip;
    a successful command that did not create a reparse point is a test failure.
    """
    if os.name != "nt":
        raise unittest.SkipTest("Windows directory junction coverage requires Windows")

    link_path = Path(link)
    target_path = Path(target)
    if os.path.lexists(link_path):
        raise FileExistsError(f"junction path already exists: {link_path}")
    if not target_path.is_dir():
        raise NotADirectoryError(f"junction target must be an existing directory: {target_path}")
    if os.path.splitdrive(os.path.abspath(link_path))[0].casefold() != os.path.splitdrive(
            os.path.abspath(target_path))[0].casefold():
        raise ValueError("directory junction target must be on the same volume")

    command = os.environ.get("COMSPEC", "cmd.exe")
    try:
        proc = subprocess.run(
            [command, "/d", "/c", "mklink", "/J", str(link_path), str(target_path)],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise unittest.SkipTest(
            f"Windows directory-junction capability unavailable: mklink /J could not run ({exc})"
        ) from exc

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "no diagnostic").strip()
        raise unittest.SkipTest(
            "Windows directory-junction capability unavailable: "
            f"mklink /J returned {proc.returncode}: {detail}"
        )
    if not is_reparse_point(link_path):
        if os.path.lexists(link_path) and link_path.is_dir():
            os.rmdir(link_path)
        raise AssertionError("mklink /J succeeded but the result is not a reparse point")
    if os.path.normcase(os.path.normpath(str(link_path.resolve(strict=True)))) != os.path.normcase(
            os.path.normpath(str(target_path.resolve(strict=True)))):
        os.rmdir(link_path)
        raise AssertionError("junction does not resolve to its requested target")
    return link_path


def make_directory_boundary_link(link: str | os.PathLike[str],
                                 target: str | os.PathLike[str]) -> str:
    """Create the directory redirect used by a boundary test.

    Prefer a real directory symlink. On Windows only, fall back to a real
    directory junction when the process cannot create the symlink. The return
    value identifies which filesystem mechanism the test actually exercised.
    """
    try:
        make_symlink(link, target, target_is_directory=True)
        return "symlink"
    except unittest.SkipTest:
        if os.name != "nt":
            raise
        make_directory_junction(link, target)
        return "junction"


def remove_directory_junction(link: str | os.PathLike[str]) -> None:
    """Remove the junction entry only; never recurse into its target."""
    link_path = Path(link)
    if not os.path.lexists(link_path):
        return
    if not is_reparse_point(link_path):
        raise AssertionError(f"refusing to remove non-reparse path as a junction: {link_path}")
    os.rmdir(link_path)
