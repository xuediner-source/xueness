import React, { useEffect, useRef, useState } from 'react';
import { get, post } from '../../xuenessApi';
import { t as tr } from '../../i18n';
import { IconWorkflow } from '../../ui/icons';
import { OperationStatus } from '../shared';

export type ExpertPhaseState = { status: string; summary: string; error?: string };
export type ExpertRun = {
  id: string;
  session: string | null;
  task: string;
  root: string;
  permission_mode: string;
  status: string;
  phase: string;
  phases: Record<string, ExpertPhaseState>;
  created_at: number;
  updated_at: number;
  error?: string;
};

export const EXPERT_PHASES = [
  { id: 'research', label: '调研', summary: '调研纪要' },
  { id: 'plan', label: '计划', summary: '计划文本' },
  { id: 'implement', label: '实现', summary: '改动摘要' },
  { id: 'review', label: '审查', summary: '审查结论' },
] as const;

const EXPERT_ACTIVE = new Set(['running', 'paused']);

/** The run the panel shows: the session's active one, else the latest. */
export function selectExpertRun(runs: ExpertRun[]): ExpertRun | null {
  const active = runs.find(run => EXPERT_ACTIVE.has(run.status));
  return active ?? runs[0] ?? null;
}

/** Phase pipeline states for tests and rendering, in fixed order. */
export function expertPhaseStates(run: Pick<ExpertRun, 'phases'>): { id: string; label: string; status: string }[] {
  return EXPERT_PHASES.map(phase => ({
    id: phase.id,
    label: phase.label,
    status: run.phases[phase.id]?.status || 'pending',
  }));
}

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

type ExpertPanelRefresh = {
  sessionId: string | null;
  signal: AbortSignal;
  isCurrent: () => boolean;
  onRuns: (runs: ExpertRun[]) => void;
};

/** Refresh the expert view for one session (or all sessions when unbound). */
export async function refreshExpertPanel(options: ExpertPanelRefresh): Promise<void> {
  const query = options.sessionId ? `?session=${options.sessionId}` : '';
  const result = await get<{ expert_runs: ExpertRun[] }>(`/api/workflows/expert${query}`, options.signal);
  if (options.isCurrent()) options.onRuns(result.expert_runs);
}

export function ExpertPanel({ sessionId }: { sessionId: string | null }) {
  const [runs, setRuns] = useState<ExpertRun[]>([]);
  const [root, setRoot] = useState('');
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!sessionId) { setRoot(''); return; }
    let live = true;
    get<{ root: string }>(`/api/sessions/${sessionId}`)
      .then(s => { if (live) setRoot(s.root); })
      .catch(() => { /* start row stays hidden without a root */ });
    return () => { live = false; };
  }, [sessionId]);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const refresh = async () => {
      if (!live) return;
      try {
        await refreshExpertPanel({
          sessionId, signal: controller.signal,
          isCurrent: () => live && !controller.signal.aborted,
          onRuns: setRuns,
        });
      } catch (e) {
        if (live && !controller.signal.aborted) setError(errorText(e));
      }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => { live = false; clearInterval(timer); controller.abort(); };
  }, [sessionId]);
  async function perform(fn: () => Promise<unknown>) {
    setBusy(true); setError('');
    try {
      await fn();
    } catch (e) {
      if (mounted.current) setError(errorText(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const run = selectExpertRun(runs);
  const terminal = Boolean(run && !EXPERT_ACTIVE.has(run.status));
  return <div className="xn-operation-card xn-expert-card" aria-label={tr("专家工作流")}>
    <h3><IconWorkflow size={16} /> {tr("专家工作流")}</h3>
    <p className="xn-expert-intro">{tr("固定四阶段流水线：调研 → 计划 → 实现 → 审查，逐阶段推进并保留各阶段摘要。")}</p>
    {error && <p role="alert">{error}</p>}
    {sessionId && root && <div className="xn-expert-start">
      <label>{tr("任务")}
        <input aria-label={tr("专家工作流任务")} value={task} maxLength={5000}
               placeholder={tr("描述要交给专家工作流完成的任务")}
               onChange={e => setTask(e.target.value)} />
      </label>
      <button className="xn-operation-primary" disabled={busy || !task.trim()}
              onClick={() => void perform(async () => {
                await post<ExpertRun>('/api/workflows/expert',
                  { task: task.trim(), root, ...(sessionId ? { session: sessionId } : {}) });
                setTask('');
              })}>{tr("启动")}</button>
    </div>}
    {run ? <div className="xn-expert-run">
      <div className="xn-subtask-row">
        <code>{run.id.slice(0, 8)}</code>
        <OperationStatus status={run.status} />
        <span>{tr("许可模式")} {run.permission_mode}</span>
        {run.error && <p role="alert">{run.error}</p>}
      </div>
      <p className="xn-expert-task">{run.task}</p>
      <div className="xn-expert-phases">
        {expertPhaseStates(run).map(phase => <div className="xn-expert-phase" key={phase.id}>
          <span>{tr(phase.label)}</span>
          <OperationStatus status={phase.status} />
        </div>)}
      </div>
      {EXPERT_PHASES.map(phase => {
        const state = run.phases[phase.id];
        if (!state || (!state.summary && !state.error)) return null;
        return <details key={phase.id} className="xn-expert-phase-detail">
          <summary>{tr(phase.summary)}</summary>
          {state.error && <p role="alert">{state.error}</p>}
          <pre>{state.summary}</pre>
        </details>;
      })}
      <div className="xn-operations-actions">
        <button disabled={busy || terminal}
                onClick={() => void perform(() => post(`/api/workflows/expert/${run.id}/resume`, {}))}>{tr("继续")}</button>
        <button className="xn-operation-danger" disabled={busy || terminal}
                onClick={() => void perform(() => post(`/api/workflows/expert/${run.id}/stop`, {}))}>{tr("停止")}</button>
      </div>
    </div> : <p>{sessionId ? tr("当前会话暂无专家工作流；输入任务后启动。") : tr("选择会话后查看专家工作流。")}</p>}
  </div>;
}
