/** Plugin-owned, credential-safe account and quota HTTP surface (Python `subscriptions/accounts.py`). */
import { isDict, pyLen, pySlice, pyStrip, PyValueError } from "@xueness/contracts";
import { isPyOSError, isPyValueError, pyOSErrorText } from "@xueness/sessions";
import type { SubscriptionBroker } from "./broker.ts";
import { clearEntitlementConfig, publicEntitlementConfigs, saveEntitlementConfig } from "./entitlement-config.ts";
import { pendingExternalConditions } from "./entitlements.ts";
import { definition, publicAccounts, readDocument, writeDocument } from "./state.ts";

type Row = Record<string, unknown>;
export type Reply = [number, unknown];
const ACTIONS = new Set(["connect", "login", "import", "manual", "cancel", "models", "quota", "disconnect", "set-models", "entitlement"]);
export const SUBSCRIPTION_ROUTES = ["GET /api/subscriptions", "GET /api/subscriptions/:id/status", "POST /api/subscriptions/:id/:action"];

function text(value: unknown, limit = 256, empty = false): string {
  if (typeof value !== "string" || pyLen(value) > limit || [...value].some((ch) => ch.codePointAt(0)! < 32)) throw new PyValueError("invalid account field");
  const clean = pyStrip(value);
  if (!clean && !empty) throw new PyValueError("account field is required");
  return clean;
}

export interface AccountsOptions {
  stateDir: string;
  enabled(): boolean;
  requireAvailable(): void;
  broker: SubscriptionBroker;
}

export function createAccountsHttp(o: AccountsOptions) {
  let chain: Promise<unknown> = Promise.resolve();
  /** Serialize the files shared with the worker's explicit account actions. */
  const locked = <T>(body: () => T | Promise<T>): Promise<T> => { const next = chain.then(body, body); chain = next.catch(() => {}); return next; };
  const connect = (item: Row, data: Row): Promise<void> => {
    o.requireAvailable();
    if (item.id !== "qoder") throw new PyValueError("use account authorization or import a CLI login for this provider");
    if (Object.keys(data).some((key) => key !== "accessToken" && key !== "userId")) throw new PyValueError("unsupported account field");
    return locked(() => {
      const connections = readDocument(o.stateDir, "connections.json");
      const previous: Row = isDict(connections[item.id as string]) ? connections[item.id as string] as Row : {};
      const token = text(Object.hasOwn(data, "accessToken") ? data.accessToken : "", 65536, true) || previous.accessToken;
      connections[item.id as string] = { ...previous, accessToken: text(token, 65536), userId: text(data.userId || previous.userId) };
      writeDocument(o.stateDir, "connections.json", connections);
      const quotas = readDocument(o.stateDir, "quota.json");
      delete quotas[item.id as string];
      writeDocument(o.stateDir, "quota.json", quotas);
    });
  };
  async function handle(method: string, parts: readonly string[], data: unknown): Promise<Reply> {
    o.requireAvailable();
    if (parts.length === 2 && method === "GET") return [200, { accounts: publicAccounts(o.stateDir), workerRunning: o.broker.running(), entitlements: publicEntitlementConfigs(o.stateDir, true), pendingInterfaces: pendingExternalConditions() }];
    if (parts.length !== 4) return [404, { error: "subscription operation not found" }];
    const [pid, action] = [parts[2]!, parts[3]!];
    const item = definition(pid);
    if (!item) return [404, { error: "subscription provider not found" }];
    if (method === "GET" && action === "status") {
      const status = await o.broker.call("status", pid, {}, { start: false });
      return [200, { status, account: publicAccounts(o.stateDir).find((row) => row.id === pid) }];
    }
    if (method !== "POST" || !ACTIONS.has(action)) return [405, { error: "method not allowed" }];
    if (!isDict(data)) throw new PyValueError("expected a JSON object");
    let result: unknown;
    if (action === "connect") { await connect(item, data); result = { saved: true }; }
    else if (action === "set-models") {
      const models = data.models;
      if (Object.keys(data).join(",") !== "models" || !Array.isArray(models) || !(models.length > 0 && models.length <= 200)) throw new PyValueError("enter at least one model ID");
      const ids = [...new Set(models.map((mid) => text(mid)))];
      await locked(() => {
        const catalogs = readDocument(o.stateDir, "public-models.json");
        catalogs[pid] = { models: ids.map((mid) => ({ id: mid, name: mid, source: "manual" })) };
        writeDocument(o.stateDir, "public-models.json", catalogs);
      });
      result = { saved: true };
    } else if (action === "entitlement") {
      if (!Object.keys(data).every((key) => key === "base" || key === "token")) throw new PyValueError("expected entitlement base URL and token");
      if (Object.hasOwn(data, "token")) {
        saveEntitlementConfig(o.stateDir, pid, data.base, data.token);
        result = { saved: true };
      } else {
        result = { removed: clearEntitlementConfig(o.stateDir, pid) };
      }
    } else {
      if (action === "manual") {
        if (Object.keys(data).join(",") !== "callback") throw new PyValueError("expected authorization callback");
        text(data.callback, 16384);
      } else if (Object.keys(data).length) throw new PyValueError("unexpected operation fields");
      result = await locked(() => o.broker.call(action, pid, data));
    }
    o.requireAvailable();
    return [200, { result, accounts: publicAccounts(o.stateDir) }];
  }
  return {
    routes: SUBSCRIPTION_ROUTES,
    owns: (_method: string, parts: readonly string[]): boolean => parts[0] === "api" && parts[1] === "subscriptions",
    async dispatch(method: string, parts: readonly string[], _query: unknown, data: unknown): Promise<Reply | null> {
      if (parts[0] !== "api" || parts[1] !== "subscriptions") return null;
      if (!o.enabled()) return [403, { error: "plugin disabled or dependency unavailable: subscriptions", plugin: "subscriptions", code: "plugin_disabled" }];
      try { return await handle(method, parts, data); } catch (error) {
        // These errors are authored locally or redacted by the worker.
        if (isPyOSError(error)) return [400, { error: pySlice(pyOSErrorText(error), 700) }];
        if (isPyValueError(error) || (error as Error)?.name === "RuntimeError") return [400, { error: pySlice((error as Error).message, 700) }];
        throw error;
      }
    },
  };
}
