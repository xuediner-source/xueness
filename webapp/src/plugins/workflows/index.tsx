import React, { useEffect, useRef, useState } from 'react';
import { get, post } from '../../xuenessApi';
import { IconWorkflow, IconTerminal, IconFolder, IconNewTask } from '../../ui/icons';
import { t as tr, tf } from '../../i18n';
import { OperationHeader, OperationStatus } from '../shared';
import '../../styles/operations.css';
type NodeState = { status: string; attempts: number; error?: string; summary?: string; reused_from?: string; log_capped?: boolean };
type Workflow = { id: string; status: string; root: string; concurrency: number; plan: { name: string; nodes: unknown[] }; nodes: Record<string, NodeState>; events: { seq: number; type: string; node?: string; status?: string }[] };
type Summary = { id: string; name: string; status: string };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const ACTIVE_STATUSES = new Set(['queued', 'running', 'pausing', 'stopping']);
const STATUS_LABELS: Record<string, string> = { created: '待执行', pending: '等待中', queued: '已排队', running: '运行中', pausing: '正在暂停', paused: '已暂停', stopping: '正在取消', cancelled: '已取消', completed: '已完成', failed: '失败', interrupted: '已中断', blocked: '受阻', closed: '已关闭' };
const INITIAL_PLAN = () => (JSON.stringify({ name: tr("检查与构建"), concurrency: 2, nodes: [
  { id: 'check', kind: 'command', argv: ['python3', '-c', 'print("check")'] },
  { id: 'build', kind: 'command', needs: ['check'], argv: ['python3', '-c', 'print("build")'] },
]}, null, 2));
export function WorkflowPanel({ sessionId }: { sessionId: string | null }) {
  const planEditor = useRef<HTMLDetailsElement>(null);
  const [items, setItems] = useState<Summary[]>([]);
  const [active, setActive] = useState('');
  const [record, setRecord] = useState<Workflow | null>(null);
  const [root, setRoot] = useState('');
  const [plan, setPlan] = useState(INITIAL_PLAN());
  const [reuse, setReuse] = useState('');
  const [approved, setApproved] = useState(false);
  const [limit, setLimit] = useState(2);
  const [log, setLog] = useState('');
  const [logNode, setLogNode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [argv, setArgv] = useState(JSON.stringify(['python3', '-c', 'print("background job")']));
  const [tasks, setTasks] = useState<{ id: string; status: string; steps: number; summary: string }[]>([]);
  useEffect(() => { if (record) setLimit(record.concurrency); }, [record?.id]);
  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    get<{ root: string }>(`/api/sessions/${sessionId}`).then(s => { if (live) setRoot(s.root); }).catch(e => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [sessionId]);
  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try {
        const list = await get<{ workflows: Summary[] }>('/api/workflows');
        if (live) setItems(list.workflows);
        if (active) {
          const r = await get<Workflow>(`/api/workflows/${active}`);
          if (live) setRecord(r);
        }
        if (sessionId) {
          const result = await get<{ tasks: typeof tasks }>(`/api/sessions/${sessionId}/tasks`);
          if (live) setTasks(result.tasks);
        }
      } catch (e) { if (live) setError(errorText(e)); }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 1000);
    return () => { live = false; clearInterval(timer); };
  }, [active, sessionId]);
  async function perform(fn: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function create(job = false) {
    const body = job ? { name: tr("后台命令"), nodes: [{ id: 'command', argv: JSON.parse(argv), timeout: 300 }] } : JSON.parse(plan);
    const r = await post<Workflow>('/api/workflows', { root, plan: body, ...(reuse && !job ? { reuse } : {}) });
    setActive(r.id); setRecord(r); setApproved(false); setLog(''); setLogNode('');
  }
  async function control(action: string) {
    const r = await post<Workflow>(`/api/workflows/${active}/${action}`, { approve: approved, concurrency: limit });
    setRecord(r);
  }
  const nodes = Object.entries(record?.nodes || {});
  const completed = nodes.filter(([, n]) => n.status === 'completed').length;
  const running = nodes.filter(([, n]) => n.status === 'running').length;
  const failed = nodes.filter(([, n]) => n.status === 'failed' || n.status === 'blocked').length;
  const isActive = Boolean(record && ACTIVE_STATUSES.has(record.status));
  return <section className="xn-operations" aria-label={tr("工作流与后台任务")}>
    <OperationHeader icon={<IconWorkflow size={22} />} title={tr("工作流与后台任务")} description={tr("创建后检查完整计划，再批准执行。命令会在所选工作区运行。")} />
    {error && <p role="alert">{error}</p>}
    <div className="xn-operation-card xn-workspace-context"><IconFolder /><label>{tr("工作区")}<input aria-label={tr("工作流工作区")} value={root} onChange={e => setRoot(e.target.value)} /></label></div>
    <div className="xn-operation-create-grid">
    <details ref={planEditor} className="xn-operation-card"><summary><IconNewTask />{tr("新建工作流")}<span>{tr("编排多个步骤与依赖")}</span></summary><div className="xn-operation-card__body">
      <textarea aria-label={tr("工作流计划 JSON")} rows={12} value={plan} onChange={e => setPlan(e.target.value)} />
      <label>{tr("复用来源")}<input aria-label={tr("复用工作流 ID")} value={reuse} onChange={e => setReuse(e.target.value)} placeholder={tr("可选：已结束的工作流 ID")} /></label>
      <button className="xn-operation-primary" disabled={busy || !root.trim()} onClick={() => void perform(() => create())}>{tr("创建计划")}</button>
    </div>
    </details>
    <details className="xn-operation-card"><summary><IconTerminal />{tr("后台命令")}<span>{tr("运行单条命令并保留日志")}</span></summary><div className="xn-operation-card__body">
      <label>{tr("命令参数 JSON")}<input aria-label={tr("后台命令 argv")} value={argv} onChange={e => setArgv(e.target.value)} /></label>
      <button className="xn-operation-primary" disabled={busy || !root.trim()} onClick={() => void perform(() => create(true))}>{tr("创建后台命令")}</button>
    </div>
    </details>
    </div>
    <label className="xn-operation-history">{tr("历史运行")}<select aria-label={tr("选择工作流")} value={active} onChange={e => { setActive(e.target.value); setApproved(false); setRecord(null); setLog(''); setLogNode(''); }}>
      <option value="">{tr("选择运行")}</option>{items.map(i => <option key={i.id} value={i.id}>{i.name} · {tr(STATUS_LABELS[i.status] || i.status)} · {i.id.slice(0, 8)}</option>)}
    </select></label>
    {record ? <article className="xn-operation-card xn-run-card">
      <div className="xn-run-card__heading"><div><h3>{record.plan.name}</h3><code>{record.id}</code><p className="xn-run-root"><IconFolder size={12} />{record.root}</p></div><OperationStatus status={record.status} /></div>
      <div className="xn-run-metrics"><div><strong>{completed}<small> / {nodes.length}</small></strong><span>{tr("已完成节点")}</span></div><div><strong>{running}</strong><span>{tr("运行中")}</span></div><div><strong>{failed}</strong><span>{tr("失败 / 受阻")}</span></div><div><strong>{record.concurrency}</strong><span>{tr("并发上限")}</span></div></div>
      <progress className="xn-run-progress" aria-label={tr("节点完成进度")} max={nodes.length || 1} value={completed} />
      <details className="xn-plan-review" key={record.id} open={record.status === 'created'}><summary>{tr("当前执行计划")}<span>{tr("检查命令、依赖与执行目录")}</span></summary><pre aria-label={tr("当前执行计划")}>{JSON.stringify(record.plan, null, 2)}</pre></details>
      {!isActive && record.status !== 'completed' && <label className="xn-plan-approval"><input type="checkbox" checked={approved} onChange={e => setApproved(e.target.checked)} />{tr("我已检查并批准这份命令计划")}</label>}
      <div className="xn-operations-actions">
        <button className="xn-operation-primary" disabled={busy || !approved || isActive || record.status === 'completed'} onClick={() => void perform(() => control('start'))}>{tr("执行 / 恢复")}</button>
        <button disabled={busy || !isActive} onClick={() => void perform(() => control('pause'))}>{tr("暂停调度")}</button>
        <button className="xn-operation-danger" disabled={busy || !isActive} onClick={() => void perform(() => control('cancel'))}>{tr("取消运行")}</button>
        <button disabled={busy || !isActive} onClick={() => void perform(() => control('recover'))}>{tr("恢复失联状态")}</button>
        <button disabled={busy || isActive} onClick={() => { setPlan(JSON.stringify(record.plan, null, 2)); setReuse(record.id); setRoot(record.root); if (planEditor.current) { planEditor.current.open = true; planEditor.current.scrollIntoView({ block: 'nearest' }); } }}>{tr("以此为基础修订")}</button>
      </div>
      <div className="xn-run-concurrency"><label>{tr("并发上限")}<input aria-label={tr("并发上限")} type="number" min={1} max={8} value={limit} onChange={e => setLimit(Number(e.target.value))} /></label>
      <button disabled={busy || !Number.isInteger(limit) || limit < 1 || limit > 8} onClick={() => void perform(() => control('concurrency'))}>{tr("应用并发上限")}</button><p>{tr("降低上限不终止已经运行的节点。")}</p></div>
      <div className="xn-node-table"><table><thead><tr><th>{tr("节点")}</th><th>{tr("状态")}</th><th>{tr("尝试次数")}</th><th>{tr("结果")}</th></tr></thead>
        <tbody>{nodes.map(([id, n]) => <tr key={id}><td><code>{id}</code>{n.reused_from && <small className="xn-node-reused">{tr("已复用")}</small>}</td><td><OperationStatus status={n.status} /></td><td>{n.attempts}</td><td><div className="xn-node-result"><span>{n.error || n.summary || '—'}</span><button disabled={busy} onClick={() => void perform(async () => { const r = await get<{ output: string; truncated: boolean }>(`/api/workflows/${active}/logs/${id}`); setLogNode(id); setLog((r.truncated || n.log_capped ? tr("[输出已截断]\n") : '') + r.output); })}>{tr("查看日志")}</button></div></td></tr>)}</tbody>
      </table></div>
      {logNode && <div className="xn-run-log"><h4>{tr("运行日志")} <code>{logNode}</code></h4><pre aria-label={tr("运行日志")}>{log || tr("暂无输出")}</pre></div>}
      <details className="xn-run-events"><summary>{tr("运行事件")}<span>{record.events.length}</span></summary><pre>{JSON.stringify(record.events, null, 2)}</pre></details>
    </article> : <div className="xn-operation-empty"><IconWorkflow size={28} /><h3>{active ? tr("正在加载运行") : tr("选择或创建一个运行")}</h3><p>{tr("在这里跟踪节点状态、调整并发并查看日志。")}</p></div>}
    <div className="xn-operation-card xn-subtask-card"><h3>{tr("当前会话的子任务")}</h3>{tasks.length ? tasks.map(task => <div className="xn-subtask-row" key={task.id}><code>{task.id}</code><OperationStatus status={task.status} /><span>{tf("{0} 步", [task.steps])}</span><p>{task.summary}</p></div>) : <p>{tr("暂无子任务")}</p>}</div>
  </section>;
}
