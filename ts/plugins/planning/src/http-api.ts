/** Planning owns durable goal edits and user corrections to delivery requirements. */
import { isDict, pyTruthy } from "@xueness/contracts";
import { isPyOSError, isPyValueError, pyExceptionName, type Session, type SessionStore } from "@xueness/sessions";
import { clearGoal, transitionGoal, updateGoalBudget } from "./goal-actions.ts";
import { GoalError, publicGoal, stageGoal } from "./goal.ts";
import { normalizeDelivery, type Row } from "./delivery.ts";
type Reply = [number, unknown];
/** `source` labels staged goals: "http" for the web, "cli" for the operator CLI. */
export function createPlanningApi(o: { store: SessionStore; enabled(id: string): boolean; running?: ReadonlySet<string>; interruptSession?: (sid: string, mutate: (s: Session) => void) => Promise<boolean>; source?: string }) {
  return {
    routes: ["GET /api/sessions/:id/goal", "POST /api/sessions/:id/goal", "DELETE /api/sessions/:id/goal", "GET /api/delivery/:id", "POST /api/delivery/:id"],
    owns(_method: string, parts: readonly string[]) { return parts[0] === "api" && (parts.length === 4 && parts[1] === "sessions" && parts[3] === "goal" && /^[a-f0-9]{32}$/.test(parts[2]!) || parts.length === 3 && parts[1] === "delivery" && /^[a-f0-9]{32}$/.test(parts[2]!)); },
    async dispatch(method: string, parts: string[], _query: Row, data: unknown): Promise<Reply | null> {
      if (!this.owns(method, parts)) return null;
      if (!o.enabled("planning")) return [403, { error: "plugin disabled or dependency unavailable: planning", plugin: "planning" }];
      const sid = parts[2]!, delivery = parts[1] === "delivery";
      if (!(delivery ? ["GET", "POST"] : ["GET", "POST", "DELETE"]).includes(method)) return [405, { error: "method not allowed" }];
      let lease: Awaited<ReturnType<SessionStore["lease"]>> | null = null;
      try {
        if (method === "GET") {
          let s; try { s = await o.store.load(sid); } catch (e) { if (!delivery && (isPyOSError(e) || isPyValueError(e))) throw new GoalError("session not found", 404); throw e; }
          return [200, delivery ? { items: s.delivery_requirements ?? [] } : { session: sid, goal: publicGoal(s) }];
        }
        if (!isDict(data) || Object.keys(data).some((key) => !(delivery ? ["items"] : method === "DELETE" ? [] : ["text", "replace", "action", "budget"]).includes(key))) return [400, { error: delivery ? "expected items only" : "expected text, with optional replace boolean" }];
        if (delivery && Object.keys(data).join(",") !== "items") return [400, { error: "expected items only" }];
        if (!delivery && Object.hasOwn(data, "replace") && typeof data.replace !== "boolean") return [400, { error: "replace must be a boolean" }];
        if (!delivery && Object.hasOwn(data, "action")) {
          if (["pause", "resume"].includes(String(data.action)) && Object.keys(data).join(",") !== "action") return [400, { error: "pause/resume 仅接受 action 字段" }];
          if (data.action === "budget" && (Object.keys(data).length !== 2 || !Object.hasOwn(data, "budget") || !isDict(data.budget))) return [400, { error: "budget 操作需要完整 budget 对象" }];
          if (!["pause", "resume", "budget"].includes(String(data.action))) return [400, { error: "action 仅支持 pause、resume 或 budget" }];
        }
        if (o.running?.has(sid)) {
          if (!delivery && method === "POST" && data.action === "pause" && o.interruptSession) {
            let mutated = false;
            const interrupted = await o.interruptSession(sid, (live) => { if (!mutated) { transitionGoal(live, "pause", o.enabled, o.source ?? "http"); mutated = true; } });
            if (!interrupted || !mutated) return [409, { error: "无法中断当前运行并暂停会话目标。" }];
            const live = await o.store.load(sid), goal = publicGoal(live);
            if (goal?.status !== "paused") return [409, { error: "会话目标已变化，未能确认暂停状态。" }];
            return [200, { session: sid, goal }];
          }
          return [409, { error: delivery ? "请先停止运行，再编辑交付清单。" : "请先停止运行，再修改会话目标。" }];
        }
        lease = await o.store.lease(sid);
        let s; try { s = await o.store.load(sid); } catch (e) { if (!delivery && (isPyOSError(e) || isPyValueError(e))) throw new GoalError("session not found", 404); throw e; }
        if (delivery) { const items = pyTruthy(data.items) ? normalizeDelivery(data.items) : []; s.delivery_requirements = items; s.completion = null; if (s.status === "completed") s.status = "paused"; await o.store.save(s); return [200, { items }]; }
        const record = method === "DELETE" ? clearGoal(s, o.enabled) : data.action === "budget" ? updateGoalBudget(s, data.budget, o.enabled, o.source ?? "http") : Object.hasOwn(data, "action") ? transitionGoal(s, String(data.action), o.enabled, o.source ?? "http") : stageGoal(s, data.text, { enabled: o.enabled, replace: data.replace === true, budget: data.budget, source: o.source ?? "http" });
        await o.store.save(s); return [200, { session: sid, goal: record }];
      } catch (e) {
        if (e instanceof GoalError) return [e.status, { error: e.message }];
        if (pyExceptionName(e) === "BlockingIOError") return [409, { error: "session is in use by another process" }];
        if (isPyOSError(e) || isPyValueError(e)) return [400, { error: delivery ? (e as Error).message : "cannot update session goal" }];
        throw e;
      } finally { await lease?.release(); }
    },
  };
}
