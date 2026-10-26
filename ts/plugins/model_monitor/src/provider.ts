/** Observe the response already being used by the conversation; never send a probe. */
import type { ChatProvider } from "@xueness/providers";
import { recordObservation } from "./records.ts";

export function observeProvider(provider: ChatProvider, options: { stateDir: string; sessionId: string; providerId: unknown; enabled(): boolean }): ChatProvider {
  const observe = (result: Record<string, unknown> | null, outcome: string): void => {
    try { recordObservation(options.stateDir, { sessionId: options.sessionId, providerId: options.providerId,
      requestedModel: provider.model, returnedModels: result?._response_models ?? [], protocol: "", outcome }, options.enabled()); } catch { /* Passive logging cannot fail a model request. */ }
  };
  return new Proxy(provider, {
    get(target, key) {
      if (key === "complete") return async (...args: Parameters<ChatProvider["complete"]>) => {
        try { const result = await target.complete(...args); observe(result, "success"); return result; }
        catch (error) { observe(null, "error"); throw error; }
      };
      if (key === "stream") return async (...args: Parameters<ChatProvider["stream"]>) => {
        try { const result = await target.stream(...args); observe(result, "success"); return result; }
        catch (error) { observe(null, "error"); throw error; }
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
