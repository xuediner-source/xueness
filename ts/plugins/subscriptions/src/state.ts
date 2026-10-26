/** Private, local account state (Python `subscriptions/state.py`). Reading it never contacts a provider. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDict, pyJsonLoadsBytes, pySlice, pyStr, pyTruthy, PyValueError } from "@xueness/contracts";
import { atomicWriteJson, isLink, protectPrivateDirectory } from "@xueness/sessions";

type Row = Record<string, unknown>;
export const ASSETS = resolve(import.meta.dirname, "..", "assets");
export const PACKAGE_ID = "xueness-subscriptions";
export const PREFIX = "subscription.";
const MAX_BYTES = 2_000_000;
const DOCUMENTS = new Set(["auth.json", "connections.json", "public-models.json", "quota.json", "entitlements.json"]);
const MEDIA = ["image", "pdf", "video"];
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const KINDS = ["session", "weekly", "daily", "monthly", "lifetime", "other"];

export function directory(stateDir: string, create = false): string {
  const root = resolve(stateDir), target = join(root, "subscriptions");
  for (const path of [root, target]) if (isLink(path)) throw new PyValueError("subscription store must not be a link");
  if (create) { mkdirSync(target, { recursive: true, mode: 0o700 }); protectPrivateDirectory(target); }
  return target;
}

export function readDocument(stateDir: string, name: string): Row {
  if (!DOCUMENTS.has(name)) throw new PyValueError("unknown subscription document");
  const path = join(directory(stateDir), name);
  if (isLink(path)) throw new PyValueError("subscription document must not be a link");
  let fd: number, original: ReturnType<typeof lstatSync>;
  try {
    original = lstatSync(path);
    if (!original.isFile()) throw new PyValueError("subscription document must be a regular file");
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  let raw: Buffer;
  try {
    const current = fstatSync(fd);
    if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino) throw new PyValueError("subscription document changed during read");
    const buffer = Buffer.alloc(MAX_BYTES + 1); let size = 0, count: number;
    while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += count;
    raw = buffer.subarray(0, size);
  } finally { closeSync(fd); }
  if (raw.length > MAX_BYTES) throw new PyValueError("subscription document too large");
  const value = pyJsonLoadsBytes(raw);
  if (!isDict(value)) throw new PyValueError("invalid subscription document");
  return value;
}

export function writeDocument(stateDir: string, name: string, value: Row): void {
  if (!DOCUMENTS.has(name)) throw new PyValueError("unknown subscription document");
  const path = join(directory(stateDir, true), name);
  if (isLink(path)) throw new PyValueError("subscription document must not be a link");
  atomicWriteJson(path, value);
}

let cachedDefinitions: Row[] | null = null;
export function definitions(): Row[] {
  cachedDefinitions ??= (JSON.parse(readFileSync(join(ASSETS, "catalog.json"), "utf8")) as { providers: Row[] }).providers;
  return cachedDefinitions.map((item) => ({ ...item }));
}
export const definition = (pid: unknown): Row | null => definitions().find((item) => item.id === pid) ?? null;

/** Model discovery ordering cannot change a session's selected model. */
export function modelId(accountId: string, model: string): string {
  return PREFIX + accountId + "." + createHash("sha256").update(model, "utf8").digest("hex").slice(0, 16);
}

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
/** Python iterates a list, a dict's keys or a string's characters. */
const members = (value: unknown): unknown[] => Array.isArray(value) ? value : isDict(value) ? Object.keys(value) : typeof value === "string" ? [...value] : [];

export function publicQuota(value: unknown): Row | null {
  if (!isDict(value)) return null;
  const windows: Row[] = [];
  const result: Row = { supported: value.supported === true, windows, checkedAt: finite(value.checkedAt) ? value.checkedAt : 0 };
  if (typeof value.plan === "string") result.plan = pySlice(value.plan, 120);
  for (const window of Array.isArray(value.windows) ? value.windows.slice(0, 40) : []) {
    if (!isDict(window)) continue;
    const clean: Row = { kind: KINDS.includes(window.kind as string) ? window.kind : "other" };
    for (const key of ["usedPercent", "usedUsd", "remaining", "limit", "resetsAt", "windowDurationMins"]) if (finite(window[key])) clean[key] = window[key];
    for (const key of ["scope", "unit"]) if (typeof window[key] === "string") clean[key] = pySlice(window[key] as string, 120);
    if (Object.keys(clean).length > 1) windows.push(clean);
  }
  result.supported = result.supported === true && windows.length > 0;
  return result;
}

function publicModels(pid: string, record: Row, item: Row, catalog: unknown): Row[] {
  let models: unknown = isDict(catalog) ? catalog.models ?? [] : [];
  if (!Array.isArray(models)) models = [];
  if (!(models as unknown[]).length) models = members(Object.hasOwn(record, "models") ? record.models : item.models ?? []).map((mid) => ({ id: mid, name: mid, source: record.modelSource === "manual" ? "manual" : "preset" }));
  const clean: Row[] = [], seen = new Set<string>();
  for (const model of (models as unknown[]).slice(0, 200)) {
    if (!isDict(model) || typeof model.id !== "string") continue;
    const mid = model.id;
    if (!mid || [...mid].length > 256 || seen.has(mid) || [...mid].some((ch) => ch.codePointAt(0)! < 32)) continue;
    seen.add(mid);
    const window = model.contextWindow;
    clean.push({ id: mid, name: pySlice(pyStr(pyTruthy(model.name) ? model.name : mid), 160), providerId: modelId(pid, mid),
      source: ["preset", "manual", "upstream"].includes(model.source as string) ? model.source : "preset",
      capabilities: members(model.capabilities ?? []).filter((cap) => MEDIA.includes(cap as string)),
      reasoningLevels: members(model.reasoningLevels ?? []).filter((effort) => EFFORTS.includes(effort as string)),
      ...(typeof window === "number" && Number.isInteger(window) && window >= 2048 && window <= 2_000_000 ? { contextWindow: window } : {}) });
  }
  return clean;
}

export function publicAccounts(stateDir: string, now = Date.now()): Row[] {
  const auth = readDocument(stateDir, "auth.json"), connections = readDocument(stateDir, "connections.json");
  const catalogs = readDocument(stateDir, "public-models.json"), quotas = readDocument(stateDir, "quota.json");
  return definitions().map((item) => {
    const pid = String(item.id);
    const stored = item.mode === "oauth" ? auth[pid] : connections[pid];
    const record: Row = isDict(stored) ? stored : {};
    const expiry = record.expiresAt;
    const expired = (typeof expiry === "number" || typeof expiry === "boolean") && Number(expiry) <= now;
    const saved = pid === "commandcode" ? pyTruthy(record.apiKey) && record.credentialSource === "cli-login"
      : pid === "qoder" ? pyTruthy(record.accessToken) && pyTruthy(record.userId) : pyTruthy(record.accessToken);
    const connected = saved && (!expired || pyTruthy(record.refreshToken));
    const account = [record.emailAddress, record.email, record.account, record.name].find(pyTruthy) ?? "";
    return { ...item, connected, credentialsSaved: saved, expired, account: pySlice(pyStr(account), 160), expiresAt: expiry ?? null,
      models: publicModels(pid, record, item, Object.hasOwn(catalogs, pid) ? catalogs[pid] : {}), quota: publicQuota(quotas[pid]),
      baseUrl: Object.hasOwn(record, "baseUrl") ? record.baseUrl : item.baseUrl ?? "", hasUserId: pyTruthy(record.userId) };
  });
}

export function providerRecords(stateDir: string, available: boolean): Row[] {
  if (!available) return [];
  const records: Row[] = [];
  for (const account of publicAccounts(stateDir)) {
    if (!account.connected) continue;
    for (const model of account.models as Row[]) {
      const mid = String(model.id);
      records.push({ id: modelId(String(account.id), mid), name: String(account.name) + " · " + String(model.name ?? mid), model: mid,
        baseUrl: pyTruthy(account.baseUrl) ? account.baseUrl : "https://subscriptions.xueness.invalid", source: "subscription", subscriptionId: account.id, hasKey: true,
        protocol: account.protocol ?? "openai", capabilities: model.capabilities ?? [], reasoningLevels: model.reasoningLevels ?? [], runtimeProfile: "standard",
        ...(pyTruthy(model.contextWindow) ? { contextWindow: model.contextWindow } : {}) });
    }
  }
  return records;
}
