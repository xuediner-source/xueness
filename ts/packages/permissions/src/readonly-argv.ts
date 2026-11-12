/**
 * Argv read-only policy, adapted from ZCode v3.15.1
 * apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-argv.ts
 */
import type { ReadonlyCommandPart } from "./readonly-argv-types.ts";
import {
  READONLY_ALLOW_ANY_ARG_COMMANDS,
  READONLY_COMMAND_POLICIES,
  READONLY_MULTIWORD_COMMAND_POLICIES,
} from "./readonly-argv-commands.ts";
import {
  evaluateDirectReadonlyArgv,
} from "./readonly-argv-direct.ts";
import { isArgvAllowedByPolicy } from "./readonly-argv-match.ts";
import {
  isGitReadOnlyCommand,
} from "./readonly-argv-git.ts";
import {
  areEnvAssignmentsAllowed,
  areRedirectsAllowed,
  isUnsafeWindowsUncPath,
  stripSafeCommandWrappers,
} from "./readonly-argv-io.ts";
import type { BashReadonlyCommandPolicy } from "./readonly-argv-types.ts";

export function evaluateBashReadonlyPolicy(
  commandPart: ReadonlyCommandPart,
): boolean | undefined {
  if (!areEnvAssignmentsAllowed(commandPart)) return false;
  if (!areRedirectsAllowed(commandPart)) return false;

  const argv = stripSafeCommandWrappers(commandPart.argv);
  if (argv.length === 0) return false;
  if (argv.some(isUnsafeWindowsUncPath)) return false;
  if (argv[0] === "git") return isGitReadOnlyCommand(argv);

  const directArgvResult = evaluateDirectReadonlyArgv(argv);
  if (directArgvResult !== undefined) return directArgvResult;

  const prefixPolicyResult = evaluateReadonlyPrefixPolicy(argv, commandPart.commandText);
  if (prefixPolicyResult !== undefined) return prefixPolicyResult;

  if (READONLY_ALLOW_ANY_ARG_COMMANDS.has(argv[0] ?? "")) return true;
  if (process.platform === "win32" && argv[0] === "xargs") return undefined;

  const policy = READONLY_COMMAND_POLICIES.get(argv[0] ?? "");
  if (!policy) return undefined;
  if (argv[0] === "cd" && argv.length > 2) return false;
  if (policy.additionalCommandIsDangerousCallback?.(commandPart.commandText, argv.slice(1)))
    return false;
  if (!isArgvAllowedByPolicy(argv, policy, argv[0] ?? "")) return false;
  if (policy.regex && !policy.regex.test(commandPart.commandText)) return false;
  return true;
}

function evaluateReadonlyPrefixPolicy(
  argv: readonly string[],
  commandText: string,
): boolean | undefined {
  for (const [commandPrefix, policy] of sortedReadOnlyMultiwordPolicies()) {
    const prefixWords = commandPrefix.split(" ");
    if (!prefixWords.every((word, index) => argv[index] === word)) continue;
    const args = argv.slice(prefixWords.length);
    if (argsContainUnsafeSafeFlagText(args)) return false;
    if (policy.additionalCommandIsDangerousCallback?.(commandPrefix, args)) return false;
    if (!isArgvAllowedByPolicy(argv, policy, argv[0] ?? "", prefixWords.length)) return false;
    if (policy.regex && !policy.regex.test(commandText)) return false;
    return true;
  }
  return undefined;
}

let readOnlyMultiwordPoliciesByLength: Array<[string, BashReadonlyCommandPolicy]> | undefined;

function sortedReadOnlyMultiwordPolicies(): Array<[string, BashReadonlyCommandPolicy]> {
  readOnlyMultiwordPoliciesByLength ??= [...READONLY_MULTIWORD_COMMAND_POLICIES.entries()].sort(
    (left, right) => {
      return right[0].split(" ").length - left[0].split(" ").length;
    },
  );
  return readOnlyMultiwordPoliciesByLength;
}

function argsContainUnsafeSafeFlagText(args: readonly string[]): boolean {
  return args.some(
    (arg) => arg.includes("$") || (arg.includes("{") && (arg.includes(",") || arg.includes(".."))),
  );
}

