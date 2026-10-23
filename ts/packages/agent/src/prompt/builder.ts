/**
 * System prompt assembly: stable prefix, stable body, dynamic system block and
 * meta-user context attachments. Adapted from ZCode v3.15.1 `core/src/context/builder.ts`
 * (Apache-2.0, see NOTICE.md). The skills listing (`sections/skills.ts`) is built by
 * the skills plugin and passed in, and so is the desktop context section (Gen UI,
 * `sections/desktop.ts`, interactive views only); memory and workflow actors are
 * omitted until their roadmap steps.
 */
import { buildCurrentDateSection, buildEnvInfoSection, buildGitSystemContextSection, buildRequestUserContextSection, type EnvInfo, type InstructionSource, type PromptModel } from "./env-sections.ts";
import { buildCliPrefixSection, buildContextManagementSection, buildDynamicBehaviorSection, buildIdentitySection, buildOutputStyleSection, buildSessionGuidanceSection, createSection, type ContextSection, type OutputStylePromptConfig } from "./sections.ts";

export interface ContextBuilderConfig {
  envInfo: EnvInfo;
  model?: PromptModel;
  currentDate?: string;
  instructions?: readonly InstructionSource[];
  customSystemPrompt?: string;
  outputStyle?: OutputStylePromptConfig;
  guidanceToolNames?: readonly string[];
  /** Product-specific host notes, appended to the dynamic system block. */
  hostNotes?: string;
  /** ZCode skills section body (plugin-built); only sent when the Skill tool is offered. */
  skillsListing?: string | null;
  /** ZCode's desktop context section (interactive views), host-built; stable system text before Dynamic Behavior. */
  desktopContext?: string | null;
}
export interface SystemMessage { role: "system"; content: string; cacheControl?: { type: "ephemeral" } }
export interface ContextMetaUserAttachment { source: "context_prefix" | "skills_listing"; content: string }
export interface ContextBuildResult {
  sections: ContextSection[];
  totalChars: number;
  totalTokens: number;
  systemMessages: SystemMessage[];
  metaUserAttachments: ContextMetaUserAttachment[];
}
const EPHEMERAL = { type: "ephemeral" } as const;

export function buildContext(config: ContextBuilderConfig): ContextBuildResult {
  const sections: ContextSection[] = [buildCliPrefixSection()];
  // ZCode `skillToolAvailable`: no listing without the Skill tool.
  const skills = config.skillsListing?.trim() && (config.guidanceToolNames === undefined || config.guidanceToolNames.includes("Skill")) ? config.skillsListing : null;
  const style = config.outputStyle?.prompt.trim() ? config.outputStyle : undefined;
  const custom = config.customSystemPrompt?.trim();
  if (custom) sections.push(createSection("Custom System Prompt", "custom_system_prompt", "system", "stable", `\n${custom}`));
  else {
    sections.push(buildIdentitySection(style));
    if (config.desktopContext?.trim()) sections.push(createSection("Xueness Desktop Context", "desktop_context", "system", "stable", config.desktopContext.trim()));
    sections.push(buildDynamicBehaviorSection());
    const guidance = buildSessionGuidanceSection(config.guidanceToolNames ?? [], skills !== null);
    if (guidance) sections.push(guidance);
    sections.push(buildEnvInfoSection(config.envInfo, config.model));
    const output = buildOutputStyleSection(style);
    if (output) sections.push(output);
    sections.push(buildContextManagementSection());
    const git = buildGitSystemContextSection(config.envInfo);
    if (git) sections.push(git);
    if (config.hostNotes?.trim()) sections.push(createSection("Host Notes", "host_notes", "system", "dynamic", config.hostNotes.trim()));
  }
  if (skills) sections.push(createSection("Skills", "skills", "meta_user", "dynamic", skills));
  const userContext = buildRequestUserContextSection(config.instructions);
  if (userContext) sections.push(userContext);
  const date = buildCurrentDateSection(config.currentDate);
  if (date) sections.push(date);
  const ordered = [
    ...sections.filter((s) => s.injectionTarget === "system" && s.cacheHint === "stable"),
    ...sections.filter((s) => s.injectionTarget === "system" && s.cacheHint === "dynamic"),
    ...sections.filter((s) => s.injectionTarget === "meta_user" && s.cacheHint === "stable"),
    ...sections.filter((s) => s.injectionTarget === "meta_user" && s.cacheHint === "dynamic"),
  ];
  const join = (list: ContextSection[]): string => list.map((s) => s.content).join("\n\n");
  const systemMessages: SystemMessage[] = [];
  const prefix = join(ordered.filter((s) => s.injectionTarget === "system" && s.source === "cli_prefix"));
  if (prefix) systemMessages.push({ role: "system", content: prefix });
  const stable = join(ordered.filter((s) => s.injectionTarget === "system" && s.cacheHint === "stable" && s.source !== "cli_prefix"));
  if (stable) systemMessages.push({ role: "system", content: stable, cacheControl: EPHEMERAL });
  const dynamic = join(ordered.filter((s) => s.injectionTarget === "system" && s.cacheHint === "dynamic"));
  if (dynamic) systemMessages.push({ role: "system", content: `\n\n${dynamic}`, cacheControl: EPHEMERAL });
  const listing = ordered.filter((s) => s.injectionTarget === "meta_user" && s.source === "skills").map((s) => s.content).join("\n\n");
  const meta = buildContextMetaUserBody(ordered.filter((s) => s.injectionTarget === "meta_user" && s.source !== "skills"));
  return {
    sections: ordered,
    totalChars: ordered.reduce((n, s) => n + s.chars, 0),
    totalTokens: ordered.reduce((n, s) => n + s.tokens, 0),
    systemMessages,
    metaUserAttachments: [...listing ? [{ source: "skills_listing" as const, content: listing }] : [], ...meta ? [{ source: "context_prefix" as const, content: meta }] : []],
  };
}
export function buildContextMetaUserBody(sections: ContextSection[]): string | null {
  if (!sections.length) return null;
  return [
    "As you answer the user's questions, you can use the following context:",
    sections.map((s) => s.content).join("\n\n"),
    "",
    "      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.",
  ].join("\n");
}
