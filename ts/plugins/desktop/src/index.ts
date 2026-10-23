/** Desktop status, tray, permissions, and one-time host tickets. The Electron launcher stays Python. */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };

export { hostCapabilityEnabled, platformFamily } from "./capability.ts";
export { createDesktopHttp, DESKTOP_ROUTES, desktopStatus, pickDirectory, type DesktopHttpOptions } from "./http.ts";
export { unsupportedSnapshot, type PermissionBridge } from "./permissions.ts";

export const desktop: BundledPlugin = { manifest, plugin: definePlugin({ name: "desktop", apply() {} }) };
