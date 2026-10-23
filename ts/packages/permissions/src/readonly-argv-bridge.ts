/**
 * Join the argv read-only policy to the shell classifier.
 * Adapted from ZCode v3.15.1
 * apps/zcode-cli/packages/core/src/tool/handlers/bash-readonly-policy-argv.ts
 * and bash-semantics.ts (`isRuntimeReadOnlyBashCommand`).
 */
import { evaluateBashReadonlyPolicy } from "./readonly-argv.ts";
import type { ReadonlyCommandPart } from "./readonly-argv-types.ts";

/** `true` / `false` when the argv policy has an opinion, `undefined` when the command is unknown to it. */
export function argvPolicyReadOnly(words: readonly string[]): boolean | undefined {
  if (words.length === 0) return false;
  // `git --version` is not a subcommand the policy lists; it cannot write.
  if (words[0] === "git" && words.length === 2 && (words[1] === "--version" || words[1] === "-v" || words[1] === "version")) return true;
  const part: ReadonlyCommandPart = {
    argv: words,
    commandText: words.join(" "),
    envAssignments: [],
    redirects: [],
  };
  return evaluateBashReadonlyPolicy(part);
}

/**
 * `cd`/`pushd`/`popd` together with `git` is not read-only: git may load hooks
 * and config from the directory it lands in. `cd` next to grep or find stays read-only.
 * Adapted from ZCode bash-git-runtime-safety.ts `analysisContainsGitAndDirectoryChange`.
 */
export function gitAndDirectoryChange(commands: readonly { readonly words: readonly string[] }[]): boolean {
  let git = false;
  let directoryChange = false;
  for (const command of commands) {
    const name = leafProgram(command.words);
    git ||= name === "git";
    directoryChange ||= name === "cd" || name === "pushd" || name === "popd";
  }
  return git && directoryChange;
}

function leafProgram(words: readonly string[]): string {
  let current = [...words];
  for (;;) {
    const wrapped = current[0];
    if (wrapped === "noglob" && current.length > 1) {
      current = current.slice(1);
      continue;
    }
    if (wrapped === "builtin") {
      const index = current[1] === "--" ? 2 : 1;
      if (index >= current.length) return wrapped;
      current = current.slice(index);
      continue;
    }
    if (wrapped === "command") {
      let index = 1;
      while (current[index] !== undefined && /^-p+$/.test(current[index] ?? "")) index += 1;
      if (current[index] === "--") index += 1;
      if (index >= current.length || (current[index] ?? "").startsWith("-")) return wrapped;
      current = current.slice(index);
      continue;
    }
    return wrapped ?? "";
  }
}

/** Reason when the argv policy rejects a command the older classifier would have allowed. */
export function stricterArgvReason(words: readonly string[]): string {
  const program = words[0] ?? "command";
  if (program === "git") {
    const flag = words.slice(1).find((word) => /^(?:-c|-C|--attr-source|--bare|--config-env|--exec-path|--git-dir|--namespace|--shallow-file|--super-prefix|--work-tree)/.test(word));
    if (flag) return `git option ${flag}`;
    const sub = words.slice(1).find((word) => word.length > 0 && !word.startsWith("-"));
    return sub ? `git ${sub}` : "git";
  }
  const flag = words.slice(1).find((word) => word.startsWith("-"));
  return flag ? `option ${flag}` : `${program} is not a known read-only command`;
}
