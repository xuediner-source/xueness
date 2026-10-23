# Native operations plugin

This plugin adapts the fixed Rust file worker and file/document schemas from
`dsh-ops@0.4.0`. It provides bounded workspace inspection, search, revision
checked file changes, and CSV, DOCX, and supported PDF text reading. The
`xops_discover_tools` tool can select advanced operations for the next model
step, with a separate selection for each session.

The adapter sends one version 1 JSON request directly to a platform-specific
worker. Xueness supplies the current workspace root and session scope, checks
paths against the workspace, limits output and runtime, and terminates workers
when a call or plugin stops. The Rust worker also refuses linked path traversal
and checks file revisions for writes. These are fixed data operations: the
plugin does not import Cordis or a DSH profile, launch a shell, or run arbitrary
JavaScript/PTC code. General command execution remains with Xueness host tools.

The full upstream license texts and notices are retained in `assets/LICENSE`,
`assets/NOTICE`, and `assets/licenses/`. Binary target hashes and copied source
paths are recorded in `assets/PROVENANCE.md` alongside the adapter scope.
