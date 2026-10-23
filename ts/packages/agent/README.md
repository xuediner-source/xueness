# Agent orchestration

`@xueness/agent` is the leased, state-bound TypeScript port of the shared Python
agent driver. It uses the shipped provider adapters, ToolBridge and SessionStore.
The server assembly is `apps/server/src/agent-service.ts`.

```ts
const hooks = kernelAgentHooks(kernel, {
  enabled: persistedEffectivePluginState,
  extensions: productExtensions,
});
const runner = new AgentRunner({ store, provider, toolBridge, root, stateDir, hooks });
await runner.run(session, { maxChars: 24000, signal }); // maxSteps/maxWallSeconds: optional caller bounds
runner.cancel(session.id);
```

`run` and `continue` acquire the store's operating-system run lease and reject
a changed durable revision before lifecycle hooks. Callers must not hold that
lease already. A session workspace must match the bridge's root.
Provider intent is validated and durably saved before any tool effect. Every
call receives a journal result, including calls skipped because the run stopped
or needed approval. A stop never replays recorded intent.

The shared driver implements optional step/wall bounds, protocol repair,
ZCode repeated-call reminders and output-token continuation (`loop-guards.ts`),
incomplete-generation records, evidence aliases/current-turn
assessment, capped completion history, streamed partials/reasoning and durable
interruption settlement. Deterministic compaction preserves human turns and
whole tool exchanges, archives masked/dropped text, and offloads large output
only for writable sessions.

Completion is ZCode-style: a turn ends when the model stops calling tools.
The optional `Evidence: E1` footer only labels the completion `verified` or
`unverified`; a missing or invalid reference never adds a repair round, blocks
tools or pauses the run. Only a failed host delivery check yields `needs_review`.

The turn loop follows ZCode: there is no default step or wall-time cap. Three
identical calls in a row add a reminder to the next request instead of stalling;
a response cut by the output budget resumes with a turn-local prompt up to three
times. Only an approval request suspends a turn; any other tool failure,
including a disabled plugin, is returned to the model.

Product behavior stays in its owning plugins:

- **providers** supplies lightweight tool selection, safe JSON protocol,
  token estimates and reported-usage calibration, bounded prompt views,
  one pre-output overflow retry, transactional semantic history handoffs,
  and measured request/tool activity.
- **files** supplies fresh bounded workspace `AGENTS.md` context. Shared native
  file reading uses directory-anchored POSIX `openat` and Windows handle-path
  verification; it refuses symlinks/reparse points, devices and FIFOs.
- **sessions** supplies completion policy, queued/prepared continuations,
  current-turn guidance, tool-activity projections, media binding and exact
  approval replay; manual compaction, next-request model switching and bounded
  background naming. Plan-mode writes are limited to the session's plan draft.
- **planning** supplies task lists and operator questions, immutable delivery
  plans, actual file/text/link checks and independent goal verification with
  bounded continuation. Goal continuation settles before queued user turns.
- **git** observes authorized writes/commands before their effects and saves
  one temporary-index checkpoint per human turn. A denied call makes no snapshot.

Every extension declares its owner and runs only while that owner is effective.
Schemas and tool ownership are rechecked before model requests and effects.
Plugin disable unloads borrowed tools and stops scoped background work. Service
shutdown aborts provider transport, drains runs, and then removes temporary
command artifacts. Background shell tasks persist across runs in their session's
plugin host and terminate when that host is disposed.

`runner.supports(session)` reports missing declared capabilities. The production
service conservatively selects Python for configured product behavior still
owned there: external hooks, MCP, delegated subagents, remote execution,
configured memory/skills, browser work, subscription providers, and Office
delivery parsing. Empty MCP/hooks opt-in flags alone do not force fallback;
configured resources do. General goal and text-delivery execution is native.
Additional product configuration must be declared through
`requiredCapabilities(session)` or the service's corresponding callback;
orchestration hooks alone do not constitute a migrated product implementation.

Tests use real Python core/helper oracles and isolated local model servers. They
cover compaction, completion, full driver scenarios, lightweight helpers,
semantic transaction staging/failure, native guidance reads, service approval
replay, provider/error/cancel lifecycle and actual
provider → plugin tool → ToolBridge → journal integration. Full production HTTP
tests cover approval replay, queued inputs, delivery, in-flight model switching,
manual compaction, goal continuation, structured answers and automatic titles.
Naming uses only the completed run's real bound adapter, honors the saved
preference and requires host model authorization; manual renames win atomically.
Background requests are owned and drained through plugin disable/shutdown.
The tests never call a
paid model or use production sessions. Windows file-symlink creation may be
denied; FIFO validation runs on POSIX and is skipped on Windows.

Model execution now emits `model_request_started/completed/failed` for each
physical attempt. The logical `requestId` remains stable across retries;
`attemptId` distinguishes physical calls, including semantic recovery. Completed
events contain measured `durationMs` and whitelisted reported `usage` only.
An abnormal finish with no text, tools or usage receives at most one empty
completion retry, within the existing attempt budget. Partial tool snapshots are
buffered until output commits or a complete tool call is accepted. Nonempty
text or reasoning commits even when reasoning display is disabled.
`modelRetry.streamIdleTimeoutMs` defaults to 600000; each retry adds 30000.
Non-positive values disable the event idle timer. Only complete SSE data
payloads refresh it; comment heartbeats do not. The existing lightweight
transport retry budget remains independent and keeps its prior delivery rules.
The providers plugin owns localized terminal failures and their persistence.

The providers plugin also contributes `providerRequestShapingExtension()` for
Anthropic history projection and one signature repair within the existing
semantic recovery budget. Main sessions, child agents and workflow actors all
install it. Pending model selection is used before projection. Signed reasoning
is retained in private `_reasoning_blocks` / `_reasoning_origin` journal fields;
the request view filters incompatible origins without rewriting history.
The request-only `reasoningHistoryNormalized` option prevents a second structural
pass after signature repair. Media-bearing user messages retain their identity.
Tool schemas may explicitly set `function.strict: true`; the contract projection
preserves this opt-in and the native Anthropic adapter checks eligibility.
Malformed or duplicate-key tool JSON remains an ordinary failed tool result.
