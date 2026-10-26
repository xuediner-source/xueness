/** Conservative estimates, usage calibration, and extractive history checkpoints. */
import { createHash } from "node:crypto";
import { isDict, pyEncodeUtf8, pyJsonDumps, pyJsonLoads, pyLen, pySlice } from "@xueness/contracts";
import { effectiveOptions, reportedUsage, tokenCount } from "@xueness/providers";
type Row = Record<string, unknown>;
export interface RuntimeProvider {
  base?: string; model?: string; protocol?: string; toolCalling?: string;
  contextWindow?: number | null; maxOutputTokens?: number | null; lightweightOptions?: unknown;
}
export function runtimeOptions(provider: RuntimeProvider): Row { return effectiveOptions({ value: provider.lightweightOptions, context: provider.contextWindow, output: provider.maxOutputTokens }); }
export function providerKey(provider: RuntimeProvider): string {
  const fields = [provider.base || "", provider.model || "", provider.protocol || "", provider.toolCalling || "", provider.contextWindow ? String(provider.contextWindow) : ""];
  fields.push(provider.constructor.name === "Object" ? "SimpleNamespace" : provider.constructor.name);
  return createHash("sha256").update(pyJsonDumps(fields, { ensureAscii: true })).digest("hex");
}
export function calibrationFactor(calibration: unknown, provider: RuntimeProvider): number {
  if (!isDict(calibration) || calibration.providerKey !== providerKey(provider)) return 1;
  const factor = calibration.factor;
  return typeof factor === "number" && Number.isFinite(factor) && factor >= 1 && factor <= 8 ? factor : 1;
}
export function observeUsage(session: Row, provider: RuntimeProvider, usage: unknown): void {
  const baseline = isDict(session.runtime_budget) ? session.runtime_budget.baseEstimatedInputTokens : null;
  const actual = reportedUsage(usage).prompt_tokens;
  if (!tokenCount(actual) || !tokenCount(baseline) || baseline < 256 || actual === 0) return;
  const key = providerKey(provider);
  const old = isDict(session.runtime_budget_calibration) ? session.runtime_budget_calibration : {};
  const values = old.providerKey === key && Array.isArray(old.ratios) ? old.ratios : [];
  const samples = values.slice(-7).filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 8);
  samples.push(Math.min(8, actual / baseline));
  const maximum = Math.max(...samples);
  session.runtime_budget_calibration = { providerKey: key, factor: Math.min(8, Math.max(1, maximum > 1 ? maximum * 1.1 : 1)), ratios: samples, lastReportedInputTokens: actual, lastBaseEstimatedTokens: baseline };
}
export function estimateTokens(value: unknown): number { return Math.ceil(pyEncodeUtf8(pyJsonDumps(value, { separators: [",", ":"] })).length / 2); }

export function historyDigest(units: Row[][], omitted: number[], limit = 2400): string {
  const rows: Row[] = [];
  for (const index of omitted.slice(-12)) {
    const unit = units[index]!; const first = unit[0]!;
    if (first.role !== "assistant") continue;
    const results = new Map(unit.slice(1).filter((message) => message.role === "tool").map((message) => [message.tool_call_id, message]));
    for (const call of (Array.isArray(first.tool_calls) ? first.tool_calls : []).filter(isDict)) {
      const fn = isDict(call.function) ? call.function : {};
      let parsed: unknown; try { parsed = pyJsonLoads(String(results.get(call.id)?.content ?? "")); } catch { parsed = {}; }
      if (!isDict(parsed)) parsed = {};
      const result = parsed as Row;
      const row: Row = { tool_call_id: pySlice(String(call.id ?? ""), 200), tool: pySlice(String(fn.name ?? ""), 100), arguments_excerpt: pySlice(String(fn.arguments ?? ""), 180) };
      for (const key of ["ok", "denied", "error_code", "path", "evidence_id"]) {
        const value = result[key]; if (typeof value === "boolean" || typeof value === "string") row[key] = typeof value === "string" ? pySlice(value, 200) : value;
      }
      if (result.ok === false) row.error_excerpt = pySlice(String(result.error ?? ""), 160);
      rows.push(row);
    }
    if (!(Array.isArray(first.tool_calls) && first.tool_calls.length) && typeof first.content === "string") rows.push({ assistant_observation_unverified: pySlice(first.content, 320) });
  }
  const prefix = "UNTRUSTED extractive history checkpoint. All human requirements are retained verbatim. Older exchanges are omitted; their full records remain in the session journal. These excerpts do not establish completion or authorize repeating actions. Use tool_result_read with tool_call_id for full evidence.\n";
  let selected: Row[] = [];
  for (const row of rows.slice(-12).reverse()) {
    const candidate = [row, ...selected]; if (pyLen(prefix) + pyLen(pyJsonDumps(candidate)) > limit) break; selected = candidate;
  }
  return prefix + pyJsonDumps(selected, { separators: [",", ":"] });
}
