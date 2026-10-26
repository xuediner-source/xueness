/** Session-owned HTTP routes for proposing, reviewing, starting and applying memory dreams. */
import { isDict, PyValueError } from "@xueness/contracts";
import { MemoryDreamService, MemoryDreamServiceError } from "./memory-dream-service.ts";

const BASE = "/api/sessions/:id/memory-dreams";
const ID = /^[a-f0-9]{32}$/;
export const MEMORY_DREAM_ROUTES = [
  `GET ${BASE}`, `POST ${BASE}`, `GET ${BASE}/:dreamId`, `GET ${BASE}/:dreamId/diff`,
  ...["start", "cancel", "apply", "revert"].map((op) => `POST ${BASE}/:dreamId/${op}`),
];
type Reply = [number, unknown] | null;
const text = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required`);
  return value;
};

export function createMemoryDreamApi(service: MemoryDreamService) {
  const owns = (_method: string, parts: readonly string[]): boolean => parts[0] === "api" && parts[1] === "sessions"
    && ID.test(parts[2] ?? "") && parts[3] === "memory-dreams";
  return {
    routes: MEMORY_DREAM_ROUTES,
    owns,
    async dispatch(method: string, parts: readonly string[], _query: Record<string, unknown> = {}, data: unknown = {}): Promise<Reply> {
      if (!owns(method, parts)) return null;
      const sessionId = parts[2]!, body = isDict(data) ? data : {};
      try {
        if (parts.length === 4) {
          if (method === "GET") return [200, { dreams: await service.list(sessionId) }];
          if (method === "POST") {
            if (body.name !== undefined && typeof body.name !== "string") throw new TypeError("name must be a string");
            if (body.sourceSessionIds !== undefined && (!Array.isArray(body.sourceSessionIds) || body.sourceSessionIds.some((id) => typeof id !== "string"))) throw new TypeError("sourceSessionIds must be a string array");
            return [200, await service.propose(sessionId, {
              ...(body.name === undefined ? {} : { name: body.name as string }),
              ...(body.sourceSessionIds === undefined ? {} : { sourceSessionIds: body.sourceSessionIds as string[] }),
            })];
          }
          return [405, { error: "method not allowed" }];
        }
        const id = parts[4] ?? "";
        if (!ID.test(id)) return [404, { error: "memory dream not found" }];
        if (parts.length === 5) return method === "GET" ? [200, await service.get(sessionId, id)] : [405, { error: "method not allowed" }];
        if (parts.length !== 6 || (method !== "POST" && !(method === "GET" && parts[5] === "diff"))) return [405, { error: "method not allowed" }];
        const operation = parts[5];
        if (operation === "diff") return method === "GET" ? [200, await service.diff(sessionId, id)] : [405, { error: "method not allowed" }];
        if (operation === "start") {
          if (body.confirmed !== undefined && typeof body.confirmed !== "boolean") throw new TypeError("confirmed must be a boolean");
          if (body.allowReal !== undefined && typeof body.allowReal !== "boolean") throw new TypeError("allowReal must be a boolean");
          return [200, await service.start(sessionId, id, { digest: text(body.digest, "digest"), confirmed: body.confirmed === true, allowReal: body.allowReal === true })];
        }
        if (operation === "cancel") return [200, await service.cancel(sessionId, id)];
        if (operation === "apply") {
          if (body.confirmed !== undefined && typeof body.confirmed !== "boolean") throw new TypeError("confirmed must be a boolean");
          return [200, await service.apply(sessionId, id, { digest: text(body.digest, "digest"), confirmed: body.confirmed === true })];
        }
        if (operation === "revert") {
          if (body.confirmed !== undefined && typeof body.confirmed !== "boolean") throw new TypeError("confirmed must be a boolean");
          return [200, await service.revert(sessionId, id, { digest: text(body.digest, "digest"), confirmed: body.confirmed === true })];
        }
        return [404, { error: "memory dream operation not found" }];
      } catch (error) {
        if (error instanceof MemoryDreamServiceError) return [error.status, { error: error.message }];
        if (error instanceof TypeError || error instanceof PyValueError) return [400, { error: error.message }];
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return [404, { error: "memory dream or session not found" }];
        return [500, { error: "memory dream operation failed" }];
      }
    },
  };
}
