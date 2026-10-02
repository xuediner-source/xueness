import { post } from "./xuenessApi";

export type ComposerInput = {
  attachments: { name: string; mimeType: string; data: string }[];
  files: string[];
  sessions: string[];
  skills: string[];
  plugins: string[];
  remote?: string;
  goal: boolean;
};
export type ComposerModel = {
  id: string;
  name: string;
  model: string;
  configured: boolean;
  protocol: "openai" | "anthropic";
  capabilities: string[];
  reasoningLevels: string[];
  runtimeProfile?: "standard" | "lightweight";
  contextWindow?: number;
  maxOutputTokens?: number;
  toolCalling?: "native" | "json";
  compatibility?: {
    streamUsage?: boolean;
    parallelToolCalls?: boolean;
    maxTokensField?: "max_tokens" | "max_completion_tokens";
    [key: string]: unknown;
  };
};
export type RuntimeProfile = "standard" | "lightweight";

/** A missing override means: use the selected provider's declared profile. */
export function effectiveRuntimeProfile(
  model: Pick<ComposerModel, "runtimeProfile"> | undefined,
  override?: RuntimeProfile,
): RuntimeProfile {
  return override ?? model?.runtimeProfile ?? "standard";
}

/** Explicit user choice stays explicit even when it matches the provider default. */
export function runtimeProfileSelection(
  requested: RuntimeProfile,
): RuntimeProfile {
  return requested;
}

/** Ignore absent or malformed historical fields and let the provider default apply. */
export function runtimeProfileFromSession(value: unknown): RuntimeProfile | undefined {
  return value === "standard" || value === "lightweight" ? value : undefined;
}

export function canUseRuntimeProfile(
  model: Pick<ComposerModel, "toolCalling"> | undefined,
  requested: RuntimeProfile,
): boolean {
  return requested !== "standard" || model?.toolCalling !== "json";
}
export type ComposerCatalog = {
  root: string | null;
  isolatedRoot: string;
  roots: { path: string; name: string }[];
  files: { id: string; label: string }[];
  sessions: { id: string; label: string; description?: string }[];
  skills: { id: string; label: string; description?: string }[];
  plugins: { id: string; label: string; description?: string }[];
  models: ComposerModel[];
  allowReal: boolean;
  backgroundCount?: number;
  git?: { branch: string; branches: string[] };
  remoteConnections?: { id: string; label: string; digest: string }[];
};
export const emptyComposerCatalog: ComposerCatalog = {
  root: null, isolatedRoot: "", roots: [], files: [], sessions: [], skills: [], plugins: [], models: [], allowReal: false,
};
export async function loadComposerCatalog(root?: string, sessionId?: string, signal?: AbortSignal): Promise<ComposerCatalog> {
  const query = new URLSearchParams();
  if (root) query.set("root", root);
  if (sessionId) query.set("session_id", sessionId);
  const response = await fetch(`/api/composer${query.size ? `?${query}` : ""}`, {
    credentials: "same-origin", cache: "no-store", signal,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload as ComposerCatalog;
}
export async function prepareComposer(text: string, input: ComposerInput | undefined, selection: {
  root?: string; session_id?: string; provider_id?: string; model?: string; reasoning_effort?: string;
}): Promise<{ text: string; token: string; root: string; metadata: Record<string, unknown>; goal: boolean }> {
  return post("/api/composer/prepare", { text, ...selection, ...(input ? { input } : {}) });
}
export async function switchComposerBranch(root: string, branch: string): Promise<void> {
  await post("/api/composer/branch", { root, branch });
}
