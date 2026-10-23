# Native file worker provenance

This bundled fixed-data worker and its file/document schemas are adapted from
`dsh-ops@0.4.0` (MIT and Apache-2.0 composite distribution). The three runtime
files are the upstream `dsh-ops-worker` binaries for `win32-x64`, `linux-x64`,
and `darwin-arm64`. The schemas are generated from the upstream
`lib/capabilities/file.js`, `documents.js`, and `result.js` modules.

Xueness exposes only the 15 `xops_*` file and document operations plus
`xops_discover_tools`. Calls use the worker's version 1 JSON envelope and
fixed file component. Xueness supplies workspace paths, scope, read-only flag,
write root, credential-name fence, timeout, and output budget. The worker does
not load Cordis or DSH profile code. Shell and general command execution remain
Xueness host tools; this adapter does not provide the complete DSH host.

No Bash IPC payload or arbitrary PTC/code runner is included.

The upstream package's `LICENSE`, `NOTICE`, and full `licenses/` notices are
retained under `assets/`.

## Copied assets

The files below were copied from the corresponding paths in the installed
`dsh-ops@0.4.0` package. Hashes are SHA-256 of the bundled bytes.

| Bundled path | Upstream package path | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `runtime/win32-x64/dsh-ops-worker.exe` | `runtime/win32-x64/dsh-ops-worker.exe` | 3,850,240 | `95bd9dee27f83506ce8309aa2e9af84b783a94e8bb06f0f1ffceba660e3240e4` |
| `runtime/linux-x64/dsh-ops-worker` | `runtime/linux-x64/dsh-ops-worker` | 5,257,376 | `aa3cb6146b8feaec21dcdf4fc51dd475f9e1c6a216d13fcdba829327f3662e6b` |
| `runtime/darwin-arm64/dsh-ops-worker` | `runtime/darwin-arm64/dsh-ops-worker` | 4,218,800 | `706b6d0d51c1b680e1029617e31a18562e758547b8a38ef62be8af3144eca06e` |
| `schemas.json` | Generated from `lib/capabilities/file.js`, `lib/capabilities/documents.js`, and `lib/capabilities/result.js` | 85,920 | `50a73e8947323668787bfb7b87ab85119bead431bd443d2d56e33d5d92a97f53` |

The upstream top-level license files and retained third-party notices are the
matching package files copied to the same relative paths under `assets/`.
