/** Wiring for the host's reviewed optional ports. No implementation is shipped here. */
import { loadOptionalModule, optionalInstalled } from "@xueness/kernel";
import type { AgentExtension, ModelRequest } from "@xueness/agent";
import type { ChatProvider } from "@xueness/providers";
import type { ExternalProfiles } from "@xueness/plugin-providers";

// The plugins' code lives in the xueness-marketplace repository and arrives as a downloaded, pinned package.
// These are the entry points the host calls, written out here because the source is not in this repository.
type OptionalContext = { stateDir: string; enabled(id: string): boolean; env: NodeJS.ProcessEnv };
type AccountPlugin = { http: HttpPort; profiles: ExternalProfiles; close?(): void | Promise<void> };
type SubscriptionModule = {
  createSubscriptions(options: { stateDir: string; enabled(): boolean; installed(): boolean; env: NodeJS.ProcessEnv }): AccountPlugin;
  NativeProvider: abstract new (...args: never[]) => ChatProvider & { sessionId?: string };
};
type WorkbuddyModule = { createWorkbuddy(options: OptionalContext): AccountPlugin };
type MonitorModule = {
  createModelMonitorHttp(options: OptionalContext): HttpPort;
  observeProvider(provider: ChatProvider, options: { stateDir: string; sessionId: string; providerId: unknown; enabled(): boolean }): ChatProvider;
};
type TavernModule = {
  createTavernHttp(options: OptionalContext): HttpPort;
  /** Tavern 2+: rebuild a request for a session the Tavern started (roleplay mode). Absent in older packages. */
  prepareRoleplayRequest?(options: { stateDir: string }, session: Record<string, unknown>, request: ModelRequest, view: { lightweight: boolean }): ModelRequest;
};

type Context = { stateDir: string; enabled(id: string): boolean; env: NodeJS.ProcessEnv };
type Reply = [number, unknown] | null;
type HttpPort = { routes: readonly string[]; owns(method: string, parts: readonly string[]): boolean; dispatch(method: string, parts: readonly string[], query: Record<string, string[]>, data: Record<string, unknown>): Reply | Promise<Reply> };

function slot<T extends { close?(): void | Promise<void> }>(o: Context, id: string, create: () => T) {
  let instance: T | null = null;
  const drop = async (): Promise<void> => { const previous = instance; instance = null; await previous?.close?.(); };
  return {
    get(): T | null {
      if (!o.enabled(id) || !optionalInstalled(o.stateDir, id)) { if (instance) void drop(); return null; }
      return instance ??= create();
    },
    async sync() { if (!o.enabled(id) || !optionalInstalled(o.stateDir, id)) await drop(); },
    drop,
  };
}

function httpPort(o: Context, id: string, routes: readonly string[], get: () => { http: HttpPort } | null): HttpPort {
  return {
    routes,
    owns: (_method, parts) => parts[0] === "api" && parts[1] === id,
    dispatch(method, parts, query, data) {
      const implementation = get();
      return implementation ? implementation.http.dispatch(method, parts, query, data)
        : [403, { error: `plugin disabled or dependency unavailable: ${id}`, plugin: id }];
    },
  };
}

export function createOptionalAccounts(o: Context) {
  let subscriptionModule: SubscriptionModule | null = null;
  const subscriptions = slot(o, "subscriptions", () => {
    subscriptionModule = loadOptionalModule(o.stateDir, "subscriptions") as SubscriptionModule;
    return subscriptionModule.createSubscriptions({ stateDir: o.stateDir, enabled: () => o.enabled("subscriptions"), installed: () => optionalInstalled(o.stateDir, "subscriptions"), env: o.env });
  });
  const workbuddy = slot(o, "workbuddy", () => (loadOptionalModule(o.stateDir, "workbuddy") as WorkbuddyModule).createWorkbuddy(o));
  const handlers = [
    httpPort(o, "subscriptions", ["GET /api/subscriptions", "GET /api/subscriptions/:id/status", "POST /api/subscriptions/:id/:action"], subscriptions.get),
    httpPort(o, "workbuddy", ["GET /api/workbuddy/status", "GET /api/workbuddy/accounts", "POST /api/workbuddy/accounts", "DELETE /api/workbuddy/accounts/:id"], workbuddy.get),
  ];
  const profiles: ExternalProfiles = {
    list: () => [...subscriptions.get()?.profiles.list() ?? [], ...workbuddy.get()?.profiles.list() ?? []],
    record: id => workbuddy.get()?.profiles.record(id) ?? subscriptions.get()?.profiles.record(id) ?? null,
    resolve: (record, selection) => {
      const owner = String(record.id ?? "").startsWith("workbuddy.") ? workbuddy.get() : subscriptions.get();
      if (!owner) throw new Error("Optional provider plugin is unavailable");
      return owner.profiles.resolve(record, selection);
    },
    supplier: record => workbuddy.get()?.profiles.supplier(record) ?? subscriptions.get()?.profiles.supplier(record) ?? null,
  };
  const sync = async (): Promise<void> => { await subscriptions.sync(); await workbuddy.sync(); };
  const watcher = setInterval(() => { void sync().catch(() => undefined); }, 1000); watcher.unref();
  return {
    handlers, profiles, sync,
    bindSession(provider: ChatProvider, sid: string) { if (subscriptionModule && provider instanceof subscriptionModule.NativeProvider) provider.sessionId = sid; },
    async close(): Promise<void> { clearInterval(watcher); await subscriptions.drop(); await workbuddy.drop(); },
  };
}

export function createOptionalMonitor(o: Context): HttpPort {
  let implementation: HttpPort | null = null;
  return httpPort(o, "model_monitor", ["GET /api/model_monitor", "POST /api/model_monitor/clear"], () => {
    if (!o.enabled("model_monitor") || !optionalInstalled(o.stateDir, "model_monitor")) { implementation = null; return null; }
    implementation ??= (loadOptionalModule(o.stateDir, "model_monitor") as MonitorModule).createModelMonitorHttp(o);
    return { http: implementation };
  });
}

export function createOptionalTavern(o: Context): HttpPort {
  let implementation: HttpPort | null = null;
  // The Tavern package owns everything under /api/tavern; the list documents its families for the route catalog.
  return httpPort(o, "tavern", ["GET /api/tavern", "POST /api/tavern/:kind", "POST /api/tavern/:kind/:id", "POST /api/tavern/:kind/:id/:action", "DELETE /api/tavern/:kind/:id"], () => {
    if (!o.enabled("tavern") || !optionalInstalled(o.stateDir, "tavern")) { implementation = null; return null; }
    implementation ??= (loadOptionalModule(o.stateDir, "tavern") as TavernModule).createTavernHttp(o);
    return { http: implementation };
  });
}

/**
 * Roleplay mode: a session the Tavern started carries `plugin_refs.tavern` (its playthrough id). For those
 * sessions only, the downloaded Tavern package rebuilds each model request (character, persona, world
 * information, author's note). Every other session, and every session while Tavern is off or not
 * downloaded, is left untouched; the extension's id makes the driver skip it while the plugin is not effective.
 *
 * Two hooks, one per prompt path: in lightweight mode the request is rebuilt before the lightweight view is
 * built from it (the view then uses the roleplay system prompt and keeps its own history budget); otherwise
 * it is rebuilt after the standard prompt view, which would replace the system prompt.
 */
export function createOptionalTavernRoleplay(o: Context): { beforeViews: AgentExtension; afterViews: AgentExtension } {
  const hook = (lightweightPath: boolean): AgentExtension => ({
    id: "tavern",
    prepareRequest(context, request) {
      const refs = context.session.plugin_refs;
      if (!refs || typeof refs !== "object" || typeof (refs as Record<string, unknown>).tavern !== "string") return request;
      const lightweight = (context.session.runtime_profile ?? context.provider.runtimeProfile) === "lightweight";
      if (lightweight !== lightweightPath || !o.enabled("tavern") || !optionalInstalled(o.stateDir, "tavern")) return request;
      const module = loadOptionalModule(o.stateDir, "tavern") as TavernModule;
      if (typeof module.prepareRoleplayRequest !== "function") return request;
      return module.prepareRoleplayRequest({ stateDir: o.stateDir }, context.session as Record<string, unknown>, request, { lightweight });
    },
  });
  return { beforeViews: hook(true), afterViews: hook(false) };
}

export function observeOptionalProvider(o: Context, provider: ChatProvider, sessionId: string, providerId: unknown): ChatProvider {
  if (!o.enabled("model_monitor") || !optionalInstalled(o.stateDir, "model_monitor")) return provider;
  const monitor = loadOptionalModule(o.stateDir, "model_monitor") as MonitorModule;
  return monitor.observeProvider(provider, { stateDir: o.stateDir, sessionId, providerId, enabled: () => o.enabled("model_monitor") });
}
