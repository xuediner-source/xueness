#!/usr/bin/env python3
"""Prepare a local, allowlisted Xueness source archive.

This script does not publish, tag, or push. It creates local files in
``release/`` only after the source tree, built web assets, and archive pass the
release gates. Use ``--root`` to validate the workflow against an isolated
fixture tree.
"""

from __future__ import annotations

import argparse
import ast
import gzip
import hashlib
import io
import importlib.util
import json
import os
import re
import shutil
import stat
import sys
import tarfile
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterable


ARCHIVE_SUFFIXES = {
    ".css", ".eot", ".gif", ".html", ".ico", ".jpeg", ".jpg", ".js",
    ".json", ".mjs", ".png", ".svg", ".toml", ".ttf", ".txt", ".ts",
    ".tsx", ".wasm", ".webmanifest", ".webp", ".woff", ".woff2", ".yaml",
    ".yml", ".py", ".sh", ".cjs",
}
SOURCE_SUFFIXES = ARCHIVE_SUFFIXES - {".eot", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".ttf", ".wasm", ".webp", ".woff", ".woff2"}
PUBLIC_SUFFIXES = {
    ".css", ".eot", ".gif", ".html", ".ico", ".jpeg", ".jpg", ".js",
    ".json", ".mjs", ".png", ".svg", ".txt", ".wasm", ".webmanifest",
    ".ttf", ".webp", ".woff", ".woff2",
}
WEBAPP_SOURCE_SUFFIXES = SOURCE_SUFFIXES | {
    ".eot", ".gif", ".ico", ".jpeg", ".jpg", ".png", ".ttf", ".wasm",
    ".webp", ".woff", ".woff2",
}
DIST_SUFFIXES = {
    ".css", ".eot", ".gif", ".html", ".ico", ".jpeg", ".jpg", ".js",
    ".json", ".mjs", ".png", ".svg", ".txt", ".ttf", ".wasm", ".webmanifest",
    ".webp", ".woff", ".woff2",
}
TEST_SUFFIXES = {
    ".css", ".html", ".js", ".json", ".mjs", ".py", ".sh", ".toml",
    ".ts", ".tsx", ".txt", ".yaml", ".yml",
}

EXCLUDED_DIRECTORY_NAMES = {
    ".git", ".state", ".xueness-data", ".web-runs", ".vite", ".cache",
    ".pytest_cache", ".mypy_cache", ".ruff_cache", "__pycache__", "node_modules",
    "screenshots", "reviews", "integration-lab", "release", "vendor", "legacy",
    "log", "logs", "coverage", "playwright-report", "test-results",
    ".venv", ".build", "runtime",
}
FORBIDDEN_ARCHIVE_COMPONENTS = {
    ".git", ".state", ".xueness-data", ".web-runs", ".vite", ".cache",
    ".pytest_cache", ".mypy_cache", ".ruff_cache", "__pycache__", "node_modules",
    "vendor", "legacy", "material-icons", "screenshots", "reviews", "integration-lab",
    ".venv", ".build", "runtime",
}
FORBIDDEN_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".pkcs12", ".keystore"}
FORBIDDEN_EXACT_NAMES = {
    "credentials", "credentials.json", "credential.json", "secrets.json",
    "secrets.yaml", "secrets.yml", "secrets.toml", "service-account.json",
    "id_rsa", "id_ed25519", "id_ecdsa", "authorized_keys", "known_hosts",
    "token.json", "tokens.json", "oauth-token.json", "access-token.json",
}

PRIVATE_KEY_PATTERN = re.compile(
    r"-----BEGIN (?:OPENSSH |RSA |EC |DSA |PGP )?PRIVATE KEY-----", re.IGNORECASE
)
PROVIDER_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("openai-api-key", re.compile(r"\bsk-(?:proj-|live-|prod-)?[A-Za-z0-9_-]{24,}\b")),
    ("anthropic-api-key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{24,}\b")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("aws-access-key", re.compile(r"\bAKIA[A-Z0-9]{16}\b")),
    ("github-token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b")),
    ("slack-token", re.compile(r"\bxox[baprs]-[0-9A-Za-z-]{20,}\b")),
)
ASSIGNED_SECRET_PATTERN = re.compile(
    r"\b(?:api[-_]?key|api[-_]?token|access[-_]?token|refresh[-_]?token|"
    r"client[-_]?secret|secret[-_]?key|authorization|password)\b"
    r"[\"']?\s*[:=]\s*(?:Bearer\s+)?[\"']?([A-Za-z0-9/+_.=-]{24,})",
    re.IGNORECASE,
)
TEST_DUMMY_MARKER = re.compile(
    r"\b(?:fake|dummy|example|fixture|placeholder|redacted|not[-_ ]real|"
    r"test[-_ ]?(?:only|key|token|secret))\b",
    re.IGNORECASE,
)
TEST_DUMMY_VALUE = re.compile(r"(?:fake|dummy|example|placeholder|redacted|test[-_])", re.IGNORECASE)
RETIRED_SOURCE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("vendor import/reference", re.compile(r"@zcode/|vendor/zcode", re.IGNORECASE)),
    ("legacy shell entry", re.compile(r"legacy/ZcodeShell|shell\s*=\s*zcode", re.IGNORECASE)),
)
RETIRED_ASSET_PATTERN = re.compile(
    r"@zcode/|vendor/zcode|legacy/ZcodeShell|shell=zcode|material-icons/",
    re.IGNORECASE,
)


class ReleasePreparationError(Exception):
    """A safe-to-report release preparation failure."""


@dataclass(frozen=True)
class SourceFile:
    archive_path: PurePosixPath
    source_path: Path | None
    source_root: Path | None
    inline_data: bytes | None
    mode: int


@dataclass(frozen=True)
class SecretFinding:
    path: str
    kind: str


def _version_from_source(root: Path) -> str:
    init_path = root / "xueness" / "__init__.py"
    _assert_regular_file(root, PurePosixPath("xueness/__init__.py"))
    try:
        tree = ast.parse(init_path.read_text(encoding="utf-8"), filename="xueness/__init__.py")
    except (OSError, UnicodeError, SyntaxError) as error:
        raise ReleasePreparationError("cannot read xueness/__init__.py version") from error
    for node in tree.body:
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, ast.AnnAssign):
            targets = [node.target]
        else:
            continue
        if any(isinstance(target, ast.Name) and target.id == "__version__" for target in targets):
            if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                version = node.value.value
                if re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?", version):
                    return version
            break
    raise ReleasePreparationError("xueness/__init__.py has no valid __version__ string")


def _assert_no_symlink(path: Path, relative_path: PurePosixPath) -> os.stat_result:
    try:
        metadata = path.lstat()
    except OSError as error:
        raise ReleasePreparationError(f"required source is missing: {relative_path.as_posix()}") from error
    if stat.S_ISLNK(metadata.st_mode):
        raise ReleasePreparationError(f"symlink is not allowed: {relative_path.as_posix()}")
    return metadata


def _assert_no_symlink_components(root: Path, relative_path: PurePosixPath) -> os.stat_result:
    cursor = root
    metadata: os.stat_result | None = None
    for index, part in enumerate(relative_path.parts):
        cursor = cursor / part
        prefix = PurePosixPath(*relative_path.parts[: index + 1])
        metadata = _assert_no_symlink(cursor, prefix)
    if metadata is None:
        raise ReleasePreparationError("unsafe archive path")
    return metadata


def _assert_regular_file(root: Path, relative_path: PurePosixPath) -> Path:
    path = root.joinpath(*relative_path.parts)
    metadata = _assert_no_symlink_components(root, relative_path)
    if not stat.S_ISREG(metadata.st_mode):
        raise ReleasePreparationError(f"expected a regular file: {relative_path.as_posix()}")
    _assert_safe_name(relative_path)
    return path


def _assert_safe_name(relative_path: PurePosixPath) -> None:
    parts = relative_path.parts
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise ReleasePreparationError("unsafe archive path")
    if any(part.casefold() in FORBIDDEN_ARCHIVE_COMPONENTS for part in parts):
        raise ReleasePreparationError(f"excluded path is not allowed: {relative_path.as_posix()}")
    for part in parts:
        lowered = part.casefold()
        if lowered == ".env" or lowered.startswith(".env."):
            raise ReleasePreparationError(f"environment file is not allowed: {relative_path.as_posix()}")
    basename = parts[-1].casefold()
    if basename in FORBIDDEN_EXACT_NAMES or Path(basename).suffix in FORBIDDEN_SUFFIXES:
        raise ReleasePreparationError(f"credential filename is not allowed: {relative_path.as_posix()}")


def _required_directory(root: Path, relative_path: PurePosixPath) -> Path:
    path = root.joinpath(*relative_path.parts)
    metadata = _assert_no_symlink_components(root, relative_path)
    if not stat.S_ISDIR(metadata.st_mode):
        raise ReleasePreparationError(f"expected a directory: {relative_path.as_posix()}")
    return path


def _walk_allowlisted_tree(
    root: Path,
    relative_directory: PurePosixPath,
    suffixes: set[str],
    *,
    excluded_names: set[str] | None = None,
    excluded_relative_directories: set[str] | None = None,
) -> list[SourceFile]:
    base = _required_directory(root, relative_directory)
    excluded_names = EXCLUDED_DIRECTORY_NAMES | (excluded_names or set())
    excluded_relative_directories = {
        path.casefold() for path in (excluded_relative_directories or set())
    }
    excluded_name_set = {name.casefold() for name in excluded_names}
    collected: list[SourceFile] = []
    pending = [base]

    while pending:
        directory = pending.pop()
        rel_dir = PurePosixPath(directory.relative_to(root).as_posix())
        try:
            with os.scandir(directory) as scanner:
                children = sorted(scanner, key=lambda item: item.name.casefold())
        except OSError as error:
            raise ReleasePreparationError(f"cannot read allowlisted directory: {rel_dir.as_posix()}") from error

        for child in children:
            child_path = Path(child.path)
            child_rel = rel_dir / child.name
            try:
                metadata = child.stat(follow_symlinks=False)
            except OSError as error:
                raise ReleasePreparationError(f"cannot inspect path: {child_rel.as_posix()}") from error
            if stat.S_ISLNK(metadata.st_mode):
                raise ReleasePreparationError(f"symlink is not allowed: {child_rel.as_posix()}")
            if stat.S_ISDIR(metadata.st_mode):
                if child.name.casefold() in excluded_name_set:
                    continue
                if child_rel.as_posix().casefold() in excluded_relative_directories:
                    continue
                pending.append(child_path)
                continue
            if not stat.S_ISREG(metadata.st_mode):
                raise ReleasePreparationError(f"non-regular file is not allowed: {child_rel.as_posix()}")
            if child_path.suffix.casefold() not in suffixes:
                continue
            _assert_safe_name(child_rel)
            _assert_no_symlink_components(root, child_rel)
            collected.append(
                SourceFile(
                    archive_path=child_rel,
                    source_path=child_path,
                    source_root=root,
                    inline_data=None,
                    mode=stat.S_IMODE(metadata.st_mode),
                )
            )

    return collected


def _collect_files(root: Path, version: str) -> list[SourceFile]:
    files: list[SourceFile] = []
    files.extend(_walk_allowlisted_tree(root, PurePosixPath("xueness"), SOURCE_SUFFIXES))
    files.extend(
        _walk_allowlisted_tree(
            root,
            PurePosixPath("webapp/src"),
            WEBAPP_SOURCE_SUFFIXES,
            excluded_names={"legacy"},
        )
    )
    files.extend(
        _walk_allowlisted_tree(
            root,
            PurePosixPath("webapp/public"),
            PUBLIC_SUFFIXES,
            excluded_relative_directories={"webapp/public/material-icons"},
        )
    )
    files.extend(_walk_allowlisted_tree(root, PurePosixPath("webapp/dist"), DIST_SUFFIXES))
    files.extend(_walk_allowlisted_tree(root, PurePosixPath("tests"), TEST_SUFFIXES))
    files.extend(_walk_allowlisted_tree(root, PurePosixPath("desktop"), SOURCE_SUFFIXES))
    files.extend(_walk_allowlisted_tree(root, PurePosixPath(".github/workflows"), SOURCE_SUFFIXES))

    explicit_paths = (
        ".dockerignore",
        ".gitignore",
        "bin/xueness",
        "install.sh",
        "Dockerfile",
        "compose.yaml",
        "LICENSE",
        "NOTICE.md",
        "webapp/index.html",
        "webapp/package.json",
        "webapp/package-lock.json",
        "webapp/vite.config.ts",
        "webapp/tsconfig.json",
        "webapp/tsconfig.typecheck.json",
        "webapp/run-tests.mjs",
        "webapp/verify-plugin-disclosures.mjs",
        "webapp/verify-automation-redesign.mjs",
        "webapp/verify-desktop-onboarding.mjs",
        "webapp/run-validate-events.mjs",
        "tools/check-parity-hygiene.mjs",
        "tools/validate-events-v1.ts",
        "tools/protocol-v1-golden.json",
        "tools/prepare_release.py",
        "tools/check_plugin_architecture.py",
        "tools/check_frontend_design.mjs",
        "tools/check_frontend_bundle.mjs",
        "tools/generate_web_notices.py",
        "tools/license-texts/react-remove-scroll-bar-upstream-LICENSE.source.json",
        "tools/license-texts/react-remove-scroll-bar-upstream-LICENSE.txt",
        "AGENTS.md",
        "CONTRIBUTING.md",
        "docs/xueness-start-interface.md",
        "docs/xueness-settings-workspaces.md",
        "docs/xueness-project-history-2026-10-01.md",
        "docs/xueness-local-lightweight-mode.md",
        "docs/xueness-harness-feature-audit-2026-10-01.md",
        "docs/xueness-plugin-architecture.md",
        "docs/xueness-subagent-coordination.md",
        "docs/windows-updater-handoff.md",
        "docs/frontend-optimization-2026-10-04.md",
        "docs/images/d-frontend-optimization-2026-10-04-plugins-light.png",
        "docs/images/d-frontend-optimization-2026-10-04-plugins-dark.png",
        "docs/images/d-frontend-optimization-2026-10-04-plugins-420-dark.png",
        "docs/images/d-frontend-optimization-2026-10-04-diff-light.png",
        "docs/release-preparation.md",
        "docs/github-publishing.md",
        "docs/xueness-desktop.md",
        "docs/xueness-network-tools.md",
        "docs/xueness-reliability-and-updates.md",
        "docs/desktop-onboarding-2026-10-06.md",
        "docs/frontend-handoff-prompt.md",
    )
    for path_text in explicit_paths:
        relative_path = PurePosixPath(path_text)
        source_path = _assert_regular_file(root, relative_path)
        metadata = source_path.lstat()
        files.append(
            SourceFile(
                archive_path=relative_path,
                source_path=source_path,
                source_root=root,
                inline_data=None,
                mode=stat.S_IMODE(metadata.st_mode),
            )
        )

    readme = _minimal_readme(version).encode("utf-8")
    files.append(
        SourceFile(
            archive_path=PurePosixPath("README.md"),
            source_path=None,
            source_root=None,
            inline_data=readme,
            mode=0o644,
        )
    )
    files.sort(key=lambda item: item.archive_path.as_posix().casefold())
    seen: set[str] = set()
    for item in files:
        archive_name = item.archive_path.as_posix()
        _assert_safe_name(item.archive_path)
        if archive_name in seen:
            raise ReleasePreparationError(f"duplicate allowlisted path: {archive_name}")
        seen.add(archive_name)
    return files


def _minimal_readme(version: str) -> str:
    return f"""# Xueness {version} source archive

This source archive is prepared from an explicit allowlist. The preparation
tool does not publish files, create tags, or sign artifacts. Release downloads
and the complete repository are available at:

- https://github.com/xuediner-source/xueness
- https://github.com/xuediner-source/xueness/releases

The backend uses Python 3.10 or newer and the Python standard library. The
prebuilt browser interface is included under `webapp/dist/`; Node.js is only
needed to rebuild or test that interface. Docker Compose is optional.

Start from this directory with `python3 -m xueness.web --port 8138`, then open
`http://127.0.0.1:8138`. The default port without this option is
`http://127.0.0.1:8137`. Configure a real model endpoint in Settings before
sending a task. Local small models can use the lightweight profile described
in `docs/xueness-local-lightweight-mode.md`. Use `python3 -m xueness` for the Agent CLI.

Backend checks: `python3 -m unittest discover -s tests`. To rebuild the web
interface: `npm --prefix webapp ci`, then `npm --prefix webapp run build`.

Self-contained Windows and macOS installers use the desktop host in
`desktop/`. Build them on the target operating system and architecture;
see `docs/xueness-desktop.md` for the runtime and installer build commands.

Every product feature must be implemented by a trusted bundled plugin and
listed in Settings > Plugins, including each new feature. See `AGENTS.md`,
`CONTRIBUTING.md` and `docs/xueness-plugin-architecture.md`. Run
`python3 tools/check_plugin_architecture.py` before handing off a change.

## Get the complete checkout

```sh
git clone https://github.com/xuediner-source/xueness.git
cd xueness
```

Use the desktop installer for your operating system and architecture if you
prefer an application with its Python and Node.js runtimes already bundled.

Model credentials and other online-service configuration must be supplied by
the operator at runtime. This archive contains no runtime state or credentials.
See `docs/release-preparation.md`, `LICENSE`, and `NOTICE.md` before use or
redistribution.
"""


def _check_release_gates(root: Path, files: list[SourceFile]) -> None:
    gate_path = Path(__file__).with_name("check_plugin_architecture.py")
    gate_spec = importlib.util.spec_from_file_location("xueness_plugin_architecture_release_gate", gate_path)
    if gate_spec is None or gate_spec.loader is None:
        raise ReleasePreparationError("plugin architecture gate is unavailable")
    gate = importlib.util.module_from_spec(gate_spec)
    gate_spec.loader.exec_module(gate)
    try:
        problems = gate.audit(root)
    except (OSError, ValueError, SyntaxError) as error:
        raise ReleasePreparationError("plugin architecture gate failed: " + str(error)) from error
    if problems:
        raise ReleasePreparationError("plugin architecture gate failed: " + "; ".join(problems))
    if (root / "vendor").exists() or (root / "vendor").is_symlink():
        raise ReleasePreparationError("vendor tree remains; remove retired vendor sources before preparing release")
    if (root / "webapp" / "src" / "legacy").exists() or (root / "webapp" / "src" / "legacy").is_symlink():
        raise ReleasePreparationError("legacy source tree remains; remove it before preparing release")
    dist_icons = root / "webapp" / "dist" / "material-icons"
    if dist_icons.exists() or dist_icons.is_symlink():
        raise ReleasePreparationError("built assets still contain retired material-icons")

    dist_files = [file for file in files if file.archive_path.parts[:2] == ("webapp", "dist")]
    dist_names = {file.archive_path.as_posix() for file in dist_files}
    if "webapp/dist/index.html" not in dist_names:
        raise ReleasePreparationError("built web assets are missing webapp/dist/index.html")
    if not any(path.startswith("webapp/dist/assets/") and path.endswith(".js") for path in dist_names):
        raise ReleasePreparationError("built web assets are missing JavaScript bundles")

    source_files = [
        file for file in files
        if file.archive_path.parts[0] == "xueness"
        or file.archive_path.parts[:2] == ("webapp", "src")
    ]
    for file in source_files:
        payload = _read_source_file(file)
        try:
            text = payload.decode("utf-8")
        except UnicodeDecodeError:
            continue
        for label, pattern in RETIRED_SOURCE_PATTERNS:
            if pattern.search(text):
                raise ReleasePreparationError(
                    f"retired shell/vendor reference in source: {file.archive_path.as_posix()} ({label})"
                )

    for file in dist_files:
        if file.archive_path.suffix.casefold() not in {".css", ".html", ".js", ".mjs"}:
            continue
        payload = _read_source_file(file)
        text = payload.decode("utf-8", errors="ignore")
        if RETIRED_ASSET_PATTERN.search(text):
            raise ReleasePreparationError(f"retired shell/vendor reference in built asset: {file.archive_path.as_posix()}")


def _read_source_file(file: SourceFile) -> bytes:
    if file.inline_data is not None:
        return file.inline_data
    if file.source_path is None:
        raise ReleasePreparationError(f"missing source data: {file.archive_path.as_posix()}")
    try:
        current = (
            _assert_no_symlink_components(file.source_root, file.archive_path)
            if file.source_root is not None
            else file.source_path.lstat()
        )
        if stat.S_ISLNK(current.st_mode) or not stat.S_ISREG(current.st_mode):
            raise ReleasePreparationError(f"source changed to a non-regular file: {file.archive_path.as_posix()}")
        return file.source_path.read_bytes()
    except OSError as error:
        raise ReleasePreparationError(f"cannot read source: {file.archive_path.as_posix()}") from error


def _filename_secret_kind(path: str) -> str | None:
    parts = PurePosixPath(path).parts
    for part in parts:
        lowered = part.casefold()
        if lowered == ".env" or lowered.startswith(".env."):
            return "environment-file"
        if lowered in FORBIDDEN_EXACT_NAMES or Path(lowered).suffix in FORBIDDEN_SUFFIXES:
            return "credential-filename"
    return None


def _test_placeholder(line: str, value: str, path: str) -> bool:
    if not path.startswith("tests/"):
        return False
    return bool(TEST_DUMMY_MARKER.search(line) or TEST_DUMMY_VALUE.search(value))


def _scan_secret_payload(path: str, payload: bytes) -> list[SecretFinding]:
    name_kind = _filename_secret_kind(path)
    if name_kind:
        return [SecretFinding(path, name_kind)]
    text = payload.decode("utf-8", errors="ignore")
    findings: list[SecretFinding] = []
    for line in text.splitlines():
        if PRIVATE_KEY_PATTERN.search(line):
            if not _test_placeholder(line, line, path):
                findings.append(SecretFinding(path, "private-key-material"))
        for kind, pattern in PROVIDER_PATTERNS:
            for match in pattern.finditer(line):
                if not _test_placeholder(line, match.group(0), path):
                    findings.append(SecretFinding(path, kind))
        match = ASSIGNED_SECRET_PATTERN.search(line)
        if match and not _test_placeholder(line, match.group(1), path):
            findings.append(SecretFinding(path, "assigned-provider-secret"))
    return findings


def _dedupe_findings(findings: Iterable[SecretFinding]) -> list[SecretFinding]:
    return sorted(set(findings), key=lambda item: (item.path, item.kind))


def _raise_for_findings(findings: Iterable[SecretFinding]) -> None:
    unique = _dedupe_findings(findings)
    if not unique:
        return
    lines = ["secret scan rejected the archive (values are redacted):"]
    lines.extend(f"  {finding.path}: {finding.kind}" for finding in unique)
    raise ReleasePreparationError("\n".join(lines))


def _scan_sources(files: list[SourceFile]) -> None:
    findings: list[SecretFinding] = []
    for file in files:
        name = file.archive_path.as_posix()
        finding = _filename_secret_kind(name)
        if finding:
            findings.append(SecretFinding(name, finding))
            continue
        findings.extend(_scan_secret_payload(name, _read_source_file(file)))
    _raise_for_findings(findings)


def _add_tar_file(archive: tarfile.TarFile, package_prefix: str, source: SourceFile) -> None:
    name = f"{package_prefix}/{source.archive_path.as_posix()}"
    info = tarfile.TarInfo(name)
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    info.mode = source.mode & 0o777
    if source.inline_data is not None:
        data = source.inline_data
        info.size = len(data)
        archive.addfile(info, io.BytesIO(data))
        return
    if source.source_path is None:
        raise ReleasePreparationError(f"missing source data: {source.archive_path.as_posix()}")
    metadata = (
        _assert_no_symlink_components(source.source_root, source.archive_path)
        if source.source_root is not None
        else source.source_path.lstat()
    )
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise ReleasePreparationError(f"source changed to a non-regular file: {source.archive_path.as_posix()}")
    info.size = metadata.st_size
    with source.source_path.open("rb") as source_stream:
        archive.addfile(info, source_stream)


def _write_source_archive(archive_path: Path, version: str, files: list[SourceFile]) -> None:
    package_prefix = f"xueness-{version}"
    try:
        with archive_path.open("xb") as raw_stream:
            with gzip.GzipFile(fileobj=raw_stream, mode="wb", filename="", mtime=0, compresslevel=9) as gzip_stream:
                with tarfile.open(fileobj=gzip_stream, mode="w", format=tarfile.PAX_FORMAT) as archive:
                    for source in files:
                        _add_tar_file(archive, package_prefix, source)
    except FileExistsError as error:
        raise ReleasePreparationError("source archive already exists; choose a clean output directory") from error
    except OSError as error:
        raise ReleasePreparationError("failed to write source archive") from error


def _inspect_archive(archive_path: Path, version: str) -> list[dict[str, object]]:
    expected_prefix = f"xueness-{version}"
    files: list[dict[str, object]] = []
    findings: list[SecretFinding] = []
    try:
        with tarfile.open(archive_path, mode="r:gz") as archive:
            for member in archive.getmembers():
                member_path = PurePosixPath(member.name)
                if member_path.is_absolute() or ".." in member_path.parts:
                    raise ReleasePreparationError("archive contains an unsafe path")
                if not member.isfile() or member.issym() or member.islnk():
                    raise ReleasePreparationError("archive contains a non-regular entry")
                if not member_path.parts or member_path.parts[0] != expected_prefix:
                    raise ReleasePreparationError("archive entry is outside its package root")
                relative_member = PurePosixPath(*member_path.parts[1:])
                _assert_safe_name(relative_member)
                stream = archive.extractfile(member)
                if stream is None:
                    raise ReleasePreparationError("archive contains an unreadable file")
                payload = stream.read()
                relative_name = relative_member.as_posix()
                findings.extend(_scan_secret_payload(relative_name, payload))
                files.append(
                    {
                        "path": relative_name,
                        "size": len(payload),
                        "sha256": hashlib.sha256(payload).hexdigest(),
                    }
                )
    except (OSError, tarfile.TarError) as error:
        raise ReleasePreparationError("failed to inspect source archive") from error
    _raise_for_findings(findings)
    files.sort(key=lambda item: str(item["path"]).casefold())
    return files


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _check_no_output_conflict(release_dir: Path, names: Iterable[str]) -> None:
    if release_dir.is_symlink():
        raise ReleasePreparationError("release output path must not be a symlink")
    if release_dir.exists() and not release_dir.is_dir():
        raise ReleasePreparationError("release output path exists and is not a directory")
    for name in names:
        candidate = release_dir / name
        if candidate.exists() or candidate.is_symlink():
            raise ReleasePreparationError("release output already exists; no files were overwritten")


def prepare_release(root: Path) -> tuple[str, Path]:
    if root.is_symlink():
        raise ReleasePreparationError("source root must not be a symlink")
    try:
        root = root.resolve(strict=True)
    except OSError as error:
        raise ReleasePreparationError("source root does not exist") from error
    if not root.is_dir():
        raise ReleasePreparationError("source root is not a directory")

    version = _version_from_source(root)
    archive_name = f"xueness-{version}-source.tar.gz"
    output_names = (archive_name, "manifest.json", "SHA256SUMS")
    release_dir = root / "release"
    _check_no_output_conflict(release_dir, output_names)
    files = _collect_files(root, version)
    _check_release_gates(root, files)
    _scan_sources(files)

    release_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="xueness-release-stage-") as staging_name:
        staging = Path(staging_name)
        staged_archive = staging / archive_name
        _write_source_archive(staged_archive, version, files)
        archive_files = _inspect_archive(staged_archive, version)
        archive_sha = _sha256_file(staged_archive)
        manifest = {
            "schemaVersion": 1,
            "version": version,
            "archive": archive_name,
            "archiveSha256": archive_sha,
            "fileCount": len(archive_files),
            "files": archive_files,
        }
        staged_manifest = staging / "manifest.json"
        staged_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        sums = (
            f"{archive_sha}  {archive_name}\n"
            f"{_sha256_file(staged_manifest)}  manifest.json\n"
        )
        staged_sums = staging / "SHA256SUMS"
        staged_sums.write_text(sums, encoding="ascii")

        release_dir.mkdir(mode=0o755, exist_ok=True)
        _check_no_output_conflict(release_dir, output_names)
        for name in output_names:
            shutil.move(str(staging / name), str(release_dir / name))

    return version, release_dir


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Prepare a local, allowlisted Xueness source archive.")
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="source tree root (defaults to this checkout; used for isolated validation fixtures)",
    )
    args = parser.parse_args(argv)
    try:
        version, _release_dir = prepare_release(args.root)
    except ReleasePreparationError as error:
        print(f"release preparation blocked: {error}", file=sys.stderr)
        return 1
    print(f"Prepared local Xueness {version} source archive in release/ (not published).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
