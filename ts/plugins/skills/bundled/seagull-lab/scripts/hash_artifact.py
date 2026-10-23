#!/usr/bin/env python3
"""Report SHA-256 hashes and sizes for files without modifying them."""

import argparse
import hashlib
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="+", help="file paths to hash")
    args = parser.parse_args()

    artifacts = []
    for value in args.files:
        path = Path(value)
        if not path.is_file():
            parser.error(f"not a file: {value}")

        digest = hashlib.sha256()
        size = 0
        try:
            with path.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
                    size += len(chunk)
        except OSError as exc:
            parser.error(f"cannot read {value}: {exc}")

        artifacts.append(
            {"path": str(path.resolve()), "bytes": size, "sha256": digest.hexdigest()}
        )

    print(json.dumps({"artifacts": artifacts}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
