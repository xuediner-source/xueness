---
name: seagull-memory
description: Analyze process memory, dumps, signatures, pointer chains and runtime structures on Windows, Linux, Android, Unity and Unreal. Use for module offsets, crash dumps, memory forensics and repeatable structure recovery.
---

# Seagull Memory

Resolve runtime addresses and structures from evidence, then produce repeatable tooling.

## Start

1. Establish architecture, pointer width, endianness, target OS/runtime, and artifact type.
2. Locate modules, heaps, and candidate structures before writing offsets.
3. Validate signatures and pointer chains against a second sample or run.
4. Prefer safe read-only inspection first.

## Commands

- Use the file and shell tools available in Xueness for dump inspection, string extraction and signature scanning.
- Keep offset calculations and observed values together.
- Record module base, RVA, and final absolute address explicitly.

## Pitfalls

- Do not trust a single pointer chain without revalidation.
- Do not confuse a dump artifact with live process state.
- Do not hardcode offsets without noting the build and module version.

## Verify

- Re-read the target value from a fresh capture or process state.
- Show how the recovered structure explains the evidence.
- Note any version sensitivity.
