/**
 * Argv read-only policy, adapted from ZCode v3.15.1
 * apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-multiword-core.ts
 */
import type { BashReadonlyCommandPolicy } from "./readonly-argv-types.ts";
import {
  dockerCommandIsDangerous,
  ghCommandIsDangerous,
} from "./readonly-argv-callbacks.ts";
import { DOCKER_INSPECT_SAFE_FLAGS, DOCKER_LOGS_SAFE_FLAGS } from "./readonly-argv-flags.ts";

export const READONLY_MULTIWORD_POLICY_ENTRIES_CORE = [
  [
    "docker inspect",
    {
      safeFlags: DOCKER_INSPECT_SAFE_FLAGS,
      additionalCommandIsDangerousCallback: dockerCommandIsDangerous,
    },
  ],
  [
    "docker logs",
    {
      safeFlags: DOCKER_LOGS_SAFE_FLAGS,
      additionalCommandIsDangerousCallback: dockerCommandIsDangerous,
    },
  ],
  [
    "gh auth status",
    {
      safeFlags: {
        "-a": "none",
        "-h": "string",
        "--active": "none",
        "--hostname": "string",
        "--json": "string",
      },
      additionalCommandIsDangerousCallback: ghCommandIsDangerous,
    },
  ],
] as const satisfies readonly (readonly [string, BashReadonlyCommandPolicy])[];
