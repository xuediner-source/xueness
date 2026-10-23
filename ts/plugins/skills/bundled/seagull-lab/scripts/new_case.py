#!/usr/bin/env python3
"""Create a minimal Seagull case workspace."""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path, PureWindowsPath


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("name", help="single directory name for the new case")
    parser.add_argument("--root", required=True, help="directory under which to create the case")
    args = parser.parse_args()

    win_name = PureWindowsPath(args.name)
    if (
        args.name in ("", ".", "..")
        or Path(args.name).is_absolute()
        or win_name.drive
        or "/" in args.name
        or "\\" in args.name
    ):
        parser.error("name must be a single directory name")

    case = Path(args.root) / args.name
    try:
        case.mkdir(parents=True, exist_ok=False)
        for directory in (
            "artifacts/originals",
            "artifacts/derived",
            "scripts",
            "logs",
            "notes",
            "reports",
        ):
            (case / directory).mkdir(parents=True, exist_ok=True)

        created_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        manifest = {
            "schema": "seagull.case.v1",
            "name": args.name,
            "createdAt": created_at,
            "artifacts": [],
            "outputs": [],
        }
        (case / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        (case / "logs" / "commands.log").write_text("", encoding="utf-8")
        (case / "notes" / "evidence.md").write_text("", encoding="utf-8")
    except OSError as exc:
        parser.error(f"cannot create case: {exc}")

    print(case.resolve())


if __name__ == "__main__":
    main()
