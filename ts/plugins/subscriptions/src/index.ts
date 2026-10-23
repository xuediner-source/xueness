/**
 * Optional subscription accounts and provider adapters. Default off, available
 * only after the marketplace marker is installed; the worker stops when the
 * plugin is disabled.
 */
import { PyValueError } from "@xueness/contracts";
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
import { createAccountsHttp } from "./accounts.ts";
import { SubscriptionBroker } from "./broker.ts";
import { resolveSubscription } from "./provider.ts";
import { definition, PREFIX, providerRecords } from "./state.ts";

export * from "./state.ts";
export { SubscriptionBroker, SubscriptionRequestError, SubscriptionWorker, type CallOptions } from "./broker.ts";
export { createAccountsHttp, SUBSCRIPTION_ROUTES, type AccountsOptions } from "./accounts.ts";
export { NativeProvider, resolveSubscription } from "./provider.ts";

type Row = Record<string, unknown>;
export interface SubscriptionsOptions {
  stateDir: string;
  /** Python `is_enabled(state, 'subscriptions')`: marker installed, switch on, providers on. */
  enabled(): boolean;
  /** The marketplace marker for `xueness-subscriptions`. */
  installed(): boolean;
  env?: NodeJS.ProcessEnv;
}
export interface SubscriptionSelection { model?: string | null; reasoningEffort?: string | null; runtimeProfile?: string | null }

export function createSubscriptions(o: SubscriptionsOptions) {
  const requireAvailable = (): void => {
    if (!o.enabled()) throw new PyValueError("plugin disabled or dependency unavailable: subscriptions");
    if (!o.installed()) throw new PyValueError("Install Subscriptions Hub from the marketplace first");
  };
  const available = (): boolean => { try { requireAvailable(); return true; } catch { return false; } };
  const broker = new SubscriptionBroker(o.stateDir, requireAvailable, o.env);
  const http = createAccountsHttp({ stateDir: o.stateDir, enabled: o.enabled, requireAvailable, broker });
  /** Saved-profile view for the providers plugin (Python `provider_records` / `provider_record`). */
  const profiles = {
    list: (): Row[] => providerRecords(o.stateDir, available()),
    record(id: unknown): Row | null {
      if (typeof id !== "string" || !id.startsWith(PREFIX)) return null;
      try { return providerRecords(o.stateDir, available()).find((row) => row.id === id) ?? null; } catch { return null; }
    },
    resolve: (record: Row, selection: SubscriptionSelection = {}) => resolveSubscription(broker, requireAvailable, record, selection.model, selection.reasoningEffort, selection.runtimeProfile),
    /** `model_supplier_metadata` for subscription records. */
    supplier(record: Row): Row | null {
      const account = record.source === "subscription" ? definition(record.subscriptionId) : null;
      return account ? { supplierId: "subscription:" + String(account.id), supplierName: account.name, supplierNameEn: account.nameEn ?? account.name } : null;
    },
  };
  const watcher = setInterval(() => { if (!available()) broker.shutdown(); }, 1000);
  watcher.unref();
  return { http, profiles, broker, available, close(): void { clearInterval(watcher); broker.shutdown(); } };
}
export type Subscriptions = ReturnType<typeof createSubscriptions>;

export const subscriptions: BundledPlugin = { manifest, plugin: definePlugin({ name: "subscriptions", apply() {} }) };
