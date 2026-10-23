/** Next-request model selection, never retargeting a request already in flight. */
import type { AgentProvider, Row } from "@xueness/agent";
import { isDict, pyDeepCopy, pyStrip, pyTruthy, PyValueError } from "@xueness/contracts";
import type { Session } from "@xueness/sessions";
const ALIASES: Record<string, string> = { providerId: "provider_id", reasoningEffort: "reasoning_effort", runtimeProfile: "runtime_profile", saveDefault: "save_default" };
const KEYS = ["provider_id", "model", "reasoning_effort", "selection", "save_default", "source", "runtime_profile"];
export function currentModelSelection(session: Row): Row {
  const raw = isDict(session.model_selection) ? session.model_selection : {};
  return Object.fromEntries(["provider_id", "model", "reasoning_effort"].map((key) => [key, typeof raw[key] === "string" ? raw[key] : null]));
}
export function parseModelTarget(text: string): [string | null, string | null] {
  const value = pyStrip(text || ""); if (!value) throw new PyValueError("用法: /model <provider/model>、/model <ID> [MODEL] 或 /model list");
  if (value === "env") return [null, null];
  if (!value.includes("/")) return [value, null];
  let provider = pyStrip(value.slice(0, value.indexOf("/"))); const model = pyStrip(value.slice(value.indexOf("/") + 1));
  if (provider === "env") provider = "";
  if (!provider && !model) throw new PyValueError("模型选择不能为空");
  return [provider || null, model || null];
}
export function normalizeModelSwitch(requested: Row): [Row, string] {
  const fields: Row = {};
  for (const [key, value] of Object.entries(requested)) { const target = ALIASES[key] ?? key; if (!KEYS.includes(target)) return [{}, "unknown selection key: " + key]; fields[target] = value; }
  for (const key of ["provider_id", "model", "reasoning_effort", "selection", "runtime_profile"]) {
    if (fields[key] === undefined || fields[key] === null) continue;
    if (typeof fields[key] !== "string") return [{}, `${key} must be a string`]; fields[key] = pyStrip(fields[key]) || null;
  }
  if (Object.hasOwn(fields, "save_default") && ![false, true, null, 0, 1].includes(fields.save_default as boolean)) return [{}, "save_default must be a boolean"];
  if (fields.selection != null && (fields.provider_id != null || fields.model != null)) return [{}, "selection cannot be combined with provider_id or model"];
  return [fields, ""];
}
export function planModelSelection(previous: Row, fields: Row): Row {
  let provider: unknown = fields.provider_id ?? previous.provider_id, model: unknown = fields.model ?? previous.model, effort: unknown = fields.reasoning_effort ?? null;
  if (fields.selection != null) [provider, model] = parseModelTarget(fields.selection as string);
  if (effort === null && provider === previous.provider_id && model === previous.model) effort = previous.reasoning_effort;
  return { provider_id: provider || null, model: model || null, ...(effort ? { reasoning_effort: effort } : {}) };
}
export function recordModelSwitch(session: Row, previous: Row, selected: Row, source = "api", effect = "immediate", stamp = new Date().toISOString()): void {
  const message = (Array.isArray(session.messages) ? session.messages : []).filter(isDict).findLast((row) => ["user", "assistant"].includes(String(row.role)));
  const id = typeof message?._message_id === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(message._message_id) ? message._message_id : null;
  const history = Array.isArray(session.model_history) ? session.model_history : [];
  history.push({ ...(id ? { message_id: id } : {}), from: pyDeepCopy(previous), to: pyDeepCopy(selected), at: stamp, source, effect }); session.model_history = history.slice(-50);
}
export interface SwitchableAgentProvider extends AgentProvider {
  readonly session: Session;
  boundProvider(): AgentProvider;
  /** The provider the next request will use (a pending switch applies then). */
  upcomingProvider(): AgentProvider;
  switchTo(selection: Row, provider: AgentProvider): void;
  pendingSelection(): Row | null;
}
export function switchableProvider(initial: AgentProvider, session: Session): SwitchableAgentProvider {
  let current = initial, pending: { selection: Row; provider: AgentProvider } | null = null;
  const facade = { session, boundProvider: () => current, upcomingProvider: () => pending?.provider ?? current,
    switchTo(selection: Row, provider: AgentProvider) { pending = { selection: { ...selection }, provider }; },
    pendingSelection: () => pending ? { ...pending.selection } : null };
  return new Proxy(facade, {
    get(target, key) {
      if (Reflect.has(target, key)) return Reflect.get(target, key);
      if ((key === "complete" || key === "stream") && pending) {
        const next = pending; pending = null;
        if (current !== next.provider) { const deadline = current.requestDeadline; current = next.provider; if (deadline != null) current.requestDeadline = deadline; }
        session.model_selection = { ...next.selection }; session.runtime_profile = current.runtimeProfile ?? "standard"; session.tool_calling = current.toolCalling ?? "native";
      }
      const value = Reflect.get(current, key); return typeof value === "function" ? value.bind(current) : value;
    },
    set(target, key, value) { if (Reflect.has(target, key)) return Reflect.set(target, key, value); return Reflect.set(current, key, value); },
  }) as unknown as SwitchableAgentProvider;
}
