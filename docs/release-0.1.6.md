Xueness 0.1.6 ships 30 plugin-owned modules and 212 registered features across Windows and both Mac architectures.

- Conversations: current-turn guidance, durable history, incremental updates, bounded paging, semantic compaction, goal continuation, recoverable child sessions, Find, selection and sanitized sharing.
- Workflow: saved workflow library, read-only model/run introspection, `/mcp`, doctor, and session auto-titling that preserves manual titles and reuses the authorized model from the current run.
- Desktop: notification focus/recovery, localized Mac Cmd+W menu, boot placeholder, and consistent platform paths and native architecture checks.
- Review fixes: atomic title publication, bounded child shutdown, revision-bound journal cursors, locked workflow template writes, doctor failure handling, clearer plugin/manifest states, and Antigravity tool-schema and request-deadline compatibility.

Native artifacts must be built from this exact source commit. Build-info.json records whether focused or full validation ran and identifies checks that were not run; SHA256SUMS.txt provides installer integrity. The isolated regression suites are not live-model benchmarks, and the reported subscription HTTP 400 still needs a real-account retry after updating.
