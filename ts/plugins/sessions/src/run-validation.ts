import { isDict, isPyIntValue, numericValue, pyIter, pyStr, pyStrip, PyValueError } from "@xueness/contracts";
import type { Row, RunPolicy, LifecycleRunOptions } from "./lifecycle-types.ts";

export function requestedSelection(data: Row): Row {
  let raw = data.model_selection;
  if (raw === undefined || raw === null) raw = Object.fromEntries(["provider_id", "model", "reasoning_effort", "providerId", "reasoningEffort"].filter((k) => Object.hasOwn(data, k)).map((k) => [k, data[k]]));
  if (isDict(raw)) raw = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key === "providerId" ? "provider_id" : key === "reasoningEffort" ? "reasoning_effort" : key, value]));
  if (!isDict(raw) || Object.keys(raw).some((k) => !["provider_id", "model", "reasoning_effort"].includes(k)) || Object.values(raw).some((v) => v !== null && typeof v !== "string")) throw new PyValueError("invalid model selection");
  return raw;
}
export function selectionRecord(selection: Row): Row { return { provider_id: selection.provider_id ?? null, model: selection.model ?? null, ...(selection.reasoning_effort != null ? { reasoning_effort: selection.reasoning_effort } : {}) }; }
export function validateRun(data: Row, knownTools: readonly string[]): { policy: Omit<RunPolicy, "selection" | "permissionMode">; options: LifecycleRunOptions; permissionMode: unknown; acknowledgeYolo: boolean } {
  if (typeof (data.continue_queue ?? false) !== "boolean") throw new PyValueError("continue_queue must be a boolean");
  if (data.promotion_request_id != null) {
    if (typeof data.promotion_request_id !== "string" || !/^[0-9a-f]{32}$/.test(data.promotion_request_id)) throw new PyValueError("promotion_request_id must be a valid send-now receipt");
    if (!data.continue_queue) throw new PyValueError("promotion_request_id requires continue_queue=true");
  }
  if (["allow_write", "allowWrite", "allow_exec", "allowExec", "allow_edit", "allowEdit", "allow_network", "allowNetwork", "approve_all", "approveAll"].some((k) => Object.hasOwn(data, k))) throw new PyValueError("blanket approval is never accepted via web; approve single actions instead");
  const options: LifecycleRunOptions = {};
  if (Object.hasOwn(data, "steps")) { if (!isPyIntValue(data.steps) || Number(data.steps) < 1 || Number(data.steps) > 20) throw new PyValueError("steps must be 1..20"); options.maxSteps = Number(data.steps); }
  if (Object.hasOwn(data, "max_chars") || Object.hasOwn(data, "maxChars")) { const v = Object.hasOwn(data, "max_chars") ? data.max_chars : data.maxChars; if (!isPyIntValue(v) || Number(v) < 1000 || Number(v) > 100000) throw new PyValueError("max_chars must be 1000..100000"); options.maxChars = Number(v); }
  const tokens = Object.hasOwn(data, "max_tokens") ? data.max_tokens : data.maxTokens;
  // The historical web API accepts True as a positive int here.
  if (tokens !== undefined && tokens !== null) { if (!(isPyIntValue(tokens) || tokens === true) || Number(tokens) < 1) throw new PyValueError("max_tokens must be a positive integer"); options.maxTokens = Number(tokens); }
  if (data.runtime_profile != null && !["standard", "lightweight"].includes(String(data.runtime_profile))) throw new PyValueError("runtime_profile must be standard or lightweight");
  if (Object.hasOwn(data, "max_wall_seconds") || Object.hasOwn(data, "maxWallSeconds")) { const v = Object.hasOwn(data, "max_wall_seconds") ? data.max_wall_seconds : data.maxWallSeconds, n = numericValue(v); if (typeof v === "boolean" || n === null || !(n > 0 && n <= 3600)) throw new PyValueError("max_wall_seconds must be greater than zero and at most 3600"); options.maxWallSeconds = n; }
  const mode = data.mode ?? "build";
  if (mode !== "plan" && mode !== "build") throw new PyValueError("mode must be 'plan' or 'build'");
  const raw = data.disallow_tools ?? data.disallowTools ?? data.disallow ?? null;
  const items = raw === null ? [] : typeof raw === "string" ? raw.split(",") : Array.from(pyIter(raw));
  const disallowed = items.map((v) => pyStrip(pyStr(v))).filter(Boolean);
  const unknown = disallowed.filter((v) => !knownTools.includes(v) && v !== "skill_read");
  if (unknown.length) throw new PyValueError("unknown tool(s) in disallow list: " + unknown.sort().join(", "));
  const browser = data.browser;
  if (browser !== undefined && browser !== null && typeof browser !== "boolean") throw new PyValueError("browser must be a boolean");
  if (browser === false) disallowed.push(...knownTools.filter((n) => n.startsWith("browser_")));
  const permissionMode = data.permission_mode ?? data.permissionMode ?? null;
  if (permissionMode !== null && !["build", "edit", "yolo", "plan", "guarded"].includes(String(permissionMode))) throw new PyValueError("permission_mode must be 'build', 'edit', 'yolo', 'plan', or 'guarded'");
  const acknowledgeYolo = data.acknowledge_yolo ?? false;
  if (typeof acknowledgeYolo !== "boolean") throw new PyValueError("acknowledge_yolo must be a boolean");
  if (acknowledgeYolo && permissionMode !== "yolo") throw new PyValueError("acknowledge_yolo requires permission_mode=yolo");
  if (data.remote != null && (typeof data.remote !== "string" || !data.remote)) throw new PyValueError("remote must be a configured connection id");
  return { policy: { mode, disallowed: [...new Set(disallowed)], ...(typeof browser === "boolean" ? { browser } : {}), request: data }, options, permissionMode, acknowledgeYolo };
}
