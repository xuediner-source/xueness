/** The Members tab: one card per member with its brief, state, live activity, recovery actions, and transcript. */
import React, { useState } from "react";
import { t as tr, tf } from "../../i18n";
import { killMember, MEMBER_STATE_LABELS, readMemberJournal, reassignMember, ROLE_LABELS, switchMemberModel, type JournalMessage, type SwarmMember } from "./swarmApi";

type Props = { sessionId: string; swarmId: string; members: SwarmMember[]; running: string[]; active: boolean; onChanged: () => void };

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

function MemberCard({ member, working, peers, sessionId, swarmId, active, onChanged }: { member: SwarmMember; working: boolean; peers: SwarmMember[] } & Omit<Props, "members" | "running">): React.JSX.Element {
  const [journal, setJournal] = useState<JournalMessage[] | null>(null);
  const [mode, setMode] = useState<"none" | "model" | "reassign">("none");
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

  const meta = `${tf("{0} 轮 · {1} 步", [member.turns, member.steps])}${member.posts !== undefined ? tf(" · {0} 贴", [member.posts]) : ""}${member.unread ? tf(" · {0} 未读", [member.unread]) : ""}`;

  return <li className="xn-swarm-member" data-role={member.role} data-state={state}>
    <div className="xn-swarm-member__head">
      <strong>@{member.name}</strong>
      <span className="xn-swarm-chip" data-tone={member.role}>{tr(ROLE_LABELS[member.role])}</span>
      <span className="xn-swarm-chip" data-tone={state}>{tr(MEMBER_STATE_LABELS[state])}</span>
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
      <input type="text" value={providerId} placeholder={tr("模型配置 ID（如 openai）")} onChange={e => setProviderId(e.currentTarget.value)} />
      <input type="text" value={modelId} placeholder={tr("可选模型名（留空用默认）")} onChange={e => setModelId(e.currentTarget.value)} />
      <div className="xn-swarm-member__actions">
        <button type="button" disabled={busy || !providerId.trim()} onClick={() => void runAction(() => switchMemberModel(sessionId, swarmId, member.name, { provider_id: providerId.trim(), ...(modelId.trim() ? { model: modelId.trim() } : {}) }))}>{tr("应用模型")}</button>
        <button type="button" disabled={busy} onClick={() => void runAction(() => switchMemberModel(sessionId, swarmId, member.name, "inherit"))}>{tr("沿用对话模型")}</button>
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
  return <ul className="xn-swarm-members" data-testid="swarm-members">
    {props.members.map(member => <MemberCard key={member.name} member={member} working={props.running.includes(member.name)}
      peers={props.members} sessionId={props.sessionId} swarmId={props.swarmId} active={props.active} onChanged={props.onChanged} />)}
  </ul>;
}

export default SwarmMembers;
