/** Desktop routes this plugin actually implements. Other `/api/desktop/*` paths stay unowned. */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isLink } from "@xueness/sessions";
import { capabilityDispatch } from "./capability.ts";
import { permissionDispatch } from "./permissions.ts";
import type { PermissionBridge } from "./permissions.ts";

export const DESKTOP_ROUTES = ["GET /api/desktop/status", "GET /api/desktop/tray", "GET /api/desktop/permissions", "POST /api/desktop/host-capability"] as const;

export interface DesktopHttpOptions {
  stateDir: string;
  enabled: boolean | ((id: string) => boolean);
  desktopToken?: string;
  webappDir?: string;
  version?: string;
  frozen?: boolean;
  pickDirectory?: (initialRoot?: string) => string;
  /** The desktop host relays `/api/workspaces/native-picker` to the window's folder dialog. */
  nativePicker?: boolean;
  permissionBridge?: PermissionBridge | null;
  header?: () => string | null;
  now?: () => number;
}

function enabled(options: DesktopHttpOptions): boolean {
  return typeof options.enabled === "function" ? options.enabled("desktop") : options.enabled;
}

function owned(method: string, parts: readonly string[]): boolean {
  if (parts[0] !== "api" || parts[1] !== "desktop") return false;
  if (parts.length === 3 && parts[2] === "status") return method === "GET";
  if (parts.length === 3 && (parts[2] === "tray" || parts[2] === "permissions" || parts[2] === "host-capability")) return true;
  if (parts.length === 4 && parts[2] === "host-capability" && parts[3] === "consume") return true;
  if (parts.length === 4 && parts[2] === "permissions" && (parts[3] === "policy" || parts[3] === "request")) return true;
  return false;
}

export function desktopStatus(options: DesktopHttpOptions): Record<string, unknown> {
  return {
    desktop: Boolean(options.desktopToken),
    platform: process.platform,
    version: options.version ?? "0.2.1",
    frozen: options.frozen === true,
    dataDirectory: dirname(options.stateDir),
    nativeDirectoryPicker: options.nativePicker === true || typeof options.pickDirectory === "function",
  };
}

export function createDesktopHttp(options: DesktopHttpOptions) {
  return {
    routes: DESKTOP_ROUTES,
    owns: (method: string, parts: readonly string[]): boolean => owned(method, parts),
    dispatch(method: string, parts: readonly string[], _query: Record<string, string[]>, data: unknown): [number, unknown, string?] | null | Promise<[number, unknown]> {
      if (!owned(method, parts)) return null;
      if (!enabled(options)) return [403, { error: "plugin disabled or dependency unavailable: desktop", plugin: "desktop" }];
      const capability = capabilityDispatch(method, parts, data, {
        stateDir: options.stateDir, desktop: Boolean(options.desktopToken), version: options.version ?? "0.2.1",
        ...(options.pickDirectory ? { pickDirectory: options.pickDirectory } : {}),
        ...(options.header ? { header: options.header } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
      if (capability) return capability;
      const permissions = permissionDispatch(method, parts, data, { desktop: Boolean(options.desktopToken), bridge: options.permissionBridge });
      if (permissions) return permissions;
      if (parts.length === 3 && parts[2] === "tray") {
        if (method !== "GET") return [405, { error: "method not allowed" }];
        if (!options.desktopToken) return [403, { error: "desktop host required" }];
        if (!options.webappDir) return [503, { error: "ui asset missing" }];
        const root = resolve(options.webappDir);
        const page = join(root, "tray.html");
        if (resolve(page, "..") !== root || isLink(page)) return [404, { error: "not found" }];
        try { return [200, readFileSync(page), "text/html; charset=utf-8"]; }
        catch { return [503, { error: "ui asset missing" }]; }
      }
      if (parts.length === 3 && parts[2] === "status" && method === "GET") return [200, desktopStatus(options)];
      return null;
    },
  };
}

/** Windows has no osascript picker. Settings still owns `/api/workspaces`. */
export function pickDirectory(): never {
  const error = new Error("native directory picker is not available");
  error.name = "PickerUnavailable";
  throw error;
}
