/**
 * model_monitor stays off in `effectivePlugins` because its Python manifest
 * sets `installPackage`. Owning `/api/model_monitor` with that callback would
 * 403 a route Python can still serve. Match the catalog instead: marketplace
 * marker installed, explicit switch true, providers on. Default stays off.
 */
import { loadDataManifests } from "@xueness/plugin-extensions";
import { explicitPluginChoice } from "./plugin-state.ts";

export function modelMonitorEnabled(stateDir: string, providersOn: boolean): boolean {
  if (!providersOn || explicitPluginChoice(stateDir, "model_monitor") !== true) return false;
  try {
    return loadDataManifests(stateDir).some((item) => item.id === "xueness-model-monitor" && item.builtin === "model_monitor");
  } catch {
    return false;
  }
}
