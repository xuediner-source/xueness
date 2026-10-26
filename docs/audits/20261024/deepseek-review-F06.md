# DeepSeek Review — Phase F06 (MCP Core Protocol, Rich Content, OAuth, Elicitation, Apps)

**Reviewer**: deepseek-v4.1-flash (1017 high)
**Branch**: `wt-review-3`
**Scope**: all phase commits matching `^F06\.`

| Commit | Subject |
| --- | --- |
| `25e6e1d` | F06.01-02: MCP Connection Pool & Lease Generations + Core Protocol Capabilities Matrix |
| `7e496bb` | F06.03-04: MCP Rich Content & Resource Links + OAuth Discovery & Token Lifecycle |
| `68502ab` | F06.05-06: Deepen Elicitation & Server Sampling Bridge + Deepen MCP Apps UI Bridge & Frontend Host |
| `555b1a0` | F06.05-06: MCP Elicitation Flows + MCP Apps UI Host & Bridge |

**Verdict**: phase delivers against its contracts. Phase tests were green on arrival; three real defects were found by edge-case inspection of the modified files, fixed here, and covered by new regressions.

## 1. What was verified

- **Tests as found**: `bun test plugins/mcp/test/` → **89 pass, 0 fail** (15 files). After fixes: **90 pass, 0 fail**.
- **Affected regressions outside the plugin**: `packages/agent/test/accepted-call-ledger.test.ts` + `plugins/subagents/test/background-receipts.test.ts` → **19 pass, 0 fail**.
- **Gates after fixes** (`ts/`): `bun scripts/check-max-lines.ts` → ok (799 prod files, largest 388/400);
  `bun scripts/check-plugins.ts` → ok (33 plugins, 484 source files);
  `tsc -p tsconfig.json --noEmit` → clean.
- **Frontend**: `bun test src/plugins/mcp/AppsUiHost.test.tsx` → **15 pass, 0 fail**;
  `tsc --noEmit -p tsconfig.typecheck.json` → clean; `bun run build` → PASS (bundle budget gate included).
- **Edge cases inspected**: generation retirement in `McpConnectionPool` (idle dead entries, handshake re-check after `listTools`, `#publish` supersede guard, `pool.closed` short-circuit), progress/cancel metadata bounds (ring limit 32, numbers only), rich-content budget (`MCP_MEDIA_MAX_ITEMS=20`, `MCP_MEDIA_MAX_BYTES=20 MiB`, over-budget degrades to a reference, not an error), OAuth endpoint validation (https or loopback http, no credentials/query/fragment), `mergeOauthConfig` precedence (static > cache, no network), `discardPrelude` replay idempotence, elicitation queue bound (`MAX_QUEUE=4`) and generation-scoped lease/generation guards in the Apps registry.

## 2. Defects found and fixed

### F06-D1 (high) — Apps UI host could never report readiness (frontend deadlock)
`webapp/src/plugins/mcp/AppsUiHost.tsx`

`appsConnect` publishes a connection as `connecting`; only `appsReady` (the `app_ready` bridge POST) moves it to `connected`. But the panel rendered `<AppsFrame>` only for `status === "connected"`, and `AppsFrame` only calls `onLoad` (which posts `app_ready`) from a mounted `<iframe>`. With `nextReadyKey` also refusing any non-`connected` snapshot, the host had no path to ever post readiness: the connection stayed `connecting` forever, `openAppsResource` / `appsToolContext` always answered `not_connected`, and the panel showed the "waiting" placeholder indefinitely. The F06.05-06 tests did not catch this because they exercised the pure helpers with an already-`connected` fixture.

**Fix**: the panel now *claims* a frame once per connection generation as soon as the snapshot names a safe url (`appsClaimedFrame`), mounts the iframe during `connecting`, and lets the frame load emit `app_ready`. Staleness protection is unchanged: the claim is keyed by `connectionId:generation`, so a superseded frame can never report readiness for its replacement, and `closed` snapshots never claim a frame. Unclaimed rendering (`AppsFrame` without `state`) still requires `connected`, and unsafe urls (`http:` non-loopback, non-http schemes) still refuse to mount. The close path clears the claim.

### F06-D2 (medium) — `apps-http` POST bypassed plugin ownership
`ts/plugins/mcp/src/apps-http.ts`

The GET branch checked `unavailable(o.enabled)` and returned 403 when `mcp`/`sessions` were unavailable; the POST branch did not, so `app_ready` / `open_ui` / `tool_context` / `app_closed` mutated registry state with the plugin disabled. This breaks the project rule that every HTTP surface checks feature ownership (`ts/plugins/mcp/src/mcp-ops-http.ts:118` and the sibling handlers gate the verb they mutate).

**Fix**: ownership is now checked once for every verb before any state change, matching the sibling handlers. Regression added for both `mcp` and `sessions` being disabled.

### F06-D3 (low) — `openAppsResource` could report a live connection as stale
`ts/plugins/mcp/src/apps-protocol.ts`

The lookup scanned the session's entries and took the first one whose `ui://` uri matched. Two apps in one session publishing the same uri (legitimate — `ui://` is app-namespaced, not server-namespaced) meant a call from the second app resolved to the first app's entry, failed `guardOk`, and returned `stale` even though the caller's own connection was live.

**Fix**: the caller's own `connectionId`+`generation` now wins the scan; `stale` is reported only when no entry matches the guard (previously-matched uri), and `no_connection` when nothing in the session has that uri. Regression added.

## 3. Deliberate non-changes

- **`appsDisconnect` cannot name the server.** `entryKey` already includes the server id and `appsResponseFor` passes the calling server's id, so a server only ever closes its own entry. The bridge POST path carries a client-supplied `server`, which is the intended bridge contract and is constrained by the session id + generation guard.
- **`stateDir === null` in `appsResponseFor` yields `unattended`.** Unreachable in practice (the pool only attaches `_elicitation_session` alongside `_state_dir`), and the fail-closed answer is correct.
- **`oauthRevoke` without a `server` argument skips network revocation.** Static-only configuration cannot resolve an endpoint without the server row; `oauth.ts` passes the row where it has one. Not a regression.
- **`525`-style OAuth refusals.** `mergeOauthConfig` reuses the "invalid OAuth endpoint" message where Python said "OAuth endpoints require HTTPS…". Only reachable for `http:` non-loopback, which the discovery path rejects before caching; the refusal behavior (fail closed) is identical.

## 4. Residual risks (not defects)

- Progress/cancel/resource signals are in-memory ring buffers per connection (32 entries) — bounded by design, but they reset on reconnect, so a UI polling `progressCount` across a generation change sees a lower number. The snapshot carries `generation` so a client can detect that.
- The `apps` capability is advertised on `initialize` only when `server.apps === true`; a server that starts sending `apps/connect` without that config gets `-32601`. Intentional (explicit opt-in), consistent with `elicitation`.

## 5. Files changed by this review

- `ts/plugins/mcp/src/apps-http.ts` — ownership gate on every verb (F06-D2).
- `ts/plugins/mcp/src/apps-protocol.ts` — guard-first `ui://` lookup (F06-D3).
- `ts/plugins/mcp/test/apps-host.test.ts` — +2 regressions (disabled-plugin POST, shared-uri lookup).
- `webapp/src/plugins/mcp/AppsUiHost.tsx` — frame claim during `connecting`, `appsClaimedFrame`, clear-on-close (F06-D1).
- `webapp/src/plugins/mcp/AppsUiHost.test.tsx` — readiness contract updated + claimed-frame regression.

No plugin catalog, manifest, or unrelated tracked artifact was modified; the build rewrote `webapp/dist/`, which was restored to the committed state so the commit stays review-scoped. `webapp/node_modules` was linked from the shared tree (gitignored) because the review environment had no frontend dependencies installed.
