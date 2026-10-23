import { performance } from "node:perf_hooks";
import { isDict, PyValueError, uuid4Hex } from "@xueness/contracts";
import { AnthropicMessages, OpenAICompatible, validateCompatibility } from "@xueness/providers";
import { defaultSelection, loadDefault } from "./default-selection.ts";
import { providerExecutionSnapshot } from "./model-execution.ts";
import { compatibilityTest, discoverModels, testConnection } from "./diagnostic-wire.ts";
import { configurationError, resolveSavedProvider, type ResolvedProvider, type Selection } from "./provider-config.ts";
import { ProfileStore, publicProfile, validId, type Dict, type Reply } from "./profile-store.ts";
import { hasProof, optionsHash, publicCheck, requiredModes, safeError, storedCheck, TEST_MODES } from "./verification.ts";

export interface ProvidersApiOptions {
  stateDir: string;
  allowReal?: boolean;
  enabled: (id: string) => boolean;
  resolveProvider?: (id: string) => ResolvedProvider;
  now?: () => string;
}
export const PROVIDER_ROUTES = ["GET /api/providers", "POST /api/providers", "DELETE /api/providers/:id", "GET /api/providers/default", "GET /api/providers/execution", "POST /api/providers/default", "POST /api/providers/test", "POST /api/providers/discover", "POST /api/providers/compatibility-test", "POST /api/providers/compatibility-adopt"];
export function ownsProviderRoute(method: string, parts: readonly string[]): boolean {
  return parts[0] === "api" && parts[1] === "providers" && (parts.length === 2 && ["GET", "POST"].includes(method) || parts.length === 3 && (method === "DELETE" || method === "POST" && ["default", "test", "discover", "compatibility-test", "compatibility-adopt"].includes(parts[2]!) || method === "GET" && ["default", "execution"].includes(parts[2]!)));
}
export function createProvidersApi(options: ProvidersApiOptions) {
  const store = new ProfileStore(options.stateDir);
  const now = options.now ?? (() => new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1000+00:00"));
  const allProfiles = (): Dict[] => store.listAll();
  const resolveProvider = (id: string) => options.resolveProvider?.(id) ?? resolveSavedProvider(store, { providerId: id });
  const summary = (profile: Dict): Dict => ({ id: profile.id, name: profile.name, model: profile.model, protocol: profile.protocol ?? "openai" });
  const networkCheck = async (action: string, data: unknown): Promise<Reply> => {
    if (options.allowReal !== true) return [403, { error: "real model requests are disabled by the server" }];
    if (action === "compatibility-test") return checkCompatibility(data);
    if (!isDict(data) || Object.keys(data).join(",") !== "id") return [400, { error: "expected provider id only" }];
    if (!validId(data.id)) return [400, { error: "invalid provider id" }];
    let profile: Dict; let provider: ResolvedProvider;
    try {
      const raw = action === "test" ? allProfiles().find((r) => r.id === data.id) : store.read(data.id);
      if (!raw) return [404, { error: "provider profile not found" }];
      if (action === "discover") {
        if (raw.protocol === "anthropic") return [400, { error: "model discovery is not supported for Anthropic providers" }];
        if ((raw.protocol ?? "openai") !== "openai") return [400, { error: "provider profile uses an unsupported protocol" }];
      }
      profile = raw; provider = resolveProvider(data.id);
    } catch (error) { return [400, { error: configurationError(error) }]; }
    // `getattr(provider, "test_connection")`: host adapters such as subscription providers have none.
    if (action === "test" && !(provider instanceof OpenAICompatible || provider instanceof AnthropicMessages)) return [400, { error: "provider protocol does not support connection tests" }];
    const started = performance.now();
    try {
      // Recheck after resolving the saved snapshot and before starting network work.
      if (!options.enabled("providers")) return [403, { error: "plugin disabled or dependency unavailable: providers", plugin: "providers", code: "plugin_disabled" }];
      if (action === "discover") {
        if (!(provider instanceof OpenAICompatible)) return [400, { error: "provider protocol does not support model discovery" }];
        return [200, { ok: true, provider: { ...summary(profile), protocol: "openai" }, models: await discoverModels(provider) }];
      }
      await testConnection(provider as OpenAICompatible | AnthropicMessages);
      return [200, { ok: true, provider: summary(profile), latencyMs: Math.max(0, Math.floor(performance.now() - started)) }];
    } catch { return [502, { error: action === "discover" ? "provider model discovery failed (details suppressed)" : "provider connection failed (details suppressed)" }]; }
  };
  const checkCompatibility = async (data: unknown): Promise<Reply> => {
    if (!isDict(data) || Object.keys(data).some((k) => !["id", "mode", "compatibility"].includes(k))) return [400, { error: "expected provider id, test mode and optional compatibility object" }];
    if (!Object.hasOwn(data, "id") || !Object.hasOwn(data, "mode")) return [400, { error: "provider id and test mode are required" }];
    if (!validId(data.id)) return [400, { error: "invalid provider id" }];
    if (typeof data.mode !== "string" || !TEST_MODES.has(data.mode)) return [400, { error: "unsupported provider compatibility test mode" }];
    const id = data.id, mode = data.mode;
    let compatibility: Dict | null = null;
    if (Object.hasOwn(data, "compatibility")) { try { compatibility = validateCompatibility(data.compatibility); } catch (error) { return [400, { error: (error as Error).message }]; } }
    let record: Dict; let provider: ResolvedProvider;
    try {
      const raw = store.read(id);
      if (!raw) return [404, { error: "provider profile not found" }];
      record = raw;
      if ((record.protocol ?? "openai") !== "openai") return [400, { error: "compatibility diagnostics require an OpenAI-compatible profile" }];
      if (typeof record._profileRevision !== "string" || !/^[0-9a-f]{32}$/.test(record._profileRevision)) { record._profileRevision = uuid4Hex(); store.write(id, record); }
      compatibility ??= validateCompatibility(record.compatibility ?? {});
      provider = resolveProvider(id);
    } catch (error) { return [400, { error: configurationError(error) }]; }
    if (mode.startsWith("json_") && provider.runtimeProfile !== "lightweight") return [400, { error: "JSON tool-call diagnostics require a lightweight profile" }];
    if (!(provider instanceof OpenAICompatible)) return [400, { error: "provider protocol does not support compatibility diagnostics" }];
    if (!options.enabled("providers")) return [403, { error: "plugin disabled or dependency unavailable: providers", plugin: "providers", code: "plugin_disabled" }];
    const hash = optionsHash(compatibility), revision = record._profileRevision, started = performance.now();
    const result = await compatibilityTest(provider, mode, compatibility);
    const d = result.details;
    const count = isDict(d) ? d.requestCount : null;
    if (typeof result.ok !== "boolean" || !isDict(d) || d.mode !== mode || typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > (mode.endsWith("roundtrip") ? 2 : 1)) return [502, { error: "invalid provider compatibility result" }];
    if (result.ok && !hasProof(mode, result)) return [502, { error: "provider compatibility result did not contain the required proof" }];
    const at = now(); const error = result.error !== undefined && result.error !== null ? safeError(result.error) : null;
    let updated: Dict;
    try {
      const current = store.read(id);
      if (!current || current._profileRevision !== revision) return [409, { error: "provider profile changed during diagnostics; rerun the check" }];
      const diagnostics = isDict(current._compatibilityDiagnostics) ? current._compatibilityDiagnostics : {};
      const prior = diagnostics[hash];
      const group: Dict = isDict(prior) && prior.profileRevision === revision && optionsHash(prior.compatibility) === hash ? prior : { profileRevision: revision, compatibility: { ...compatibility }, checks: {} };
      const checks = isDict(group.checks) ? group.checks : {};
      checks[mode] = storedCheck(mode, { ...result, ...(error ? { error } : {}) }, at);
      group.checks = checks; group.updatedAt = at; diagnostics[hash] = group;
      const oldest = Object.entries(diagnostics).sort((a, b) => String(isDict(a[1]) ? a[1].updatedAt ?? "" : "").localeCompare(String(isDict(b[1]) ? b[1].updatedAt ?? "" : "")));
      for (const [key] of oldest.slice(0, Math.max(0, oldest.length - 8))) delete diagnostics[key];
      current._compatibilityDiagnostics = diagnostics; store.write(id, current); updated = publicProfile(current);
    } catch { return [500, { error: "could not persist compatibility diagnostic metadata" }]; }
    const latencyMs = Math.max(0, Math.floor(performance.now() - started));
    const safe = publicCheck(mode, { ok: result.ok, error, requestCount: count, latencyMs, httpStatus: d.httpStatus, failedStep: d.failedStep, details: d }) ?? { mode, ok: result.ok, requestCount: count };
    return [200, { ...safe, provider: { ...summary(record), protocol: "openai" }, latencyMs, optionsHash: hash, testedAt: at, providerCompatibilityDiagnostics: updated.compatibilityDiagnostics ?? [] }];
  };
  const adopt = (data: unknown): Reply => {
    if (!isDict(data) || Object.keys(data).sort().join(",") !== "id,optionsHash") return [400, { error: "expected provider id and verified options hash" }];
    if (!validId(data.id) || typeof data.optionsHash !== "string" || !/^[0-9a-f]{64}$/.test(data.optionsHash)) return [400, { error: "invalid provider id or options hash" }];
    const record = store.read(data.id);
    if (!record) return [404, { error: "provider profile not found" }];
    if ((record.protocol ?? "openai") !== "openai") return [400, { error: "compatibility diagnostics require an OpenAI-compatible profile" }];
    const diagnostics = record._compatibilityDiagnostics;
    const group = isDict(diagnostics) ? diagnostics[data.optionsHash] : null;
    if (typeof record._profileRevision !== "string" || !isDict(group) || group.profileRevision !== record._profileRevision) return [409, { error: "verified diagnostics are stale or unavailable; rerun the checks" }];
    let candidate: Dict;
    try { candidate = validateCompatibility(group.compatibility); } catch { return [409, { error: "verified compatibility options are invalid; rerun the checks" }]; }
    if (optionsHash(candidate) !== data.optionsHash) return [409, { error: "verified compatibility options changed; rerun the checks" }];
    const checks = group.checks;
    const required = requiredModes(record);
    if (!isDict(checks) || required.some((mode) => !isDict(checks[mode]) || checks[mode].ok !== true)) return [409, { error: "all required compatibility checks must pass before adoption" }];
    const at = now(), revision = uuid4Hex();
    group.profileRevision = revision; group.updatedAt = at; record._profileRevision = revision; record.compatibility = candidate;
    record._compatibilityVerification = { profileRevision: revision, optionsHash: data.optionsHash, verifiedAt: at, checks: required.map((mode) => ({ ...checks[mode] as Dict, mode })) };
    try { store.write(data.id, record); return [200, { provider: publicProfile(record) }]; } catch { return [500, { error: "could not save verified compatibility options" }]; }
  };
  return {
    store, routes: PROVIDER_ROUTES, owns: ownsProviderRoute,
    resolve(selection: Selection = {}): ResolvedProvider {
      if (!options.enabled("providers")) throw new PyValueError("plugin disabled: providers");
      if (selection.providerId == null && selection.model == null && selection.reasoningEffort == null) {
        const saved = loadDefault(store);
        selection = { ...selection, providerId: saved.providerId as string | null, model: saved.model as string | null, reasoningEffort: saved.reasoningEffort as string | null };
      }
      return resolveSavedProvider(store, selection);
    },
    async dispatch(method: string, parts: string[], _query: Dict, data: unknown): Promise<Reply | null> {
      if (!ownsProviderRoute(method, parts)) return null;
      if (!options.enabled("providers")) return [403, { error: "plugin disabled or dependency unavailable: providers", plugin: "providers", code: "plugin_disabled" }];
      try {
        if (parts.length === 2) return method === "GET" ? [200, { providers: allProfiles() }] : store.save(data);
        const action = parts[2]!;
        if (method === "GET" && action === "execution") return [200, providerExecutionSnapshot(options.stateDir)];
        if (method === "DELETE") return store.delete(action);
        if (action === "default") return defaultSelection(method, data, store);
        if (action === "compatibility-adopt") return adopt(data);
        return await networkCheck(action, data);
      } catch (error) { if ((error as Error).name === "ValueError") return [400, { error: (error as Error).message }]; throw error; }
    },
  };
}
