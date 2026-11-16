/**
 * Swarm routes for the Swarm pane.
 *
 * Session-scoped (`createSwarmSessionApi`, mounted with the sessions API; the
 * host's `owner` check authorizes the session and its workspace):
 *   GET  /api/sessions/:sid/swarms
 *   GET  /api/sessions/:sid/swarms/:id
 *   GET  /api/sessions/:sid/swarms/:id/board?after=
 *   POST /api/sessions/:sid/swarms/:id/{post,stop,resume}
 *   POST /api/sessions/:sid/swarms/:id/members/:name/{kill,model,reassign}
 *   GET  /api/sessions/:sid/swarms/:id/members/:name/journal
 * Settings (`createSwarmSettingsHttp`): GET|POST /api/swarm/settings.
 */
import { isDict } from "@xueness/contracts";
import { normalizeChannelName, normalizeModel, PlanError } from "./plan.ts";
import { SwarmServiceError, type SwarmService } from "./service.ts";
import { readSwarmSettings, SwarmSettingsError, writeSwarmSettings } from "./settings.ts";
import { SWARM_ID, type MemberRecord, type SwarmRecord } from "./store.ts";
import { swarmSummary } from "./tools.ts";

type Row = Record<string, unknown>;
type Reply = [number, unknown];
const BASE = "/api/sessions/:id/swarms";
export const SWARM_SESSION_ROUTES = [
  `GET ${BASE}`, `GET ${BASE}/:swarm`, `GET ${BASE}/:swarm/board`,
  ...["post", "stop", "resume"].map((op) => `POST ${BASE}/:swarm/${op}`),
  ...["kill", "model", "reassign"].map((op) => `POST ${BASE}/:swarm/members/:name/${op}`),
  `GET ${BASE}/:swarm/members/:name/journal`,
] as const;
export const SWARM_SETTINGS_ROUTES = ["GET /api/swarm/settings", "POST /api/swarm/settings"] as const;

export interface SwarmSessionApiOptions {
  service: SwarmService;
  enabled(id: string): boolean;
  /** Loads the conversation and checks its workspace; throws when the caller may not see it. */
  owner(sid: string): Promise<unknown>;
  /** A member's transcript, bounded, for the Members tab. */
  journal(record: SwarmRecord, member: MemberRecord): Promise<Row[]>;
  /** Live transcript activity summary per member name. */
  activities?(record: SwarmRecord): Promise<Record<string, { activity: string }>>;
}

const disabled = (): Reply => [403, { error: "plugin disabled or dependency unavailable: swarm", plugin: "swarm" }];
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

export function createSwarmSessionApi(options: SwarmSessionApiOptions) {
  const owns = (_method: string, parts: readonly string[]): boolean => parts[0] === "api" && parts[1] === "sessions" && /^[a-f0-9]{32}$/.test(parts[2] ?? "") && parts[3] === "swarms";
  return {
    routes: SWARM_SESSION_ROUTES, owns,
    async dispatch(method: string, parts: readonly string[], query: Record<string, unknown> = {}, data: unknown = {}): Promise<Reply | null> {
      if (!owns(method, parts)) return null;
      if (!options.enabled("swarm")) return disabled();
      const sid = parts[2]!, id = parts[4], body = isDict(data) ? data : {};
      try {
        try { await options.owner(sid); } catch { return [404, { error: "conversation not found" }]; }
        const service = options.service;
        if (parts.length === 4) return method === "GET" ? [200, { swarms: service.list(sid).map((record) => swarmSummary(record, service.running(record.id), service.posts(record.id))) }] : [405, { error: "method not allowed" }];
        if (!id || !SWARM_ID.test(id)) return [404, { error: "swarm not found" }];
        const record = service.get(id);
        if (record.parentSessionId !== sid) return [404, { error: "swarm not found" }];
        if (parts.length === 5) {
          if (method !== "GET") return [405, { error: "method not allowed" }];
          const allPosts = service.posts(id);
          const running = service.running(id);
          const sum = swarmSummary(record, running, allPosts);
          const byName = new Map(((sum.members ?? []) as Row[]).map((m) => [String(m.name), m]));
          const acts = options.activities ? await options.activities(record) : {};
          const enriched = {
            ...record,
            edges: sum.edges,
            systemAttention: sum.systemAttention,
            members: record.members.map((m) => {
              const sm = byName.get(m.name);
              const act = acts[m.name]?.activity;
              return { ...m, ...(sm ? { posts: sm.posts, unread: sm.unread, lastPostSeq: sm.lastPostSeq, lastPostAt: sm.lastPostAt } : {}), ...(act ? { activity: act } : {}) };
            }),
          };
          return [200, { swarm: enriched, running }];
        }
        const op = parts[5];
        if (parts.length === 6 && op === "board" && method === "GET") {
          const after = query.after === undefined ? 0 : Number(query.after);
          if (!Number.isSafeInteger(after) || after < 0) return [400, { error: "after must be a non-negative integer" }];
          const chanFilter = typeof query.channel === "string" && query.channel.trim() ? normalizeChannelName(query.channel, "channel") : null;
          let posts = service.posts(id, after);
          if (chanFilter) posts = posts.filter((p) => (p.channel ?? "main") === chanFilter);
          return [200, { posts, status: record.status, running: service.running(id) }];
        }
        if (parts.length === 6 && method === "POST") {
          if (op === "post") return [200, { post: service.post(id, "user", strings(body.to), typeof body.text === "string" ? body.text : "", "user", typeof body.channel === "string" && body.channel.trim() ? body.channel : "main") }];
          if (op === "stop") return [200, { swarm: service.stop(id, typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 300) : "stopped by the user") }];
          if (op === "resume") return [200, { swarm: service.resume(id) }];
        }
        if (parts.length === 8 && op === "members") {
          const member = record.members.find((item) => item.name === parts[6]);
          if (!member) return [404, { error: "member not found" }];
          if (parts[7] === "kill" && method === "POST") return [200, { swarm: service.kill(id, member.name, "user", typeof body.reason === "string" ? body.reason : "stopped by the user") }];
          if (parts[7] === "model" && method === "POST") return [200, { swarm: service.switchModel(id, member.name, normalizeModel(body.model, "model"), "user") }];
          if (parts[7] === "reassign" && method === "POST") {
            const to = typeof body.to === "string" ? body.to.trim().replace(/^@/, "").toLowerCase() : "";
            if (!to) return [400, { error: "to is required" }];
            return [200, { swarm: service.reassign(id, {
              from: member.name, to,
              task: typeof body.task === "string" ? body.task : undefined,
              owns: Array.isArray(body.owns) ? strings(body.owns) : undefined,
              commands: Array.isArray(body.commands) ? strings(body.commands) : undefined,
              fork: body.fork === true,
              model: body.model === undefined ? undefined : normalizeModel(body.model, "model"),
            }, "user") }];
          }
          if (parts[7] === "journal" && method === "GET") return [200, { member: member.name, messages: await options.journal(record, member) }];
        }
        return [404, { error: "swarm route not found" }];
      } catch (error) {
        if (error instanceof SwarmServiceError) return [error.status, { error: error.message }];
        if (error instanceof PlanError) return [400, { error: error.message }];
        throw error;
      }
    },
  };
}

export function createSwarmSettingsHttp(options: { stateDir: string; enabled(id: string): boolean }) {
  const owns = (_method: string, parts: readonly string[]): boolean => parts.length === 3 && parts[0] === "api" && parts[1] === "swarm" && parts[2] === "settings";
  return {
    routes: SWARM_SETTINGS_ROUTES, owns,
    async dispatch(method: string, parts: readonly string[], _query: Record<string, unknown> = {}, data: unknown = {}): Promise<Reply | null> {
      if (!owns(method, parts)) return null;
      if (!options.enabled("swarm")) return disabled();
      try {
        if (method === "GET") return [200, { settings: readSwarmSettings(options.stateDir) }];
        if (method === "POST") return [200, { settings: writeSwarmSettings(options.stateDir, data) }];
        return [405, { error: "仅支持 GET 和 POST。" }];
      } catch (error) {
        if (error instanceof SwarmSettingsError) return [400, { error: error.message }];
        if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string") return [500, { error: "无法读写蜂群设置，请检查本地目录权限。" }];
        throw error;
      }
    },
  };
}
