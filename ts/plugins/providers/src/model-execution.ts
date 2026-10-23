/** Plugin-owned process admission and optional content-free local diagnostics. */
import { resolve } from "node:path";
import type { AgentExtension, Row } from "@xueness/agent";
import { providerAdmissionForState } from "./admission-policy.ts";
import { ModelDebugStore } from "./model-debug.ts";
import { modelDebugRecord, summarizeModelRequest } from "./model-diagnostics.ts";

const debugStores = new Map<string, ModelDebugStore>();
function debugStore(stateDir: string): ModelDebugStore {
  const path = resolve(stateDir), key = process.platform === "win32" ? path.toLowerCase() : path;
  let store = debugStores.get(key);
  if (!store) { store = new ModelDebugStore(path); debugStores.set(key, store); }
  return store;
}

export function providerExecutionSnapshot(stateDir: string): Row {
  const admission = providerAdmissionForState(stateDir);
  return { admission: admission ? { enabled: true, ...admission.snapshot() } : { enabled: false }, debug: debugStore(stateDir).snapshot() };
}

export function providerModelExecutionExtension(): AgentExtension {
  const requests = new WeakMap<Row, Row>();
  const record = (session: Row, stateDir: string, info: Row): void => {
    debugStore(stateDir).write(modelDebugRecord(String(session.id), info, requests.get(session)));
  };
  return { id: "providers", capabilities: ["providers.model_admission", "providers.model_debug"],
    prepareRequest(context, request) {
      requests.delete(context.session);
      return { ...request, options: { ...request.options, modelRequestAdmission: providerAdmissionForState(context.stateDir) } };
    },
    modelRequestPrepared(context, request) { requests.set(context.session, summarizeModelRequest(request)); },
    modelRequestCompleted(context, info) { record(context.session, context.stateDir, { ...info, type: "model_request_completed" }); },
    modelRequestFailed(context, info) { record(context.session, context.stateDir, { ...info, type: "model_request_failed" }); },
    close(context) { requests.delete(context.session); },
  };
}
