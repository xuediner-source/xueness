/**
 * Argv read-only policy, adapted from ZCode v3.15.1
 * apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-commands.ts
 */
import type { BashReadonlyCommandPolicy } from "./readonly-argv-types.ts";
import { GIT_READONLY_SUBCOMMAND_POLICY_ENTRIES_CORE } from "./readonly-argv-git-core.ts";
import { GIT_READONLY_SUBCOMMAND_POLICY_ENTRIES_HISTORY } from "./readonly-argv-git-history.ts";
import { READONLY_MULTIWORD_POLICY_ENTRIES_CORE } from "./readonly-argv-multiword-core.ts";
import { READONLY_MULTIWORD_POLICY_ENTRIES_GH } from "./readonly-argv-multiword-gh.ts";

export {
  GIT_GLOBAL_DANGEROUS_FLAGS,
  GIT_GLOBAL_NO_VALUE_FLAGS,
  GIT_GLOBAL_VALUE_FLAGS,
  READONLY_ALLOW_ANY_ARG_COMMAND_PREFIXES,
  READONLY_ALLOW_ANY_ARG_COMMANDS,
  READONLY_COMMAND_POLICIES,
} from "./readonly-argv-simple.ts";

export const GIT_READONLY_SUBCOMMAND_POLICIES = new Map<string, BashReadonlyCommandPolicy>([
  ...GIT_READONLY_SUBCOMMAND_POLICY_ENTRIES_CORE,
  ...GIT_READONLY_SUBCOMMAND_POLICY_ENTRIES_HISTORY,
]);

export const READONLY_MULTIWORD_COMMAND_POLICIES = new Map<string, BashReadonlyCommandPolicy>([
  ...READONLY_MULTIWORD_POLICY_ENTRIES_CORE,
  ...READONLY_MULTIWORD_POLICY_ENTRIES_GH,
]);
