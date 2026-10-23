/**
 * Hook JSON output (ZCode v3.15.1 `core/hooks/output.ts` `processHookOutput`,
 * `mergeHookRunResult`, `matchesHookMatcher`; `configured-runner-callback.ts`
 * `parseHookStdout`). Ported verbatim apart from error construction.
 *
 * Xueness applies only the parts that can tighten a run: a PreToolUse hook
 * that exits 0 and prints `{"continue": false}`, `{"decision": "block"}` or a
 * `permissionDecision: "deny"` blocks the call like exit 2. An "allow" or
 * "approve" is never honoured because a hook cannot bypass its tool gate.
 */
import { isDict } from "@xueness/contracts";
type Row = Record<string, unknown>;
export type PermissionBehavior = "allow" | "deny" | "ask";
export interface HookRunResult {
  additionalContexts: string[];
  blockRequested?: boolean;
  hookPermissionDecisionReason?: string;
  permissionBehavior?: PermissionBehavior;
  permissionRequestResult?: unknown;
  preventContinuation?: boolean;
  stopShouldContinue?: boolean;
  stopReason?: string;
  updatedInput?: unknown;
}
export class HookOutputError extends Error { override name = "HookOutputError"; }

const str = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const isPermissionEvent = (event: string): boolean => event === "PreToolUse" || event === "PermissionRequest";
const shouldPreventContinuation = (event: string): boolean => event === "PreToolUse" || event === "PermissionRequest" || event === "UserPromptSubmit";

export function processHookOutput(expectedEvent: string, output: Row | undefined): HookRunResult {
  const result: HookRunResult = { additionalContexts: [] };
  if (!output) return result;
  if (output.continue === false && expectedEvent !== "Stop") {
    result.blockRequested = true;
    result.stopReason = str(output.stopReason) ?? str(output.reason);
    if (shouldPreventContinuation(expectedEvent)) result.preventContinuation = true;
    if (isPermissionEvent(expectedEvent)) result.permissionBehavior = "deny";
  }
  if (expectedEvent === "Stop" && output.continue === true) {
    result.stopShouldContinue = true;
    result.stopReason = str(output.stopReason) ?? str(output.reason);
    if (str(output.systemMessage)) result.additionalContexts.push(output.systemMessage as string);
    if (str(output.reason)) result.additionalContexts.push(output.reason as string);
    if (str(output.stopReason)) result.additionalContexts.push(output.stopReason as string);
  }
  if (output.decision === "approve" && isPermissionEvent(expectedEvent)) result.permissionBehavior = "allow";
  if (output.decision === "block") {
    result.blockRequested = true;
    result.stopReason = str(output.stopReason) ?? str(output.reason) ?? str(output.systemMessage);
    if (isPermissionEvent(expectedEvent)) result.permissionBehavior = "deny";
    if (shouldPreventContinuation(expectedEvent)) result.preventContinuation = true;
    if (expectedEvent === "Stop") {
      result.stopShouldContinue = true;
      if (str(output.systemMessage)) result.additionalContexts.push(output.systemMessage as string);
      if (str(output.reason)) result.additionalContexts.push(output.reason as string);
    }
  }
  if (str(output.additionalContext)) result.additionalContexts.push(output.additionalContext as string);
  if (str(output.additional_context)) result.additionalContexts.push(output.additional_context as string);
  const specific = output.hookSpecificOutput;
  if (!specific || typeof specific !== "object" || Array.isArray(specific)) return result;
  const named = specific as Row;
  if (named.hookEventName !== expectedEvent) throw new HookOutputError("Hook returned wrong event name");
  switch (named.hookEventName) {
    case "PreToolUse":
      if (named.permissionDecision === "allow" || named.permissionDecision === "deny" || named.permissionDecision === "ask") {
        result.permissionBehavior = named.permissionDecision;
        result.hookPermissionDecisionReason = str(named.permissionDecisionReason);
      }
      if (isDict(named.updatedInput)) result.updatedInput = named.updatedInput;
      if (str(named.additionalContext)) result.additionalContexts.push(named.additionalContext as string);
      break;
    case "PermissionRequest":
      if (named.decision) result.permissionRequestResult = named.decision;
      break;
    case "PostToolUse": case "PostToolUseFailure": case "UserPromptSubmit": case "SessionStart": case "Stop":
      if (str(named.additionalContext)) result.additionalContexts.push(named.additionalContext as string);
      break;
  }
  return result;
}

function mergePermissionBehavior(current: PermissionBehavior | undefined, next: PermissionBehavior): PermissionBehavior {
  if (current === "deny" || next === "deny") return "deny";
  if (current === "ask" || next === "ask") return "ask";
  return next;
}

export function mergeHookRunResult(target: HookRunResult, next: HookRunResult): void {
  target.additionalContexts.push(...next.additionalContexts);
  if (next.blockRequested) { target.blockRequested = true; target.stopReason = next.stopReason ?? target.stopReason; }
  if (next.preventContinuation) { target.preventContinuation = true; target.stopReason = next.stopReason ?? target.stopReason; }
  if (next.stopShouldContinue !== undefined) { target.stopShouldContinue = next.stopShouldContinue; target.stopReason = next.stopReason ?? target.stopReason; }
  if (next.updatedInput !== undefined) target.updatedInput = next.updatedInput;
  if (next.permissionRequestResult) target.permissionRequestResult = next.permissionRequestResult;
  if (next.hookPermissionDecisionReason) target.hookPermissionDecisionReason = next.hookPermissionDecisionReason;
  if (next.permissionBehavior) target.permissionBehavior = mergePermissionBehavior(target.permissionBehavior, next.permissionBehavior);
}

/** ZCode's matcher (exact `a|b` lists, else a regex); kept for reference and tests, Python's `select` decides. */
export function matchesHookMatcher(matchValue: string | undefined, matcher: string | undefined): boolean {
  if (!matcher || matcher === "*") return true;
  if (!matchValue) return false;
  if (/^[a-zA-Z0-9_|]+$/u.test(matcher)) return matcher.split("|").includes(matchValue);
  try { return new RegExp(matcher).test(matchValue); } catch { return false; }
}

/** ZCode `parseHookStdout`: a JSON object on stdout is a decision; anything else is diagnostic text. */
export function parseHookStdout(stdout: string): Row | undefined {
  const trimmed = stdout.trim();
  if (!trimmed || !trimmed.startsWith("{")) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HookOutputError("Hook stdout failed HookJSONOutput schema validation");
  return parsed as Row;
}

/** The decision a passing PreToolUse hook printed: a deny reason, or null (allow/ask never grant). */
export function preToolDenial(output: string): string | null {
  let decision: HookRunResult;
  try { decision = processHookOutput("PreToolUse", parseHookStdout(output)); } catch { return null; }
  if (decision.permissionBehavior !== "deny" && !decision.blockRequested) return null;
  return decision.hookPermissionDecisionReason ?? decision.stopReason ?? "";
}
