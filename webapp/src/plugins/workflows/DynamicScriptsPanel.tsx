import { useEffect, useRef, useState } from 'react';
import { startSessionPolling } from '../sessions/SessionPolling';
import { get, post } from '../../xuenessApi';
import { t as tr } from '../../i18n';
import { IconWorkflow, IconNewTask } from '../../ui/icons';
import { OperationStatus } from '../shared';

export type DynamicActorView = {
  id: string;
  name?: string;
  asks: number;
  persona: { system?: string; role?: string; model?: string };
};

export type DynamicNodeView = {
  id: string;
  siteId: string;
  kind: 'ask' | 'read' | 'hole' | 'report' | 'trajectory';
  status: string;
  actorId?: string;
  result?: unknown;
  error?: string;
  question?: string;
};

export type DynamicEventView = {
  seq: number;
  type: string;
  at: string;
  nodeId?: string;
  actorId?: string;
  message?: string;
  phase?: string;
};

export type DynamicScriptRun = {
  id: string;
  name: string;
  description?: string;
  source: string;
  args?: unknown;
  status: string;
  phase?: string;
  maxConcurrency: number;
  writable: boolean;
  allowReal: boolean;
  digest?: string;
  active?: boolean;
  actors: Record<string, DynamicActorView>;
  nodes: Record<string, DynamicNodeView>;
  events: DynamicEventView[];
  reports: unknown[];
  result?: unknown;
  error?: string;
  updatedAt: string;
};

const ACTIVE_SCRIPT_STATES = new Set(['queued', 'running']);

const STARTER_SCRIPT = `phase("扫描工作区");
const targets = await files.glob("*.md");
log("发现文档数量:", targets.length);

phase("并行读取摘要");
const previews = await parallel(targets.slice(0, 4), async (file) => {
  const text = await files.read(file);
  return { file, chars: text.length, head: text.slice(0, 120) };
});

report({ count: previews.length, previews });
return previews;`;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function selectDynamicRun(runs: DynamicScriptRun[], selectedId: string): DynamicScriptRun | null {
  if (selectedId) {
    const exact = runs.find((item) => item.id === selectedId);
    if (exact) return exact;
  }
  return runs.find((item) => ACTIVE_SCRIPT_STATES.has(item.status) || item.status === 'awaiting_user') ?? runs[0] ?? null;
}

export function DynamicScriptsPanel({ sessionId }: { sessionId: string | null }) {
  const [runs, setRuns] = useState<DynamicScriptRun[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<DynamicScriptRun | null>(null);
  const [name, setName] = useState('并行编排脚本');
  const [description, setDescription] = useState('');
  const [source, setSource] = useState(STARTER_SCRIPT);
  const [argsText, setArgsText] = useState('{}');
  const [writable, setWritable] = useState(false);
  const [concurrency, setConcurrency] = useState(4);
  const [liveLimit, setLiveLimit] = useState(4);
  const [answerText, setAnswerText] = useState('');
  const [compileNote, setCompileNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const chosen = selectDynamicRun(runs, selectedId);
  const activeRunId = chosen?.id ?? '';

  useEffect(() => {
    if (detail) setLiveLimit(detail.maxConcurrency);
  }, [detail?.id, detail?.maxConcurrency]);

  useEffect(() => {
    setRuns([]);
    setDetail(null);
    setSelectedId('');
    setError('');
    if (!sessionId) return;
    let live = true;
    const controller = new AbortController();
    const refresh = async () => {
      if (!live || controller.signal.aborted) return;
      try {
        const res = await get<{ runs: DynamicScriptRun[] }>(`/api/sessions/${sessionId}/workflow-scripts`, controller.signal);
        if (!live || controller.signal.aborted) return;
        setRuns(res.runs);
        const target = selectDynamicRun(res.runs, selectedId);
        if (target) {
          const full = await get<DynamicScriptRun>(`/api/sessions/${sessionId}/workflow-scripts/${target.id}`, controller.signal);
          if (live && !controller.signal.aborted) setDetail(full);
        } else {
          setDetail(null);
        }
      } catch (e) {
        if (live && !controller.signal.aborted && !(e instanceof DOMException && e.name === 'AbortError')) {
          setError(errorText(e));
        }
      }
    };
    const stop = startSessionPolling({ refresh, initialDelayMs: 0, visibleDelayMs: 1200 });
    return () => { live = false; stop(); controller.abort(); };
  }, [sessionId, activeRunId, selectedId]);

  async function perform(fn: () => Promise<void>) {
    if (!sessionId) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      if (mounted.current) setError(errorText(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  function parseArgsInput(): unknown {
    const trimmed = argsText.trim();
    if (!trimmed) return undefined;
    try { return JSON.parse(trimmed); }
    catch { throw new Error(tr('脚本参数 args 必须是合法 JSON。')); }
  }

  const run = detail ?? chosen;
  const nodes = Object.values(run?.nodes ?? {});
  const actors = Object.values(run?.actors ?? {});
  const completedNodes = nodes.filter((n) => n.status === 'completed').length;
  const awaitingNode = nodes.find((n) => n.status === 'awaiting_user');
  const logs = (run?.events ?? []).filter((e) => e.type === 'log' && e.message);
  const phases = [...new Set((run?.events ?? []).filter((e) => e.type === 'phase' && e.phase).map((e) => e.phase!))];
  const isRunning = Boolean(run && ACTIVE_SCRIPT_STATES.has(run.status));

  return (
    <div className="xn-operation-card" aria-label={tr('动态脚本编排器')}>
      <h3><IconWorkflow size={16} /> {tr('动态脚本编排器 (Antigravity Orchestrator)')}</h3>
      <p className="xn-expert-intro">
        {tr('支持 TypeScript 子集编排：phase、parallel 并行扇出、pipeline 串行流水线、agent({ role, model })、typed ask<T>、trajectory 与 hole 问答。')}
      </p>
      {error && <p role="alert">{error}</p>}
      {compileNote && <p>{compileNote}</p>}

      {sessionId ? (
        <>
          <details className="xn-plan-review">
            <summary><IconNewTask size={14} /> {tr('编写并运行编排脚本')} <span>{tr('检查或直接启动 run_workflow')}</span></summary>
            <div className="xn-operation-card__body">
              <label>{tr('名称')}
                <input aria-label={tr('编排脚本名称')} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
              </label>
              <label>{tr('目标简述')}
                <input aria-label={tr('编排目标简述')} value={description} maxLength={500} placeholder={tr('可选：说明本次编排目标')} onChange={(e) => setDescription(e.target.value)} />
              </label>
              <label>{tr('编排脚本 (TypeScript)')}
                <textarea aria-label={tr('动态编排脚本源码')} rows={10} value={source} onChange={(e) => setSource(e.target.value)} />
              </label>
              <label>{tr('输入参数 args (JSON)')}
                <input aria-label={tr('编排脚本 args')} value={argsText} onChange={(e) => setArgsText(e.target.value)} />
              </label>
              <div className="xn-run-concurrency">
                <label>{tr('并发上限 (1-8)')}
                  <input aria-label={tr('新建脚本并发上限')} type="number" min={1} max={8} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} />
                </label>
                <label className="xn-plan-approval">
                  <input type="checkbox" checked={writable} onChange={(e) => setWritable(e.target.checked)} />
                  {tr('允许 Actor 修改工作区文件')}
                </label>
              </div>
              <div className="xn-operations-actions">
                <button disabled={busy || !source.trim()} onClick={() => void perform(async () => {
                  const res = await post<{ ok: boolean; diagnostics: { code: string; message: string; line: number; column: number }[]; sites: { kind: string }[] }>(
                    `/api/sessions/${sessionId}/workflow-scripts/compile`,
                    { source },
                  );
                  if (res.ok) {
                    setCompileNote(`编译通过：共识别 ${res.sites.length} 个编排位点（${res.sites.map((s) => s.kind).join(', ') || '纯计算'}）。`);
                  } else {
                    const first = res.diagnostics[0];
                    throw new Error(`编译诊断 ${first?.line}:${first?.column} [${first?.code}] ${first?.message}`);
                  }
                })}>{tr('编译检查')}</button>
                <button className="xn-operation-primary" disabled={busy || !source.trim()} onClick={() => void perform(async () => {
                  const parsedArgs = parseArgsInput();
                  const started = await post<DynamicScriptRun>(`/api/sessions/${sessionId}/workflow-scripts/run`, {
                    name: name.trim() || 'Dynamic workflow',
                    ...(description.trim() ? { description: description.trim() } : {}),
                    source,
                    ...(parsedArgs === undefined ? {} : { args: parsedArgs }),
                    maxConcurrency: concurrency,
                    writable,
                    confirmed: true,
                    allowReal: true,
                    waitMsBeforeAsync: 1500,
                  });
                  setSelectedId(started.id);
                  setDetail(started);
                  setCompileNote('');
                })}>{tr('批准并立即运行')}</button>
              </div>
            </div>
          </details>

          {runs.length > 0 && (
            <label className="xn-operation-history">
              {tr('本会话脚本编排记录')}
              <select aria-label={tr('选择动态脚本运行')} value={run?.id ?? ''} onChange={(e) => setSelectedId(e.target.value)}>
                {runs.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.status}{item.phase ? ` (${item.phase})` : ''} · {item.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
          )}

          {run ? (
            <div className="xn-expert-run" style={{ marginTop: 10 }}>
              <div className="xn-subtask-row">
                <strong>{run.name}</strong>
                <code>{run.id.slice(0, 8)}</code>
                <OperationStatus status={run.status} />
                {run.phase && <span className="xn-swarm-pill">{tr('阶段')}: {run.phase}</span>}
                {run.writable && <span className="xn-swarm-pill">{tr('可写')}</span>}
              </div>
              {run.description && <p className="xn-expert-task">{run.description}</p>}
              {run.error && <p role="alert">{run.error}</p>}

              {phases.length > 0 && (
                <div className="xn-expert-phases">
                  {phases.map((p) => (
                    <div className="xn-expert-phase" key={p}>
                      <span>{p}</span>
                      <OperationStatus status={run.phase === p ? (isRunning ? 'running' : run.status) : 'completed'} />
                    </div>
                  ))}
                </div>
              )}

              <div className="xn-run-metrics">
                <div><strong>{actors.length}</strong><span>Actors</span></div>
                <div><strong>{completedNodes}<small> / {nodes.length}</small></strong><span>{tr('已完成节点')}</span></div>
                <div><strong>{run.reports.length}</strong><span>{tr('报告项')}</span></div>
                <div><strong>{run.maxConcurrency}</strong><span>{tr('并发上限')}</span></div>
              </div>

              {actors.length > 0 && (
                <div className="xn-node-table">
                  <table>
                    <thead>
                      <tr>
                        <th>Actor</th>
                        <th>{tr('角色')}</th>
                        <th>{tr('模型档位')}</th>
                        <th>{tr('调用次数')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {actors.map((actor) => (
                        <tr key={actor.id}>
                          <td><code>{actor.name || actor.id}</code></td>
                          <td>{actor.persona.role || '—'}</td>
                          <td><code>{actor.persona.model || 'inherit'}</code></td>
                          <td>{actor.asks}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {awaitingNode && (
                <div className="xn-operation-card" style={{ marginTop: 8 }}>
                  <h4>{tr('等待回答')} (<code>{awaitingNode.id}</code> · {awaitingNode.kind === 'hole' ? 'JSON Hole' : 'Actor Question'})</h4>
                  <p>{awaitingNode.question || tr('请提供继续运行所需的输入：')}</p>
                  <div className="xn-expert-start">
                    <input
                      aria-label={tr('动态脚本问题回答')}
                      value={answerText}
                      placeholder={awaitingNode.kind === 'hole' ? tr('输入 JSON 值，例如 {"approved":true} 或 "yes"') : tr('输入回复给 Actor 的文本')}
                      onChange={(e) => setAnswerText(e.target.value)}
                    />
                    <button className="xn-operation-primary" disabled={busy || !answerText.trim()} onClick={() => void perform(async () => {
                      const answer = awaitingNode.kind === 'hole'
                        ? (() => { try { return JSON.parse(answerText); } catch { return answerText; } })()
                        : answerText;
                      await post(`/api/sessions/${sessionId}/workflow-scripts/${run.id}/resolve`, { nodeId: awaitingNode.id, answer });
                      const refreshed = await get<DynamicScriptRun>(`/api/sessions/${sessionId}/workflow-scripts/${run.id}`);
                      if (refreshed.digest) {
                        const resumed = await post<DynamicScriptRun>(`/api/sessions/${sessionId}/workflow-scripts/${run.id}/resume`, {
                          digest: refreshed.digest,
                          confirmed: true,
                          allowReal: refreshed.allowReal,
                        });
                        setDetail(resumed);
                      }
                      setAnswerText('');
                    })}>{tr('提交并恢复')}</button>
                  </div>
                </div>
              )}

              <div className="xn-run-concurrency">
                <label>{tr('实时并发')}
                  <input aria-label={tr('脚本实时并发')} type="number" min={1} max={8} value={liveLimit} onChange={(e) => setLiveLimit(Number(e.target.value))} />
                </label>
                <button disabled={busy || liveLimit < 1 || liveLimit > 8} onClick={() => void perform(async () => {
                  const updated = await post<DynamicScriptRun>(`/api/sessions/${sessionId}/workflow-scripts/${run.id}/concurrency`, { maxConcurrency: liveLimit });
                  setDetail(updated);
                })}>{tr('更新并发')}</button>
              </div>

              <div className="xn-operations-actions">
                {['draft', 'paused', 'interrupted'].includes(run.status) && (
                  <button className="xn-operation-primary" disabled={busy || !detail?.digest} onClick={() => void perform(async () => {
                    if (!detail?.digest) return;
                    const started = await post<DynamicScriptRun>(`/api/sessions/${sessionId}/workflow-scripts/${run.id}/start`, {
                      digest: detail.digest,
                      confirmed: true,
                      allowReal: true,
                    });
                    setDetail(started);
                  })}>{tr('启动 / 恢复')}</button>
                )}
                <button className="xn-operation-danger" disabled={busy || !isRunning} onClick={() => void perform(async () => {
                  const cancelled = await post<DynamicScriptRun>(`/api/sessions/${sessionId}/workflow-scripts/${run.id}/cancel`, {});
                  setDetail(cancelled);
                })}>{tr('取消运行')}</button>
                <button disabled={busy || isRunning} onClick={() => void perform(async () => {
                  const recovered = await post<DynamicScriptRun>(`/api/sessions/${sessionId}/workflow-scripts/${run.id}/recover`, {});
                  setDetail(recovered);
                })}>{tr('恢复失联锁')}</button>
              </div>

              {logs.length > 0 && (
                <details className="xn-expert-phase-detail" open>
                  <summary>{tr('编排日志')} ({logs.length})</summary>
                  <pre>{logs.map((l) => `[#${l.seq}] ${l.message}`).join('\n')}</pre>
                </details>
              )}

              {run.reports.length > 0 && (
                <details className="xn-expert-phase-detail" open>
                  <summary>{tr('结构化报告 (reports)')} ({run.reports.length})</summary>
                  <pre>{JSON.stringify(run.reports, null, 2)}</pre>
                </details>
              )}

              {run.result !== undefined && (
                <details className="xn-expert-phase-detail" open>
                  <summary>{tr('最终返回值 (result)')}</summary>
                  <pre>{JSON.stringify(run.result, null, 2)}</pre>
                </details>
              )}
            </div>
          ) : (
            <p>{tr('当前会话暂无动态编排运行；可在对话中调用 run_workflow 或展开上方编辑器启动。')}</p>
          )}
        </>
      ) : (
        <p>{tr('选择会话后即可查看或启动动态脚本编排。')}</p>
      )}
    </div>
  );
}
