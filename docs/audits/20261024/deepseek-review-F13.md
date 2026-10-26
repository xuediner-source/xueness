# Phase F13 audit — execution ports, off-peak tickets, entitlements, capability announcement

Reviewer: deepseek-v4.1-flash (1017, max)
Scope: all F13 commits on `wt-review-3`

- `0dde153` F13.01-02 — execution selection / request-auth ports, off-peak ticket + takeover
- `c63d16d` F13.03-04 — optional provider entitlement adapters, unified capability discovery and degradation

Verdict: **two real defects found and fixed** (one protocol-level, one cross-account security-relevant).
All F13 suites pass after the fixes; the two new regressions lock the fixes in.

## What was verified

| Area | Evidence |
| --- | --- |
| Ports (`execution-ports.ts`) | `savedProfileRequestAuth` reads the profile registry at request time, fails before network I/O with no credential, no baked-in account; `withCredentialRefresh` restricted to 401/403 and auth-shaped provider codes; `composeRequestAuth` merges in declaration order and fails as a whole; `sameProviderFallback` keeps the provider and swaps the model (`sameProvider: true`). |
| Ticket state machine (`off-peak-ticket.ts`) | take / renew / re-sign / settle / takeover / `ticketRequestAuth`; expiry classification `absent / active / resignable / settled`; output-first guard (`已输出不重播`) enforced on take, on re-sign and in the queue reconciler. |
| Queue integration (`off-peak-queue.ts`) | ticket taken on claim, settled on terminal attempt, re-sign only when `outputDelivered === false`, `null` (unknowable) treated as delivered, overall deadline anchored on `ticket.startedAt` so re-signs cannot reset it, takeover invalidates the ticket and stops the workflow. |
| Entitlement contract (`entitlements.ts`) | real HTTP against a loopback service; per-endpoint whitelisting; bounded strings/timestamps; failure mapping onto shared categories (`401/403 → authentication_failed`, `404`, `429`, `5xx → upstream_failure`, invalid JSON, timeout, connection). |
| Config store (`entitlement-config.ts`) | base/token validated and bounded; token never returned over HTTP (`hasToken` only); removal leaves the credential-only path intact. |
| Capability announcement (`execution-capabilities.ts`) | standard always available; `effective` always an available mode; subscription records announce `lightweight` unavailable with `subscriptions.standard_only`; ticket path real only when account-backed + plugin available + service configured; WorkBuddy pool reported as `workbuddy.pool_gateway`; pending vendor interfaces listed, never claimed aligned. |
| HTTP surface | `GET /api/providers/capabilities` honours the plugin-disable guard (403), 404 for unknown/absent selections, and passes front-door flags through `capabilityFlags`; `POST /api/subscriptions/:id/entitlement` accepts only `base`/`token`. |

Tests: `bun test plugins/automation/test plugins/providers/test plugins/subscriptions/test` → **157 pass, 1 skip, 0 fail**.

## Defect 1 — a lapsed ticket could be revived in place (F13.02)

`renewTicketState` only checked `state === "active"`, not the clock. Renewing a ticket after
`expiresAt` set `expiresAt = now + segment` while leaving the lapsed id live, so the request
boundary `ticketRequestAuth` — which refuses on `state === "expired" || now >= expiresAt` before
the write — would have accepted the revived ticket, and the reconciler's expiry path was skipped
entirely. Reproduced before the fix:

```
take at 1000 (segment 3h) → renew at 1000+3h+10 → headers: ["X-Off-Peak-Ticket-ID"]
```

That breaks the upstream D26 rule that a lapsed segment is ended by re-signing (no output) or
settling (output delivered), and lets an unattended run continue on a segment nobody authorized.

Fix (`ts/plugins/automation/src/off-peak-ticket.ts`): renewal now refuses a lapsed ticket
(`now >= prior.expiresAt → PyValueError`), forcing the expiry path — `resignTicketState` when no
output was delivered, settlement otherwise. Regression: "a lapsed ticket renews only through the
expiry path, never in place".

## Defect 2 — one in-flight ticket was shared across scopes (F13.03)

`EntitlementTickets` kept a single `inFlight` promise. Concurrent `get` calls for different scopes
(the multi-account case, `generate:<accountA>` / `generate:<accountB>`) joined whichever
acquisition was already running and both returned that ticket, then cached it under *both* scope
keys. Reproduced before the fix:

```
Promise.all([get("scope-a"), get("scope-b")]) → A, A
```

So account B's generate would carry account A's entitlement ticket — a cross-account credential
mix-up that also makes the cache serve a foreign ticket for a full lifetime — and the second
scope's `acquire` was silently never called.

Fix (`ts/plugins/subscriptions/src/entitlements.ts`): in-flight acquisitions are keyed by scope
(`Map<string, Promise>`, entry deleted on settle), and a returned ticket whose `scope` differs from
the requested one is rejected rather than cached. Regression: "never hands one scope's in-flight
ticket to another scope".

## Contract gaps noted, not changed

- `announceExecutionCapabilities` attaches the ticket-path reason only to the `standard` mode; the
  ticket mechanic is runtime-level, so this is a reporting choice, not a capability claim.
- `degradeSelection` returns the announcement's own fallback when the request equals `effective`;
  that is the intended "no new degradation to report" reading and is covered by tests.
- Takeover on a task that is *queued* (not running) still stamps `takeoverAt` and defers to the next
  window without minting a ticket — consistent with "interactive turns run on the ordinary session
  model", no ticket to invalidate exists yet.

## Gates

- `bun scripts/check-max-lines.ts` → ok (largest `plugins/automation/src/off-peak-queue.ts`, 399/400).
- `bun scripts/check-plugins.ts` → ok (34 plugins, 508 source files).
- `bun run typecheck` → 24 errors, all pre-existing and outside F13 scope
  (`apps/server/src/agent-subagents.ts`, `apps/server/src/bundled-plugins.ts`,
  `plugins/subagents/test/{inheritance,channel-reply}.test.ts`); no error in any file touched by
  F13 or by this review.

## Files changed by this review

- `ts/plugins/automation/src/off-peak-ticket.ts` — renew refuses a lapsed ticket.
- `ts/plugins/automation/test/off-peak-queue.test.ts` — regression for the expiry-path rule.
- `ts/plugins/subscriptions/src/entitlements.ts` — per-scope in-flight acquisition + scope check.
- `ts/plugins/subscriptions/test/entitlements.test.ts` — cross-scope regression.
