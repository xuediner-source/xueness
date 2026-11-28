/** The Members tab: add-worker bar plus one card per member with configured model selector, recovery actions, and transcript. */
import React, { useEffect, useState } from "react";
import { t as tr, tf } from "../../i18n";
import {
  addSwarmMember, killMember, listSwarmModels, MEMBER_STATE_LABELS, readMemberJournal,
  reassignMember, ROLE_LABELS, switchMemberModel,
  type JournalMessage, type SwarmMember, type SwarmModelOption,
} from "./swarmApi";

type Props = { sessionId: string; swarmId: string; members: SwarmMember[]; running: string[]; active: boolean; onChanged: () => void };

function encodeModelKey(providerId: string, model: string | null): string {
  return `${providerId}::${model ?? ""}`;
}

function decodeModelKey(key: string): "inherit" | { provider_id: string; model?: string } | null {
  if (!key || key === "inherit") return "inherit";
  if (key === "__custom__") return null;
  const idx = key.indexOf("::");
  if (idx < 0) return { provider_id: key };
  const providerId = key.slice(0, idx);
  const model = key.slice(idx + 2);
  return { provider_id: providerId, ...(model ? { model } : {}) };
}

function Journal({ messages }: { messages: JournalMessage[] }): React.JSX.Element {
  if (!messages.length) return <p className="xn-swarm-muted">{tr("还没有记录。")}</p>;
  return <ol className="xn-swarm-journal">
    {messages.map((message, index) => <li key={index} data-role={message.role}>
      <span className="xn-swarm-journal__role">{message.role === "assistant" ? tr("成员") : message.role === "user" ? tr("投递") : message.role === "tool" ? tr("工具结果") : tr("系统")}</span>
      {message.tools.length > 0 && <span className="xn-swarm-journal__tools">{message.tools.join("、")}</span>}
      {typeof message.content === "string" && message.content.trim() && <pre>{message.content}</pre>}
    </li>)}
  </ol>;
}

function AddWorkerBar({ sessionId, swarmId, members, models, onChanged }: { sessionId: string; swarmId: string; members: SwarmMember[]; models: SwarmModelOption[]; onChanged: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [task, setTask] = useState("");
  const [count, setCount] = useState(1);
  const [fork, setFork] = useState("");
  const [modelKey, setModelKey] = useState("inherit");
  const [ownsText, setOwnsText] = useState("");
  const [cmdsText, setCmdsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setBusy(true); setError("");
    try {
      const owns = ownsText.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      const commands = cmdsText.split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
      const model = decodeModelKey(modelKey) ?? "inherit";
      await addSwarmMember(sessionId, swarmId, {
        name: name.trim(),
        task: task.trim(),
        ...(count > 1 ? { count } : {}),
        ...(owns.length ? { owns } : {}),
        ...(commands.length ? { commands } : {}),
        ...(fork ? { fork } : {}),
        model,
      });
      setName(""); setTask(""); setCount(1); setOwnsText(""); setCmdsText(""); setFork(""); setOpen(false);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return <div><button type="button" onClick={() => setOpen(true)}>{tr("＋ 新增工作者 / 分片组")}</button></div>;
  }

  return (
    <div className="xn-swarm-member__subform" aria-label={tr("新增蜂群成员")}>
      {error && <p className="xn-swarm-error" role="alert">{error}</p>}
      <div className="xn-swarm-composer__row">
        <input type="text" aria-label={tr("新成员名称")} value={name} placeholder={tr("名称（如 helper 或 shard）")} onChange={(e) => setName(e.currentTarget.value)} />
        <select aria-label={tr("温上下文分叉来源")} value={fork} onChange={(e) => setFork(e.currentTarget.value)}>
          <option value="">{tr("全新对话（不分叉）")}</option>
          <option value="coordinator">{tr("分叉自协调者 (@coordinator)")}</option>
          {members.map((m) => <option key={m.name} value={m.name}>{tf("分叉自 @{0}", [m.name])}</option>)}
        </select>
      </div>
      <input type="text" aria-label={tr("新成员任务说明")} value={task} placeholder={tr("任务简报：说明负责内容与完成标准")} onChange={(e) => setTask(e.currentTarget.value)} />
      <div className="xn-swarm-composer__row">
        <select aria-label={tr("新成员模型")} value={modelKey} onChange={(e) => setModelKey(e.currentTarget.value)}>
          <option value="inherit">{tr("沿用当前对话模型 (inherit)")}</option>
          {models.map((m) => {
            const key = encodeModelKey(m.providerId, m.model);
            return <option key={key} value={key}>{m.name ?? `${m.providerId}${m.model ? ` / ${m.model}` : ""}`}</option>;
          })}
        </select>
        <input type="text" aria-label={tr("分片数量")} value={String(count)} placeholder={tr("分片数 1-6")} onChange={(e) => setCount(Math.max(1, Math.min(6, Number(e.currentTarget.value) || 1)))} style={{ maxWidth: 96 }} />
      </div>
      <input type="text" aria-label={tr("可写路径列表")} value={ownsText} placeholder={tr("可选可写相对路径（逗号分隔，如 src/ui, src/lib）")} onChange={(e) => setOwnsText(e.currentTarget.value)} />
      <input type="text" aria-label={tr("可运行命令列表")} value={cmdsText} placeholder={tr("可选允许运行的命令（分号分隔，如 npm test; npm run build）")} onChange={(e) => setCmdsText(e.currentTarget.value)} />
      <div className="xn-swarm-member__actions">
        <button type="button" disabled={busy || !name.trim() || !task.trim()} onClick={() => void submit()}>{tr("加入看板并唤醒")}</button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)}>{tr("取消")}</button>
      </div>
    </div>
  );
}

function MemberCard({ member, working, peers, models, sessionId, swarmId, active, onChanged }: { member: SwarmMember; working: boolean; peers: SwarmMember[]; models: SwarmModelOption[] } & Omit<Props, "members" | "running">): React.JSX.Element {
  const [journal, setJournal] = useState<JournalMessage[] | null>(null);
  const [mode, setMode] = useState<"none" | "model" | "reassign">("none");
  const initialKey = member.model ? encodeModelKey(member.model.providerId, member.model.model) : "inherit";
  const hasPreset = initialKey === "inherit" || models.some((m) => encodeModelKey(m.providerId, m.model) === initialKey);
  const [selectedModelKey, setSelectedModelKey] = useState(hasPreset ? initialKey : "__custom__");
  const [providerId, setProviderId] = useState(member.model?.providerId ?? "");
  const [modelId, setModelId] = useState(member.model?.model ?? "");
  const reassignTargets = peers.filter(p => p.name !== member.name && p.role !== "coordinator" && p.state !== "killed");
  const [target, setTarget] = useState(reassignTargets[0]?.name ?? "");
  const [taskNote, setTaskNote] = useState("");
  const [forkCtx, setForkCtx] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const state = working ? "active" : member.state;
  const extraChans = (member.channels ?? []).filter(c => c !== "*" && c !== "main");

  const runAction = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await fn(); setMode("none"); onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const toggleJournal = async () => {
    if (journal) { setJournal(null); return; }
    setBusy(true); setError("");
    try { setJournal((await readMemberJournal(sessionId, swarmId, member.name)).messages); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const applySelectedModel = () => {
    const decoded = decodeModelKey(selectedModelKey);
    if (decoded !== null) return switchMemberModel(sessionId, swarmId, member.name, decoded);
    return switchMemberModel(sessionId, swarmId, member.name, { provider_id: providerId.trim(), ...(modelId.trim() ? { model: modelId.trim() } : {}) });
  };

  const meta = `${tf("{0} 轮 · {1} 步", [member.turns, member.steps])}${member.posts !== undefined ? tf(" · {0} 贴", [member.posts]) : ""}${member.unread ? tf(" · {0} 未读", [member.unread]) : ""}`;

  return <li className="xn-swarm-member" data-role={member.role} data-state={state}>
    <div className="xn-swarm-member__head">
      <strong>@{member.name}</strong>
      <span className="xn-swarm-chip" data-tone={member.role}>{tr(ROLE_LABELS[member.role])}</span>
      <span className="xn-swarm-chip" data-tone={state}>{tr(MEMBER_STATE_LABELS[state])}</span>
      {member.addedBy && <span className="xn-swarm-chip">{tf("由 @{0} 添加", [member.addedBy])}</span>}
      {member.failureKind && <span className="xn-swarm-chip" data-tone="failed">{member.failureKind === "quota" ? tr("限额/限流") : tr("错误")}</span>}
      <span className="xn-swarm-member__meta">{meta}</span>
    </div>
    {member.activity && <p className="xn-swarm-member__activity">{tf("动态：{0}", [member.activity])}</p>}
    <p className="xn-swarm-member__task">{member.task}</p>
    <dl className="xn-swarm-member__facts">
      <dt>{tr("模型")}</dt><dd>{member.model ? `${member.model.providerId}${member.model.model ? ` / ${member.model.model}` : ""}` : tr("与对话相同")}</dd>
      {(extraChans.length > 0 || member.wakeMode === "any") && <><dt>{tr("频道/唤醒")}</dt><dd>{extraChans.map(c => <code key={c}>#{c}</code>)}{member.wakeMode === "any" && <span className="xn-swarm-chip">{tr("任意发言唤醒")}</span>}</dd></>}
      <dt>{tr("可写")}</dt><dd>{member.owns.length ? member.owns.map(path => <code key={path}>{path}</code>) : tr("无（只读）")}</dd>
      <dt>{tr("可运行")}</dt><dd>{member.commands.length ? member.commands.map(command => <code key={command}>{command}</code>) : tr("无")}</dd>
    </dl>
    {member.summary && <p className="xn-swarm-member__summary">{member.summary}</p>}
    {member.error && <p className="xn-swarm-error">{member.error}</p>}
    {error && <p className="xn-swarm-error" role="alert">{error}</p>}
    <div className="xn-swarm-member__actions">
      <button type="button" disabled={busy} aria-expanded={journal !== null} onClick={() => void toggleJournal()}>{journal ? tr("收起记录") : tr("查看记录")}</button>
      {active && member.state !== "killed" && <button type="button" disabled={busy} aria-expanded={mode === "model"} onClick={() => setMode(m => m === "model" ? "none" : "model")}>{tr("切换模型")}</button>}
      {active && member.role !== "coordinator" && member.state !== "killed" && reassignTargets.length > 0 && <button type="button" disabled={busy} aria-expanded={mode === "reassign"} onClick={() => setMode(m => m === "reassign" ? "none" : "reassign")}>{tr("转交任务")}</button>}
      {active && member.role !== "coordinator" && member.state !== "killed" && <button type="button" disabled={busy} onClick={() => { if (window.confirm(tf("停止 @{0}？它不会再被唤醒。", [member.name]))) void runAction(() => killMember(sessionId, swarmId, member.name, tr("用户在蜂群面板中停止"))); }}>{tr("停止")}</button>}
    </div>
    {mode === "model" && <div className="xn-swarm-member__subform">
      <select aria-label={tr("选择已配置模型")} value={selectedModelKey} onChange={e => setSelectedModelKey(e.currentTarget.value)}>
        <option value="inherit">{tr("沿用对话默认模型 (inherit)")}</option>
        {models.map(m => {
          const key = encodeModelKey(m.providerId, m.model);
          return <option key={key} value={key}>{m.name ?? `${m.providerId}${m.model ? ` / ${m.model}` : ""}`}</option>;
        })}
        <option value="__custom__">{tr("手动输入配置 ID…")}</option>
      </select>
      {selectedModelKey === "__custom__" && <>
        <input type="text" value={providerId} placeholder={tr("模型配置 ID（如 magpie 或 openai）")} onChange={e => setProviderId(e.currentTarget.value)} />
        <input type="text" value={modelId} placeholder={tr("可选模型名（如 agy-cli/gemini-3.8-flash）")} onChange={e => setModelId(e.currentTarget.value)} />
      </>}
      <div className="xn-swarm-member__actions">
        <button type="button" disabled={busy || (selectedModelKey === "__custom__" && !providerId.trim())} onClick={() => void runAction(applySelectedModel)}>{tr("应用模型")}</button>
      </div>
    </div>}
    {mode === "reassign" && <div className="xn-swarm-member__subform">
      <select aria-label={tr("接收成员")} value={target} onChange={e => setTarget(e.currentTarget.value)}>
        {reassignTargets.map(p => <option key={p.name} value={p.name}>@{p.name}</option>)}
      </select>
      <input type="text" value={taskNote} placeholder={tr("可选补充任务说明")} onChange={e => setTaskNote(e.currentTarget.value)} />
      <label className="xn-swarm-check"><input type="checkbox" checked={forkCtx} onChange={e => setForkCtx(e.currentTarget.checked)} /> {tr("继承原成员上下文摘要")}</label>
      <div className="xn-swarm-member__actions">
        <button type="button" disabled={busy || !target} onClick={() => void runAction(() => reassignMember(sessionId, swarmId, member.name, { to: target, ...(taskNote.trim() ? { task: taskNote.trim() } : {}), fork: forkCtx }))}>{tr("确认转交")}</button>
      </div>
    </div>}
    {journal && <Journal messages={journal} />}
  </li>;
}

export function SwarmMembers(props: Props): React.JSX.Element {
  const [models, setModels] = useState<SwarmModelOption[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    listSwarmModels(props.sessionId, controller.signal)
      .then((items) => { if (!controller.signal.aborted) setModels(items); })
      .catch(() => { /* fallback to custom input if unavailable */ });
    return () => controller.abort();
  }, [props.sessionId]);

  return <div className="xn-swarm-members-wrap">
    {props.active && <AddWorkerBar sessionId={props.sessionId} swarmId={props.swarmId} members={props.members} models={models} onChanged={props.onChanged} />}
    <ul className="xn-swarm-members" data-testid="swarm-members">
      {props.members.map(member => <MemberCard key={member.name} member={member} working={props.running.includes(member.name)}
        peers={props.members} models={models} sessionId={props.sessionId} swarmId={props.swarmId} active={props.active} onChanged={props.onChanged} />)}
    </ul>
  </div>;
}

export default SwarmMembers;
