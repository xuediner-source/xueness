/**
 * The composer's model picker (Python `composer_api._provider_catalog` and
 * `providers_api.model_supplier_metadata`): saved profiles that resolve now
 * are `configured`; the environment model is the `""` choice. Subscription
 * accounts come from the attached external view, listed after saved profiles.
 */
import { createHash } from "node:crypto";
import { isDict, pySlice, pyStrip } from "@xueness/contracts";
import { pyUrlSplit } from "@xueness/providers";
import { REASONING_LEVELS, reasoningLevels, type Dict, type ProfileStore } from "./profile-store.ts";
import { resolveSavedProvider } from "./provider-config.ts";

const MEDIA_CAPABILITIES = ["image", "pdf", "video"];
const RUNTIME_FIELDS = ["runtimeProfile", "contextWindow", "maxOutputTokens", "toolCalling", "compatibility"];
/** Subscription catalogue endpoints keep their account names when saved as plain profiles. */
const KNOWN_HOSTS: Record<string, string> = { "qwen-api.alicdn.com": "Qwen Code", "api-agnes-code.agnes-ai.com": "Agnes AI" };

/** `_safe_label`: printable, stripped and bounded, else the fallback. */
export function safeLabel(value: unknown, fallback: string, limit = 160): string {
  const text = [...pyStrip(typeof value === "string" ? value : fallback)].filter((ch) => ch.codePointAt(0)! >= 32 && ch.codePointAt(0) !== 127).join("");
  return pySlice(text, limit) || pySlice(fallback, limit);
}

function safeLevels(value: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (typeof item === "string" && REASONING_LEVELS.includes(item) && !out.includes(item)) out.push(item);
    if (out.length >= 8) break;
  }
  return out;
}

/** `urlsplit(...).port`: ASCII digits within 0..65535, else a `ValueError`. */
function urlPort(port: string | null): number | null {
  if (port === null) return null;
  if (!/^[0-9]+$/.test(port) || Number(port) > 65535) throw new Error("Port could not be cast to integer value");
  return Number(port);
}

/** `model_supplier_metadata` for saved profiles: descriptive grouping only. */
export function supplierMetadata(record: Dict): Dict {
  let authority = "", host = "";
  try {
    const url = pyUrlSplit(typeof record.baseUrl === "string" ? record.baseUrl : "");
    host = url.hostname ?? "";
    const port = urlPort(url.port);
    authority = host.toLowerCase() + (port ? ":" + port : "");
  } catch { authority = ""; host = ""; }
  if (!authority) return { supplierId: "environment", supplierName: "环境模型", supplierNameEn: "Environment models" };
  let name = authority, nameEn = authority;
  if (["localhost", "127.0.0.1", "::1"].includes(host.toLowerCase())) { name = "本机模型 · " + authority; nameEn = "Local models · " + authority; }
  else if (Object.hasOwn(KNOWN_HOSTS, host)) name = nameEn = KNOWN_HOSTS[host]!;
  return { supplierId: "endpoint:" + createHash("sha256").update(authority, "utf8").digest("hex").slice(0, 16), supplierName: pySlice(name, 160), supplierNameEn: pySlice(nameEn, 160) };
}

const mediaOf = (values: Iterable<unknown>): string[] => [...new Set([...values].filter((cap): cap is string => typeof cap === "string" && MEDIA_CAPABILITIES.includes(cap)))].sort();

export interface ComposerModels { options: Dict[]; choices: Map<string, Dict> }

/** `_provider_catalog`: public options plus the private choice table `prepare` checks. */
export function composerModels(store: ProfileStore, env: NodeJS.ProcessEnv = process.env): ComposerModels {
  let rows: Dict[] = [];
  try { rows = store.listAll(); } catch { rows = []; }
  const options: Dict[] = [], choices = new Map<string, Dict>(), seen = new Set<string>();
  for (const item of rows.slice(0, 500)) {
    const pid = isDict(item) ? item.id : null;
    if (typeof pid !== "string" || !pid || seen.has(pid)) continue;
    seen.add(pid);
    let record: Dict | null;
    record = store.record(pid);
    if (!isDict(record)) continue;
    const protocol = Object.hasOwn(record, "protocol") ? record.protocol : "openai";
    if (protocol !== "openai" && protocol !== "anthropic") continue;
    const model = record.model;
    if (typeof model !== "string" || !pyStrip(model)) continue;
    let configured: boolean, capabilities: string[];
    try { capabilities = mediaOf(resolveSavedProvider(store, { providerId: pid, model }).capabilities); configured = true; }
    catch { configured = false; capabilities = Array.isArray(record.capabilities) ? mediaOf(record.capabilities) : []; }
    const option: Dict = { id: pid, name: safeLabel(record.name, pid), model: safeLabel(model, "", 200), configured, protocol, capabilities, reasoningLevels: safeLevels(item.reasoningLevels) };
    for (const key of RUNTIME_FIELDS) if (Object.hasOwn(item, key)) option[key] = item[key];
    Object.assign(option, (record.source === "subscription" ? store.external?.supplier(record) : null) ?? supplierMetadata(record));
    options.push(option); choices.set(pid, option);
  }
  let provider: { model: unknown; base: unknown; capabilities: Iterable<unknown> } | null;
  try { provider = resolveSavedProvider(store, { providerId: "" }) as typeof provider; } catch { provider = null; }
  if (provider && typeof provider.model === "string" && pyStrip(provider.model)) {
    const protocol = pyStrip(env.XUENESS_PROVIDER ?? "").toLowerCase() === "anthropic" ? "anthropic" : "openai";
    const option: Dict = { id: "", name: safeLabel(provider.model, "Environment model", 160), model: safeLabel(provider.model, "", 200), configured: true, protocol,
      capabilities: mediaOf(provider.capabilities), reasoningLevels: protocol === "openai" ? [...reasoningLevels(provider.model, typeof provider.base === "string" ? provider.base : null)] : [] };
    options.push(option); choices.set("", option);
  }
  return { options, choices };
}
