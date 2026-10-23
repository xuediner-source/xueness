---
name: seagull-lab
description: Create reproducible research workspaces, hash original artifacts and track commands, evidence and derived outputs for reverse engineering, memory analysis, security testing and protocol research.
---

# Seagull Lab

Create a clean, repeatable case before complex analysis.

## Start

1. Resolve script paths against the base directory returned by the Xueness Skill tool. Run `python "<skill-base>/scripts/new_case.py" <name> --root <workspace-directory>` to create a case workspace.
2. Hash every original artifact before modifying anything.
3. Keep a command log and a short evidence log alongside the case.
4. Store derived outputs separately from originals.

## Commands

- Run `python "<skill-base>/scripts/hash_artifact.py" <file> [<file> ...]` to obtain absolute paths, sizes and SHA-256 hashes as JSON; add the evidence records to the case manifest.
- Use the generated case layout to keep analysis reproducible.
- Write notes in the case folder, not in ad hoc scratch files.

## Pitfalls

- Do not mix originals and generated files.
- Do not skip hashes for volatile artifacts.
- Do not lose the exact commands used to produce a result.

## Verify

- A third party should be able to replay the case from the workspace.
- The manifest should list source artifacts, hashes, and outputs.
