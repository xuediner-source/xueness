/**
 * Environment, git snapshot, current-date and request-user-context sections.
 * Adapted from ZCode v3.15.1 `core/src/context/sections/{env-info,current-date,request-user-context}.ts`
 * (Apache-2.0, see NOTICE.md).
 */
import { createSection, type ContextSection } from "./sections.ts";

export interface EnvInfo {
  cwd: string;
  platform: string;
  shell: string;
  osVersion: string;
  isGitRepository?: boolean;
  gitBranch?: string;
  gitMainBranch?: string;
  gitUser?: string;
  gitStatus?: "clean" | "dirty" | "not_repo" | "unknown";
  gitStatusLines?: string[];
  recentCommits?: string[];
}
export interface PromptModel { providerId: string; modelId: string }
export interface InstructionSource { scope: "workspace" | "user"; filePath: string; content: string; truncated?: boolean; fileName?: string }

const GIT_SYSTEM_CONTEXT_PREFIX = "gitStatus: This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.";

export function isEnvInfoGitRepository(info: EnvInfo): boolean {
  return info.isGitRepository ?? (info.gitStatus !== undefined ? info.gitStatus !== "not_repo" : Boolean(info.gitBranch));
}
export function buildEnvInfoSection(info: EnvInfo, model?: PromptModel): ContextSection {
  const lines = [
    "# Environment",
    "You have been invoked in the following environment:",
    `- Primary working directory: ${info.cwd}`,
    `- Is a git repository: ${isEnvInfoGitRepository(info) ? "yes" : "no"}`,
    `- Platform: ${info.platform}`,
    `- Shell: ${info.shell}`,
    `- OS Version: ${info.osVersion}`,
    ...(model ? [`- You are powered by the model named ${model.providerId}/${model.modelId}.`] : []),
  ];
  return createSection("Environment Info", "env_info", "system", "dynamic", lines.join("\n"));
}
export function buildGitSystemContextSection(info: EnvInfo): ContextSection | null {
  if (!isEnvInfoGitRepository(info)) return null;
  const lines = [GIT_SYSTEM_CONTEXT_PREFIX];
  if (info.gitBranch) lines.push("", `Current branch: ${info.gitBranch}`);
  if (info.gitMainBranch) lines.push("", `Main branch (you will usually use this for PRs): ${info.gitMainBranch}`);
  if (info.gitUser) lines.push("", `Git user: ${info.gitUser}`);
  const status = info.gitStatusLines?.length ? info.gitStatusLines.join("\n") : info.gitStatus === "dirty" ? "(dirty)" : info.gitStatus === "clean" ? "(clean)" : "(unknown)";
  lines.push("", `Status:\n${status}`);
  lines.push("", `Recent commits:\n${info.recentCommits?.length ? info.recentCommits.join("\n") : ""}`);
  return createSection("System Context", "system_context", "system", "dynamic", lines.join("\n"));
}
export function buildCurrentDateSection(currentDate?: string): ContextSection | null {
  return currentDate ? createSection("Current Date", "current_date", "meta_user", "dynamic", `# currentDate\nToday's date is ${currentDate}.`) : null;
}
export function buildRequestUserContextSection(sources: readonly InstructionSource[] = []): ContextSection | null {
  const parts = sources.map((source) => {
    const body = (source.truncated ? `${source.content}\n\n[File truncated: ${source.fileName ?? source.filePath}]` : source.content).trim();
    return body ? [`Contents of ${source.filePath} (${source.scope === "user" ? "user default instructions" : "workspace instructions"}):`, "", body].join("\n") : null;
  }).filter((part): part is string => part !== null);
  if (!parts.length) return null;
  const content = [
    "# agentsMd",
    "Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.",
    "",
    parts.join("\n\n"),
  ].join("\n");
  return createSection("Request User Context", "request_user_context", "meta_user", "dynamic", content);
}
/** Local calendar date as YYYY-MM-DD (ZCode passes the host's local date). */
export function localDate(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
