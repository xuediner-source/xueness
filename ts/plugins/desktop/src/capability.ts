/** Process-local host tickets. Consuming one does not authorize any other route. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDict, pyJsonLoads } from "@xueness/contracts";
import { isLink } from "@xueness/sessions";

export const FEATURE_ID = "desktop.host_capability";
const SCHEMA = "xueness.host-capability.v1";
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const TTL = 30_000;

export function hostCapabilityEnabled(stateDir: string): boolean {
  const path = join(stateDir, "settings.json");
  try {
    if (isLink(path)) return false;
    const value = pyJsonLoads(readFileSync(path, "utf8"));
    return isDict(value) && isDict(value.general) && value.general.desktopHostCapabilityEnabled === true;
  } catch { return false; }
}

export function platformFamily(raw = process.platform): string {
  const text = raw.trim().toLowerCase();
  if (!text) return "unknown";
  if (text === "darwin" || text.startsWith("mac")) return "macos";
  if (text.startsWith("win")) return "windows";
  if (text.startsWith("linux")) return "linux";
  return text;
}

class TicketStore {
  readonly serverId = randomBytes(16).toString("hex");
  private readonly items = new Map<string, number>();
  issue(now: number): { capability: string; expiresAt: number } | null {
    for (const [token, expires] of this.items) if (expires <= now) this.items.delete(token);
    if (this.items.size >= 128) return null;
    const capability = randomBytes(32).toString("base64url");
    const expiresAt = now + TTL;
    this.items.set(capability, expiresAt);
    return { capability, expiresAt };
  }
  consume(token: string, now: number): boolean {
    const expires = this.items.get(token);
    this.items.delete(token);
    return expires !== undefined && expires > now;
  }
}

const stores = new Map<string, TicketStore>();
function storeFor(stateDir: string): TicketStore {
  const existing = stores.get(stateDir);
  if (existing) return existing;
  const created = new TicketStore();
  stores.set(stateDir, created);
  return created;
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function capabilityDispatch(method: string, parts: readonly string[], data: unknown, options: { stateDir: string; desktop: boolean; version: string; pickDirectory?: unknown; header?: () => string | null; now?: () => number }): [number, unknown] | null {
  const probe = parts.length === 3 && parts[2] === "host-capability";
  const consume = parts.length === 4 && parts[2] === "host-capability" && parts[3] === "consume";
  if (!probe && !consume) return null;
  const notEnabled = (): [number, unknown] => [400, { error: `${FEATURE_ID} not enabled`, feature: FEATURE_ID }];
  if (!hostCapabilityEnabled(options.stateDir)) return notEnabled();
  const now = options.now?.() ?? Date.now();
  if (probe && method === "GET") {
    const family = platformFamily();
    return [200, {
      schema: SCHEMA, feature: FEATURE_ID, serverId: storeFor(options.stateDir).serverId, version: options.version,
      platform: { raw: process.platform, family },
      capabilities: { desktopHost: options.desktop, nativeDirectoryPicker: typeof options.pickDirectory === "function", hostCapabilityTicket: true, caseInsensitivePaths: process.platform === "win32" || process.platform === "darwin", grantsAccess: false },
    }];
  }
  if (probe && method === "POST") {
    if (!isDict(data) || Object.keys(data).length !== 0) return [400, { error: "expected empty body", feature: FEATURE_ID }];
    const issued = storeFor(options.stateDir).issue(now);
    if (!issued) return [429, { error: "host capability store full", feature: FEATURE_ID }];
    return [200, { schema: SCHEMA, feature: FEATURE_ID, capability: issued.capability, expiresAt: issued.expiresAt, grantsAccess: false }];
  }
  if (consume && method === "POST") {
    const header = options.header?.() ?? null;
    if (!isDict(data)) return [400, { error: "expected capability", feature: FEATURE_ID }];
    const body = Object.hasOwn(data, "capability") ? data.capability : null;
    if (header === null && (body === null || Object.keys(data).length === 0)) return [400, { error: "expected capability", feature: FEATURE_ID }];
    if (Object.keys(data).length && (Object.keys(data).length !== 1 || !Object.hasOwn(data, "capability"))) return [400, { error: "expected capability only", feature: FEATURE_ID }];
    if ((header !== null && (typeof header !== "string" || !TOKEN.test(header))) || (body !== null && (typeof body !== "string" || !TOKEN.test(body)))) return [400, { error: "invalid host capability", feature: FEATURE_ID }];
    if (typeof header === "string" && typeof body === "string" && !same(header, body)) return [400, { error: "host capability mismatch", feature: FEATURE_ID }];
    const token = typeof header === "string" ? header : body;
    if (typeof token !== "string" || !storeFor(options.stateDir).consume(token, now)) return [401, { error: "invalid or expired host capability" }];
    return [200, { schema: SCHEMA, feature: FEATURE_ID, accepted: true, grantsAccess: false }];
  }
  if (method === "GET" || method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") return [405, { error: "method not allowed" }];
  return null;
}
