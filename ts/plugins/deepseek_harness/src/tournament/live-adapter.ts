/**
 * H09.05 — Live provider adapter hooks for tournament matches.
 * Dry-run fallback when no live model factory is supplied.
 */
import type { HarnessModel, ModelResponse } from "../builtins/critic-solver.ts";

export type LiveModelFactory = (id: string) => HarnessModel | Promise<HarnessModel>;

export interface LiveAdapterOptions {
  readonly factory?: LiveModelFactory;
  /** When true (default), missing factory yields offline echo models. */
  readonly dryRunFallback?: boolean;
}

export interface LiveAdapter {
  resolve(id: string): Promise<HarnessModel>;
  readonly mode: "live" | "dry-run";
}

export function createLiveAdapter(options: LiveAdapterOptions = {}): LiveAdapter {
  const dryRunFallback = options.dryRunFallback ?? true;
  if (!options.factory && !dryRunFallback) {
    throw new Error("live adapter requires a factory when dryRunFallback is false");
  }
  const mode: "live" | "dry-run" = options.factory ? "live" : "dry-run";
  return {
    mode,
    async resolve(id: string) {
      if (options.factory) return options.factory(id);
      const model: HarnessModel = {
        id,
        async complete(request): Promise<ModelResponse> {
          return {
            text: `dry-run:${id}:${request.prompt.slice(0, 48)}`,
            usage: { promptTokens: request.prompt.length, completionTokens: 8, cachedTokens: 0 },
          };
        },
      };
      return model;
    },
  };
}
