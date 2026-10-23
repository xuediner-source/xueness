/**
 * The providers view this plugin publishes. `ProfileStore.external` is a
 * single slot, so the front door merges this view with the subscriptions one
 * before attaching it; every id carries the `workbuddy.` prefix so each view
 * answers only for its own records.
 *
 * Records bypass `resolveRuntimeOptions`: that bound (262144) applies to saved
 * profiles, and the pool's windows are larger.
 */
import { PyValueError } from "@xueness/contracts";
import type { ChatProvider } from "@xueness/providers";
import { Gateway } from "./gateway.ts";
import { WorkbuddyAccountStore, type WorkbuddyAccountMetadata } from "./accounts.ts";
import { createWorkbuddyHttp } from "./http.ts";
import { workbuddyLayout } from "./layout.ts";
import { MODELS, modelForProfile, profileId, type WorkbuddyModel } from "./models.ts";
import { WorkbuddyProvider } from "./provider.ts";

type Dict = Record<string, unknown>;

/** Every profile id this view owns starts here. */
export const PROFILE_PREFIX = "workbuddy.";
/** The `subscriptionId` marker of a pool record. */
const SUPPLIER = "workbuddy";

export interface ProfileSelection {
  model?: string | null;
  reasoningEffort?: string | null;
  runtimeProfile?: string | null;
}

/** Structurally `ExternalProfiles`; declaring it here keeps plugins independent. */
export interface WorkbuddyProfiles {
  list(): Dict[];
  record(id: string): Dict | null;
  resolve(record: Dict, selection: ProfileSelection): ChatProvider;
  supplier(record: Dict): Dict | null;
}

/** The public row and saved record of one model; the two shapes are the same. */
function publicRecord(gateway: Gateway, model: WorkbuddyModel): Dict {
  return {
    id: profileId(model), name: `WorkBuddy · ${model.name}`, baseUrl: gateway.baseUrl, model: model.id,
    // "subscription" is the composer's marker for account-backed external
    // profiles: read-only in provider settings, listed after saved ones.
    source: "subscription", subscriptionId: SUPPLIER, hasKey: true, protocol: "openai",
    capabilities: [], reasoningLevels: [...model.reasoningLevels], runtimeProfile: "standard",
    contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, toolCalling: "native",
  };
}

/** `resolve` never throws for a record this view produced: the picker reads a
 *  throw as "not configured" and would grey the model out. */
function providerFor(gateway: Gateway, record: Dict, selection: ProfileSelection): ChatProvider {
  const model = modelForProfile(typeof record.id === "string" ? record.id : "");
  if (!model) throw new PyValueError("unknown WorkBuddy model");
  const effort = selection.reasoningEffort ?? null;
  if (effort !== null && !model.reasoningLevels.includes(effort)) {
    throw new PyValueError("unsupported reasoning effort for this WorkBuddy model");
  }
  const profile = selection.runtimeProfile ?? null;
  if (profile !== null && profile !== "standard") throw new PyValueError("WorkBuddy models require the standard runtime profile");
  return new WorkbuddyProvider(gateway, model, effort);
}

export interface WorkbuddyOptions {
  stateDir: string;
  enabled(id: string): boolean;
  env?: NodeJS.ProcessEnv;
  /** The directory holding the gateway binary and the credential seed copies. */
  assets?: string;
}

export function createWorkbuddy(options: WorkbuddyOptions) {
  const gateway = new Gateway(workbuddyLayout(options.stateDir, options.env ?? process.env, options.assets));
  const accountStore = new WorkbuddyAccountStore(gateway.layout);
  const available = (): boolean => options.enabled("workbuddy");

  const accountSnapshot = async (mayEnsure: boolean): Promise<Dict> => {
    const local = accountStore.list();
    let status: Dict | null = null;
    if (local.length > 0 && available()) {
      if (mayEnsure) {
        try { await gateway.ensure(); } catch { /* preserve locally stored accounts while offline */ }
      }
      if (mayEnsure || gateway.running) {
        try { status = await gateway.status(); } catch { status = null; }
      }
    }
    const byUid = new Map<string, Dict>();
    if (Array.isArray(status?.accounts)) {
      for (const item of status.accounts) {
        if (typeof item === "object" && item !== null && !Array.isArray(item)) {
          const row = item as Dict;
          if (typeof row.uid === "string" && row.uid !== "") byUid.set(row.uid, row);
        }
      }
    }
    const accounts = local.map((account) => publicAccount(account, byUid.get(account.uid), accountStore));
    return { ok: true, accounts, gatewayAvailable: status !== null };
  };

  const reloadOwnedGateway = async (): Promise<void> => {
    try { await gateway.reloadOwned(accountStore.list().length > 0); }
    catch { /* credentials are saved; the next status read reports gateway availability */ }
  };

  const profiles: WorkbuddyProfiles = {
    list: () => available() ? MODELS.map((model) => publicRecord(gateway, model)) : [],
    record: (id) => { if (!available()) return null; const model = modelForProfile(id); return model ? publicRecord(gateway, model) : null; },
    resolve: (record, selection = {}) => providerFor(gateway, record, selection),
    supplier: (record) => record.subscriptionId === SUPPLIER
      ? { supplierId: `subscription:${SUPPLIER}`, supplierName: "WorkBuddy 号池", supplierNameEn: "WorkBuddy pool" }
      : null,
  };
  const http = createWorkbuddyHttp({
    enabled: available,
    status: async () => {
      if (!available()) return null;
      if (accountStore.list().length === 0) return null;
      try { await gateway.ensure(); } catch { return null; }
      return await gateway.status();
    },
    accounts: () => accountSnapshot(true),
    addAccount: async (credentials) => {
      accountStore.save(credentials);
      await reloadOwnedGateway();
      return await accountSnapshot(false);
    },
    deleteAccount: async (id) => {
      accountStore.delete(id);
      await reloadOwnedGateway();
      return await accountSnapshot(false);
    },
  });
  return { gateway, http, profiles, available, close(): void { void gateway.stop(); } };
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function publicAccount(account: WorkbuddyAccountMetadata, state: Dict | undefined, store: WorkbuddyAccountStore): Dict {
  const statusNickname = text(state?.nickname);
  const safeNickname = (statusNickname ? store.safeStatusText(account.uid, statusNickname) : null)
    ?? store.safeStatusText(account.uid, account.nickname)
    ?? "";
  return {
    id: account.id,
    uid: account.uid,
    nickname: safeNickname,
    credits: numeric(state?.credits),
    cooling: state?.cooling === true,
    disabled: state?.disabled === true,
    inFlight: Math.max(0, Math.trunc(numeric(state?.in_flight) ?? 0)),
    lastSuccess: store.safeStatusText(account.uid, state?.last_success),
    lastError: store.safeStatusText(account.uid, state?.last_err),
    cooldownUntil: store.safeStatusText(account.uid, text(state?.until) ?? text(state?.breaker_until)),
  };
}
