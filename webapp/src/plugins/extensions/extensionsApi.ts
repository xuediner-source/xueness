import { get, post } from "../../xuenessBridge";

export type MarketplaceItem = {
  id: string; name: string; description: string; version: string; sha256: string;
  installedVersion: string | null; manifest: Record<string, unknown>; source: string;
  delivery?: "official"; downloadBytes?: number;
};

/** One selectable composition profile: allowlisted plugin ids, booleans only. */
export type PluginProfileRow = {
  name: string;
  source: string;
  extends: string[];
  description: string;
  descriptionEn: string;
  enabled: string[];
  disabled: string[];
  active: boolean;
};

export type PluginProfileCatalog = { active: string | null; profiles: PluginProfileRow[] };

/** What applying a profile switches, and what the host kept ahead of it. */
export type PluginProfileApplyResult = {
  ok: boolean;
  dryRun: boolean;
  profile: string;
  changes: { id: string; enabled: boolean; wasEnabled: boolean; effective: boolean; wasEffective: boolean }[];
  blocked: { id: string; blockedBy: string[] }[];
  warnings: { code: string; id?: string; message: string }[];
};

export async function listMarketplace(signal?: AbortSignal): Promise<{ marketplace: MarketplaceItem[] }> {
  const payload = await get<{ marketplace: MarketplaceItem[] }>("/api/plugins/marketplace", signal);
  if (!Array.isArray(payload.marketplace)) throw new Error("Invalid marketplace response");
  return { marketplace: payload.marketplace };
}

export async function installMarketplaceItem(id: string, sha256: string, update = false): Promise<{ marketplace: MarketplaceItem[] }> {
  const payload = await post<{ marketplace: MarketplaceItem[] }>(`/api/plugins/marketplace/${encodeURIComponent(id)}/${update ? "update" : "install"}`, { sha256 });
  if (!Array.isArray(payload.marketplace)) throw new Error("Invalid marketplace response");
  return { marketplace: payload.marketplace };
}

function profileNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** GET /api/plugins/profiles — the selectable pure-data plugin tiers. */
export async function listPluginProfiles(): Promise<PluginProfileCatalog> {
  const payload = await get<{ active?: unknown; profiles?: unknown }>("/api/plugins/profiles");
  if (!Array.isArray(payload.profiles)) throw new Error("Invalid plugin profile response");
  const profiles = payload.profiles.map((item): PluginProfileRow => {
    const row = item as Record<string, unknown>;
    if (!row || typeof row.name !== "string" || !row.name) throw new Error("Invalid plugin profile response");
    return {
      name: row.name,
      source: typeof row.source === "string" ? row.source : "built-in",
      extends: profileNames(row.extends),
      description: typeof row.description === "string" ? row.description : "",
      descriptionEn: typeof row.descriptionEn === "string" ? row.descriptionEn : "",
      enabled: profileNames(row.enabled),
      disabled: profileNames(row.disabled),
      active: row.active === true,
    };
  });
  return { active: typeof payload.active === "string" ? payload.active : null, profiles };
}

/** POST /api/plugins/profiles/apply — choose a tier; explicit user switches stay ahead of it. */
export async function applyPluginProfile(name: string, dryRun = false): Promise<PluginProfileApplyResult> {
  const payload = await post<Record<string, unknown>>("/api/plugins/profiles/apply", { name, dryRun });
  if (payload.ok !== true || !Array.isArray(payload.changes) || !Array.isArray(payload.blocked) || !Array.isArray(payload.warnings)) {
    throw new Error("Invalid plugin profile response");
  }
  return {
    ok: true,
    dryRun: payload.dryRun === true,
    profile: typeof payload.profile === "string" ? payload.profile : name,
    changes: payload.changes as PluginProfileApplyResult["changes"],
    blocked: payload.blocked as PluginProfileApplyResult["blocked"],
    warnings: payload.warnings as PluginProfileApplyResult["warnings"],
  };
}
