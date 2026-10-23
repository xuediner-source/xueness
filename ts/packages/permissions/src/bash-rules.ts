/**
 * Allow / deny / ask matching for one bash command line.
 * Adapted from ZCode v3.15.1
 * apps/zcode-cli/packages/core/src/tool/handlers/bash-command-rule-evaluator.ts
 * and packages/core/src/permission/rule-matching.ts (`wildcardToRegExp`).
 *
 * Deny and ask match when any segment matches. Allow matches only when every
 * required segment matches. An empty rule matches everything. A rule ending
 * in `:*` or ` *` is a prefix. Any other `*` is a wildcard. Anything else is
 * exact. When the line is not safe to split (the caller passes `safe: false`),
 * only an empty rule or an exact copy of the whole command matches.
 */
import { unwrapCommand } from "./readonly.ts";
import { parseShell } from "./shell-parse.ts";

export interface BashRuleContent {
  /** Null is a tool-wide rule (`exec` with no specifier). */
  readonly content: string | null;
}

export interface BashRuleEvaluationInput {
  readonly allSubjectGroups: readonly (readonly string[])[];
  readonly behavior: "allow" | "deny" | "ask";
  readonly exactCommands: readonly string[];
  readonly requiredSubjectGroups: readonly (readonly string[])[];
  readonly rules: readonly BashRuleContent[];
  readonly safe: boolean;
}

export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\S]*");
  return new RegExp(`^${escaped}$`);
}

/** Shell-word form of a rule specifier, keeping a trailing `:*` or ` *` prefix marker. */
export function ruleNeedle(specifier: string): string {
  let marker = "";
  let body = specifier.trim();
  if (body === "*") return "*";
  if (body.endsWith(":*")) {
    marker = ":*";
    body = body.slice(0, -2).trimEnd();
  } else if (body.endsWith(" *")) {
    marker = " *";
    body = body.slice(0, -2).trimEnd();
  }
  const parsed = parseShell(body);
  if (parsed.unsafe.length || parsed.commands.length > 1) return specifier.trim();
  const text = (parsed.commands[0]?.words ?? []).join(" ");
  if (!marker && text.includes("*")) return text;
  return marker ? `${text}${marker}` : text;
}

/** The command text and the same command with safe wrappers peeled off. */
export function commandSubjects(words: readonly string[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (list: readonly string[]): void => {
    const text = list.join(" ");
    if (seen.has(text)) return;
    seen.add(text);
    found.push(text);
  };
  add(words);
  for (let current = unwrapCommand(words); current?.length; current = unwrapCommand(current)) add(current);
  // No `/bin/rm` → `rm` here: deny rules get that from commandsForDeny, and an
  // allow rule for `rm` must not cover `./rm`, which may be any program.
  return found;
}

export function matchesInvocationRule(subject: string, ruleContent: string | null): boolean {
  if (ruleContent === null) return true;
  if (ruleContent.endsWith(":*") || ruleContent.endsWith(" *")) {
    const prefix = ruleContent.slice(0, -2);
    if (!prefix.includes("*")) return subject === prefix || subject.startsWith(`${prefix} `) || subject.startsWith(`${prefix}\t`);
    // `git * push *`, `* --force *`: wildcards inside the prefix still match any text.
    return new RegExp(`${wildcardToRegExp(prefix).source.slice(0, -1)}(?:[ \\t][\\s\\S]*)?$`).test(subject);
  }
  if (ruleContent.includes("*")) return wildcardToRegExp(ruleContent).test(subject);
  return subject === ruleContent;
}

export function evaluateBashRules(input: BashRuleEvaluationInput): boolean {
  if (input.rules.some((rule) => rule.content === null || rule.content === "")) return true;
  if (
    input.exactCommands.some((command) => command.length > 0) &&
    input.rules.some((rule) => rule.content !== null && input.exactCommands.includes(rule.content))
  ) {
    return true;
  }
  if (!input.safe) return false;

  const subjectGroups = input.behavior === "allow" ? input.requiredSubjectGroups : input.allSubjectGroups;
  if (subjectGroups.length === 0) return false;
  if (input.behavior !== "allow") {
    return subjectGroups.some((subjects) => subjects.some((subject) => input.rules.some((rule) => matchesInvocationRule(subject, rule.content))));
  }
  return subjectGroups.every((subjects) => subjects.some((subject) => input.rules.some((rule) => matchesInvocationRule(subject, rule.content))));
}
