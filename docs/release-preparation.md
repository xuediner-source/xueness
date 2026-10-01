# Local release preparation

`tools/prepare_release.py` assembles a reviewable source archive in `release/` from an explicit file allowlist. It reads the version from `xueness/__init__.py`, creates a minimal archive README, writes a per-file manifest and SHA-256 checksums, then scans the finished archive before keeping the outputs.

Run it after the production web assets have been built and reviewed:

```sh
python3 tools/prepare_release.py
```

The script is local-only. It does not create a Git tag, push changes, contact a release service, or publish an artifact. It refuses to overwrite files already present at its output names. `--root PATH` points it at an isolated source fixture for validation; the default is this checkout.

The archive includes Xueness Python modules, bundled plugin manifests and worker code, webapp source and built assets, safe test sources and fixtures, the install and container entry points, the license and notices, selected event-validation tools, and the current start-interface, plugin-architecture, lightweight-mode and source-audit docs. It generates a short archive README instead of copying the checkout README, which may contain machine-specific setup history.

The allowlist excludes Git metadata, vendored and legacy trees, local state (`.state`, `.xueness-data`, and `.web-runs`), dependency installs, environment files, credentials, logs, caches, screenshots, reviews, and previous release outputs. Public `material-icons` assets are excluded. Preparation stops if retired vendor or legacy trees remain, built browser assets are missing or still refer to retired UI assets, a symlink enters an allowlisted tree, or the archive scan finds private-key material or a provider credential pattern. The scanner reports only the affected archive path and finding type, never the matched value.

The backend requires Python 3.10 or newer and uses the Python standard library. Node.js is optional at runtime; it is needed to rebuild or run browser-interface checks. The prebuilt interface is included in the archive. Docker Compose is optional.

Model credentials and other online-service configuration are supplied by the operator at runtime and are not included. Review `LICENSE` and `NOTICE.md` before redistribution; source attribution and required notices remain part of the prepared archive. The release platform has not been selected, so a prepared archive is not a published release.

Before collecting a package, the plugin architecture gate checks the trusted package allowlist, complete backend/frontend ownership, bilingual feature inventory, contributions, dependencies and UI catalog metadata. A missing declaration stops preparation. The archive includes `AGENTS.md`, `CONTRIBUTING.md` and the check tool so future changes retain the same plugin requirement.
