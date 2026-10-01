#!/usr/bin/env python3
"""Generate the web dependency license inventory from package-lock and node_modules.

Run from any directory with:
    python3 tools/generate_web_notices.py

Use --check to verify the checked-in inventory is current, or --root PATH to
generate/check a temporary project fixture with the same webapp layout.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


LOCK_REL = Path("webapp/package-lock.json")
OUTPUT_REL = Path("webapp/public/third-party-notices.txt")
README_HEADING_RE = re.compile(r"(?im)^(#{1,6})\s*(?:license|licence)\b[^\n]*\n")
LICENSE_FILE_RE = re.compile(r"(?i)^(?:license|licence|copying|notice)(?:\.|$)")


@dataclass(frozen=True)
class LicenseSource:
    label: str
    text: str
    basis: str


@dataclass(frozen=True)
class PackageRecord:
    lock_path: str
    name: str
    version: str
    declared_license: str
    optional: bool
    sources: tuple[LicenseSource, ...]


def package_name_from_lock_path(lock_path: str) -> str:
    # Nested installs can contain multiple node_modules segments. The final
    # segment is the installed package's own path/name.
    suffix = lock_path.rsplit("node_modules/", 1)[-1]
    parts = suffix.split("/")
    if parts and parts[0].startswith("@") and len(parts) > 1:
        return "/".join(parts[:2])
    return parts[0]


def read_package_json(package_dir: Path) -> dict:
    package_json = package_dir / "package.json"
    if not package_json.is_file():
        return {}
    try:
        return json.loads(package_json.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read {package_json}: {exc}") from exc


def license_files(package_dir: Path) -> list[Path]:
    if not package_dir.is_dir():
        return []
    return sorted(
        (path for path in package_dir.iterdir() if path.is_file() and LICENSE_FILE_RE.match(path.name)),
        key=lambda path: (0 if path.name.lower().startswith(("license", "licence", "copying")) else 1, path.name.lower()),
    )


def readme_license_section(package_dir: Path, root: Path) -> LicenseSource | None:
    if not package_dir.is_dir():
        return None
    readmes = sorted(
        path for path in package_dir.iterdir() if path.is_file() and path.name.lower().startswith("readme")
    )
    for readme in readmes:
        text = readme.read_text(encoding="utf-8", errors="replace")
        for match in README_HEADING_RE.finditer(text):
            level = len(match.group(1))
            next_heading = re.search(rf"(?m)^#{{1,{level}}}\s+", text[match.end() :])
            end = match.end() + next_heading.start() if next_heading else len(text)
            section = text[match.start() : end].strip()
            body = section[match.end() - match.start() :].strip()
            # A bare SPDX label such as "MIT" is not license text. Continue
            # searching in case a later README contains the full terms.
            if len(body) < 80:
                continue
            rel = readme.relative_to(root).as_posix()
            return LicenseSource(rel + " (license section)", section, "README license section")
    return None


def source_text(path: Path, root: Path) -> LicenseSource:
    try:
        text = path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError as exc:
        raise ValueError(f"cannot read license source {path}: {exc}") from exc
    if not text:
        raise ValueError(f"license source is empty: {path}")
    return LicenseSource(path.relative_to(root).as_posix(), text, "installed license/notice file")


def fallback_sources(root: Path, lock_path: str, package_dir: Path) -> tuple[LicenseSource, ...]:
    if lock_path.startswith("node_modules/@radix-ui/"):
        donor = root / "webapp/node_modules/@radix-ui/react-select/LICENSE"
        if not donor.is_file():
            raise ValueError(f"Radix family fallback source is missing: {donor}")
        return (LicenseSource(
            donor.relative_to(root).as_posix() + " (shared WorkOS Radix family license)",
            donor.read_text(encoding="utf-8", errors="replace").strip(),
            "shared WorkOS Radix family license",
        ),)

    if lock_path.startswith("node_modules/@napi-rs/canvas-"):
        donor = root / "webapp/node_modules/@napi-rs/canvas/LICENSE"
        if not donor.is_file():
            raise ValueError(f"canvas platform fallback source is missing: {donor}")
        return (LicenseSource(
            donor.relative_to(root).as_posix() + " (shared @napi-rs/canvas platform license)",
            donor.read_text(encoding="utf-8", errors="replace").strip(),
            "shared @napi-rs/canvas platform license",
        ),)

    if lock_path == "node_modules/react-remove-scroll-bar":
        # Version 2.3.8 declares MIT but omits a license file. Preserve the
        # official same-project upstream text and its exact source revision.
        donor = root / "tools/license-texts/react-remove-scroll-bar-upstream-LICENSE.txt"
        metadata = json.loads(donor.with_suffix(".source.json").read_text())
        if metadata.get("package") != "react-remove-scroll-bar" or metadata.get("license") != "MIT":
            raise ValueError("invalid upstream license provenance")
        return (LicenseSource(
            metadata["url"] + " (official upstream; npm 2.3.8 omits license text)",
            donor.read_text(encoding="utf-8").strip(),
            "same-project official upstream license; package declares MIT",
        ),)

    raise ValueError(f"no license text found for {lock_path}; refusing to infer a license")


def load_records(root: Path) -> list[PackageRecord]:
    lock_path = root / LOCK_REL
    if not lock_path.is_file():
        raise ValueError(f"missing lock file: {lock_path}")
    try:
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read {lock_path}: {exc}") from exc

    packages = lock.get("packages")
    if not isinstance(packages, dict):
        raise ValueError("package-lock.json does not contain a packages object")

    records: list[PackageRecord] = []
    for lock_path_text, metadata in sorted(packages.items()):
        if not lock_path_text.startswith("node_modules/") or metadata.get("dev") is True:
            continue

        package_dir = root / "webapp" / lock_path_text
        package_data = read_package_json(package_dir)
        name = metadata.get("name") or package_data.get("name") or package_name_from_lock_path(lock_path_text)
        version = metadata.get("version") or package_data.get("version")
        declared = metadata.get("license") or package_data.get("license")
        if not version or not declared:
            raise ValueError(f"missing locked version or declared license for {lock_path_text}")

        files = license_files(package_dir)
        if files:
            sources = tuple(source_text(path, root) for path in files)
        else:
            readme_source = readme_license_section(package_dir, root)
            if readme_source:
                sources = (readme_source,)
            else:
                sources = fallback_sources(root, lock_path_text, package_dir)

        records.append(PackageRecord(
            lock_path=lock_path_text,
            name=name,
            version=version,
            declared_license=str(declared),
            optional=bool(metadata.get("optional") or metadata.get("devOptional")),
            sources=sources,
        ))

    if not records:
        raise ValueError("no non-development package-lock entries found")
    return records


def render_notices(root: Path) -> str:
    records = load_records(root)
    lines = [
        "THIRD-PARTY NOTICES — Xueness web interface",
        "",
        f"This inventory covers {len(records)} non-development package entries in `webapp/package-lock.json`, including optional packages. It records locked versions and declared SPDX license expressions from the lockfile or installed package metadata.",
        "",
        "License and notice text is reproduced from the installed package files. If a package omits a full text, the source column identifies a README license section or an explicit family/same-author fallback. Optional platform packages not installed on this host are included from the lockfile and use their package family's installed license text. The inventory does not infer license terms from an SPDX expression alone.",
        "",
        "PACKAGE INVENTORY",
        "",
        "| Lock path | Package | Version | Declared license | Optional | License text source |",
        "|---|---|---:|---|:---:|---|",
    ]

    for record in records:
        source_labels = "; ".join(source.label for source in record.sources)
        lines.append(
            f"| `{record.lock_path}` | `{record.name}` | {record.version} | `{record.declared_license}` | {'yes' if record.optional else 'no'} | `{source_labels}` |"
        )

    groups: dict[str, dict[str, object]] = {}
    for record in records:
        for source in record.sources:
            digest = hashlib.sha256(source.text.encode("utf-8")).hexdigest()
            group = groups.setdefault(digest, {"text": source.text, "source": source.label, "basis": source.basis, "packages": []})
            packages_for_text = group["packages"]
            assert isinstance(packages_for_text, list)
            package_ref = f"`{record.name}` {record.version} (`{record.lock_path}`)"
            if package_ref not in packages_for_text:
                packages_for_text.append(package_ref)

    lines.extend(["", "LICENSE TEXTS AND NOTICES", ""])
    ordered_groups = sorted(groups.values(), key=lambda item: (str(item["source"]).lower(), str(item["source"])))
    for index, group in enumerate(ordered_groups, start=1):
        packages_for_text = group["packages"]
        assert isinstance(packages_for_text, list)
        lines.extend([
            f"## License text {index}",
            "",
            "Applies to: " + ", ".join(packages_for_text),
            "",
            f"Source: `{group['source']}` ({group['basis']})",
            "",
            str(group["text"]).rstrip(),
            "",
        ])

    return "\n".join(lines).rstrip() + "\n"


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1], help="project root (defaults to this script's repository)")
    parser.add_argument("--check", action="store_true", help="fail if the checked-in notices differ from generated output")
    args = parser.parse_args(argv)
    root = args.root.resolve()
    output = root / OUTPUT_REL
    try:
        generated = render_notices(root)
        if args.check:
            if not output.is_file():
                print(f"missing generated inventory: {output}", file=sys.stderr)
                return 1
            current = output.read_text(encoding="utf-8")
            if current != generated:
                print(f"stale third-party notices: {output}", file=sys.stderr)
                return 1
            print(f"third-party notices are current ({len(load_records(root))} locked packages): {output}")
            return 0

        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(generated, encoding="utf-8", newline="\n")
        print(f"generated third-party notices ({len(load_records(root))} locked packages): {output}")
        return 0
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
