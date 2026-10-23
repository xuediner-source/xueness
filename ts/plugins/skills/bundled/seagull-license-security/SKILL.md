---
name: seagull-license-security
description: Audit license, activation, subscription, entitlement and device-binding systems. Trace verification and key lifecycle, then validate replay, rollback, tampering and revocation findings against evidence.
---

# Seagull License Security

Model the license system as an entitlement and trust problem, not as one client-side comparison.

## Start

1. Identify product, client, server, operator/admin, payment, key store, entitlement store, device identity, and update channel.
2. Determine what the client can verify locally and what must be checked server-side.
3. Trace the lifecycle: issuance, activation, renewal, revocation, transfer, and recovery.
4. Look for replay, tampering, rollback, secret extraction, and bypass paths.

## Commands

- Map each validation step, entitlement decision and trust boundary from the supplied code and protocol traces.
- Prefer protocol traces, signed payloads, and config inspection over assumptions.
- Capture any proof-of-bypass in a minimal reproducible form.

## Pitfalls

- Do not treat obfuscation as protection.
- Do not assume client-side checks are trustworthy.
- Do not ignore clock, device, and network failure modes.

## Verify

- Show the exact validation path.
- State whether the system fails open or closed.
- Confirm the remediation with a retest.
