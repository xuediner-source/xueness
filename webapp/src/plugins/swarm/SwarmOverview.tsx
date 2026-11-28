/**
 * Antigravity-style Swarm Overview: goal & inline title editor, groups of work
 * (sharded worker groups and role lanes with live activity), acceptance contract
 * progress, and milestone timeline with jump-to-board citations.
 */
import React, { useEffect, useState } from "react";
import { t as tr, tf } from "../../i18n";
import {
  MEMBER_STATE_LABELS, ROLE_LABELS, updateSwarmTitle,
  type BoardPost, type SwarmDetail, type SwarmMember,
} from "./swarmApi";

interface OverviewProps {
  sessionId: string;
  detail: SwarmDetail;
  running: string[];
  posts: BoardPost[];
  active: boolean;
  onChanged: () => void;
  onJumpToPost: (seq: number) => void;
}

interface WorkGroup {
  key: string;
  label: string;
  members: SwarmMember[];
}

function buildWorkGroups(members: SwarmMember[]): WorkGroup[] {
  const groups = new Map<string, SwarmMember[]>();
  for (const member of members) {
    const key = member.groups[0] ? `group:${member.groups[0]}` : `role:${member.role}`;
    const list = groups.get(key) ?? [];
    list.push(member);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, items]) => ({
    key,
    label: key.startsWith("group:")
      ? `@${key.slice(6)} (${tf("{0} 个分片", [items.length])})`
      : tr(ROLE_LABELS[items[0]!.role]),
    members: items,
  }));
}

export function SwarmOverview({ sessionId, detail, running, posts, active, onChanged, onJumpToPost }: OverviewProps): React.JSX.Element {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(detail.title ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setTitleDraft(detail.title ?? "");
    setEditingTitle(false);
  }, [detail.id, detail.title]);

  const saveTitle = async () => {
    if (!titleDraft.trim()) return;
    setSaving(true);
    setError("");
    try {
      await updateSwarmTitle(sessionId, detail.id, titleDraft.trim());
      setEditingTitle(false);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const workGroups = buildWorkGroups(detail.members);
  const workerMembers = detail.members.filter((m) => m.role === "worker" && m.state !== "killed");
  const doneWorkers = workerMembers.filter((m) => m.state === "done").length;

  const milestones = posts
    .filter((p) => p.kind === "done" || p.kind === "verdict" || p.kind === "user" || (p.kind === "system" && !p.text.startsWith("Model for")))
    .slice(-12)
    .reverse();

  return (
    <div className="xn-swarm-overview" data-testid="swarm-overview">
      {error && <p className="xn-swarm-error" role="alert">{error}</p>}

      <div className="xn-swarm-overview__card">
        <div className="xn-swarm-overview__titlebar">
          <strong>{detail.title || tr("未命名蜂群")}</strong>
          {active && (
            <button type="button" onClick={() => setEditingTitle((v) => !v)}>
              {editingTitle ? tr("取消") : tr("修改标题")}
            </button>
          )}
        </div>
        {editingTitle && (
          <div className="xn-swarm-member__subform">
            <input
              type="text"
              aria-label={tr("蜂群标题")}
              value={titleDraft}
              maxLength={120}
              placeholder={tr("输入简短蜂群标题")}
              onChange={(e) => setTitleDraft(e.currentTarget.value)}
            />
            <div className="xn-swarm-member__actions">
              <button type="button" disabled={saving || !titleDraft.trim()} onClick={() => void saveTitle()}>
                {tr("保存标题")}
              </button>
            </div>
          </div>
        )}
        <p className="xn-swarm-member__task">{detail.goal}</p>
        <div className="xn-swarm__stats">
          <span className="xn-swarm-chip" data-tone={doneWorkers === workerMembers.length && workerMembers.length > 0 ? "done" : "running"}>
            {tf("工作者完成进度：{0} / {1}", [doneWorkers, workerMembers.length])}
          </span>
          {detail.channels && detail.channels.length > 1 && (
            <span className="xn-swarm-muted">
              {tr("活跃频道：")}{detail.channels.map((c) => `#${c.name}`).join(" ")}
            </span>
          )}
        </div>
      </div>

      <div className="xn-swarm-overview__groups">
        {workGroups.map((group) => {
          const doneCount = group.members.filter((m) => m.state === "done").length;
          return (
            <div key={group.key} className="xn-swarm-overview__card">
              <div className="xn-swarm-member__head">
                <strong>{group.label}</strong>
                <span className="xn-swarm-member__meta">{doneCount} / {group.members.length}</span>
              </div>
              <ul className="xn-swarm-overview__roster">
                {group.members.map((m) => {
                  const st = running.includes(m.name) ? "active" : m.state;
                  return (
                    <li key={m.name}>
                      <div className="xn-swarm-member__head">
                        <code>@{m.name}</code>
                        <span className="xn-swarm-chip" data-tone={st}>{tr(MEMBER_STATE_LABELS[st])}</span>
                        {m.addedBy && <span className="xn-swarm-muted">by @{m.addedBy}</span>}
                      </div>
                      {m.activity && <p className="xn-swarm-member__activity">{m.activity}</p>}
                      {!m.activity && m.summary && <p className="xn-swarm-member__summary">{m.summary.slice(0, 140)}</p>}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>

      {milestones.length > 0 && (
        <div className="xn-swarm-overview__card">
          <strong>{tr("里程碑时间线")}</strong>
          <ul className="xn-swarm-overview__timeline">
            {milestones.map((post) => (
              <li key={post.seq}>
                <button type="button" className="xn-swarm-cite" onClick={() => onJumpToPost(post.seq)}>
                  #{post.seq}
                </button>
                <span className="xn-swarm-chip" data-tone={post.kind === "done" || post.kind === "verdict" ? "done" : "waiting"}>
                  @{post.from}
                </span>
                <span>{post.text.slice(0, 200)}{post.text.length > 200 ? "…" : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default SwarmOverview;
