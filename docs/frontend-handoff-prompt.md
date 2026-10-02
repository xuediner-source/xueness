You are taking over **frontend design and implementation only** for Xueness, a personal Agent CLI with a React web workbench embedded in an Electron desktop app.

**Workspace:** `/Users/xuediner/.openclaw/workspace/xueness`

Implement a cohesive, polished interface in the existing project. Preserve working behavior and backend contracts. Do not rewrite the application, implement backend features, or merely produce a design proposal.

### Design direction

Use **ZCode as the primary reference for layout, navigation, control placement, and interaction density**, especially the start screen, conversation, settings, and Windows header. Use the restrained neutral colors, typography, spacing, and surfaces associated with **Codex** for visual refinement. Keep Xueness's own name and identity; do not copy another product's logos, brand watermarks, or account information. Support both light and dark themes and Chinese/English interfaces.

The owner's comparison showed a Windows build with a separate native title bar, an always-visible application menu, an oversized sidebar header, and Mac shortcut symbols on Windows. Integrated desktop chrome and platform shortcuts have since been implemented. Refine the current result, preserving the native window control area and drag regions. Do not restore the duplicated header or require Electron changes. Browser mode must also remain usable without desktop chrome.

### Focus, in order

1. **Application frame and start screen:** balance sidebar width, top controls, main surface, greeting, workspace selector, composer, model/reasoning/permission selectors, attachments, and quick actions. Preserve all existing functional controls and their conditional visibility.
2. **Projects and conversations:** improve folder/project selection, session grouping and navigation, conversation history rail, timeline, tool details, approval states, scroll behavior, and composer ergonomics. Use real existing data and APIs.
3. **Settings:** make navigation and forms consistent and easy to scan. Give the detailed local-model/lightweight settings enough space and clear grouping; this is a core product capability, not an optional advanced page to hide. Refine provider compatibility checks and explicit adoption of verified settings, network search configuration, and update controls.
4. **Secondary panels:** carry the same visual system into plugins, workflows, terminal, files/previews, diagnostics, and resource management. Fix obvious inconsistencies without expanding their capabilities.

### Existing capabilities to preserve

- `network`: independently configured search service or OpenAI-compatible search-model API, endpoint/model/key fields, explicit credential clearing, DNS/DoH diagnostics, and a manually triggered test search. Saved secrets must never be displayed. Selecting a tab or editing a form must not trigger a paid request.
- `providers`: detailed lightweight configuration; conversation, tool, roundtrip, and stream compatibility checks; server-validated adoption of passing settings; live host monitoring and actual request/tool timing. Missing metrics stay unknown. Never fabricate tokens, GPU memory, throughput, cache hits, or success.
- `planning`: editable persistent deliverable requirements and missing-item feedback. **Tool execution success and delivery checks passed are different states.** A successful read or a normally ended run does not prove the entire task was completed.
- `updates`: stable-release status, download/cancel, and explicit restart/install controls. Windows installed builds support restart/install; unsigned Mac builds download/open a DMG and require replacement in Finder. Source mode and Windows portable builds have different limitations. Render the supplied states accurately.
- Plugin switches and dependencies: disabled capabilities must not launch requests, polls, effects, or tasks. The complete installed feature catalog—including disabled and blocked entries—must remain visible, with the plugin-management recovery entry accessible when settings is disabled.

### Implementation boundaries

Read `AGENTS.md` and `CONTRIBUTING.md` first. Every product feature belongs to a trusted plugin. New frontend implementation belongs in `webapp/src/plugins/<id>/`; update the existing manifest's `frontendModules` and `webapp/src/xuenessPluginRegistry.ts` only when registration needs to change. Do not introduce arbitrary runtime plugin loading. Shell/container changes may coordinate layout and mounting, but must not absorb plugin business logic.

Use existing React/TypeScript components, CSS variables, icons, translations, and dependencies. No new design framework, gratuitous animation, or blanket rewrite. Preserve keyboard access, focus, Escape behavior, input-method composition, error/loading/empty states, and destructive-action safeguards.

Do **not** change Python code, Electron/native modules, API endpoints or response shapes, permissions, persisted state schemas, credentials, model configuration, release/version settings, or updater security. Do not delete existing uncommitted work. Do not commit, push, publish, install dependencies, or invoke paid/live model services. Any helper agents must use **GPT-6 Luna with MAX reasoning**. If a desired UI genuinely requires a missing backend capability, document that narrow gap and continue with the supported interface.

### Read only what you need

Start with `webapp/src/XuenessWorkbenchContainer.tsx`, `XuenessShell.tsx`, the relevant owner directories under `webapp/src/plugins/` (including `sessions` and `settings`), `xuenessSettingsNavigation.ts`, `xuenessPluginRegistry.ts`, and the matching manifests. Consult `docs/xueness-reliability-and-updates.md` and `docs/xueness-local-lightweight-mode.md` for current semantics. Earlier batch documents and screenshots may describe older paths or behavior; current source and manifests are authoritative.

### Efficient completion

Make a brief implementation plan, then implement. Ask only for information that blocks progress. Limit verification to one final frontend test/typecheck/build pass, the required plugin architecture checks, and a small real-browser visual check of the built UI: start screen, conversation, and key settings in light/dark desktop plus one narrow viewport. Use isolated state and an available system browser; never overwrite the owner's running service or settings. Add focused regression tests only for interaction changes that need them.

Report what changed, the checks actually run, and any concrete remaining gaps. Do not claim Windows native behavior or local-model performance was verified unless it was actually tested. Deliver the working frontend, not a mockup or a promise to continue.
