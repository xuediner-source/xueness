/** Wiring for the host's three reviewed optional ports. No implementation is shipped here. */
import { loadOptionalModule, optionalInstalled } from "@xueness/kernel";
import type * as SubscriptionModule from "@xueness/plugin-subscriptions";
import type * as WorkbuddyModule from "@xueness/plugin-workbuddy";
import type * as MonitorModule from "@xueness/plugin-model_monitor";
import type { ChatProvider } from "@xueness/providers";
import type { ExternalProfiles } from "@xueness/plugin-providers";

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
  let subscriptionModule: typeof SubscriptionModule | null = null;
  const subscriptions = slot(o, "subscriptions", () => {
    subscriptionModule = loadOptionalModule(o.stateDir, "subscriptions") as typeof SubscriptionModule;
    return subscriptionModule.createSubscriptions({ stateDir: o.stateDir, enabled: () => o.enabled("subscriptions"), installed: () => optionalInstalled(o.stateDir, "subscriptions"), env: o.env });
  });
  const workbuddy = slot(o, "workbuddy", () => (loadOptionalModule(o.stateDir, "workbuddy") as typeof WorkbuddyModule).createWorkbuddy(o));
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
  let implementation: ReturnType<typeof MonitorModule.createModelMonitorHttp> | null = null;
  return httpPort(o, "model_monitor", ["GET /api/model_monitor", "POST /api/model_monitor/clear"], () => {
    if (!o.enabled("model_monitor") || !optionalInstalled(o.stateDir, "model_monitor")) { implementation = null; return null; }
    implementation ??= (loadOptionalModule(o.stateDir, "model_monitor") as typeof MonitorModule).createModelMonitorHttp(o);
    return { http: implementation };
  });
}

export function observeOptionalProvider(o: Context, provider: ChatProvider, sessionId: string, providerId: unknown): ChatProvider {
  if (!o.enabled("model_monitor") || !optionalInstalled(o.stateDir, "model_monitor")) return provider;
  const monitor = loadOptionalModule(o.stateDir, "model_monitor") as typeof MonitorModule;
  return monitor.observeProvider(provider, { stateDir: o.stateDir, sessionId, providerId, enabled: () => o.enabled("model_monitor") });
}
