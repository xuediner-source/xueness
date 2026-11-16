/**
 * Tool-call outcomes across sessions, for the usage page. Each session keeps
 * its own bounded `tool_outcomes` counters (written by the providers plugin
 * during runs); this sums the sessions active in the selected range. A
 * session counts whole when it was touched in the range: per-call timestamps
 * are not kept, so a range cannot split one session's totals.
 *
 * Journal data is untrusted: only finite, non-negative numbers are summed and
 * names are bounded.
 */
type Row = Record<string, unknown>;

export interface OutcomeTotals {
  calls: number; failed: number; avoidable: number;
  toolMs: number; failedToolMs: number; recoveryMs: number;
  protocolRepairs: number; protocolMs: number;
}
export interface ToolOutcomeReport {
  sessions: number;
  total: OutcomeTotals;
  groups: { group: string; avoidable: boolean; failed: number; failedToolMs: number; recoveryMs: number }[];
  tools: { name: string; calls: number; failed: number }[];
  codes: { code: string; count: number }[];
  models: (OutcomeTotals & { model: string })[];
}

const FIELDS = ["calls", "failed", "avoidable", "toolMs", "failedToolMs", "recoveryMs", "protocolRepairs", "protocolMs"] as const;
const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const name = (value: string): string => value.slice(0, 160);
const blank = (): OutcomeTotals => ({ calls: 0, failed: 0, avoidable: 0, toolMs: 0, failedToolMs: 0, recoveryMs: 0, protocolRepairs: 0, protocolMs: 0 });
function add(into: OutcomeTotals, from: unknown): void { if (isRow(from)) for (const field of FIELDS) into[field] += count(from[field]); }

/** Sum the sessions whose `mtime` (seconds) falls at or after `cutoff`; null when no session has outcomes. */
export function aggregateToolOutcomes(sessions: readonly Row[], cutoff: number | null): ToolOutcomeReport | null {
  const total = blank(), groups = new Map<string, ToolOutcomeReport["groups"][number]>(), tools = new Map<string, { calls: number; failed: number }>();
  const codes = new Map<string, number>(), models = new Map<string, OutcomeTotals>();
  let used = 0;
  for (const session of sessions) {
    const outcomes = session.tool_outcomes;
    if (!isRow(outcomes) || outcomes.version !== 1 || !isRow(outcomes.total)) continue;
    const mtime = count(session.mtime);
    if (cutoff !== null && mtime < cutoff) continue;
    used += 1;
    add(total, outcomes.total);
    if (isRow(outcomes.groups)) for (const [group, row] of Object.entries(outcomes.groups)) {
      if (!isRow(row)) continue;
      const entry = groups.get(group) ?? { group: name(group), avoidable: row.avoidable === true, failed: 0, failedToolMs: 0, recoveryMs: 0 };
      entry.failed += count(row.failed); entry.failedToolMs += count(row.failedToolMs); entry.recoveryMs += count(row.recoveryMs);
      groups.set(group, entry);
    }
    if (isRow(outcomes.tools)) for (const [tool, row] of Object.entries(outcomes.tools)) {
      if (!isRow(row)) continue;
      const entry = tools.get(tool) ?? { calls: 0, failed: 0 };
      entry.calls += count(row.calls); entry.failed += count(row.failed); tools.set(tool, entry);
    }
    if (isRow(outcomes.codes)) for (const [code, value] of Object.entries(outcomes.codes)) codes.set(code, (codes.get(code) ?? 0) + count(value));
    if (isRow(outcomes.models)) for (const [model, row] of Object.entries(outcomes.models)) {
      const entry = models.get(model) ?? blank();
      add(entry, row); models.set(model, entry);
    }
  }
  if (!used) return null;
  return {
    sessions: used, total,
    groups: [...groups.values()].filter((row) => row.failed > 0).sort((a, b) => b.failed - a.failed || a.group.localeCompare(b.group)),
    tools: [...tools].map(([tool, row]) => ({ name: name(tool), ...row })).sort((a, b) => b.failed - a.failed || b.calls - a.calls).slice(0, 12),
    codes: [...codes].map(([code, value]) => ({ code: name(code), count: value })).filter((row) => row.count > 0).sort((a, b) => b.count - a.count).slice(0, 12),
    models: [...models].map(([model, row]) => ({ model: name(model), ...row })).sort((a, b) => b.calls - a.calls).slice(0, 12),
  };
}
