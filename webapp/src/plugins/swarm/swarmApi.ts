import { get, post } from "../../xuenessApi";

export type SwarmRole = "coordinator" | "worker" | "verifier";
export type MemberState = "active" | "waiting" | "done" | "killed";
export type FailureKind = "quota" | "error";
export type WakeMode = "mentions" | "any";
export type SwarmStatus = "running" | "paused" | "interrupted" | "stalled" | "completed" | "failed" | "cancelled";
export type SwarmOutcome = { status: string; summary: string } | null;
export type SwarmVerification = { verdict: string; findings: unknown; at: string; criteria?: { criterion: number; met: boolean; evidence: string }[] } | null;
export type SwarmChannel = { name: string; topic: string; createdBy: string; archived?: boolean };
export type SystemAttention = { id: string; kind: "quota" | "error" | "unanswered" | "idle"; member: string; seq?: number; text: string; detail?: string };
export type DetailedEdge = { from: string; to: string; count: number; direct: number; viaAll: number };

export type SwarmListMember = {
  name: string; role: SwarmRole; state: MemberState; turns: number; steps: number;
  summary?: string; error?: string; failureKind?: FailureKind | null;
  channels?: string[]; wakeMode?: WakeMode; posts?: number; unread?: number;
  lastPostSeq?: number; lastPostAt?: string | null; activity?: string;
};
export type SwarmSummary = {
  id: string; title?: string; status: SwarmStatus; pauseReason: string; goal: string;
  channels?: SwarmChannel[]; members: SwarmListMember[];
  edges?: DetailedEdge[]; systemAttention?: SystemAttention[];
  verification: SwarmVerification; outcome: SwarmOutcome;
};
export type SwarmMember = SwarmListMember & {
  task: string; owns: string[]; commands: string[]; groups: string[];
  model: { providerId: string; model: string | null } | null; lastActiveAt?: string;
};
export type SwarmDetail = Omit<SwarmSummary, "members"> & {
  createdAt?: string; startedAt?: string; members: SwarmMember[]; acceptance?: string[];
  limits: { maxActive: number; memberMaxSteps: number; memberMaxTurns: number; nudgeLimit: number; wallMinutes: number };
  monitor?: { nudges: number };
};
export type BoardPost = {
  seq: number; at: string; from: string; kind: "post" | "user" | "system" | "verdict" | "done";
  to: { names: string[]; groups: string[]; all: boolean; channels?: string[] }; recipients: string[]; text: string;
  channel?: string; citations?: number[];
};
export type JournalMessage = { role: string; content: unknown; tools: string[] };
export type SwarmLimits = {
  maxMembers: number; maxActive: number | null; memberMaxSteps: number; memberMaxTurns: number; nudgeLimit: number; wallMinutes: number;
};

const base = (sid: string, id?: string) => `/api/sessions/${encodeURIComponent(sid)}/swarms${id ? `/${encodeURIComponent(id)}` : ""}`;

export const listSwarms = async (sid: string, signal?: AbortSignal): Promise<SwarmSummary[]> =>
  (await get<{ swarms: SwarmSummary[] }>(base(sid), signal)).swarms ?? [];

export const readSwarm = (sid: string, id: string, signal?: AbortSignal) =>
  get<{ swarm: SwarmDetail; running: string[] }>(base(sid, id), signal);

export const readBoard = (sid: string, id: string, after: number, signal?: AbortSignal) =>
  get<{ posts: BoardPost[]; status: SwarmStatus; running: string[] }>(`${base(sid, id)}/board?after=${after}`, signal);

export const postToBoard = async (sid: string, id: string, text: string, to?: string[], channel?: string): Promise<BoardPost> =>
  (await post<{ post: BoardPost }>(`${base(sid, id)}/post`, { text, ...(to && to.length ? { to } : {}), ...(channel && channel !== "main" ? { channel } : {}) })).post;

export const stopSwarm = (sid: string, id: string, reason?: string) => post<unknown>(`${base(sid, id)}/stop`, reason ? { reason } : {});
export const resumeSwarm = (sid: string, id: string) => post<{ swarm: SwarmDetail }>(`${base(sid, id)}/resume`, {});
export const killMember = (sid: string, id: string, name: string, reason?: string) =>
  post<unknown>(`${base(sid, id)}/members/${encodeURIComponent(name)}/kill`, reason ? { reason } : {});
export const switchMemberModel = (sid: string, id: string, name: string, model: "inherit" | { provider_id: string; model?: string }) =>
  post<{ swarm: SwarmDetail }>(`${base(sid, id)}/members/${encodeURIComponent(name)}/model`, { model });
export const reassignMember = (sid: string, id: string, from: string, body: { to: string; task?: string; fork?: boolean }) =>
  post<{ swarm: SwarmDetail }>(`${base(sid, id)}/members/${encodeURIComponent(from)}/reassign`, body);
export const readMemberJournal = (sid: string, id: string, name: string, signal?: AbortSignal) =>
  get<{ member: string; messages: JournalMessage[] }>(`${base(sid, id)}/members/${encodeURIComponent(name)}/journal`, signal);

export const readSwarmSettings = async (): Promise<SwarmLimits> => (await get<{ settings: SwarmLimits }>("/api/swarm/settings")).settings;
export const saveSwarmSettings = async (patch: Partial<SwarmLimits>): Promise<SwarmLimits> =>
  (await post<{ settings: SwarmLimits }>("/api/swarm/settings", patch)).settings;

export const STATUS_LABELS: Record<SwarmStatus, string> = {
  running: "运行中", paused: "已暂停", interrupted: "已中断（重启后需继续）", stalled: "停滞",
  completed: "已完成", failed: "未完成", cancelled: "已停止",
};
export const ROLE_LABELS: Record<SwarmRole, string> = { coordinator: "协调者", worker: "工作者", verifier: "验证者" };
export const MEMBER_STATE_LABELS: Record<MemberState, string> = { active: "工作中", waiting: "等待", done: "已完成", killed: "已停止" };
/** Statuses where Stop / Resume make sense. */
export const canStop = (status: SwarmStatus): boolean => status === "running" || status === "stalled";
export const canResume = (status: SwarmStatus): boolean => status === "paused" || status === "interrupted" || status === "stalled";
