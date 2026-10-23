/** Jailed credential records. HTTP callers receive only publicProfile(). */
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isDict, pyDecodeUtf8, pyJsonDumps, pyJsonLoads, pyStrip, PyValueError, uuid4Hex } from "@xueness/contracts";
import { knownReasoningLevels, publicRuntimeOptions, pyUrlSplit, resolveRuntimeOptions, validateCompatibility, validateOptions, type ChatProvider } from "@xueness/providers";
import { isLink, mkstemp, protectPrivateFile, pyCodeCompare, readRegularBytes, realish, replaceFile, writeAll } from "@xueness/sessions";
import { publicDiagnostics } from "./verification.ts";

export type Dict = Record<string, unknown>;
export type Reply = [number, Dict];
export const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
export function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(value) && value !== "." && value !== "..";
}
export function reasoningLevels(model: unknown, base: unknown, configured?: unknown): string[] {
  if (configured !== undefined && configured !== null) return Array.isArray(configured) ? configured.filter((v) => typeof v === "string" && REASONING_LEVELS.includes(v)) : [];
  if (typeof model === "string" && model.trim().toLowerCase() === "deepseek-v4.1-flash" && typeof base === "string") {
    try {
      const u = pyUrlSplit(base.trim());
      if (u.scheme === "https" && u.hostname === "ark.cn-beijing.volces.com" && [null, "443"].includes(u.port) && !u.username && !u.password && ["/api/coding/v3", "/api/coding/v3/"].includes(u.path) && !u.query && !u.fragment) return ["low", "medium", "high"];
    } catch { /* Infer only from a valid trusted endpoint. */ }
  }
  return knownReasoningLevels(model);
}
export function publicBaseUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const u = pyUrlSplit(value);
    if (!u.username && !u.password && !u.query && !u.fragment) return value;
    if (!u.hostname) return "";
    return `${u.scheme}://${u.hostname.includes(":") ? `[${u.hostname}]` : u.hostname}${u.port === null ? "" : ":" + u.port}${u.path}`;
  } catch { return ""; }
}
export function publicProfile(record: Dict): Dict {
  const result: Dict = { id: record.id ?? "", name: record.name ?? "", baseUrl: publicBaseUrl(record.baseUrl), model: record.model ?? "", hasKey: !!record.apiKey };
  if (record.allowLoopbackHttp === true) result.allowLoopbackHttp = true;
  if (record.protocol === "anthropic") result.protocol = "anthropic";
  if (Array.isArray(record.capabilities) && record.capabilities.length) result.capabilities = [...record.capabilities];
  let levels: unknown = record.reasoningLevels;
  const declared = Object.hasOwn(record, "reasoningLevels");
  if (declared && (!Array.isArray(levels) || levels.some((v) => !REASONING_LEVELS.includes(v)) || new Set(levels).size !== levels.length)) levels = null;
  else if (!declared && (record.protocol ?? "openai") === "openai") levels = reasoningLevels(record.model, record.baseUrl);
  if (Array.isArray(levels) && (declared || levels.length)) result.reasoningLevels = [...levels];
  return Object.assign(result, publicRuntimeOptions(record), publicDiagnostics(record));
}
/** Saved-profile view another provider plugin owns (Python `profile_record` falls back to subscriptions). */
export interface ExternalProfiles {
  list(): Dict[];
  record(id: string): Dict | null;
  resolve(record: Dict, selection: { model?: string | null; reasoningEffort?: string | null; runtimeProfile?: string | null }): ChatProvider;
  supplier(record: Dict): Dict | null;
}
export class ProfileStore {
  readonly stateDir: string;
  /** The front door attaches the subscriptions view; plugins never import each other. */
  external: ExternalProfiles | null = null;
  constructor(stateDir: string) { this.stateDir = realish(stateDir); }
  /** `providers_api.profile_record`: a saved profile, else an external one; failures read as absent. */
  record(id: unknown): Dict | null {
    if (typeof id !== "string" || !validId(id)) return null;
    try { return this.read(id) ?? this.external?.record(id) ?? null; } catch { return null; }
  }
  /** `_list`: saved profiles, then external ones not shadowed by a saved id. */
  listAll(): Dict[] {
    const records = this.list(), existing = new Set(records.map((r) => r.id));
    return [...records, ...(this.external?.list() ?? []).filter((r) => !existing.has(r.id))].sort((a, b) => Number(a.source === "subscription") - Number(b.source === "subscription") || pyCodeCompare(String(a.id), String(b.id)));
  }
  get directory(): string {
    const dir = join(this.stateDir, "providers");
    if (isLink(dir)) throw new PyValueError("providers directory must not be a symlink, junction, or reparse point");
    return dir;
  }
  pathFor(id: string): string | null {
    const path = join(this.directory, `${id}.json`);
    return validId(id) && !isLink(path) ? path : null;
  }
  read(id: string): Dict | null {
    const path = this.pathFor(id);
    if (!path) return null;
    try {
      const record = pyJsonLoads(pyDecodeUtf8(readRegularBytes(path)));
      if (!isDict(record) || (Object.hasOwn(record, "allowLoopbackHttp") && typeof record.allowLoopbackHttp !== "boolean")) return null;
      resolveRuntimeOptions(record, String(record.protocol ?? "openai"));
      return record;
    } catch { return null; }
  }
  list(): Dict[] {
    const dir = this.directory;
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((n) => n.endsWith(".json")).sort().map((n) => this.read(n.slice(0, -5))).filter((v): v is Dict => v !== null && validId(v.id)).map(publicProfile);
  }
  write(id: string, record: Dict): void {
    const path = this.pathFor(id);
    if (!path) throw new PyValueError("invalid id");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try { chmodSync(this.directory, 0o700); } catch { /* Windows uses the host ACL. */ }
    const temporary = mkstemp(this.directory, ".provider-");
    let fd: number | null = temporary.fd;
    try {
      protectPrivateFile(fd);
      writeAll(fd, Buffer.from(pyJsonDumps(record, { indent: 2, sortKeys: true }), "utf8"));
      fsyncSync(fd); closeSync(fd); fd = null;
      replaceFile(temporary.path, path);
    } finally {
      if (fd !== null) closeSync(fd);
      if (existsSync(temporary.path)) unlinkSync(temporary.path);
    }
  }
  save(data: unknown): Reply {
    if (!isDict(data)) return [400, { error: "body must be a JSON object" }];
    const id = data.id;
    if (!validId(id)) return [400, { error: "id must match ^[A-Za-z0-9._-]{1,64}$" }];
    const values: Dict = {};
    for (const field of ["name", "baseUrl", "model"]) {
      const raw = data[field];
      if (typeof raw !== "string" || !pyStrip(raw)) return [400, { error: `${field} is required` }];
      values[field] = pyStrip(raw);
    }
    const existing = this.read(id);
    const merged = (field: string, fallback: unknown = undefined) => Object.hasOwn(data, field) ? data[field] : existing?.[field] ?? fallback;
    const allow = merged("allowLoopbackHttp", false);
    if (typeof allow !== "boolean") return [400, { error: "allowLoopbackHttp must be a boolean" }];
    const protocol = merged("protocol", "openai");
    if (protocol !== "openai" && protocol !== "anthropic") return [400, { error: "protocol must be openai or anthropic" }];
    const runtime: Dict = { protocol };
    for (const field of ["runtimeProfile", "contextWindow", "maxOutputTokens", "toolCalling", "compatibility", "lightweightOptions"]) {
      if (Object.hasOwn(data, field)) runtime[field] = data[field];
      else if (existing && Object.hasOwn(existing, field)) runtime[field] = existing[field];
    }
    try {
      if (Object.hasOwn(data, "compatibility")) {
        const submitted = validateCompatibility(data.compatibility);
        runtime.compatibility = Object.keys(submitted).length && isDict(existing?.compatibility) ? { ...validateCompatibility(existing.compatibility), ...submitted } : submitted;
      }
      if (Object.hasOwn(data, "lightweightOptions")) runtime.lightweightOptions = validateOptions(data.lightweightOptions, protocol);
      resolveRuntimeOptions(runtime, protocol);
    } catch (error) { return [400, { error: (error as Error).message }]; }
    const capabilities = merged("capabilities", null);
    if (capabilities !== null && (!Array.isArray(capabilities) || capabilities.length > 3 || capabilities.some((v) => !["image", "pdf", "video"].includes(v)) || new Set(capabilities).size !== capabilities.length)) return [400, { error: "capabilities must be unique image/pdf/video values" }];
    let levels = merged("reasoningLevels", null);
    if (protocol === "anthropic") {
      if (Object.hasOwn(data, "reasoningLevels") && data.reasoningLevels !== null) return [400, { error: "reasoningLevels are supported only for OpenAI-compatible providers" }];
      levels = null;
    }
    if (levels !== null && (!Array.isArray(levels) || levels.length > REASONING_LEVELS.length || levels.some((v) => !REASONING_LEVELS.includes(v)) || new Set(levels).size !== levels.length)) return [400, { error: "reasoningLevels must contain unique supported reasoning values" }];
    try {
      const u = pyUrlSplit(String(values.baseUrl));
      if (!["http", "https"].includes(u.scheme) || !u.hostname || !u.netloc || u.username !== null || u.password !== null || u.query || u.fragment) throw new Error();
    } catch { return [400, { error: "baseUrl must start with http:// or https://" }]; }
    if (!this.pathFor(id)) return [400, { error: "invalid id" }];
    let key = Object.hasOwn(data, "apiKey") ? data.apiKey : existing?.apiKey ?? "";
    if (Object.hasOwn(data, "apiKey") && typeof key !== "string") return [400, { error: "apiKey must be a string" }];
    if (typeof key !== "string") key = "";
    const record: Dict = { id, ...values };
    for (const [field, value] of Object.entries(runtime)) if (field !== "protocol") record[field] = value;
    if (protocol === "anthropic") record.protocol = protocol;
    if (allow) record.allowLoopbackHttp = true;
    if (Array.isArray(capabilities) && capabilities.length) record.capabilities = [...capabilities].sort();
    if (levels !== null) record.reasoningLevels = [...levels as string[]];
    if (key) record.apiKey = key;
    record._profileRevision = uuid4Hex();
    try { this.write(id, record); } catch (error) { return [400, { error: `could not persist provider: ${(error as NodeJS.ErrnoException).code ?? (error as Error).name}` }]; }
    return [200, { provider: publicProfile(record) }];
  }
  delete(id: string): Reply {
    if (!validId(id)) return [400, { error: "id must match ^[A-Za-z0-9._-]{1,64}$" }];
    const path = this.pathFor(id);
    if (!path) return [400, { error: "invalid id" }];
    try { unlinkSync(path); } catch { return [404, { error: "provider not found" }]; }
    return [200, { ok: true, id }];
  }
}
