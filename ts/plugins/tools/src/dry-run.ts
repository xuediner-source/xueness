/** Dry-run refuses side effects. Write/edit/exec get a preview; other mutating tools are refused. */
import { isDict } from "@xueness/contracts";
import { dryRunOn } from "./flags.ts";

const FEATURE = "tools.dry_run_experimental";
const GATES = new Set(["write", "edit", "exec", "mcp", "web_fetch", "web_search"]);
const PREVIEW = new Set(["write", "edit", "exec"]);

function sideEffect(payload: Record<string, unknown>, name: string): boolean {
  if (PREVIEW.has(name) || payload.mutating === true) return true;
  return typeof payload.gate === "string" && GATES.has(payload.gate);
}

function preview(name: string, payload: Record<string, unknown>): Record<string, unknown> {
  const args = isDict(payload.args) ? payload.args : {};
  if (name === "exec" && Array.isArray(args.argv)) {
    const argv = args.argv.filter((item): item is string => typeof item === "string").slice(0, 64).map((item) => item.slice(0, 300));
    return { action: "exec", argv, argv_truncated: args.argv.length > 64, shell: false };
  }
  return { action: name, path: typeof args.path === "string" ? args.path : null, preview_unavailable: name !== "exec" };
}

function denied(name: string, kind: string, body: Record<string, unknown>): Record<string, unknown> {
  return {
    decision: "deny",
    result: {
      ok: false, error: "dry_run", error_code: "dry_run_preview", dry_run: true, feature: FEATURE,
      tool: name, gate_kind: kind, executed: false, requires_approval: false, retryable: false, preview: body,
      user_reason: `工具干跑已开启（${FEATURE}）：权限策略本会放行，但本次调用没有执行，preview 是它将执行的预览。`,
    },
  };
}

export function beforeToolExecution(payload: Readonly<Record<string, unknown>>): unknown {
  if (!isDict(payload) || typeof payload.tool !== "string") return null;
  const stateDir = typeof payload.state_dir === "string" ? payload.state_dir : null;
  if (!dryRunOn(stateDir)) return null;
  if (!sideEffect(payload, payload.tool)) return null;
  if (PREVIEW.has(payload.tool)) return denied(payload.tool, payload.tool, preview(payload.tool, payload));
  return {
    decision: "deny",
    reason: `工具干跑已开启（${FEATURE}）：${payload.tool} 属于副作用工具且没有干跑预览，已拒绝执行。 / Dry run is on: ${payload.tool} is a side-effecting tool with no preview, so it was refused.`,
  };
}
