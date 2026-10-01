# Xueness Plugin Audit Report

> Status: COMPLETE (read-only, no integration)
> Date: 2026-09-23
> Scope: 3 core repos deep audit + 3 later candidates enumeration
> Constraint honored: no runtime/repo modification, no integration, no subagents, no long CLI agents
> Method: GitHub file tools only, exact paths + blob SHAs + commit SHAs

## 1. Scope & Method

Core (full source read):
- xuediner-source/dsh-autocompact (branch main)
- xuediner-source/dsh-grok-memory (branch master)
- xuediner-source/dsh-antigravity-boost (branch master)

Later candidates (enumeration only, package.json + top-level listing):
- xuediner-source/dsh-xuediner-gateway
- xuediner-source/dsh-subs-hub
- xuediner-source/dsh-usage-board

Only verified bugs/blockers below. No speculation. Severity: High = blocks integration or risks data loss; Medium = wrong behavior under plausible conditions; Low = doc drift / dead code.

---

## 2. dsh-autocompact — v0.1.0

HEAD: `5e81c38bb91212f9240cc8e50fb3b7213026504d` (2026-09-18, "chore: genericize preset-name comment")
Parent chain verified: `b233342d6a75bb887faf43b514d382c9b4330bda` (remove provider hardcoding) <- `b7b353f92bf962ef3598adea02d0e592a9929f03` <- `365a96f5bfa1274cc560de67f3866b79bfd6bad0` (initial feat).

Exact blobs (main):
- `src/index.ts` sha `5086a82dc3209637ae05c77d01c5ea1313a297d3` (18358 bytes)
- `lib/index.js` sha `0d4b5d1d6ff015320b9bc29917d47dad762c266d`
- `lib/index.d.ts` sha `3a023dee5656693032e413c0b99602ea4b741e73`
- `package.json` sha `83a2f0e53af01d79b4e2c29135e1f04036622a8e`
- `cordis.patch.yml` sha `9b059ac54c122d02d0420a5ede1bf8810a10a435`
- `README.md` sha `aafd39c4db10024857a6c417ba9c389b17aab120`

What it does (verified in source): patches `ctx.llm.stream` to re-classify overflow text to `CONTEXT_WINDOW_EXCEEDED`, wraps `resolveModelInfo` with `min(declared, learned)`, appends official compaction group to presets missing it, exposes `/autocompact status`.

### B1 [High] No tests, no test script — cannot gate integration
- Evidence: `package.json` scripts = `build/typecheck/prepare` only; repo top-level has no `test/` dir (listing: `.gitignore, LICENSE, README, cordis.patch.yml, lib/, package.json, pnpm-lock.yaml, src/, tsconfig.json`).
- Impact: overflow regexes + preset file mutation ship without regression net. Any Xueness integration must treat this as ungated.
- Test gate: add `node --test` or `tsc --noEmit` at minimum; add cases for OVERFLOW_RES false positives + captureWindow parsing + inject idempotency before install.

### B2 [Medium-High] Boot-time mutation of user presets with no opt-out
- Evidence: `src/index.ts` `injectPresets()` called unconditionally inside `apply()`; writes `~/.dsh/.agent-presets/*/agent.cordis.yml` + `.bak-autocompact` backup.
- Impact: installing plugin = immediate filesystem mutation on next boot. Uninstall leaves injected blocks (README admits: "卸载不影响已注入预设"). Rollback is manual per-file restore.
- Test gate: dry-run/status-only mode + config flag `injectPresets: false` + verify `.bak` restore path on one fixture preset.

### B3 [Medium] Over-broad overflow patterns risk spurious compaction
- Evidence: `src/index.ts` OVERFLOW_RES includes `/request.{0,24}too.{0,12}large/i` and `/\b11115\b/`.
- Impact: non-context 413s (attachment too large, tool payload too large) get re-classified as context overflow, triggering compaction + retry loop for the wrong reason.
- Test gate: feed 5 negative samples (attachment 413, gateway 413 without context tokens, code 11115 in unrelated body) — must NOT classify.

### B4 [Medium] Learned window persists forever, no eviction/clear
- Evidence: `remember()` in `src/index.ts` writes any `captureWindow()` hit (1000–10M range) to `~/.dsh/dsh-autocompact/state.json`; `resolveModelInfo` wrapper applies `min(declared, entry)`; no TTL, no `/autocompact clear`, status command is read-only.
- Impact: one mis-parsed number (e.g. `context[_\\s-]?length\\D{0,24}([\\d,]{4,})` grabbing an unrelated count) permanently shrinks the effective window until manual file deletion.
- Test gate: verify `captureWindow` against adversarial messages; require explicit-window precedence (seeds.json > learned) or a clear command.

### Notes (not bugs, checked against partial-audit claims)
- `SEED_WINDOWS = {}` verified empty — no provider hardcoding in public code. Personal seeds live in `~/.dsh/dsh-autocompact/seeds.json` (outside git). Claim "genericized" holds.
- `inject = ['llm']` with defensive `ctx.get('commands')` verified: `/autocompact` silently absent if commands service missing. Acceptable degradation, not a crash.
- `resolutionProbe` false-negative only adds a note string, does not block injection. OK.

---

## 3. dsh-grok-memory — v0.3.0

HEAD: `d5fa8b8fe3c6ca879da0f6991359f9f6c91e5f63` (2026-09-18, "feat!: v0.3.0 merge five-track model").
Key prior fix verified in history: `06aceff353daed07900ed92c7495a70cf9b04b6e` (cordis serial contract, no `next()`), `a19d27676977d49bfa6072344b8f13075e512287` (`output:{schema,render}` for real defineTool).

Exact blobs (master):
- `lib/index.js` sha `ac8576710b9f9d357272f2312e3ab18e9669b1ad`
- `lib/tracks.js` sha `f441eeb98315a7d662967130b2ee5200905ba4fe`
- `lib/search.js` sha `81973344a08ed541c6cbec8e380c2f8e968b9531`
- `lib/inject.js` sha `2214870f0e0aaaee1491857e4df6346a1ffd07a1`
- `lib/dream.js` sha `a5f9817b3af77c5dada6ff52aa28633f60f8915c`
- `lib/suggest.js` sha `d855492d637f1af33873304ea04631790bb572f9`
- `cordis.patch.yml` sha `d217f1d82c5a4a0afe8d109273cda9b4d9f911b2`
- Tests: `test/core.test.mjs` sha `2d76ce6767a761224ccb1cbee481cf7b0f9eef42`, `test/plugin.test.mjs` sha `26e36cfb1209c64e196521215c17cc50774eac66`, `test/harness.mjs` sha `c6f4b13f331aa77cc84176dfb83b4324dc34efbc`, `test/migrate.test.mjs` sha `bf825ce58b250ca60b689081f4c4ea9211a64df5`

### B5 [Medium] Cross-process read-modify-write race (admitted, still a blocker for shared roots)
- Evidence: `lib/tracks.js` `MemoryTracks.add/replace/remove/archive/promote` are whole-file read-modify-write with atomic rename but no inter-process lock; README "已知边界" admits "单进程文件锁，跨进程并发写同一轨未做仲裁".
- Impact: two DSH processes writing the same track concurrently can lose one entry. Xueness must not point two writers at one `memoryRoot` until file locking or append-merge lands.
- Test gate: two-process concurrent `add` stress (100x) must lose 0 entries.

### B6 [Low-Medium] Turn buffer is dead — auto-save depends entirely on session events
- Evidence: `lib/index.js` declares `turnBuffers` Map and reads it in `/flush` + `persistSession`, but no code path ever `.set()`s into it; `agent/turn-stopping` handler is `void payload` no-op. Fallback chain `userTextFromEvents()` -> buffer -> '' verified in `lib/inject.js`.
- Impact: on hosts that don't expose `session.events` with `user/message`, `sessionSummary` gets 0 prompts and returns null, so auto-save silently writes nothing. `/flush` then reports "session too small".
- Test gate: mock agent without `.session.events` but with 5 user turns — currently yields no summary; decide: populate buffer from `context.messages` or document events as hard requirement.

### B7 [Low] Per-call full reindex cost
- Evidence: `lib/inject.js` `withIndex()` -> `openIndex` + `reindex(allMarkdownFiles)` on every snapshot/search/recall; `lib/search.js` `reindex` walks whole root + rebuilds FTS mirror.
- Impact: first-turn latency grows with store size; every search pays full scan (mtime shortcut helps only for unchanged files).
- Test gate: benchmark with 500 daily files; if p95 > 500ms, add index-mtime cache or debounce.

### B8 [Low] Doc drift on test counts
- Evidence: README says "63 项测试"; v0.3.0 commit message says "69 tests, all passing"; test dir has core + plugin + migrate suites.
- Impact: cannot tell from docs which count is current; gate must run `npm test` and record actual pass count.
- Test gate: `npm run check && npm test` on pinned SHA, paste counts into this report before integration.

### Checked and cleared
- `output:{schema,render}` present on both tools (host crash class fixed). Verified in `lib/index.js` `textOutput`.
- Cordis listener signatures use positional `(agent, turn, reason)` / `({agent})`, no `next()`. Verified.
- `withIndex` always `db.close()` in finally (Windows EPERM class fixed). Verified.
- `replace()` preserves `[id:...]` + `[branch:...]`. Verified in `tracks.js`.
- Injection strips program prefixes, dedups `- ` bullets. Verified in `inject.js` `bullet()`.
- Decay only on `daily/project` (`DECAYING_SOURCES`), archived weight 0.6, stale flag. Verified in `search.js`.

---

## 4. dsh-antigravity-boost — v0.1.1

HEAD: `5583254b0c96b1decbe06000cbe7a700e5a7aa4b` (2026-09-18, cross-repo active-run fix).
Prior: `310e59b614be33291fafaac8297489dfa4af0d6d` (workspace targeting + defineTool output fix), `49a1fd9ac1f9844fce5bcc62c9dac0221854f321` (output fix).

Exact blobs (master):
- `lib/index.js` sha `4e00f4f17aa789f58f79e29226dc8a71d30d91b4`
- `lib/worktree.js` sha `732fd6a0611e3038e774fd326c1d897bfcede773`
- `lib/verify.js` sha `d75f7ee75d23c0606900c7553f217ac39f0af223`
- `lib/pipeline.js` sha `eba21269f1fd158ac8ced437c7f8f9bedc211a95`
- `cordis.patch.yml` sha `ce645f9f9399783469ca590e0ffbcd6a479e774a`
- Tests: `test/core.test.mjs` sha `e2073f39ece7a1b352975a4ab6f29a729b68b69b`, `test/plugin.test.mjs` sha `5fc194759c1f575adc9cd21e31cc07ad796f3a35`, `test/harness.mjs` sha `e7d7d06941ea463f9bfe89a16d5b297f3eae0d7d`

### B9 [High] closeRun merges into current checkout, not the recorded target
- Evidence: `lib/worktree.js` `closeRun(workspace, runId, {target, keepWorktree})` computes `targetBranch = target || state.base` for the *report*, but executes `git(workspace, ['merge','--no-ff','-q', state.branch, ...])` without `git checkout targetBranch` first.
- Impact: if the user switched branches after `/boost` opened, `/boost-deliver` merges the boost branch into the wrong branch while reporting success on `targetBranch`.
- Test gate: open run on `main`, checkout another branch, deliver — must either refuse or checkout target first; assert `git branch --contains boost/<id>` lands on target only.

### B10 [High] auto-commit failure is swallowed, merge can ship empty
- Evidence: `closeRun` calls `autoCommitWorktree(workspace, runId, 'verified changes')` and ignores the return; `autoCommitWorktree` fails when git identity missing, hooks reject, or `git add/commit` errors.
- Impact: uncommitted verified files stay in the worktree uncommitted; subsequent `git merge boost/<id>` merges the branch *without* them yet reports "verified changes merged". Silent content loss.
- Test gate: set repo without `user.name/email`, create changes, deliver — must fail loudly, not report success.

### B11 [Medium] Investigation contract false-positives on build artifacts
- Evidence: `lib/pipeline.js` `validateWorkstream` + `worktreeHasChanges()` uses `git status --porcelain` (tracked + untracked) in the worktree; any disk change rejects an `investigation` report.
- Impact: a verify run that leaves build output / logs / coverage in the worktree blocks legitimate root-cause reports until manual cleanup.
- Test gate: run verify producing `dist/` output, then file investigation report — currently rejected; need artifact ignore or tracked-only check.

### B12 [Low-Medium] parseReport defaults to implementation on garbage
- Evidence: `lib/index.js` `parseReport()` defaults `kind='implementation'`, `summary='(no summary)'` when input unparseable.
- Impact: `/boost-report <typo>` silently records an empty implementation workstream instead of erroring.
- Test gate: garbage input must return usage error, not `ok`.

### B13 [Low] splitCommand is dead code; README credit is stale
- Evidence: `lib/verify.js` exports `splitCommand` (quote-aware tokenizer) but `runCommand` uses `spawnSync(string, {shell:true})` on all platforms (Windows: ComSpec), never calls `splitCommand`.
- Impact: no functional bug (shell handles quotes), but README "引号内命令的正确解析" implies the tokenizer is the fix; future editors may "fix" the wrong function.
- Test gate: either wire `splitCommand` into a `shell:false` path or mark it as legacy-tested helper.

### Checked and cleared
- Destructive deliver/discard refuse `inferred` runs. Verified in `lib/index.js` both command + tool paths.
- `/boost-report` leading token is kind, not runId (`keepReportText`). Verified in `locateRun`.
- Active-run registry bounded to 50 entries, non-fatal writes. Verified in `worktree.js`.
- `runRound` stops at first failure, returns diagnostics tail (12k cap). Verified in `verify.js`.
- Verification gate requires every recorded round passed (`verifications.length>0 && every passed`) in both command and tool deliver paths. Verified.

---

## 5. Later candidates (enumeration only, not audited)

| Repo | Version | Branch | Contents (top-level) | Notes for later pass |
|---|---|---|---|---|
| dsh-xuediner-gateway | 0.2.0 | main | `client/ gateway/ scripts/ src/ test/ package.json(tsc build), pnpm-lock, tsconfig` | TS plugin, `jose` dep, `dsh.client.inject=[slots]` platform web; needs provider-surface + secret-handling audit |
| dsh-subs-hub | 0.1.2 | main | `lib/ docs/ test/ package.json(node --check + run-all.mjs)` | `dsh.client.inject=[dsh-client-runtime, connection, ui-settings]`; needs OAuth/subscription flow audit |
| dsh-usage-board | 0.3.0 | main | `lib/ docs/ test/ package.json(node --check + run-all.mjs)` | `dsh.client.inject=[slots]` usage overlay; needs detector + HTTP surface audit |

Package blobs: gateway `890747f2f36495690cdb6d572d1a2a91877dfd4a`, subs-hub `205aca00563255eb833c2b3ae6e16d6e0fc1e034`, usage-board `1885e67c82c6770292af1a99ba79c2b5c3f52f64`. No source read, no findings claimed.

---

## 6. Integration blockers summary (ordered)

1. autocompact ships ungated (B1) + mutates presets on boot (B2) — do not install until dry-run flag + tests land.
2. boost deliver path can merge wrong branch (B9) or empty merge (B10) — do not use `/boost-deliver` on real repos until both fixed + covered by tests.
3. grok-memory shared-root concurrent writes lose entries (B5) — single-writer only until lock/merge.
4. autocompact window learning has no eviction (B4) + over-broad patterns (B3) — seed explicitly, monitor `state.json`.
5. grok-memory auto-save silent-noop without session events (B6) — confirm host exposes `user/message` events before relying on `/flush`/dream counts.

## 7. Next test gates (no integration until green)

- [ ] G1 autocompact: `tsc --noEmit` clean on pinned SHA `5e81c38`; add overflow true/false-positive suite + captureWindow adversarial suite + inject idempotency on fixture preset.
- [ ] G2 grok-memory: `npm run check && npm test` on pinned SHA `d5fa8b8`; record actual counts (resolves 63 vs 69 drift); two-process concurrent-add stress 100x zero loss or document single-writer constraint.
- [ ] G3 boost: `npm run check && npm test` on pinned SHA `5583254`; add deliver-target test (branch switch) + no-identity auto-commit test + artifact-then-investigate test + garbage-report test.
- [ ] G4 Later candidates: separate read-only pass (package + lib + client + docs + tests) before any install ordering decision.
- [ ] G5 Xueness-side: define per-plugin `memoryRoot`/`DSH_HOME` isolation + backup/restore runbook for `.agent-presets/*.bak-autocompact` before any live install.

Report path: `/Users/xuediner/.openclaw/workspace/xueness/reviews/plugin-audit.md`
No runtime or repo modifications made.

---

## 8. Xueness local interface map (this turn, read from `/Users/xuediner/.openclaw/workspace/xueness/`)

Local Xueness is a Python stdlib-only harness (no JS runtime, no Cordis host):

- `xueness/core.py`: `Gate(root, allow_write, allow_exec, interactive)` + `execute()` (read/list/write/exec tools, workspace jail via `path_in`, exec strips `KEY|TOKEN|SECRET|...` env, 30s timeout); `Store(directory)` (atomic tmp+rename session JSON, id must match `[0-9a-f]{32}`); `compact(session, max_chars)` (deterministic bounded prompt view: keep first + last 4 messages, digest dropped, truncate surviving tool output); `assess(content, results)` (completion only `verified` when JSON `{summary, evidence[]}` cites successful recorded tool calls); `run(session, store, provider, gate, max_steps=8, max_chars=24000)` (intent persisted before side effects, interrupted writes NOT replayed, workspace-bound gate check).
- `xueness/provider.py`: `OpenAICompatible(base, model, key)` (HTTPS-only base, no credentials/query in URL, key from `XUENESS_API_KEY`; error details suppressed); `FakeProvider` (deterministic demo-write + demo-read two-turn).
- `xueness/cli.py`: `new/run/list/show/demo` (README documents `run`/`resume` names but code implements `new <task> --root` + `run <id>`; `--allow-write/--allow-exec/--interactive`, `--steps`, `--max-chars`; `demo` uses `FakeProvider` with `allow_write=True`).
- `tests/test_core.py`: 5 tests (persist/resume/evidence, gate+path-escape, compaction+invalid-evidence, bad-session-id+provider-config, unverified-completion).

Interface comparison per plugin:

- **autocompact vs Xueness**: functional overlap with `core.compact()` but different layer. Xueness `compact()` is deterministic truncation (chars budget, no model call, journal intact); autocompact is semantic recovery (overflow re-classification → official compaction engine + learned `min(declared, learned)` windows + preset group mount). No direct port path: autocompact patches `ctx.llm.stream` / `resolveModelInfo` on a Cordis/DSH host that Xueness does not have. Reusable idea only: `captureWindow`-style explicit-limit learning could become a Python-side `max_chars` auto-tuner, but the regexes (B3/B4) must be fixed first. No shared file/interface; `state.json`/`seeds.json` under `~/.dsh/` are outside Xueness `Store`.
- **grok-memory vs Xueness**: closest fit. Xueness has no cross-session memory (`Store` is per-task sessions, `compact()` drops history into a digest). grok-memory's five-track model (injected `memory/user/key` + on-demand `project/daily`), FTS5 search, suggestion queue, and `buildInjection` snapshot map to a future Xueness `recall(task, workspace)` pre-step. Blockers: JS (node:sqlite `DatabaseSync`) vs Python stdlib (no sqlite FTS5 used in Xueness today); project key is `sha1(cwd)[:12]` (same repo, different clone/worktree = different memory — must document); cross-process race (B5) forbids shared `memoryRoot` between concurrent Xueness runs; auto-save depends on DSH `session.events` (B6) which Xueness `run()` does not emit. A Python port would need: file layout + `§` format reader, per-budget renderer (`memoryMaxChars/userMaxChars/keyMaxChars/recallMaxChars`, total `maxChars`), and `SUGGESTIONS.jsonl` gating for injected tracks.
- **boost vs Xueness**: complementary, highest-risk. Xueness `Gate` already has `allow_write/allow_exec` + `Store` journal + `assess()` evidence gate; boost adds ephemeral git worktree isolation (`boost/<runId>`, `<repo>/.dsh-boost/`), `verifyCommands` rounds with diagnostics-feedback loop (`maxRounds`→`needs_review`), and investigation read-only contract. No code reuse directly (Node `execFileSync/spawnSync` git orchestration vs Xueness `subprocess.run` argv-only exec). If adopted, Xueness would need: worktree path inside `Gate.root` (else jail violation), verify-command allowlist (never raw shell strings), `closeRun` target-branch fix (B9) and auto-commit failure loudness (B10) ported as requirements, and `.dsh-boost/` excluded from evidence/confusion with `.xueness/tasks/`.

## 9. Candidate integration order (recommended)

1. **grok-memory (first, read-only subset)**: port `renderCurated` budgets + `recallHits` (chronological tracks only) as a Xueness pre-prompt builder over a dedicated `memoryRoot` (single writer). Gate G2 must pass; B5 single-writer constraint documented in runbook.
2. **autocompact (second, ideas only)**: do NOT install the plugin; adopt hardened `captureWindow` patterns + explicit-seed precedence as a Xueness `max_chars` advisor. Gates G1 + preset dry-run required; never enable boot-time preset mutation on this machine.
3. **boost (last, after B9+B10 fixed upstream)**: worktree isolation + verify loop for hard tasks only; forbid `/boost-deliver` on real repos until deliver-target + no-identity tests land (G3). Start with `verifyCommands=["python3 -m unittest discover -s tests -v"]` inside the worktree.
4. **Later candidates (separate pass, no order yet)**: `dsh-usage-board` (usage overlay, likely lowest risk) → `dsh-subs-hub` (OAuth/subscription secret handling) → `dsh-xuediner-gateway` (largest surface: Go gateway + TS client) — each needs its own read-only audit before any ordering decision.

## 10. Uncertainties and ambiguities (not guessed)

- dsh-llm chunk `failure` shape (`Error` instance vs `{message, code}` plain object) is unverified — the private `@deepseek-ai/*` packages were not fetched; B2-class risk in autocompact (`failureMessage` → `"[object Object]"`) stands as conditional.
- `LlmError` constructor signature `(message, code, {cause})` taken from source call-site; upstream validation not performed.
- Official DSH compaction-group block (`compaction-basic + command-compact + tool-result-pruner`, `thresholdChars 8192/head 4096/tail 1024`, `isolate.compaction/toolResultPruner`) taken from the plugin's mirrored block; not diffed against the official preset package (not fetched).
- Test counts (README "63" vs v0.3.0 message "69") unresolved — actual `npm test` run on pinned SHAs still required (G2/G3).
- Later-candidate repos enumerated from top-level + package.json only; no source read, no findings claimed (see §5).
- Subagent assistance used for initial collection; every blob SHA, branch, version, and cited function in §§2–4, 8 was re-verified this turn via read-only `gh api` (contents/sha) and exact source grep (`parseReport` defaults, zero `turnBuffers.set`, `closeRun` merge-without-checkout + ignored `autoCommitWorktree` return). Where the host packages are private, marked conditional above.
