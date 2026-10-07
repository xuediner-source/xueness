Xueness 0.1.5 improves the conversation workflow and ships the same feature set on Windows and macOS.

- Conversation: clear the composer when a message is accepted, preserve newer drafts, align multi-turn thinking/tool activity, and present quieter work details with real terminal output.
- Composer: working capability actions, session goals, document/image/browser capabilities, a context usage ring, and a reasoning-strength button with a slider. Model choices reflect configured providers.
- Agent workflow: plugin-owned standard and lightweight rules for task decomposition, continued execution, collection of delegated results, and delivery self-checks. No upstream safety-review prompts were imported; existing permission controls are unchanged.
- Context continuity: bounded references for current uncollected subtasks and successfully read skills survive compaction.
- Desktop parity: shared navigation, themes, platform-specific shortcut labels, native window safe areas, shell discovery, menus and plugin catalog. Office tools are included in the native runtime.

The complete catalog contains 28 plugins and 163 registered features. Every capability remains owned by a visible feature plugin. Tool execution success and delivery completeness remain separate checks.

Installers: Windows x64 Setup EXE / portable ZIP, macOS Apple Silicon DMG / ZIP, and macOS Intel DMG / ZIP. Application replacement preserves the existing data directory. Windows Setup supports in-app updates; portable users must switch to Setup for that path. Unsigned macOS updates download a verified DMG and still require replacing the app in Finder.

Verification and exact source/build references are listed in build-info.json. SHA256SUMS.txt covers the attached files. Deterministic regression results are not live-model performance benchmarks.
