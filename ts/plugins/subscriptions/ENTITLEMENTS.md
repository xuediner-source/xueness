# Optional provider entitlement adapters (F13.03)

The subscriptions plugin can talk to a **user-authorized entitlement service**:
any HTTP service the user configures that implements the public contract below.
For accounts with such a service configured, model requests really carry an
entitlement ticket ("ticket path"); without one, everything keeps working
exactly as before.

## The public contract

One bearer token (`Authorization: Bearer <token>`), four JSON endpoints under
the configured base URL:

| Purpose   | Method | Path                        | Response (sanitized on our side)                             |
| --------- | ------ | --------------------------- | ------------------------------------------------------------ |
| Account   | GET    | `/entitlement/account`      | `{account?, plan?, region?, verified?}`                       |
| Subscription | GET | `/entitlement/subscription` | `{status?, plan?, renewsAt?, expiresAt?, startedAt?, seats?}` |
| Quota     | GET    | `/entitlement/quota`        | `{supported, windows: [{kind, usedPercent, resetsAt, …}]}`    |
| Ticket    | POST   | `/entitlement/tickets`      | `{ticket: string, expiresAt?: epoch-ms}` for body `{scope}`   |

Every response is whitelisted and bounded before it reaches the UI; unknown
keys, oversized strings and non-finite timestamps are dropped. Failures map to
the shared request categories (`authentication_failed`, `rate_limited`,
`timeout`, `connection_failed`, `upstream_failure`, `invalid_response`,
`endpoint_not_found`, `request_rejected`).

## Configuring an account

With the plugin enabled and `xueness-subscriptions` installed:

```
POST /api/subscriptions/<provider-id>/entitlement   {"base": "https://ent.example.internal/v1", "token": "<user token>"}
POST /api/subscriptions/<provider-id>/entitlement   {"base": ""}            # token omitted ⇒ remove
GET  /api/subscriptions                             # entitlements[] (token never returned) + pendingInterfaces[]
```

The configuration is stored in the private subscription store
(`subscriptions/entitlements.json`, 0700, no symlinks) next to the account
documents. `GET` never returns the token — only `hasToken: true`.

## What the ticket path does

When an account has a configured service, `NativeProvider` acquires a ticket
for scope `generate:<account>` (cached until 30 s before its expiry, shared
across concurrent calls) and includes it as `ticket` in every `generate` call
it forwards to the account worker. Model discovery, quota reads and the
composer are unchanged; removing the configuration simply returns the account
to the credential-only path.

## Honest availability

- **Connectable now:** the public contract above — any service the user
  authorizes (self-hosted, company-internal, or a vendor that publishes it).
  Connectivity is exercised against real HTTP in
  `plugins/subscriptions/test/entitlements.test.ts`.
- **Pending external conditions:** the vendor-private entitlement/ticket
  interfaces of ChatGPT/Codex, Claude, Qwen Code, Command Code Go and Qoder.
  No public endpoint exists for them, so they are listed — with reasons — in
  `pendingInterfaces` and are **not** claimed as aligned. Their model and
  account surfaces keep working independently of entitlements.

`plugins/providers/src/execution-capabilities.ts` (F13.04) announces, per
model record, whether the ticket path is active and why not when it is not;
`GET /api/providers/capabilities?id=<profile>` is the UI surface for that.
