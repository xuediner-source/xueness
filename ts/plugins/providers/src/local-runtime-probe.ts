/**
 * What a local inference server is actually running, read from its own
 * management endpoints: the context window the model is loaded with, the
 * model's maximum, and whether it is built for native tool calls.
 *
 * A profile's `contextWindow` is typed by hand, and a server that runs a
 * smaller window truncates the prompt without telling the client. The probe
 * compares the two and suggests values; it never changes a profile.
 *
 * Only loopback endpoints are probed. Requests are GET/POST of fixed
 * management paths with short deadlines and bounded bodies; nothing is
 * generated. Only numbers, booleans and fixed codes leave this module:
 * server-provided text is never returned or stored. Field names follow each
 * runtime's published API and every one is optional, so an older or newer
 * server yields fewer facts rather than an error.
 */
import { performance } from "node:perf_hooks";
import { isDict, pyJsonDumps, pyJsonLoadsBytes } from "@xueness/contracts";
import { isLoopbackLiteral, openChecked, pyUrlSplit, readBody, type OpenAICompatible } from "@xueness/providers";
import type { Dict } from "./profile-store.ts";

export type LocalRuntime = "ollama" | "llama.cpp" | "lmstudio";
interface Facts { runtime: LocalRuntime; loaded: boolean | null; contextWindow: number | null; maxContextWindow: number | null; nativeTools: boolean | null }

const MIN_PROFILE_CONTEXT = 2048, MAX_PROFILE_CONTEXT = 262144;
const tokens = (value: unknown): number | null => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 16_777_216 ? value : null;

async function fetchJson(provider: OpenAICompatible, url: string, body: Dict | null, timeout: number): Promise<unknown> {
  const headers: Record<string, string> = body ? { "Content-Type": "application/json" } : { Accept: "application/json" };
  if (provider.key) headers.Authorization = "Bearer " + provider.key;
  try {
    const response = await openChecked({ url: pyUrlSplit(url), method: body ? "POST" : "GET", headers,
      body: body ? Buffer.from(pyJsonDumps(body, { ensureAscii: true })) : null, timeoutMs: timeout * 1000, deadlineMs: performance.now() + timeout * 1000, proxy: null });
    try { return pyJsonLoadsBytes(await readBody(response, 2_000_000)); } finally { response.close(); }
  } catch { return null; }
}

/** Ollama: `/api/show` describes the model, `/api/ps` the loaded instance. */
async function ollama(provider: OpenAICompatible, root: string, timeout: number): Promise<Facts | null> {
  const shown = await fetchJson(provider, root + "/api/show", { model: provider.model }, timeout);
  if (!isDict(shown) || !(isDict(shown.model_info) || isDict(shown.details) || typeof shown.parameters === "string")) return null;
  const info = isDict(shown.model_info) ? shown.model_info : {};
  const maximum = Object.entries(info).map(([key, value]) => key.endsWith(".context_length") ? tokens(value) : null).find((value) => value !== null) ?? null;
  // `parameters` is Modelfile text; a `num_ctx` line is the window this model is created with.
  const declared = typeof shown.parameters === "string" ? /^\s*num_ctx\s+(\d{1,8})\s*$/m.exec(shown.parameters) : null;
  const running = await fetchJson(provider, root + "/api/ps", null, timeout);
  const instances = isDict(running) && Array.isArray(running.models) ? running.models.filter(isDict) : null;
  const instance = instances?.find((row) => row.model === provider.model || row.name === provider.model || row.name === provider.model + ":latest") ?? null;
  return { runtime: "ollama", loaded: instances ? instance !== null : null,
    contextWindow: tokens(instance?.context_length) ?? (declared ? tokens(Number(declared[1])) : null), maxContextWindow: maximum,
    nativeTools: Array.isArray(shown.capabilities) ? shown.capabilities.includes("tools") : null };
}

/** llama.cpp server: `/props` reports the per-slot window; `/v1/models` the trained maximum. */
async function llamaCpp(provider: OpenAICompatible, root: string, timeout: number): Promise<Facts | null> {
  const props = await fetchJson(provider, root + "/props", null, timeout);
  if (!isDict(props) || !isDict(props.default_generation_settings)) return null;
  const models = await fetchJson(provider, provider.base.replace(/\/+$/, "") + "/models", null, timeout);
  const first = isDict(models) && Array.isArray(models.data) && isDict(models.data[0]) && isDict(models.data[0].meta) ? models.data[0].meta : {};
  const caps = isDict(props.chat_template_caps) ? props.chat_template_caps : {};
  return { runtime: "llama.cpp", loaded: true, contextWindow: tokens(props.default_generation_settings.n_ctx), maxContextWindow: tokens(first.n_ctx_train),
    nativeTools: typeof caps.supports_tools === "boolean" ? caps.supports_tools : null };
}

/** LM Studio: the v1 model list carries loaded instances; the v0 list is the fallback for older builds. */
async function lmStudio(provider: OpenAICompatible, root: string, timeout: number): Promise<Facts | null> {
  for (const path of ["/api/v1/models", "/api/v0/models"]) {
    const listing = await fetchJson(provider, root + path, null, timeout);
    const entries = isDict(listing) ? (Array.isArray(listing.models) ? listing.models : Array.isArray(listing.data) ? listing.data : null) : null;
    if (!entries || !entries.some((row) => isDict(row) && (row.max_context_length !== undefined || row.loaded_instances !== undefined))) continue;
    const instancesOf = (row: Dict): Dict[] => Array.isArray(row.loaded_instances) ? row.loaded_instances.filter(isDict) : [];
    const model = entries.filter(isDict).find((row) => row.key === provider.model || row.id === provider.model || instancesOf(row).some((instance) => instance.id === provider.model));
    if (!model) return { runtime: "lmstudio", loaded: null, contextWindow: null, maxContextWindow: null, nativeTools: null };
    const instance = instancesOf(model).find((row) => row.id === provider.model) ?? instancesOf(model)[0];
    const capabilities = model.capabilities;
    return { runtime: "lmstudio", loaded: Array.isArray(model.loaded_instances) ? !!instance : typeof model.state === "string" ? model.state === "loaded" : null,
      contextWindow: tokens(isDict(instance?.config) ? instance.config.context_length : undefined) ?? tokens(model.loaded_context_length),
      maxContextWindow: tokens(model.max_context_length),
      nativeTools: isDict(capabilities) && typeof capabilities.trained_for_tool_use === "boolean" ? capabilities.trained_for_tool_use
        : Array.isArray(capabilities) ? capabilities.includes("tool_use") : null };
  }
  return null;
}

/** Compare the profile with what the runtime reports; codes are fixed and carry numbers only. */
export function runtimeFindings(facts: Facts, provider: Pick<OpenAICompatible, "contextWindow" | "toolCalling" | "runtimeProfile">): { findings: Dict[]; suggestion: Dict } {
  const findings: Dict[] = [], suggestion: Dict = {};
  const configured = provider.contextWindow, actual = facts.contextWindow, maximum = facts.maxContextWindow;
  if (facts.loaded === false) findings.push({ code: "model_not_loaded" });
  if (actual === null) {
    findings.push({ code: facts.runtime === "ollama" ? "ollama_default_context" : "runtime_context_unreported", ...(maximum !== null ? { maximum } : {}) });
  } else if (actual < MIN_PROFILE_CONTEXT) {
    findings.push({ code: "runtime_context_too_small", runtime: actual, minimum: MIN_PROFILE_CONTEXT });
  } else {
    const usable = Math.min(actual, MAX_PROFILE_CONTEXT);
    if (configured === null) { findings.push({ code: "context_not_configured", runtime: actual }); suggestion.contextWindow = usable; }
    else if (configured > actual) { findings.push({ code: "context_exceeds_runtime", configured, runtime: actual }); suggestion.contextWindow = usable; }
    else if (configured < usable) { findings.push({ code: "context_below_runtime", configured, runtime: actual }); suggestion.contextWindow = usable; }
    else findings.push({ code: "context_matches_runtime", runtime: actual });
  }
  if (actual === null && configured !== null && maximum !== null && configured > maximum) {
    findings.push({ code: "context_exceeds_model", configured, maximum });
    if (maximum >= MIN_PROFILE_CONTEXT) suggestion.contextWindow = Math.min(maximum, MAX_PROFILE_CONTEXT);
  }
  if (facts.nativeTools === false && provider.toolCalling === "native") {
    findings.push({ code: "native_tools_unsupported" });
    // The JSON tool protocol exists only in the lightweight profile.
    if (provider.runtimeProfile === "lightweight") suggestion.toolCalling = "json";
  } else if (facts.nativeTools === true && provider.toolCalling === "json") {
    findings.push({ code: "native_tools_available" });
  }
  return { findings, suggestion };
}

export async function probeLocalRuntime(provider: OpenAICompatible, timeout = 3): Promise<Dict> {
  const configured = { contextWindow: provider.contextWindow, toolCalling: provider.toolCalling };
  let host: string;
  try { host = pyUrlSplit(provider.base).hostname ?? ""; } catch { host = ""; }
  if (!isLoopbackLiteral(host)) return { local: false, runtime: null, configured, findings: [], suggestion: {} };
  const root = provider.base.replace(/\/+$/, "").replace(/\/v1$/, "");
  const facts = await ollama(provider, root, timeout) ?? await llamaCpp(provider, root, timeout) ?? await lmStudio(provider, root, timeout);
  if (!facts) return { local: true, runtime: null, configured, findings: [{ code: "runtime_not_recognised" }], suggestion: {} };
  return { local: true, ...facts, configured, ...runtimeFindings(facts, provider) };
}
