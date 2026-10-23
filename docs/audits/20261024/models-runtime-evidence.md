# Models / agent runtime / tools / shell / files: evidence notes

## Root-agent addendum: model admission production wiring

ZCode `apps/zcode-cli/packages/bootstrap/src/app/workflow-concurrency-governor.ts:1-14,39-70` describes the per-model AIMD controller, run round-robin and admission ports; `:328` uses cooldownUntil. The main runtime observer at `:414-426` does not queue the foreground request but reports feedback. Production `create-app.ts:598-601,841-842` shares the governor with workflow drivers and injects `workflowConcurrencyGovernor.observer()` into the main runtime.

Xueness `ts/plugins/providers/src/admission-policy.ts:22-60,99-107` implements a fixed FIFO bucket with a constant limit; `model-execution.ts:17,26-29` exposes and injects it for agent requests. `title-model.ts:15` and `semantic-model.ts:27,43` use adapters directly, outside this admission path. This is an older depth gap, not a feature newly introduced by 3.16.2. Unifying auxiliary calls should preserve foreground responsiveness rather than blindly forcing all nested calls to hold the same slot.

## Basis and scope

- Latest ZCode: `E:/models/apps/_stage-z8/reference-ZCode-latest-20261024`, HEAD `3c5b227649371507ddc4eb46ac5133afe6db1cab`, package `3.16.2`.
- Prior ZCode baseline: `E:/models/apps/session-comparison-20261012/sources/ZCode`, HEAD `aac4755666d09fdcd70272fcf063c077a639015f`, package `3.15.1`.
- Xueness: `E:/models/apps/_stage-z8/Xueness-0.1.8-complete-project`.
- Read-only source inspection only. No code edits, tests, dependency installs, app startup, or model requests.

## 1. Generic ToolSearch/DeferredToolCall is new in latest ZCode; Xueness exposes a different, lightweight discovery layer

Latest ZCode adds a generic catalog and two executable control tools. `resolveToolSearchMode` in `packages/core/src/tool/search/exposure.ts:23-39` gates native mode on provider protocol capability and selects local mode for other tool-calling models; `buildToolExposure` at `:60-141` removes deferred schemas from the request, keeps the complete catalog for local search, and projects discovered tools back into history. `toolSearchToolEntry` in `packages/core/src/tool/handlers/tool-search.ts:15-45` searches that catalog and returns actual tool references at `:46-50`; `deferredToolCallEntry` is registered with it by `packages/core/src/tool/handlers/index.ts:80-84`. The turn loop constructs and passes the exposure context at `packages/core/src/runtime/methods/turn-loop.ts:184-220,262-271`; streamed calls are admitted/unwrapped by `packages/core/src/runtime/methods/streaming-tool-coordinator.ts:62-67` via `packages/core/src/tool/deferred-call.ts:15-57`.

Provider availability is narrow: `packages/adapters/src/model/tool-search.ts:3-13` sets `protocolSupported` only for `anthropic-messages`; `defaultEnabled` additionally requires a Zhipu coding-plan access type. `packages/adapters/src/model/runner.ts:287-294` attaches that capability. In native mode the Anthropic adapter adds the beta header (`runner-options.ts:90-92`) and maps `deferLoading` to provider options only when enabled (`tool-transform.ts:232-245`). This is not an all-model default.

The 3.15.1 source search found no generic `ToolSearch` or `DeferredToolCall` handler/contract; its only `ToolSearch` hit was a compaction comment at `packages/core/src/runtime/methods/compact-active.ts:255`.

Xueness has a real lightweight tool-selection path: `plugins/providers/src/runtime-tools.ts:7-40` filters the registry catalog, includes exact tool-name mentions from the last user message, then includes names already in `session.discovered_tools` up to `maxDiscoveredTools`. `plugins/providers/src/runtime.ts:17-29,47-62` applies that selected view only for the `lightweight` profile; the inactive branch passes the original request through. `packages/providers/src/options.ts:17-29` defines `maxDiscoveredTools` and `toolSearchResults`. This establishes lightweight schema selection and standard-profile exposure as separate layers; it does not establish same-turn schema hydration or a deferred wrapper.

## 2. Latest ZCode adds a special execution-selection failure route, while Xueness has general request retry/recovery

For an execution-scoped model selection that declares a fallback on the same provider, `resolveExecutionModelRetryBudget` in `packages/core/src/runtime/methods/turn-model.ts:93-105` sets `SingleAttempt`. `packages/core/src/runtime/methods/turn.ts:260-267` supplies that budget when creating the turn model. On a matching request failure, `packages/core/src/runtime/methods/turn-model-step.ts:288-315` applies execution fallback before same-model stream recovery; `packages/core/src/runtime/methods/turn-execution-fallback.ts:140-226` settles already accepted streamed tool calls before switching to the original/session model. The separate pre-request path catches only provider/model registry lookup errors (`turn.ts:269-297`; matcher at `turn-execution-fallback.ts:41-63`). These execution-selection helpers do not occur in the 3.15.1 source tree.

Xueness does have broad request failure handling: `packages/agent/src/model-request.ts:11-20,40-52,89-108` combines run deadline and cancellation, queues/adopts model attempts, retries, and allows one uncommitted compaction/extension repair; `packages/agent/src/model-retry.ts:56-68` selects single-attempt for lightweight mode and the configured/default budget otherwise. The scoped source search found no counterpart to ZCode's per-execution model-selection fallback/accepted-stream settlement route.

## 3. Latest ZCode adds runtime-owned off-peak model tickets and user takeover; Xueness already has a durable idle-window queue

The new `packages/core/src/runtime/off-peak/runtime.ts:72-137` is wired at ordinary turn entry by `packages/core/src/runtime/methods/turn.ts:143-149`. It binds a turn to an execution ID, selection and request dependencies, then releases its retained model round on completion. `OffPeakTicketAuthority` in `packages/core/src/runtime/off-peak/model-binding.ts:25-85,97-141` renews request credentials by ticket and retries an expired-ticket failure only before a stream has delivered output. `acceptOffPeakUserTakeover` is reached when a user selection is accepted (`runtime/methods/turn-model.ts:72-81`); `runtime/off-peak/turn.ts:8-23` releases the child binding and restores the ordinary model at the request boundary. The old 3.15.1 tree has off-peak tools/ports, but no `OffPeakRuntimeExecution`, `OffPeakTicketAuthority`, or `prepareOffPeakTurn` implementation.

Xueness does not lack off-peak work: `plugins/automation/src/tool.ts:29-73` queues a separate non-urgent task and states that it has no guaranteed start time and needs operator approval of the immutable plan; `plugins/automation/src/index.ts:33-62` wires the scheduler/tool. That is a durable idle-window automation queue, while latest ZCode's addition binds provider ticket lifecycle, model ownership, and takeover to a live runtime execution. No platform entitlement inference is made here.

## 4. Tool deadlines account for nested model-admission queue time in ZCode; Xueness has request deadlines and queueing but no common tool timeout field

ZCode's `ToolDeadline` in `packages/core/src/tool/executor/timeout.ts:11-18,19-53,81-91` pauses on a matching `model_request_queued` event and resumes on `model_request_admitted`; timeout failure includes `queuedMs` (`:131-149`). Production wiring is at `packages/core/src/tool/executor/call-runner.ts:460-472,484-508`, which wraps the model-status event sink around the handler's model. This behavior already exists in 3.15.1; it is not a new 3.16.2 delta.

Xueness's common `ToolDefinition`/`ToolEnv` in `packages/engine-tools/src/tool.ts:21-35,59-82` carries an abort signal but no per-tool timeout/deadline property. `packages/tool-bridge/src/bridge.ts:185-205,229-253` passes cancellation into a tool and awaits it; it does not impose a generic tool wall-clock deadline. Xueness separately has request deadlines/admission in `packages/agent/src/model-request.ts:15-20,40-51` and explicit process timeouts for `exec.ts:232-257`.

## 5. Concurrency governance is broadly aligned; the production dependency graph is currently empty

ZCode's `ToolScheduler` (`packages/core/src/tool/scheduler.ts:43-103,154-201`) groups safe work under a configurable cap (default 10), deriving safety from read-only, destructive, `concurrentSafe`, and side-effect metadata. Production turn calls flow through `runtime/methods/turn-tools.ts:126-140` and `runtime/methods/tools.ts:38-61`; the mapper currently emits `dependsOn: []` for each call (`tools.ts:42-57`), so the scheduler's topological/dependency API is a capability, not active dependency behavior in this call path. `AgentRuntime` injects `toolConcurrency.maxConcurrency` at `runtime/agent-runtime.ts:302-306`.

Xueness `packages/agent/src/tools.ts:97-115` also parallelizes explicitly `concurrencySafe` calls in groups of at most 10, preserving call order and serializing other calls as barriers; `packages/tool-bridge/src/bridge.ts:208-226` implements the same grouping at the bridge boundary. Thus the evidence does not support a broad claim that Xueness lacks safe parallel tool execution; the material differences are configurable cap and safety metadata vocabulary, while the dependency graph is not populated in ZCode's current model-turn mapper.

## 6. Latest ZCode keeps eligible Bash commands alive after a foreground timeout; Xueness requires explicit background mode

ZCode's Bash handler selects `auto_on_timeout` for eligible commands (`packages/core/src/tool/handlers/bash.ts:178-218`); `NodeExecutionAdapterLifecycle.runBashWithBackgroundLifecycle` commits the process to a background task at the deadline and clears the foreground deadline/parent-abort link (`packages/adapters/src/exec/node-execution-adapter-lifecycle.ts:209-240`). The auto-background path existed in 3.15.1, but that version disabled both explicit and automatic backgrounding for `offPeakTurn` (`core/src/tool/handlers/bash.ts:178-201`); latest removes that restriction because runtime lifecycle now owns the off-peak execution.

Xueness `packages/engine-tools/src/exec.ts:194-203,223-242` starts a task only when `input.background` is true; a foreground timeout is returned as `command_timeout` after `runProcess` (`:232-257`). This is a shell lifecycle behavior difference, not a claim that Xueness lacks background tasks.

## 7. Xueness adds Windows host-crash process containment beyond per-call tree termination

ZCode's checked execution adapter terminates the per-call Windows tree with `taskkill /T /F` (`packages/adapters/src/exec/node-execution-adapter-process.ts:146-169`) and performs POSIX process-group/tree cleanup (`process-tree.ts:15-31,43-61`). Xueness also kills trees on timeout/cancel (`packages/engine-tools/src/process.ts:48-68,99-123`), and additionally assigns each Windows child to a host Job Object with `KILL_ON_JOB_CLOSE` (`process.ts:107-109`; `windows-job.ts:1-14,82-135`). That kernel containment covers a host crash/termination that skips its exit hook. This is an extra Xueness lifecycle guarantee in the inspected path; it is not a general absence of process-tree cleanup in ZCode.

## 8. File-state recovery exists in both; current native write revision checks differ at the atomic-rename boundary

ZCode cold resume clears and hydrates `readFileState` before context initialization (`packages/core/src/runtime/methods/resume.ts:140-166`). `hydrateReadFileStateFromSession` restores successful full Read/Write/Edit metadata but deliberately skips historical range reads (`packages/core/src/agent/read-file-state-hydrator.ts:28-90,93-145`). Xueness also restores successful paired file-tool snapshots in the `beforeRun` hook (`plugins/files/src/read-state.ts:18-89`); range reads invalidate that path's prior state (`:73-79`). File-state restoration should therefore not be reported as wholly missing in Xueness.

Native writes differ under a concurrent external edit. ZCode's adapter checks `expectedRevision` before calling `atomicWrite` (`packages/adapters/src/fs/index.ts:291-309`), and its tool handlers pass the revision (`core/src/tool/handlers/write.ts:125-138`, `edit.ts:508-520`). Xueness's `write` passes the tracked hash (`packages/engine-tools/src/write.ts:72-79`), and `writeFileAtomic` rechecks it immediately before rename (`engine-tools/src/filesystem.ts:162-181`; `atomic-write.ts:35-44,71-79`). A change after ZCode's early check but before rename can pass its check; Xueness's before-rename check rejects that stale replacement. This adapter difference predates 3.16.2: the indexed upstream delta did not list `adapters/src/fs/index.ts` as modified.

The relevant 3.16.2 native text-range change is separately concrete: `adapters/src/fs/text-range-reader.ts:164-191` now fills only an incomplete UTF-8 candidate at the 4 KiB sample edge before encoding detection, implemented by `text-metadata.ts:151-173`. Xueness instead streams a strict UTF-8 decoder over the file and falls back to a bounded full read for legacy encodings (`packages/engine-tools/src/filesystem-ranges.ts:82-139,142-166`; caller `filesystem.ts:136-159`). This is a different read strategy; the source evidence does not show a general encoding support gap in Xueness.

## Pending source-boundary item

- Xueness's production lightweight selector reads `session.discovered_tools`, and the provider extension comment says `tool_search` uses the registry catalog (`plugins/providers/src/runtime-tools.ts:16-40`; `plugins/providers/src/runtime.ts:20-29`). The scoped TypeScript tree contains the name/option/selection wiring but did not reveal the `tool_search` executor or the producer/persistence path for `discovered_tools`; docs/catalog metadata are not sufficient to classify that implementation as absent. Keep this as unresolved behavior/protocol wiring until the caller outside the inspected TypeScript source is traced.
