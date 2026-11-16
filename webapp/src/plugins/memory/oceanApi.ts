/** Memory Ocean data: the memory plugin's `/api/memory/ocean` routes and their shapes. */
import { get, post } from "../../xuenessApi";
import { t as tr, tf } from "../../i18n";

export const OCEAN_KINDS = ["preference", "fact", "decision", "experience", "pitfall"] as const;
export type OceanKind = (typeof OCEAN_KINDS)[number];

export interface OceanNode {
  id: string; summary: string; text: string; kind: OceanKind; tags: string[]; importance: number;
  scope: "global" | "project"; project: { key: string; label: string } | null;
  links: { to: string; kind: "related" | "supersedes" }[]; status: "active" | "archived";
  source: { by: "agent" | "user"; sessionId?: string; turnId?: string; title?: string };
  createdAt: string; updatedAt: string; version: number; recalls: number; lastRecalledAt: string | null;
  /** Global, or saved for the workspace the view was opened for. */
  here: boolean;
  /** Constellation index, or null for a lone memory. */
  cluster: number | null;
  /** `curated`: a read-only entry from the operator's memory tracks. */
  origin: "ocean" | "curated";
}
export interface OceanEdge { a: string; b: string; weight: number; kind: "related" | "supersedes" | "tags" | "similar" }
export interface OceanCluster { id: number; label: string; kind: OceanKind | null; size: number }
export interface OceanEvent { at: string; kind: "remember" | "recall" | "forget" | "update"; ids: string[]; sessionId?: string }
export interface OceanView {
  nodes: OceanNode[]; edges: OceanEdge[]; clusters: OceanCluster[]; events: OceanEvent[];
  project: { key: string; label: string } | null;
  stats: { total: number; active: number; kinds: Record<string, number> };
}
export interface MemoryDraft { text: string; summary?: string; kind: OceanKind; tags: string[]; importance: number; scope?: "global" | "project"; root?: string }

export const loadOcean = (root?: string, signal?: AbortSignal): Promise<OceanView> =>
  get<OceanView>(`/api/memory/ocean${root ? `?root=${encodeURIComponent(root)}` : ""}`, signal);
export const addMemory = (draft: MemoryDraft): Promise<{ memory: OceanNode; merged: boolean }> =>
  post("/api/memory/ocean/memories", draft);
export const updateMemory = (id: string, patch: Partial<MemoryDraft> & { version: number; status?: "active" | "archived" }): Promise<{ memory: OceanNode }> =>
  post(`/api/memory/ocean/memories/${encodeURIComponent(id)}`, patch);
export const forgetMemory = (id: string): Promise<{ forgotten: string }> =>
  post(`/api/memory/ocean/memories/${encodeURIComponent(id)}/forget`, { confirmed: true });
export const forgetMemories = (ids: readonly string[]): Promise<{ forgotten: string[] }> =>
  post("/api/memory/ocean/memories/forget", { ids, confirmed: true });

/** A dream: a reviewable proposal to tidy the memories from recent conversations. Nothing changes until it is applied. */
export interface OceanDreamOp {
  op: "merge" | "update" | "archive" | "add"; ids: string[]; reason: string;
  before: { id: string; summary: string; text: string }[];
  draft?: { text: string; summary: string; kind: OceanKind; tags: string[]; importance: number; scope: "global" | "project" };
  outcome?: "applied" | "skipped"; note?: string;
}
export interface OceanDream {
  id: string; root: string; status: "running" | "ready" | "applied" | "discarded" | "failed";
  sourceSessionIds: string[]; memoriesRead: number; operations: OceanDreamOp[]; error?: string; createdAt: string;
}
export const listDreams = (root: string, signal?: AbortSignal): Promise<{ dreams: OceanDream[] }> =>
  get(`/api/memory/ocean/dreams?root=${encodeURIComponent(root)}`, signal);
export const loadDream = (id: string, signal?: AbortSignal): Promise<{ dream: OceanDream }> => get(`/api/memory/ocean/dreams/${id}`, signal);
export const startDream = (root: string): Promise<{ dream: OceanDream }> => post("/api/memory/ocean/dreams", { root, allowReal: true });
export const applyDream = (id: string, accept: readonly number[]): Promise<{ dream: OceanDream }> =>
  post(`/api/memory/ocean/dreams/${id}/apply`, { accept, confirmed: true });
export const discardDream = (id: string): Promise<{ dream: OceanDream }> => post(`/api/memory/ocean/dreams/${id}/discard`, {});

export function kindLabel(kind: OceanKind | null | undefined): string {
  switch (kind) {
    case "preference": return tr("偏好");
    case "fact": return tr("事实");
    case "decision": return tr("决定");
    case "experience": return tr("经验");
    case "pitfall": return tr("教训");
    default: return tr("记忆");
  }
}

/** A stable key for one event, to tell new events from ones already shown. */
export const eventKey = (event: OceanEvent): string => `${event.at}|${event.kind}|${event.ids.join(",")}`;

/** "3 分钟前"-style age of an ISO time. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return tr("刚刚");
  if (minutes < 60) return tf("{0} 分钟前", [minutes]);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return tf("{0} 小时前", [hours]);
  const days = Math.round(hours / 24);
  if (days < 45) return tf("{0} 天前", [days]);
  return new Date(at).toLocaleDateString();
}
