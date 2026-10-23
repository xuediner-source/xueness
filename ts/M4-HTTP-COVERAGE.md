# M4 HTTP coverage

The application composes **79 session-related route signatures, 9 provider route signatures, 3 composer route signatures and 6 command route signatures** in TypeScript. These counts include the session-owned composer attachment API, and the planning/git owners mounted by `application-api.ts`. `sessions.routes` reports the complete composed inventory, not only the base CRUD routes. A listed route can still relay to its Python owner under the conditions below.

The front door retains Host/Origin, desktop-token, framing and CSRF checks. Domain handlers check effective plugin state. Session journals, histories, private media, queue/steering sidecars, receipts, checkpoints and native operating-system leases remain interoperable with Python.

## Native routes

```text
DELETE /api/conversation_shares/:id
DELETE /api/sessions/:id
DELETE /api/sessions/:id/goal
DELETE /api/sessions/:id/queue-withdrawals/:recoveryId
DELETE /api/sessions/:id/queue/:queueId
DELETE /api/sessions/:id/steer/:guidanceId
DELETE /api/sessions/archived/:id
GET /api/conversation_shares/:id
GET /api/delivery/:id
GET /api/sessions
GET /api/sessions/:id
GET /api/sessions/:id/commands/:commandId
GET /api/sessions/:id/conversation
GET /api/sessions/:id/conversation-transport
GET /api/sessions/:id/deltas
GET /api/sessions/:id/events
GET /api/sessions/:id/events.resume
GET /api/sessions/:id/events.v1
GET /api/sessions/:id/export
GET /api/sessions/:id/fork-boundaries
GET /api/sessions/:id/git/checkpoints
GET /api/sessions/:id/git/turn-checkpoints
GET /api/sessions/:id/goal
GET /api/sessions/:id/history
GET /api/sessions/:id/journal
GET /api/sessions/:id/model
GET /api/sessions/:id/question
GET /api/sessions/:id/queue
GET /api/sessions/:id/queue-withdrawals
GET /api/sessions/:id/queue-withdrawals/:recoveryId
GET /api/sessions/:id/share
GET /api/sessions/:id/steer
GET /api/sessions/:id/updates
GET /api/sessions/archived
GET /api/sessions/commands/:commandId
GET /api/sessions/conversation-transport/watch
GET /api/sessions/index
GET /api/sessions/search
PATCH /api/sessions/:id
PATCH /api/sessions/:id/message-actions
PATCH /api/sessions/:id/queue
PATCH /api/sessions/:id/queue/:queueId
POST /api/composer/attachments/abort
POST /api/composer/attachments/begin
POST /api/composer/attachments/chunk
POST /api/composer/attachments/commit
POST /api/composer/attachments/preview
POST /api/composer/attachments/release
POST /api/composer/attachments/restore
POST /api/composer/attachments/restore-abort
POST /api/composer/attachments/restore-epoch
POST /api/composer/attachments/restore-status
POST /api/conversation_shares/:id/import
POST /api/delivery/:id
POST /api/sessions
POST /api/sessions/:id/answer
POST /api/sessions/:id/answer-question
POST /api/sessions/:id/approvals
POST /api/sessions/:id/commands
POST /api/sessions/:id/compact
POST /api/sessions/:id/fork
POST /api/sessions/:id/fork-from-checkpoint
POST /api/sessions/:id/git/checkpoints
POST /api/sessions/:id/git/checkpoints/:checkpoint/restore
POST /api/sessions/:id/git/turn-checkpoints/rewind
POST /api/sessions/:id/goal
POST /api/sessions/:id/messages
POST /api/sessions/:id/model
POST /api/sessions/:id/pin
POST /api/sessions/:id/queue
POST /api/sessions/:id/queue/:queueId/send-now
POST /api/sessions/:id/restore
POST /api/sessions/:id/run
POST /api/sessions/:id/share
POST /api/sessions/:id/steer
POST /api/sessions/:id/steer-query
POST /api/sessions/:id/stop
POST /api/sessions/commands
POST /api/sessions/import

DELETE /api/providers/:id
GET /api/providers
GET /api/providers/default
POST /api/providers
POST /api/providers/compatibility-adopt
POST /api/providers/compatibility-test
POST /api/providers/default
POST /api/providers/discover
POST /api/providers/test

DELETE /api/resources/commands/:id
GET /api/composer
GET /api/resources/commands
GET /api/resources/commands/files
PATCH /api/resources/commands/:id
POST /api/composer/branch
POST /api/composer/prepare
POST /api/resources/commands
PUT /api/resources/commands
```

`events`, `events.v1` and `events.resume` have finite SSE forms. `deltas` streams model text with durable code-point offsets; `updates` emits snapshot/patch/heartbeat SSE. The front door iterates bounded async bodies with backpressure and aborts feature waits on disconnect. Conversation transport retains at most 64 topics, 64 frames per topic, 2 MiB per topic and 16 MiB overall; watches are capped at 16 topics and 32 clients. The existing event-cursor, event-resume and legacy free-text question settings remain opt-in.

The native runtime also owns accepted-media binding, immutable admission receipts, request pins, approval replay, queued-turn drain, guidance settlement, ordinary/lightweight adapters, deterministic and semantic compaction, AGENTS context, goal continuation/verification, delivery checks, manual model switching, todo/ask-user tools and bounded automatic titles. Automatic titles honor host model opt-in, manual titles, plugin disable and shutdown.

## Deliberate Python dependencies

| Routes or condition | Remaining owner and reason |
| --- | --- |
| `GET /api/composer`; `POST /api/composer/prepare` while the remote or subscriptions plugin is effective | Remote-connection selection and subscription models are still Python-owned, so the native owner relays the catalogue and preparation; the draft then lives in Python's cache. Otherwise both routes, and `POST /api/composer/branch` always, are native. |
| `POST /api/composer/consume-prepared` | Transitional protected handoff, used only after a native cache miss while the remote or subscriptions plugin is effective. Accepts exactly token/root; caller text, media owners and model metadata cannot substitute for the trusted cached record. |
| `POST /api/composer/expand-command` | No longer called by TypeScript (session admission expands `/commands` natively); it stays a Python route until the Python backend is deleted. |
| `/share/:id` page | Python serves the share SPA entry; publishing, reading, importing and revoking the share API are native. |
| Provider default/diagnostic selections using unsaved `subscription.*` identities | Subscription authentication and provider construction remain Python-owned. Native provider listing merges the public subscription catalog through a read-only bridge. |
| Create/send command envelopes or raw acceptance using such external selections; opaque prepared selections while subscription profiles exist | Relay occurs before cache redemption or durable command claim, preserving the single-use prepared record and retry authority. |
| Session run requiring configured hooks, MCP, subagents, browser, remote execution, memory, skills, or Office delivery parsing | The capability selector relays before native journal/model/tool mutation until each product owner supplies its concrete TS extension. File/plan/delivery/goal/ordinary chat paths with native owners execute natively. |
| Live detail, approvals, stop, mutable queue/guidance, model, snapshots/transport/watch while another backend holds the run lease | The backend holding the operating-system lease owns its in-memory maps. Native SSE closes on an ownership transition; an unsent watch relays without acknowledging unseen state. Immutable journal/history/event reads and durable model deltas can remain native. |
| Session index with an effective remote plugin and a saved remote connection, without `indexRemoteSummary` | Relays instead of silently dropping the remote owner's status projection. |

Workspace grants/default roots and remembered workspaces still come from the settings owner's protected bridge. Other Python plugin APIs and CLI surfaces are outside this M4 core cutover. This is an operational strangler deployment, not retirement of all Python product plugins.

## Focused verification

The final focused sessions-plugin run passed **63 tests, zero skips** in 43.1 seconds, including real Python HTTP differentials for CRUD/lifecycle refusals, snapshots, edits, event protocols, transport/watch, forks, queue/receipts, search/index, sharing, questions, prepared-input/goal metadata and archives. Media tests compare persisted owners and provider wire bodies with Python; attachment tests cover cross-runtime upload/restore, crash recovery and Windows link/ACL boundaries. Later first-yield/foreign-lease guards also passed their focused lifecycle/stream checks.

The provider HTTP suite passed **3 tests**, covering validation/credential preservation, host/plugin refusal, local discovery/connection tests and all six compatibility modes with proof adoption. Diagnostics used local fixtures, with no paid or live model calls. The protected Python handoff suite passed **5 tests**.

`npm run typecheck`, `npm run check:lines` and `npm run check:plugins` passed after integration. The line gate reported 385 TS files at a maximum of 400 lines; the plugin gate reported 6 bundled TS plugins. Final application/build/Python-wide acceptance totals are recorded by the parent handover rather than inferred from these focused counts.
