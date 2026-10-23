# Windows novice acceptance notes — 2026-10-16

## Session model recovery

The active conversation composer now explains why sending is unavailable when the model catalog is loading, has failed, has no configured model, or model requests are blocked. A failed catalog load offers an explicit retry through the existing `refreshComposerCatalog` action; a missing model offers an explicit route to provider setup. These actions do not submit the draft. The empty-draft case is covered too, so a new user does not have to type something before finding the recovery action.

The secondary-pane model picker keeps its retry action for catalog errors and adds a configure action when a successful catalog contains no usable model. The configure action is only supplied while the providers plugin is effective and applies to the active pane.

## Startup pane-group recovery

On first launch, the primary blank composer can be created before the local workspace root finishes resolving. The resolved root now hydrates that initial primary group in place when the binding is still local, empty, unaliased, and unselected. Any typed or recoverable draft, pending submission, delivery uncertainty, submission or attachment error, explicit root/session selection, or remote scope prevents this special hydration path and retains normal pane-group behavior.

Before the lazy `SessionPaneWorkbench` composer mounts, startup checks the persisted `default:new-task` record and keeps that scope selected when it contains text, attachments, pending sends, or recovery state. This lets the composer restore the saved draft under its original owner instead of binding to the root that resolves later; startup does not rewrite or rehome its attachment or recovery metadata. Once the catalog root is known, its `new-task` record is also checked before any empty-scope hydration. Explicit workspace selection continues through the existing guarded relocation path.

Focused tests cover empty-scope hydration and its preservation guards, along with active-session recovery states and secondary-pane model setup. Final Windows acceptance and build validation are recorded by the parent task.

## First provider configuration

The providers plugin now has an inline, bilingual first-use guide for online APIs, local services, and save/use/chat. It clarifies that local model services must be started separately and that the model ID must match the provider. Both runtime profiles keep advanced settings collapsed initially. Existing profiles cannot be tested or selected while edits are unsaved; an inline status message and `aria-describedby` explain how to proceed. Saved profiles also have a Use action beside the footer Save action, avoiding a return to the top of a long form.

This capability is registered as `providers.setup_guidance`. Its new translations are loaded with the provider panel rather than the initial conversation bundle. No provider credentials or acceptance state are included in the release archives.

## Final Windows validation

- Frontend: 1,663 tests passed; TypeScript checking and the production build passed. Initial JavaScript gzip is 409,448 bytes against a 409,600-byte budget; initial CSS gzip is 54,706 bytes against 65,536.
- Desktop: 102 tests passed and 6 platform tests skipped. Plugin architecture validation passed; all 26 plugin unit tests passed. Focused native checks passed 21 tests with 4 macOS-only skips.
- The frozen backend passed its 246-test preflight with 21 skips, plus authenticated HTTP, private provider storage, plugin gates, PTY interruption, ConPTY worker, and shutdown checks. Its packaged binary matches the checked runtime binary. The final desktop smoke passed with 30 plugins and 247 features, renderer isolation, Windows caption and theme checks, and bundled Playwright using installed browsers.
- Final packaged novice acceptance passed with no renderer errors and no model runs: one initial pane group, collapsed advanced configuration, unsaved Test/Use protection, draft retention through model setup, and model-catalog error recovery. A real lazy workbench chunk was delayed for 912 ms while the catalog resolved the workspace; the default-scope draft appeared and its original persisted record remained unchanged.
- The separate deterministic conversation fixture matrix passed 16 viewport/theme/runtime/length combinations, 18 interactions and 2 attachment edits. A 351-turn history remained windowed to 32 mounted rows while navigating between its beginning and end. Fixture results are not real-model quality or speed measurements.
- Real Qwen `qwen3.8-27b` lightweight and DeepSeek `deepseek-v4.1-flash` conversations both retained the same test code across two turns in Xueness and ZCode. The DeepSeek route used the existing DeepSeek Harness XuedinerAPI adapter; the recorded final Xueness test calls reached its International branch. The acceptance-only adapter bridge serialized overlapping title/chat requests and normalized incremental tool names; these harness fixes are not product changes.
- Both models produced the expected CSV totals, preserved the input file, and read back both output files under the same bounded file-tool policy. DeepSeek supplied verified completion; Qwen's output files passed independent checks but its completion evidence remained incomplete, so its application status correctly stayed `needs_review`.
- A final packaged Qwen run stopped after visible output, settled in 391 ms in this observation, retained the exact partial answer after renderer reload, and completed an explicit follow-up while remembering the test code. Exactly two model run requests occurred and no renderer errors were recorded.

The accompanying HTML report includes original Windows screenshots and machine-readable records. This work does not claim a native macOS build/test, model speed ranking, or unreported memory/token measurements. Test credentials, model weights, isolated conversation state, and local provider profiles are excluded from the source release.
