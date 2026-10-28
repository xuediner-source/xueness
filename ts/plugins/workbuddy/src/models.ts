/** The WorkBuddy pool models this plugin exposes to conversations. */
export interface WorkbuddyModel {
  /** Upstream model id sent to the gateway. */
  readonly id: string;
  /** Display name in the model picker. */
  readonly name: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  /** Reasoning efforts the gateway accepts for this model; empty means none. */
  readonly reasoningLevels: readonly string[];
}

export const MODELS: readonly WorkbuddyModel[] = Object.freeze([
  {
    id: "step-5-preview", name: "Step 5 Preview",
    contextWindow: 1_000_000, maxOutputTokens: 64_000, reasoningLevels: ["low", "medium", "high"],
  },
  {
    id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash",
    contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoningLevels: ["low", "high", "max"],
  },
  {
    id: "glm-5.3-flash", name: "GLM-5.3 Flash",
    contextWindow: 1_000_000, maxOutputTokens: 131_072, reasoningLevels: ["low", "high", "max"],
  },
  {
    id: "deepseek-v4-pro", name: "DeepSeek V4 Pro",
    contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoningLevels: [],
  },
]);

/** Stable provider profile id for a model (`^[A-Za-z0-9._-]{1,64}$`). */
export function profileId(model: WorkbuddyModel): string {
  return `workbuddy.${model.id}`;
}

/** The model a profile id names, or null. */
export function modelForProfile(id: string): WorkbuddyModel | null {
  return MODELS.find((model) => profileId(model) === id) ?? null;
}
