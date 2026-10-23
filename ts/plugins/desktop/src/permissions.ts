/** Permission snapshot. Without a desktop token the status is unsupported, not an error. */
import { isDict } from "@xueness/contracts";

const PERMISSIONS = ["accessibility", "screen", "fullDisk", "microphone"] as const;
const STATUSES = new Set(["granted", "not-determined", "denied", "restricted", "unknown", "unsupported"]);
const REQUEST_ID = /^[a-f0-9]{32}$/;

export interface PermissionBridge { request(message: Record<string, unknown>, timeoutSeconds: number): unknown }

export function unsupportedSnapshot(platform = process.platform): { platform: string; permissions: { id: string; status: string; canRequest: boolean }[] } {
  return { platform, permissions: PERMISSIONS.map((id) => ({ id, status: "unsupported", canRequest: false })) };
}

function valid(value: unknown): boolean {
  if (!isDict(value) || Object.keys(value).length !== 2 || typeof value.platform !== "string" || !value.platform || value.platform.length > 32 || !Array.isArray(value.permissions) || value.permissions.length !== PERMISSIONS.length) return false;
  const seen = new Set<string>();
  for (const row of value.permissions) {
    if (!isDict(row)) return false;
    const extra = Object.keys(row).filter((key) => !["id", "status", "canRequest", "requiresRestart"].includes(key));
    if (extra.length || typeof row.id !== "string" || !PERMISSIONS.includes(row.id as typeof PERMISSIONS[number]) || seen.has(row.id)) return false;
    if (typeof row.status !== "string" || !STATUSES.has(row.status) || typeof row.canRequest !== "boolean") return false;
    if (Object.hasOwn(row, "requiresRestart") && typeof row.requiresRestart !== "boolean") return false;
    seen.add(row.id);
  }
  return seen.size === PERMISSIONS.length;
}

export function permissionDispatch(method: string, parts: readonly string[], data: unknown, options: { desktop: boolean; bridge?: PermissionBridge | null }): [number, unknown] | null | Promise<[number, unknown]> {
  if (parts.length === 4 && parts[2] === "permissions" && parts[3] === "policy") {
    if (method !== "GET") return [405, { error: "method not allowed" }];
    if (!options.desktop) return [403, { error: "desktop host required" }];
    return [200, { enabled: true }];
  }
  if (parts.length === 3 && parts[2] === "permissions") {
    if (method !== "GET") return [405, { error: "method not allowed" }];
    if (!options.desktop) return [200, unsupportedSnapshot()];
    if (!options.bridge) return [503, { error: "desktop permission bridge unavailable" }];
    return snapshot(options.bridge, "status");
  }
  if (parts.length === 4 && parts[2] === "permissions" && parts[3] === "request") {
    if (method !== "POST") return [405, { error: "method not allowed" }];
    if (!isDict(data) || Object.keys(data).length !== 1 || typeof data.permission !== "string" || !PERMISSIONS.includes(data.permission as typeof PERMISSIONS[number])) return [400, { error: "expected permission id only" }];
    if (!options.desktop) return [403, { error: "desktop host required" }];
    if (!options.bridge) return [503, { error: "desktop permission bridge unavailable" }];
    return snapshot(options.bridge, "request", data.permission);
  }
  return null;
}

function snapshot(bridge: PermissionBridge, action: string, permission?: string): [number, unknown] | Promise<[number, unknown]> {
  const unavailable: [number, unknown] = [503, { error: "desktop permission service unavailable" }];
  try {
    // The desktop host answers over its stdio pipe (a promise); test bridges answer at once.
    const result = bridge.request({ type: "permissions", action, ...(permission ? { permission } : {}) }, action === "request" ? 600 : 30);
    return result instanceof Promise ? result.then(reply, () => unavailable) : reply(result);
  } catch { return unavailable; }
}

function reply(result: unknown): [number, unknown] {
  try {
    if (!isDict(result)) return [503, { error: "invalid desktop permission response" }];
    if (Object.keys(result).length === 2 && Object.hasOwn(result, "id") && Object.hasOwn(result, "error")) {
      if (typeof result.id !== "string" || !REQUEST_ID.test(result.id)) return [503, { error: "invalid desktop permission response" }];
      if (result.error === "disabled") return [403, { error: "desktop plugin disabled or dependency unavailable: desktop", plugin: "desktop" }];
      return [503, { error: "desktop permission service unavailable" }];
    }
    if (!valid(isDict(result) ? result.state : null) || typeof result.id !== "string" || !REQUEST_ID.test(result.id)) return [503, { error: "invalid desktop permission response" }];
    return [200, result.state];
  } catch { return [503, { error: "desktop permission service unavailable" }]; }
}
