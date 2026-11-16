/**
 * Who runs next, unread/post stats, and model-free stall diagnosis.
 *
 * Idle members cost nothing: a member runs only when a post reaches it (or any
 * post in its channels when `wakeMode === "any"`). A member that called
 * `swarm_done` wakes again only for the coordinator, a verifier, the user or
 * the host; a killed member never does.
 *
 * When everyone goes quiet before the swarm finishes, `diagnoseStall` identifies
 * the exact reason (member quota/error, unanswered `#seq`, or unreviewed worker
 * report) instead of emitting a generic nudge.
 */
import { memberChannels, type Post } from "./board.ts";
import { classifyFailure, type MemberRecord, type SwarmRecord } from "./store.ts";

export function pendingFor(member: MemberRecord, posts: readonly Post[]): Post[] {
  const channels = memberChannels(member);
  const wakeAny = member.wakeMode === "any" && member.state !== "done";
  return posts.filter((post) => {
    if (post.seq <= member.delivered) return false;
    if (post.recipients.includes(member.name)) return true;
    if (!wakeAny || post.from === member.name) return false;
    const chan = post.channel ?? "main";
    return chan === "main" || channels.includes("*") || channels.includes(chan);
  });
}

export function wakes(member: MemberRecord, pending: readonly Post[], record: SwarmRecord): boolean {
  if (member.state === "killed" || !pending.length) return false;
  if (member.turns >= record.limits.memberMaxTurns) return false;
  if (member.state !== "done") return true;
  const authority = new Set(["user", "system", ...record.members.filter((item) => item.role !== "worker").map((item) => item.name)]);
  return pending.some((post) => authority.has(post.from) && post.recipients.includes(member.name));
}

/** Members to start now, earliest unseen post first; the coordinator wins ties. */
export function chooseToRun(record: SwarmRecord, posts: readonly Post[], running: ReadonlySet<string>): string[] {
  if (record.status !== "running") return [];
  const free = record.limits.maxActive - running.size;
  if (free <= 0) return [];
  return record.members
    .filter((member) => !running.has(member.name))
    .map((member) => ({ member, pending: pendingFor(member, posts) }))
    .filter(({ member, pending }) => wakes(member, pending, record))
    .sort((a, b) => a.pending[0]!.seq - b.pending[0]!.seq || Number(b.member.role === "coordinator") - Number(a.member.role === "coordinator"))
    .slice(0, free)
    .map(({ member }) => member.name);
}

export interface MemberPostStat { posts: number; lastPostSeq: number; lastPostAt: string | null; unread: number }

export function memberStats(record: SwarmRecord, posts: readonly Post[]): Map<string, MemberPostStat> {
  const out = new Map<string, MemberPostStat>();
  for (const m of record.members) out.set(m.name, { posts: 0, lastPostSeq: 0, lastPostAt: null, unread: 0 });
  for (const post of posts) {
    const sender = out.get(post.from);
    if (sender) { sender.posts += 1; sender.lastPostSeq = post.seq; sender.lastPostAt = post.at; }
    const chan = post.channel ?? "main";
    for (const m of record.members) {
      if (m.name === post.from || post.seq <= m.delivered) continue;
      const chans = memberChannels(m);
      if (post.recipients.includes(m.name) || chan === "main" || chans.includes("*") || chans.includes(chan)) {
        out.get(m.name)!.unread += 1;
      }
    }
  }
  return out;
}

export interface SystemAttention {
  id: string;
  kind: "quota" | "error" | "unanswered" | "idle";
  member: string;
  seq?: number;
  text: string;
  detail?: string;
}

/** Inspect member errors, unanswered `@mentions`, and unreviewed reports. */
export function diagnoseStall(record: SwarmRecord, posts: readonly Post[]): { text: string; target?: string; alerts: SystemAttention[] } {
  const stats = memberStats(record, posts);
  const alerts: SystemAttention[] = [];
  for (const m of record.members) {
    if (m.state === "killed" || !m.error) continue;
    const kind = m.failureKind ?? classifyFailure(m.error) ?? "error";
    alerts.push({ id: `err-${m.name}`, kind, member: m.name, text: `@${m.name} ${kind === "quota" ? "hit quota/rate limit" : "failed"}`, detail: m.error });
  }
  for (const m of record.members) {
    if (m.state !== "waiting" || m.role === "coordinator" || m.error) continue;
    const lastPostSeq = stats.get(m.name)?.lastPostSeq ?? 0;
    const mention = [...posts].reverse().find((p) => p.seq > lastPostSeq && p.from !== m.name && p.kind !== "system" && p.recipients.includes(m.name));
    if (mention && m.delivered >= mention.seq && m.turns > 0) {
      alerts.push({ id: `unanswered-${m.name}-${mention.seq}`, kind: "unanswered", member: m.name, seq: mention.seq, text: `@${m.name} was mentioned in #${mention.seq} by @${mention.from} without a reply` });
    }
  }
  const errorAlert = alerts.find((a) => (a.kind === "quota" || a.kind === "error") && a.member !== record.members.find((m) => m.role === "coordinator")?.name) ?? alerts.find((a) => a.kind === "quota" || a.kind === "error");
  if (errorAlert) {
    return {
      alerts,
      target: errorAlert.member,
      text: `@${errorAlert.member} failed (${errorAlert.kind}: ${errorAlert.detail}). Switch its model with swarm_model, reassign its work with swarm_reassign, or post instructions.`,
    };
  }
  const unanswered = alerts.find((a) => a.kind === "unanswered");
  if (unanswered) {
    return {
      alerts,
      target: unanswered.member,
      text: `@${unanswered.member} was mentioned in #${unanswered.seq} and ended its turn without replying. Re-ping @${unanswered.member}, inspect status with board_read{status:true}, or reassign its task.`,
    };
  }
  const coordinator = record.members.find((m) => m.role === "coordinator");
  const coordLastSeq = coordinator ? (stats.get(coordinator.name)?.lastPostSeq ?? 0) : 0;
  const unreviewed = posts.filter((p) => p.seq > coordLastSeq && p.kind !== "system" && p.from !== coordinator?.name);
  if (unreviewed.length) {
    const seqs = unreviewed.slice(-4).map((p) => `#${p.seq} (@${p.from})`).join(", ");
    return {
      alerts,
      text: `${seqs} posted since @${coordinator?.name ?? "coordinator"}'s last post and everyone is idle. Review them, ask @verifier to check finished work, or call swarm_finish.`,
    };
  }
  const summary = record.members.filter((m) => m.state !== "killed").map((m) => `@${m.name}(${m.state}, last:#${stats.get(m.name)?.lastPostSeq ?? 0})`).join(", ");
  return { alerts, text: `${NUDGE_TEXT} Members: ${summary}.` };
}

export type MonitorAction = { kind: "none" } | { kind: "nudge"; text: string } | { kind: "stall"; reason: string };

export const NUDGE_TEXT = "Everyone is idle but the swarm is not finished. Read the board, give the remaining work to a member with board_post, ask @verifier to check finished work, or call swarm_finish if the goal is met or cannot be met.";

export function monitorCheck(record: SwarmRecord, posts: readonly Post[], running: ReadonlySet<string>, nowMs: number): MonitorAction {
  if (record.status !== "running") return { kind: "none" };
  const started = Date.parse(record.startedAt);
  if (Number.isFinite(started) && nowMs - started > record.limits.wallMinutes * 60_000) return { kind: "stall", reason: "wall_clock" };
  if (running.size) return { kind: "none" };
  if (record.members.some((member) => wakes(member, pendingFor(member, posts), record))) return { kind: "none" };
  const coordinator = record.members.find((member) => member.role === "coordinator");
  if (!coordinator || coordinator.state === "killed" || coordinator.turns >= record.limits.memberMaxTurns) return { kind: "stall", reason: "coordinator_unavailable" };
  if (coordinator.error) return { kind: "stall", reason: coordinator.failureKind === "quota" ? "coordinator_quota" : "coordinator_error" };
  if (record.monitor.nudges >= record.limits.nudgeLimit) return { kind: "stall", reason: "idle" };
  return { kind: "nudge", text: diagnoseStall(record, posts).text };
}
