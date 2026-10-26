/** Round-5 HTTP families. The front door stays thin; this module owns the eight plugins. */
import { isDict } from "@xueness/contracts";
import { loadSettings } from "@xueness/plugin-settings";
import { createDiagnosticsHttp } from "@xueness/plugin-diagnostics";
import { createDesktopHttp } from "@xueness/plugin-desktop";
import { createOnboardingHttp } from "@xueness/plugin-onboarding";
import type { TaskRegistry } from "@xueness/plugin-subagents";
import { createTerminalHttp, terminalBroker } from "@xueness/plugin-terminal";
import { createToolsHttp } from "@xueness/plugin-tools";
import { createUpdatesHttp } from "@xueness/plugin-updates";
import { createUsageHttp } from "@xueness/plugin-usage";
import type { SessionStore } from "@xueness/sessions";
import { BUNDLED_TS_PLUGINS } from "./bundled-plugins.ts";
import { modelMonitorEnabled } from "./model-monitor-enabled.ts";
import { createOptionalMonitor } from "./optional-integrations.ts";

export interface Round5Options {
  stateDir: string;
  enabled(id: string): boolean;
  store: SessionStore;
  allowedRoots(): readonly string[];
  resolveAllowed(value: unknown): string;
  taskRegistry: TaskRegistry;
  sessionsRunning(): boolean;
  desktopToken?: string;
  webappDir?: string;
  /** The desktop host's stdio relay to Electron (updates, permission guide, folder dialog). */
  desktopBridge?: { request(message: Record<string, unknown>, timeoutSeconds: number): unknown };
}

type Reply = [number, unknown, string?] | null;
type Request = { hostCapability?: string | null } | undefined;

function catalog(enabled: (id: string) => boolean): { id: string; effective: boolean; version: string | null }[] {
  return BUNDLED_TS_PLUGINS.map((plugin) => {
    const manifest = plugin.manifest;
    if (!isDict(manifest) || typeof manifest.id !== "string") return { id: "", effective: false, version: null };
    return { id: manifest.id, effective: enabled(manifest.id), version: typeof manifest.version === "string" ? manifest.version : null };
  });
}

function defaultShell(stateDir: string): unknown {
  const general = loadSettings(stateDir).general;
  return isDict(general) ? general.defaultShell : undefined;
}

export function createRound5(options: Round5Options) {
  const { stateDir, enabled, store } = options;
  const monitorOn = (id: string): boolean => id === "model_monitor" ? modelMonitorEnabled(stateDir, enabled("providers")) : enabled(id);
  const usageHttp = createUsageHttp({ enabled, store });
  const modelMonitorHttp = createOptionalMonitor({ stateDir, enabled: monitorOn, env: process.env });
  const onboardingHttp = createOnboardingHttp({ stateDir, enabled, desktop: !!options.desktopToken });
  const diagnosticsHttp = createDiagnosticsHttp({ stateDir, enabled, store, catalog: () => catalog(enabled) });
  const toolsHttp = createToolsHttp({ stateDir, enabled, store, allowedRoots: options.allowedRoots });
  const terminalHttp = createTerminalHttp({ enabled, store, broker: terminalBroker, allowedRoot: (root) => options.resolveAllowed(root), defaultShell: () => defaultShell(stateDir) });
  const updatesHttp = createUpdatesHttp({
    stateDir, enabled,
    ...(options.desktopToken ? { desktopToken: options.desktopToken } : {}),
    ...(options.desktopBridge ? { bridge: options.desktopBridge } : {}),
    terminalsOpen: () => terminalHttp.broker.openCount() > 0,
    tasksRunning: () => options.taskRegistry.list().some((row) => row.status === "running" || row.status === "pending"),
    sessionsRunning: options.sessionsRunning,
  });
  let hostCapability: string | null = null;
  const desktopHttp = createDesktopHttp({
    stateDir, enabled,
    ...(options.desktopToken ? { desktopToken: options.desktopToken } : {}),
    ...(options.webappDir ? { webappDir: options.webappDir } : {}),
    ...(options.desktopBridge ? { permissionBridge: options.desktopBridge, nativePicker: true } : {}),
    header: () => hostCapability,
  });
  const handlers = [usageHttp, modelMonitorHttp, onboardingHttp, diagnosticsHttp, toolsHttp, terminalHttp, updatesHttp, desktopHttp];
  return {
    routes: handlers.flatMap((handler) => handler.routes),
    owns: (method: string, parts: readonly string[]): boolean => handlers.some((handler) => handler.owns(method, parts)),
    dispatch(method: string, parts: readonly string[], query: Record<string, string[]>, data: Record<string, unknown>, request?: Request): Reply | Promise<Reply> {
      if (usageHttp.owns(method, parts)) return usageHttp.dispatch(method, parts, query);
      if (modelMonitorHttp.owns(method, parts)) return modelMonitorHttp.dispatch(method, parts, query, data);
      if (onboardingHttp.owns(method, parts)) return onboardingHttp.dispatch(method, parts, query, data);
      if (diagnosticsHttp.owns(method, parts)) return diagnosticsHttp.dispatch(method, parts, query, data);
      if (toolsHttp.owns(method, parts)) return toolsHttp.dispatch(method, parts, query);
      if (terminalHttp.owns(method, parts)) return terminalHttp.dispatch(method, parts, query, data);
      if (updatesHttp.owns(method, parts)) return updatesHttp.dispatch(method, parts, query, data);
      if (desktopHttp.owns(method, parts)) {
        hostCapability = request?.hostCapability ?? null;
        return desktopHttp.dispatch(method, parts, query, data);
      }
      return null;
    },
    close(): void { terminalHttp.broker.close(); },
  };
}
