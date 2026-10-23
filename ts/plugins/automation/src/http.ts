/**
 * The automation HTTP families (Python `automation/plugin.py` `dispatch` plus
 * `automation/off_peak.py` `http`).
 *
 *   /api/automations              cron schedules (list/save)
 *   /api/automations/<id>         one schedule (save/delete)
 *   /api/automations/<id>/run     claim and launch a due schedule
 *   /api/automations/<id>/approve approve the immutable plan
 *   /api/automation/offpeak       off-peak queue (overview/add)
 *   /api/automation/offpeak/...   settings, cancel, run-now, approve
 *
 * Each family maps its own failure ladder to the statuses Python returns.
 */
import { isDict, pySlice, pyStr } from "@xueness/contracts";
import { isPyKeyError, isPyOSError, isPyValueError } from "@xueness/sessions";
import { OffPeakQueue } from "./off-peak-queue.ts";
import { pick, PluginDisabled, requireEnabled, type Row } from "./off-peak.ts";
import { Automations, type WorkflowBridge } from "./store.ts";

type Reply = [number, unknown] | null;

export interface AutomationHttpOptions {
  stateDir: string;
  /** `ctx.get("allow_real", False)`: the host's real-provider switch. */
  allowRealHost: boolean;
  /** `require_enabled` probe; unbound means on. */
  enabled?: () => boolean;
  bridge?: WorkflowBridge;
}

export const AUTOMATION_ROUTES: readonly string[] = [
  "GET /api/automations", "POST /api/automations",
  "PATCH /api/automations/*", "POST /api/automations/*", "DELETE /api/automations/*",
  "POST /api/automations/*/run", "POST /api/automations/*/approve",
  "GET /api/automation/offpeak", "POST /api/automation/offpeak",
  "GET /api/automation/offpeak/settings", "POST /api/automation/offpeak/settings",
  "DELETE /api/automation/offpeak/*",
  "POST /api/automation/offpeak/*/run", "POST /api/automation/offpeak/*/approve",
];

export function createAutomationHttp(options: AutomationHttpOptions) {
  const owns = (method: string, parts: readonly string[]): boolean => {
    void method;
    if (parts.length >= 3 && parts[0] === "api" && parts[1] === "automation" && parts[2] === "offpeak") return true;
    return parts.length >= 2 && parts[0] === "api" && parts[1] === "automations";
  };

  /** `off_peak.http` plus its own failure ladder. */
  const offPeak = (method: string, parts: readonly string[], data: Row): Reply => {
    try {
      requireEnabled(options.stateDir);
      const queue = new OffPeakQueue(options.stateDir, {
        allowRealHost: options.allowRealHost,
        ...(options.bridge ? { bridge: options.bridge } : {}),
      });
      if (parts.length === 3) {
        if (method === "GET") return [200, queue.overview()];
        if (method === "POST") return [201, { task: queue.add(data) }];
        return [405, { error: "method not allowed" }];
      }
      if (parts.length === 4 && parts[3] === "settings") {
        if (method === "GET") return [200, { settings: queue.settings() }];
        if (method === "POST") return [200, { settings: queue.saveSettings(data) }];
        return [405, { error: "method not allowed" }];
      }
      if (parts.length === 4 && method === "DELETE") {
        return [200, { cancelled: pick(queue.cancel(parts[3] as string), "id") }];
      }
      if (parts.length === 5 && method === "POST") {
        const taskId = parts[3] as string;
        const action = parts[4] as string;
        if (action === "run") return [200, { result: queue.runNow(taskId) }];
        if (action === "approve") {
          if (data.allowReal === true && !options.allowRealHost) return [403, { error: "real provider disabled by host" }];
          if (data.confirmed !== true) return [400, { error: "approval must name the saved plan" }];
          return [200, { task: queue.approve(taskId, { allowReal: data.allowReal, confirmed: true }) }];
        }
      }
      return [405, { error: "method not allowed" }];
    } catch (error) {
      if (error instanceof PluginDisabled) return [403, { error: pyStr(error instanceof Error ? error.message : error), plugin: "automation" }];
      if (isPyValueError(error) || isPyKeyError(error)) return [400, { error: pySlice(error instanceof Error ? error.message : pyStr(error), 300) }];
      if (isPyOSError(error)) return [400, { error: "off-peak state unavailable" }];
      throw error;
    }
  };

  /** `plugin.py` dispatch for `/api/automations`. */
  const schedules = (method: string, parts: readonly string[], data: Row): Reply => {
    try {
      const store = new Automations(options.stateDir, {
        ...(options.enabled ? { enabled: options.enabled } : {}),
        ...(options.bridge ? { bridge: options.bridge } : {}),
      });
      if (parts.length === 2) {
        if (method === "GET") return [200, { automations: store.list() }];
        if (method === "POST") return [201, { automation: store.save(data) }];
      }
      if (parts.length === 3) {
        if (method === "PATCH" || method === "POST") return [200, { automation: store.save(data, parts[2] as string) }];
        if (method === "DELETE") return [200, store.delete(parts[2] as string)];
      }
      if (parts.length === 4 && method === "POST") {
        if (parts[3] === "run") {
          return [200, { run: store.run(parts[2] as string, { allowRealHost: options.allowRealHost, bridge: options.bridge }) }];
        }
        if (parts[3] === "approve" && data.allowReal === true && !options.allowRealHost) return [403, { error: "real provider disabled by host" }];
        if (parts[3] === "approve" && data.confirmed === true) return [200, { automation: store.approve(parts[2] as string, data.allowReal) }];
      }
      return [405, { error: "method not allowed" }];
    } catch (error) {
      if (isPyValueError(error) || isPyOSError(error) || isPyKeyError(error)) return [400, { error: "invalid automation or unknown ID" }];
      throw error;
    }
  };

  return {
    routes: AUTOMATION_ROUTES,
    owns,
    dispatch(method: string, parts: readonly string[], query: Row, data: Row): Reply {
      void query;
      if (!owns(method, parts)) return null;
      const body = isDict(data) ? data : {};
      if (parts.length >= 3 && parts[0] === "api" && parts[1] === "automation" && parts[2] === "offpeak") {
        return offPeak(method, parts, body);
      }
      return schedules(method, parts, body);
    },
  };
}
