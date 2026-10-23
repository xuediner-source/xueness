---
name: seagull-game-security
description: Analyze game cheats and abuse paths for detection, lab reproduction and hardening. Use for game binaries, suspicious hooks or overlays, memory/network tampering, anti-cheat telemetry and Unity/Unreal trust boundaries.
---

# Seagull Game Security

Analyze the abuse path from trust boundary to observable behavior, then implement detection and hardening.

## Start

1. Identify engine, platform, architecture, network model, authoritative state, anti-cheat components, and available artifacts.
2. Preserve originals and record hashes before any change.
3. Map the suspected abuse path to measurable signals: memory, network, hooks, files, config, telemetry, and timing.
4. Prefer lab validation over guesswork.

## Commands

- Use Xueness file and shell tools to inspect task artifacts; keep analysis commands reproducible.
- Keep evidence, notes, and outputs in the case workspace.
- Validate with reproduction artifacts, not just static reasoning.

## Pitfalls

- Do not confuse client-side inspection with server trust.
- Do not overwrite evidence or mutate the original binary.
- Do not jump to a mitigation before understanding the abuse chain.

## Verify

- Reproduce the behavior or detect the artifact path.
- Record the signal that proves the finding.
- Summarize the hardening or detection change.
