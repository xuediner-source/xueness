/**
 * Dry-run refuses side effects after the permission check (`before_tool_effect`),
 * so the call is one the policy would have let through. Write/edit/exec carry a
 * preview of what they would do; other side-effecting tools are refused.
 */
import { isDict } from "@xueness/contracts";
import { dryRunOn } from "./flags.ts";

const FEATURE = "tools.dry_run_experimental";
const GATES = new Set(["write", "edit", "exec", "mcp", "web_fetch", "web_search"]);
const PREVIEW = new Set(["write", "edit", "exec"]);
const SUBJECT_MAX = 300;

function sideEffect(payload: Record<string, unknown>, name: string): boolean {
  if (PREVIEW.has(name) || payload.mutating === true) return true;
  return typeof payload.kind === "string" && GATES.has(payload.kind);
}

/** The bridge's tool result for a call that dry-run stopped. */
export function dryRunDenial(payload: Readonly<Record<string, unknown>>, stateDir: string | null): Record<string, unknown> | null {
  if (!isDict(payload) || typeof payload.tool !== "string") return null;
  if (!dryRunOn(stateDir) || !sideEffect(payload, payload.tool)) return null;
  const name = payload.tool;
  const kind = typeof payload.kind === "string" ? payload.kind : "";
  const subject = typeof payload.subject === "string" ? payload.subject.slice(0, SUBJECT_MAX) : null;
  const previewed = PREVIEW.has(name);
  const output = previewed
    ? `工具干跑已开启（${FEATURE}）：权限策略本会放行，但本次调用没有执行。 / Dry run is on: this ${name} call was allowed but not executed.${subject ? ` It would act on: ${subject}` : ""}`
    : `工具干跑已开启（${FEATURE}）：${name} 属于副作用工具且没有干跑预览，已拒绝执行。 / Dry run is on: ${name} is a side-effecting tool with no preview, so it was refused.`;
  return {
    ok: false, output,
    error: { code: previewed ? "dry_run_preview" : "dry_run_refused", message: "dry run: the call was not executed" },
    data: { dry_run: true, feature: FEATURE, tool: name, gate_kind: kind, executed: false, retryable: false, preview: { action: name, subject } },
  };
}
