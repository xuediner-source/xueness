---
name: seagull-reverse
description: Reverse engineer binaries, firmware and undocumented protocols. Use static triage, disassembly, decompilation or emulation to recover behavior and validate algorithms against artifacts.
---

# Seagull Reverse

Work from artifact to verified recovered behavior.

## Start

1. Resolve the script against the base directory returned by the Xueness Skill tool and run `python "<skill-base>/scripts/triage_binary.py" <artifact>`. It reports hashes and format/architecture metadata without executing the artifact.
2. Confirm the reported format and architecture, then inspect imports/exports, packers and sections with an available analysis tool. The triage script only reports header metadata.
3. Build a hypothesis list before patching or emulation.
4. Prefer scriptable, repeatable analysis steps.

## Commands

- Use the bundled triage script for initial metadata, then the analysis tools available in the workspace.
- Capture function names, control flow, and key constants.
- Keep input samples and derived outputs organized.

## Pitfalls

- Do not patch before understanding the control point.
- Do not assume decompiler output is complete truth.
- Do not lose track of file offsets versus virtual addresses.

## Verify

- The recovered behavior matches the observed artifact.
- The analysis path is reproducible.
- Any patch or emulation result is validated against evidence.
