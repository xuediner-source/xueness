# ZCode-to-Xueness Feature Parity Roadmap (evidence-backed, patterns only)

Date: 2026-09-24
Upstream pin: `zai-org/ZCode@328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f` (v3.14.3, 2026-09-23)
Method: GitHub read-only (`github__get_file_contents` / `github__list_commits`) + local Xueness source read. No clone, no run, no publish, no credentials.
Xueness scope: `/Users/xuediner/.openclaw/workspace/xueness` README + `xueness/{core,cli,provider,web,memory}.py` + `xueness/static/index.html` + `tests/` + `reviews/*.md`.
Rules honored: no upstream code/assets copied, no Xueness implementation modified, product patterns/contracts only, independent implementation. No claim of full parity.

## 1. Upstream snapshot (pinned)

- Commit `328c1a0c` message: workflow concurrency adjust without stop, restart reuse, large-workflow status, script submit efficiency, crash/button/context fixes. Parent `872ad960` ("feat: open source").
- Root `package.json` blob `189729a3`: name `zcode`, version `3.14.0`, private, `Apache-2.0`, pnpm `10.33.2`, node `>=24`, React 19 override, three patched deps. Scripts prove monorepo with `dev:web`, `dev:desktop`, `build:zcode`, `bundle:desktop`, `architecture:check`, `typecheck`, `lint`, `knip`.
- `LICENSE` blob `550d8df4`: Apache-2.0, copyright `2026 Z.AI Co., Ltd`.
- `NOTICE.md` blob `03eb41e0` (27 KB): explicit risk/ownership statement. Key admissions used below: shared run config defaults to `build` mode; headless `--prompt` without `--mode` defaults to `yolo`; no OS sandbox by default; Computer Use is a placeholder; Web/remote auth defaults vary by entrypoint; credentials are local encrypted files with env-derivable keys (not OS keychain); logs on by default in dev/prod.
- `architecture-policy.yaml` blob `76e26bf7`: only `storage` module is `managed:true` with domain/app/adapters layers; everything else legacy. Global caps: 400 lines/file, 300 contract lines, 12 public methods, no cycles, no deep imports.
- `DESIGN.md` is a UI design system (typography/color/radius), not architecture. Do not cite it as runtime behavior.
- `config/README.md` blob `6ee97080`: `config/default.json` is the shipped builtin default; help/community links resolve remote-first with 1h memory cache, fallback to builtin.

## 2. Upstream architecture (verified structure, not behavior)

| Layer | Pinned evidence | Pattern |
|---|---|---|
| CLI entry | `apps/zcode-cli/packages/cli/src/main.ts` blob `7d09851f` | Parse args, sanitize env, split protocol/TUI/plugin-host/dwf-child, lazy-import `run.js`. Stdout is a strict protocol frame channel in server mode; console redirected to stderr. |
| CLI router | `run.ts` blob `05455b6a`, `arguments.ts` blob `2e9ebc39` | Commands: `tui` (default), `app-server`/`agent-server`, `doctor`, `login`/`logout`, `commands`, `plugins`, `skills`, plus `-p/--prompt`, `--target`, `--resume/--continue`, `--mode`, `--output-format text/json/stream-json`, `--attach`, `--cwd`, `--force-mcs`, `--browser-use=headless`, `--enable-workflow`, `--memory-bench`, `--disallowedTools`. Strict arg parsing; unknown command = help + exit 1. |
| Agent core | `apps/zcode-cli/packages/core/src/{agent,tool,permission,hooks,mcp,memory,compact,subagent,workflow,runtime-task}` directory listings | Turn machine + message history + hydrators, registry-gated tools, permission service, hook runner, MCP client, memory extraction/recall, compaction policy, subagent runner, workflow runtime. |
| Tools | `tool/handlers/index.ts` blob `43a8e809` + handlers dir listing | ~35 registered entries (see §3). Registry supports aliases, allow/disallow filters, branch-specific variants (Bash timeout, Agent/Task descriptions), provider-visible flag. |
| Permission | `tool/../permission/service.ts` blob `fdd8bdeb` | Modes `build/edit/plan/yolo` (+ reserved `auto` that denies). `alwaysAsk` survives yolo; hard deny (disallowedTools, project deny) survives ask. Plan allows only read-only/non-destructive/session-scoped. Project rules allow/ask/deny by tool+subject; session-scoped always-allow; owned workflow amend bypass. |
| Hooks | `core/src/hooks/` (15 files) + `apps/zcode-cli/README.md` blob `50e1222e` | 7 events: SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, Stop. Process hooks only, argv exec (no shell string), JSON stdin/stdout, exit-2 = block, timeouts + 32KB cap, workspace-hook trust review flow. Docs claim; runner source not line-audited this pass. |
| MCP/Plugins/Skills | `core/src/mcp/` (3 files), CLI `plugins-command.ts`, `skills-command.ts`, zcode-cli README plugin section | Manifest `.zcode-plugin/plugin.json` (skills/commands/mcpServers/userConfig), `${ZCODE_*}` expansion only, `mcp__<server>__<tool>` names, `/mcp list/status/connect/disconnect`. Local dirs default enabled; marketplace under `~/.zcode/cli/plugins`. Listing-level verified; runtime wiring not audited. |
| Memory | `core/src/memory/` (7 files + recall/) | Project-memory with extraction agent loop, recall, index-content, origin-session. Headless `--memory-bench` requires `features.memory + memory.use`. Detail beyond filenames not audited. |
| Compact | `core/src/compact/` (6 files) | Manual + microcompact + policy + prompt + rounds. Model-assisted summarization pattern; exact budgets not read. Contrasts with Xueness char-truncation. |
| Subagents | `core/src/subagent/` (17 files) | Profiles, runner, context-builder, borrowed MCP port, persistent-memory prompt, tool-event mirror, message steering. TUI has sidebar + transcript views (`app-subagents.ts`, `app-subagent-view.tsx`). Runner internals not audited. |
| Workflows | `dynamic-workflow*` packages, `create/amend/save/eval/list/get/resume/resolve` tool cluster, TUI `app-workflow-*` | Gated by `includeDynamicWorkflow`; 10-tool gate set named in source comments. v3.14.3 theme is workflow concurrency/reuse/status efficiency. Semantics not audited. |
| TUI | `packages/tui/src/` (~50 files, `app-*.ts(x)`) | Approval panel, question/selection panels, input history, file mentions, model/mode pickers, sidebar (MCP/subagents/modified files), streaming transcript, diff view, workflow cards. File-list verified; interaction semantics docs-level. |
| Web + server | `packages/server/src/http.ts` blob `9af1bb14`, `entry-http.ts` blob `fa44e29d`, root README `bd6247f2` | Hono server: `GET /api/server-info`, `POST /api/rpc-host-capability`, `GET /ws` (terminal-client, replayable), `GET /ws/host` (capability-gated trusted host), `POST /api/connect-remote`, `GET /ws/remote/:id`, `POST /api/bots/:provider`, static SPA fallback. Token auth only when `ZCODE_SERVER_AUTH_TOKEN` set; `/ws`+`/api/*` protected, static not. `zcode --web` defaults: cwd=CWD, bind `127.0.0.1`, no token, random free port, auto-open; `--host 0.0.0.0` generates token. Dev: `pnpm dev:web` = web `:5173` + backend `:3030`, `/ws`+`/api` proxied, OAuth token endpoint proxied separately. |
| Desktop | Root README + `packages/desktop` dir | Electron Main/Host/Renderer, `pnpm dev:desktop` (prod/test envs), `bundle:desktop` (default mac arm64), `ZCODE_DATA_BASE_DIR`, remote SSH/WSL via SFTP-uploaded mock-cdn assets. Build-level verified; runtime not audited. |
| Provider | `packages/provider/src/` (13 files), `packages/provider-node`, `packages/services/src/{providers,credential,model-provider}` | Registry + resolver + config-service + account resolution + facades. Multi-provider with per-account routing; official Coding Plan gateway forwarding for two Anthropic-compatible endpoints (NOTICE §2, unverified in code this pass). |
| CUA | `packages/zcode-cua/index.js` blob `f1481fa5` | Placeholder only: returns "Computer Use is not available in this build." Verified. |
| Sessions/storage | `packages/services/src/session/` (taskIndexRepo 91KB, automationRepo 57KB, offPeak*, zcodeTaskService), `storage/` (managed module) | SQLite-backed task index (`~/.zcode/cli/db/db.sqlite` per NOTICE), automation/cron repos, off-peak queue. Schema not audited. |

Docs-claim vs verified: README composition (Desktop/Web/CLI from one repo, `zcode`/`zcode --web` UX, pnpm/bootstrap flows) is docs-claim corroborated by package scripts and server entry. Tool names, permission precedence, hook event names, registry gating flags, HTTP routes, auth-conditional behavior are source-verified at the pinned blobs above. Model catalogs, quota/billing, gateway internals, session DB schema, workflow execution semantics, and provider failover are not verified here.

## 3. CLI/Web/Desktop/agent capability inventory (upstream → Xueness map)

Legend: [S] = source-verified at pin; [D] = docs-claim, structure-corroborated, semantics not line-audited.

Agent tools [S: registry + handler filenames]:

| Upstream tool family | Xueness today | Gap |
|---|---|---|
| Read/Write/Edit, Bash, Glob/Grep | `read/list/write/exec` only (4 tools, `core.py`). No glob/grep/edit-patch, no bash-readonly policy | Missing search + safe-edit primitives |
| WebFetch/WebSearch | None | Missing network tool contract |
| TodoRead/TodoWrite, AskUserQuestion, PlanMode enter/exit | None (no plan-mode tool, no todo, no question round-trip) | Missing planning UX |
| Agent/Task/Skill, Node REPL (`js`), Cron×4, OffPeak×2 | None | Missing delegation + automation |
| Workflow cluster (Create/Amend/Save/Eval/List/Get/Resume/Resolve/ListModels/ListSaved) | None (only `completed/needs_review/paused` via `assess()`) | Missing structured durable work |
| MCP `mcp__*`, plugin skills/commands | None (only read-only memory injection from dsh-grok-memory layout) | Missing extension surface |

CLI/agent runtime:

| Upstream [S] | Xueness today | Gap |
|---|---|---|
| Modes build/edit/plan/yolo + alwaysAsk + project/session rules (`service.ts`) | Single Gate: write/exec deny-by-default, `--allow-write/--allow-exec/--interactive` per-invocation | No modes, no project rules, no session allowlist, no risk tiers |
| Headless `-p/--prompt`, `--target`, `--resume/--continue`, `--output-format`, `--attach`, `--disallowedTools`, `doctor`, `login/logout` | `new/run/list/show/demo` only; `--steps/--max-chars/--memory-root/--state` | No non-interactive prompt run, no resume-by-id across restarts beyond JSON reload, no JSON/stream output contract |
| Hooks 7 events + trust review (`hooks-trust-command.ts` [S: filename + README]) | None | Missing pre/post governance |
| Memory extraction + recall + bench gate | Read-only curated MEMORY/USER/KEY injection, char budgets, untrusted preamble, never persisted (`memory.py`, README) | No extraction, no FTS, no decay, no project/daily tracks |
| Compaction policy + microcompact + prompt | Deterministic char-bound `compact()` (keep system+task+tail, digest dropped, truncate surviving outputs) | No model summary, no token budget, no overflow classification |
| Evidence: projection/usage/turn metadata in JSON summary (`prompt-command.ts` [S]) | `assess()`: JSON `{summary, evidence[]}` must cite successful recorded tool-call IDs; failed/denied never count | Same spirit, narrower: provenance only, no correctness/test-adequacy check |

Web/Desktop:

| Upstream [S] | Xueness Web MVP today (`web.py` + `static/index.html`) | Gap |
|---|---|---|
| Hono + WS RPC (`/ws`, `/ws/host`, `/ws/remote/:id`), remote SSH/WSL bridge, Electron desktop, token-or-capability auth | Loopback-only `127.0.0.1:8137` stdlib server, Host/Origin loopback check, per-request CSRF token, one-shot per-action approvals, no blanket approve, `real` provider only with server-env key + `--allow-real-provider`, workspace roots jailed to `.web-runs/.demo//tmp`, journal + pending-denials + approvals APIs, single self-contained page | No streaming, no multi-session concurrency control, no auth token for LAN, no remote execution, no desktop, no RPC channel, no plugin/MCP panels |

## 4. Roadmap (independent implementation, testable)

Scope discipline: each item is a Xueness-side pattern adoption (names/contracts may echo upstream for interop, implementation is new stdlib Python). Stop before workflows/desktop/remote/multi-provider.

### P0 — Harden what exists (Web MVP → trustworthy local MVP)

- P0-1 One-shot approval integrity. Close argv join collision doc-accepted in `WebGate` (use tuple key + canonical argv JSON), add expired/consumed approval audit in session journal. Accept: `tests/test_web.py` gains join-collision case (`["a b","c"]` vs `["a","b c"]` approve distinctly); `python3 -m unittest discover -s tests -v` green.
- P0-2 Permission parity-lite. Add `--mode plan|build` to CLI + web run: plan denies write/exec before approval lookup; build keeps current deny-by-default. Add `--disallow-tools` deny list. Accept: plan run with fake provider yields `needs_review` without prompting; disallowed tool id is denied even with `--allow-write`.
- P0-3 Non-interactive run + machine output. Add `run --prompt TEXT` (one-shot new+run) and `--output-format json` emitting `{id,status,steps,completion,pending}`. Accept: scripted `new` + `run --fake --output-format json` parses with `json.tool`; exit codes 0 completed / 2 needs_review/paused preserved.
- P0-4 Provider seam safety net. Add per-call timeout already 40s; add response `choices[0].message` shape validation + `tool_calls` id/type schema check before persisting intent. Accept: malformed provider payload → `provider_error` without writing intent or side effect; unit test with stub opener.
- P0-5 Journal hygiene. `show` already redacts memory; add `show --full-journal-off` default + explicit `journal` export command with warning that journals contain prompts/outputs. Accept: `show` never prints memory block; docs note private-state handling.

### P1 — Close the daily-use gap (no upstream parity claim)

- P1-1 Search + safe edit. Add `glob/grep` read-only tools (workspace-jailed, capped hits) and `edit` (exact-match replace, dry-run diff preview in web pending list). Accept: fake-provider task "find X, patch one line, show diff" completes with evidence citing `grep+read+edit`; path-escape cases denied.
- P1-2 Todo + question tools. Add `todo_read/todo_write` (session-scoped, journal-persisted) and `ask_user` (CLI interactive pause; web surfaces as pending with free-text reply box). Accept: web run pauses on `ask_user`, reply resumes without losing intent journal.
- P1-3 Plan-mode UX. `EnterPlanMode/ExitPlanMode` as session flags (not separate tools): plan blocks all mutating tools at gate; exit requires explicit user action. Accept: mode transitions recorded in journal; `assess()` unaffected.
- P1-4 Session resume + history. Add `run --continue/--resume ID`, `list --json`, per-session `title` + `turnCount/tokenChars` projection in `show`. Accept: interrupted `paused` session resumes from stored messages without replaying completed side effects.
- P1-5 Web run streaming + concurrency. SSE or pollable `events` endpoint (read-only tail), single-writer lock per session id with 409 busy. Accept: two concurrent `run` on same id → one 200, one 409; no journal corruption under `unittest` thread test.
- P1-6 Token-aware compaction advisor. Keep deterministic `compact()`; add optional `max-tokens` advisory that estimates via `len(chars)/4` and records `compactions[].estimatedTokens`. No model call. Accept: compaction record includes estimate; existing char-budget tests still pass.

### P2 — Deliberately deferred (do not build for parity)

Subagents, lifecycle hooks, MCP/stdio+http clients, plugin marketplace + skills, cron/off-peak/scheduled tasks, dynamic workflows, Computer Use, browser control, SSH/WSL/remote execution, Electron desktop, multi-provider gateway + OAuth, usage/billing dashboards, RAG/FTS memory with extraction. Rationale: each carries daemon, credential, or remote-execution surface upstream itself flags as risky (NOTICE §§1-3); Xueness stdlib + single-process + evidence-gate positioning cannot absorb them without changing the security story. Revisit only as isolated versioned adapters behind explicit operator approval, same as current `--memory-root` precedent.

## 5. Licensing and attribution constraints

- Upstream is Apache-2.0 with `NOTICE.md`. Independent reimplementation of patterns/contracts is permitted, but: retain no copied files; do not reuse `ZCode` name, logo (`public/logo/*` not fetched), or copy text/docs; if any upstream-derived notice ever ships, include `LICENSE` + relevant `NOTICE` attribution and mark changed files per §4(a)-(d). Current Xueness already states "not a fork" in README; keep that line.
- `THIRD-PARTY-NOTICES.md` is ~2MB: do not import upstream deps transitively. Xueness stdlib-only stance is a license-hygiene feature; keep it.
- Trademark: Apache-2.0 §6 grants no trademark use. Never present Xueness as ZCode/official; "feature parity" in this report means overlapping user-visible patterns, not compatibility or endorsement.
- Config/docs: `config/default.json` fallback pattern may be imitated (builtin defaults + remote override with cache) but do not copy its content.

## 6. Security concerns (must-fix before any exposure beyond loopback)

From upstream NOTICE (applies as cautionary pattern, not Xueness finding): no OS sandbox in shared adapter; `yolo` without read-only planning constraint allows ordinary tools; `~/.zcode/cli/db/db.sqlite`, session logs, and local encrypted credential files with env-derivable keys are all on-disk secrets; Web auth defaults differ per entrypoint; share/import and feedback upload can exfiltrate prompts/tools/attachments; SSH sync can move keys/tokens without per-item confirm; Computer Use placeholder must not be treated as capability.
Xueness-specific (from local reads + prior reviews in `reviews/`): `exec` is argv-only + 30s + env-stripped but explicitly not a sandbox; symlink races acknowledged in `core.py`; provider bearer redirect is fail-closed raise (good, keep + regression-tested); loopback HTTP opt-in is IP-literal-only (good, keep `localhost`/trick rejection); web binds `127.0.0.1`, validates Host/Origin, requires CSRF, rejects blanket approval keys, jails roots (good, keep); gateway-integration history (`provider-usage-audit.md`, `critical-followup.md`, `integration-validation.md`) already gates HTTPS-only default, key rotation, loopback bind, and single-writer memory. Do not regress any of these for P0-P2 convenience. Never log keys, never persist memory text into journals, never sync journals to sharing/feedback surfaces.

## 7. Acceptance gates (global)

- `python3 -m unittest discover -s tests -v` green before and after each roadmap item.
- Each P0/P1 item ships its named unit/integration case; demo (`python3 -m xueness demo`) still offline and writing only `.demo/`.
- No new network, dependency, credential store, daemon, or non-loopback listener without a separate approved security note.
- Report-only deliverable: this file. No implementation changed in this pass.

## 8. Evidence appendix (pins for re-verification)

Upstream `main` @ `328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f`: README `bd6247f2`, root package `189729a3`, LICENSE `550d8df4`, NOTICE `03eb41e0`, arch policy `76e26bf7`, arch baseline `abf0a0e0` (empty violations), zcode-cli README `50e1222e`, CLI package `c9d6bf15`, `main.ts` `7d09851f`, `run.ts` `05455b6a`, `arguments.ts` `2e9ebc39`, permission `service.ts` `fdd8bdeb`, registry `f86ad997`, handlers `index.ts` `43a8e809`, server `http.ts` `9af1bb14`, `entry-http.ts` `fa44e29d`, CUA `f1481fa5`, config README `6ee97080`.
Xueness: README v0.1 (separate-harness + evidence-gate statement), `core.py` (Gate/Store/compact/assess/run), `provider.py` (HTTPS default, loopback opt-in, `_NoRedirect`), `cli.py` (new/run/list/show/demo), `web.py` (HOST `127.0.0.1:8137`, CSRF, one-shot approvals), `memory.py` (curated 3-track read-only injection), `static/index.html` (single page), `tests/test_{core,memory,provider_loopback,web}.py`, `reviews/{plugin-audit,provider-usage-audit,integration-validation,critical-followup}.md`.
Unverified in this pass: provider failover/billing, workflow execution semantics, session DB schema, memory extraction quality, desktop packaging/signing, remote SSH/WSL transport. Do not roadmap against them.
