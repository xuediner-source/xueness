/** Owned background naming work: bounded retries and atomic manual-rename wins. */
import { isDict } from "@xueness/contracts";
import type { AgentProvider, Row } from "@xueness/agent";
import type { Session, SessionStore } from "@xueness/sessions";
import { firstExchange, isChildSession, needsAutoTitle, titleFromModel, titlePrompt } from "./title-text.ts";
export * from "./title-text.ts";
export interface AutoTitleOptions {
  store: SessionStore; enabled(id: string): boolean; settings(): Row;
  allowModelRequests: boolean;
  acceptProvider(provider: AgentProvider): boolean;
  request(provider: AgentProvider, prompt: Row[], signal: AbortSignal): Promise<string | null>;
  now?: () => string;
}
export function createAutoTitleWorker(o: AutoTitleOptions) {
  const failures = new Map<string, number>(), inflight = new Set<string>(), tasks = new Set<Promise<unknown>>(), shutdown = new AbortController(); let closed = false;
  const enabled = (): boolean => {
    if (closed || !o.allowModelRequests || !o.enabled("sessions") || !o.enabled("providers")) return false;
    try { const general = o.settings().general; return (general === undefined || isDict(general)) && (!isDict(general) || general.sessionsAutoTitleEnabled !== false); } catch { return false; }
  };
  const failure = (sid: string): void => { failures.set(sid, (failures.get(sid) ?? 0) + 1); };
  const generate = async (sid: string, provider: AgentProvider): Promise<string | null> => {
    if (inflight.has(sid) || (failures.get(sid) ?? 0) >= 3 || !enabled() || !o.acceptProvider(provider)) return null;
    inflight.add(sid);
    try {
      let fresh = await o.store.load(sid);
      if (!needsAutoTitle(fresh) || fresh.status === "running" || !firstExchange(fresh)) return null;
      if (!enabled()) return null;
      fresh = await o.store.load(sid);
      const exchange = firstExchange(fresh);
      if (!needsAutoTitle(fresh) || fresh.status === "running" || !exchange || !enabled()) return null;
      const policy = new AbortController(); const probe = setInterval(() => { if (!enabled()) policy.abort(); }, 50); probe.unref();
      let title: string | null;
      try { title = titleFromModel(await o.request(provider, titlePrompt(fresh.task, ...exchange), AbortSignal.any([shutdown.signal, policy.signal]))); }
      finally { clearInterval(probe); }
      if (!title) { failure(sid); return null; }
      const stored = await o.store.update(sid, (current) => {
        if (!enabled() || !needsAutoTitle(current) || current.status === "running") return false;
        current.title = title; current.title_source = "generated"; current.title_generated_at = o.now?.() ?? new Date().toISOString().replace(/Z$/, "+00:00"); return true;
      });
      if (stored.title_source !== "generated" || stored.title !== title) return null;
      failures.delete(sid); return title;
    } catch { failure(sid); return null; }
    finally { inflight.delete(sid); }
  };
  return {
    generate,
    schedule(session: Session, provider: AgentProvider): void {
      if (!/^[0-9a-f]{32}$/.test(String(session.id)) || isChildSession(session) || session.runtime_profile === "lightweight" || !enabled() || !needsAutoTitle(session) || !firstExchange(session) || !o.acceptProvider(provider)) return;
      const task = generate(String(session.id), provider); tasks.add(task); task.finally(() => tasks.delete(task)).catch(() => {});
    },
    async drain(): Promise<void> { await Promise.allSettled([...tasks]); },
    async close(): Promise<void> { closed = true; shutdown.abort(); await Promise.allSettled([...tasks]); },
  };
}
