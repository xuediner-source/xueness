# Critical Follow-up — Focused Read-Only Security Review

Date: 2026-09-23
Scope: NO subagents, NO shell clones/tests, NO live credentials/login, NO runtime/remote changes.

Targets:
- `xuediner-source/dsh-xuediner-gateway@gateway/internal/server/handler.go (main)`
  - HTML: https://github.com/xuediner-source/dsh-xuediner-gateway/blob/main/gateway/internal/server/handler.go
  - Raw: https://raw.githubusercontent.com/xuediner-source/dsh-xuediner-gateway/main/gateway/internal/server/handler.go
  - API: https://api.github.com/repos/xuediner-source/dsh-xuediner-gateway/contents/gateway/internal/server/handler.go?ref=main
  - Size: 24386 bytes, SHA `37a966eec6b7cb80e76576df2abe9c68b67cbb1c` (as returned by GitHub API this run)
- `xuediner-source/dsh-subs-hub@lib/index.js (main)`
  - HTML: https://github.com/xuediner-source/dsh-subs-hub/blob/main/lib/index.js
  - Raw: https://raw.githubusercontent.com/xuediner-source/dsh-subs-hub/main/lib/index.js
  - API: https://api.github.com/repos/xuediner-source/dsh-subs-hub/contents/lib/index.js?ref=main
  - Size: 277287 bytes, SHA `30f410e9148b8cab01ec09b82969a5e79dea80ab` (as returned by GitHub API this run)
  - Method: `github__get_file_contents` head+tail truncated; supplemented by bounded `web_fetch` raw window (first ~20000 chars, full 277110 chars spilled to local tmp log for paging). No credentialed paths opened.

## Summary

- Gateway `handler.go`: auth-gated chat/models/status, unauth healthz by design, 8 MB body cap with 413, per-request account rotation with sticky-session and cooldown state machine. No direct secret leakage observed in this file alone.
- Subs-hub `lib/index.js` (bundled build): PKCE/state generation, loopback OAuth callback, atomic 0600 token store, loopback-fenced RPC channel, per-provider TokenManager, Claude Keychain/file sync with stale-write guard look solid for the sections sampled.
- No Critical (RCE / mass token exfil / unauth admin) confirmed within reviewed windows. Findings below are Low/Medium hardening notes plus explicit unverified items.

## Findings — gateway handler.go

### 1. Empty API key **disables authentication** [High if exposed, deployment-dependent]
- Evidence: `handler.go` `withAuth` calls `httpauth.VerifyBearer(r, h.loadLive().APIKey)`; independently verified [`gateway/internal/httpauth/httpauth.go`](https://github.com/xuediner-source/dsh-xuediner-gateway/blob/main/gateway/internal/httpauth/httpauth.go) blob `b1a7fc36b0cc40eac193b418ef31dacc83cec30d`: `if key == "" { return true }`. The sample `gateway/config.example.json` blob `19f60037340841f6220c04127f439cc6530b1dde` uses `"listen": ":7863"`, not explicit loopback binding.
- Risk: if effective config has an empty key and listens on an exposed interface, `/v1/*` and `/status` are unauthenticated. Live config and actual network exposure were not checked; this is a confirmed fail-open design, not a confirmed live incident.
- Action: enforce nonempty strong key before non-loopback bind (ideally fail startup), bind to loopback by default, and test empty-key behavior.

### 2. Unauthenticated `/healthz` exposes pool counts [Low, intentional]
- Evidence: `h.mux.HandleFunc("GET /healthz", h.healthz)` vs `withAuth` on `/v1/*` and `/status`; body `{"healthy":..., "total":..., "service":"workbuddy2api"}` + `X-Service` header.
- Risk: minor info disclosure for LB/orchestrator probing; comment states dual-identifier anti-fake-success rationale.
- Action: keep if LB needs it; otherwise consider gating detailed counts behind auth, leaving only 200/503 + service id public.

### 3. `/status` authenticated but returns `Pool.List()` verbatim — contents unverified [Low, needs follow-up]
- Evidence: `status()` marshals `accounts: h.cfg.Pool.List()` plus `total/healthy/cooling/disabled/in_flight_full/sticky_sessions/redis_mode`.
- Risk: if `List()` ever includes tokens/secrets/paths, authenticated callers get them. Likely UIDs only, but pool implementation NOT reviewed.
- Action: verify `Pool.List()` shape; strip anything beyond UID/health/cooldown.

### 4. Upstream error body echoed to downstream client on exhaustion [Low/Medium]
- Evidence: `lastErr = &upstream.Error{Kind: kind, Status: status, Msg: string(respBody)}`, final `msg += ": " + lastErr.Error()` returned as `no_healthy_account` 503 body.
- Risk: upstream provider message (potentially account-scoped or verbose) leaks to gateway caller. Availability-oriented, but noisy.
- Action: log full upstream body server-side, return generic `no_healthy_account` to client.

### 5. No ingress rate-limit / IP throttle visible in handler [Info]
- Evidence: `chatCompletions` does body cap, sticky resolve, `MaxRotate` loop, pool `Acquire/Release`, but no per-IP/per-key limiter in this file.
- Risk: pool exhaustion / cost amplification if gateway key shared; mitigation must live elsewhere (reverse proxy / middleware).
- Action: confirm outer layer enforces rate limits.

### 6. Refresh-then-save failure only logged [Low]
- Evidence: `if err := acct.SaveAtomic(); err != nil { log.Printf("chat refresh uid=%s: save auth failed: %v", ...) }` then continues to `ChatStream`.
- Risk: restart would reuse old token; in-memory continues with fresh token so request succeeds. Durability gap, not immediate auth bypass.
- Action: consider metrics/alert on save failure; optionally failover to next account.

## Findings — subs-hub lib/index.js (sampled regions)

### 7. PKCE/state/nonce entropy looks correct [Positive]
- Evidence: `createPkce()` → `randomBytes(32)` S256; `randomToken(16)` for `state` (128-bit); `randomHex(8)` for Grok `nonce`; `DEFAULT_FLOW_TIMEOUT_MS = 18e4`, max 3 concurrent attempts, 1 per provider.
- Assessment: matches OAuth best practice for public loopback client in sampled window.

### 8. Loopback callback validates path/state/code [Positive with note]
- Evidence: `handler` checks `url.pathname !== spec.callbackPath` → 404; `state !== input.state` → 400 `state mismatch`; missing `code` → 400; `error/error_description` → failure page + settle error.
- Note: callback handler itself has NO Host/Origin fence (unlike `isLoopbackAuthRequest` for RPC). CSRF still blocked by 128-bit `state`, but DNS-rebinding / foreign-site navigation to loopback relies solely on state secrecy.
- Action: consider Host allowlist (`localhost/127.*/::1`) on callback listener if `spec.listen.host` permits; verify `spec.listen` values (NOT reviewed — see unverified).

### 9. `failurePage` strips `<>&` only [Very Low]
- Evidence: `` `${detail.replace(/[<>&]/g, "")}` `` inside `<p>`.
- Assessment: sufficient in text-node context; quotes/slashes need not be escaped there. No stored XSS in sampled path since `detail` comes from query and is rendered once.
- Action: no change required; if template ever moves into attribute context, switch to full HTML-encoder.

### 10. `manual()` bare-code path skips state binding [Very Low]
- Evidence: `manual(rawInput)` — if input is bare token (no whitespace, no `code=`/URL), accepts as `code` without `pastedState` check; URL/query forms DO enforce `pastedState === input.state` when present.
- Assessment: acceptable for user-pasted self-login, but weakens cross-attempt binding for the bare-string case.
- Action: document as intentional UX tradeoff; prefer URL paste.

### 11. Token store atomic + 0600/0700, fails closed [Positive]
- Evidence: `authFilePath() = dshHomePath('plugins','subscriptions','auth.json')`; `writeStore` → `mkdir 0700`, tmp `writeFile mode 0600`, `chmod 0600`, `rename`, `rm tmp` on error; `parseStore`/`assertSessionShape` require `accessToken/expiresAt/refreshToken`, throw on malformed JSON or non-object.
- Assessment: good durability/permissions; fail-closed avoids silent token loss. Legacy `plugins/router/auth.json` migrated then `rm` — verify legacy deletion audited (sampled code does `rm(legacyAuthFilePath(), {force:true})` after successful `writeStore`).

### 12. RPC channel loopback + Origin fence looks correct [Positive]
- Evidence: `SUBSCRIPTIONS_AUTH_CHANNEL = "/subscriptions-auth"`; `endpointFromPath` rejects `"" / . / ..` and enforces `/^[A-Za-z0-9_$.-]+$/`; `isLoopbackAuthRequest` requires Host in `localhost/::1/127.*` and same-host Origin when Origin present; `Content-Type must be application/json`; `AUTH_RPC_MAX_BODY_BYTES = 4MB`; `readProvider` allowlists `PROVIDER_IDS`; `readImageRef` allowlists image types + positive-int checks; `readVideoName` `/^[\w.-]+\.mp4$/` pins to videos dir.
- Note: 4 MB is generous for auth payloads (comment says few KB) — bounded DoS surface, not critical.

### 13. `TokenManager` coalescing + permanent-vs-transient handling [Positive]
- Evidence: `session(forceRefresh)` respects `preemptMs`, `inflight` coalescing, `doRefresh` re-loads and skips if another rotation already fresh, `isPermanent => remove()+INVALID_CREDENTIAL`, transient fallback to still-valid token.
- Assessment: avoids refresh stampedes and accidental logout on transient net errors in sampled logic.

### 14. Claude Keychain/file sync has stale-write guard [Positive]
- Evidence: `readClaudeCodeCredentials()` prefers macOS Keychain then file; `parseBlob/toSession` type-checks; `writeBackClaudeCodeCredentials` checks `blobMatches(raw, expectedPriorAccessToken)` before merge; file writes use dir `0700` / file `0600`.
- Assessment: correct TOCTOU mitigation pattern for multi-consumer (CLI + harness) rotation in sampled window.

### 15. `fetchProxyThenDirect` fallback + `bodyTimeout: 0` [Low/Medium, needs owner decision]
- Evidence (sampled `src/providers/common.ts` region): `fetchProxyThenDirect` catches `isDeadProxyError` (regex includes `ECONNREFUSED 127.0.0.1:7890|1080|UND_ERR_SOCKET|...|ECONNRESET|EPIPE|ETIMEDOUT|socket hang up`) then `fetchDirect` via undici `Agent({headersTimeout:600000, bodyTimeout:0, keepAlive...})`.
- Risks: (a) privacy/proxy-bypass — traffic intended for proxy egresses direct on broad error match; (b) `bodyTimeout: 0` disables body timeout (hanging streams); (c) 10-min headersTimeout is long.
- Action: narrow regex to certain proxy-dead signals, log fallback, consider finite body/idle timeout. Verify whether proxy use is security boundary in deployment.

## Scope Limitations (read-only, no runtime)

- Gateway: reviewed `handler.go` and, in follow-up, `httpauth.VerifyBearer`. NOT reviewed: `pool` (Pick/Acquire/Cooldown/List shape), `upstream` (Classify/ChatStream/RefreshToken/FetchModels/ExtractClientIP), `session` (ExtractKey/Bind), `prompt.Rewrite`, `livecfg.Holder`, `Panel` handler/auth, config loading, TLS/reverse-proxy, deployment env.
- Subs-hub: reviewed ONLY sampled windows of bundled `lib/index.js` (pkce, oauth-flow callback/manager, claude-code-creds, store, rpc, TokenManager/ModelCatalogCache headers, common fetch helpers). NOT reviewed: per-provider `buildAuthorizeUrl / token exchange / refresh grant / client_secret handling`, `qwen-device-flow.js`, actual `spec.listen.host/ports/callbackPath` values, proxy env handling, `usage/image/video/speed` controllers, frontend static fallback, discovery/catalog persistence full path.
- No secret values accessed; no login flows executed; no network probe beyond read-only GitHub/raw fetch; no SAST/dependency scan.

## Exact Unverified Items (need follow-up with code pointers, no live creds)

1. `httpauth.VerifyBearer` empty-key semantics verified in follow-up: empty key returns true; nonempty bearer comparison hashes both values and calls `subtle.ConstantTimeCompare` (blob `b1a7fc36b0cc40eac193b418ef31dacc83cec30d`). Effective live key and bind are still unverified.
2. `pool.Pool.List()` field shape — confirm no tokens/paths/secrets.
3. `upstream.Classify / ChatStream / RefreshToken / FetchModels` — error taxonomy, token transport (header/body), logging redaction.
4. `upstream.ExtractClientIP` — `X-Forwarded-For` spoofing / trusted-proxy list.
5. `session.ExtractKey` — key entropy / injection into router map; unbounded cardinality?
6. `prompt.Rewrite` — JSON robustness / size blowup; confirm 413 precedes rewrite (it does in handler).
7. Panel `/panel/` authz/authn — same `api_key` Bearer? CSRF? Path traversal in static?
8. `livecfg.Holder.Load` concurrency + hot-reload validation (e.g., soft_rate bounds).
9. Subs-hub `spec.listen` concrete values per provider — confirm loopback-only, fixed vs ephemeral ports.
10. Subs-hub per-provider token endpoint: PKCE `verifier` wiring, `client_secret` presence, redirect_uri exact match, token response validation, refresh error `isPermanent` mapping.
11. `dshHomePath` resolution + file ACLs on non-macOS; legacy auth file deletion audit.
12. Proxy requirement: is proxy a security boundary? If yes, `fetchProxyThenDirect` needs policy change.
13. `models.json` catalog persistence: `sanitizeSnapshot` strict-drop noted; confirm no credential fields persisted there.
14. Frontend `/subscriptions-auth` fallback: confirm non-POST falls through safely (server returns 404 in sampled handler; static fallback 405 noted in comment — verify no auth bypass).

## Severity Key

- Critical: exploitable RCE / mass cred exfil / unauth privileged — NONE confirmed in reviewed windows.
- High if deployed exposed: confirmed empty-key auth bypass by design (#1); effective deployment unverified.
- Medium: proxy-bypass policy (#15), upstream-error passthrough (#4).
- Low/Info: healthz disclosure, status shape, refresh-save durability, callback Host fence, manual bare-code, failurePage encoding.

## Deliverable Note

- Prior attempt yielded no artifact; this file is the deliverable at the exact requested path.
- Further depth requires expanding scope to files listed under Unverified Items, still read-only, still no live credentials.
