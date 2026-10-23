/**
 * Agent types the model can pick (ZCode v3.15.1, aac4755, Apache-2.0:
 * `core/src/subagent/{profile,general-purpose,explore,explore-tools,system-prompt,listing,tool-policy}.ts`;
 * product name replaced). The built-in general-purpose and Explore profiles
 * come first, then ZCode's plugin agent `visual-judge` (shipped verbatim in
 * `bundled/visual-judge.md`; its model and thought level are ZCode's own and
 * stay unused); a stored definition with the same name replaces one, as in
 * ZCode `normalizeAgentProfiles`. Stored definitions keep Python's fields.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDict, pyStrip } from "@xueness/contracts";
import { agentDisallowed, agentPromptText, clip, PROMPT_MAX_CHARS, type Row } from "./definitions.ts";

export const GENERAL_PURPOSE_AGENT_TYPE = "general-purpose";
export const EXPLORE_AGENT_TYPE = "Explore";
export const EXPLORE_AGENT_ALLOWED_TOOLS = ["Bash", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "TodoWrite"] as const;
const EXPLORE_DESCRIPTION_PRIORITY = ["Glob", "Grep", "Read", "Bash", "WebFetch", "WebSearch", "TodoWrite"];
/** ZCode `SUBAGENT_CHILD_FORCED_DISALLOWED_TOOLS`. */
export const CHILD_FORCED_DISALLOWED = ["EnterPlanMode", "ExitPlanMode"] as const;

export interface AgentProfile {
  name: string;
  description: string;
  systemPrompt: string;
  /** Model-visible or Xueness tool names; undefined inherits, `["*"]` is every tool. */
  tools?: readonly string[];
  disallowedTools?: readonly string[];
  source: "built-in" | "resource";
  /** The stored definition (Python fields: model selection, tools). */
  definition?: Row;
}

export function buildGeneralPurposeSystemPrompt(): string {
  return [
    "You are an agent for Xueness. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done. When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.",
    "",
    "Your strengths:",
    "- Searching for code, configurations, and patterns across large codebases",
    "- Analyzing multiple files to understand system architecture",
    "- Investigating complex questions that require exploring many files",
    "- Performing multi-step research tasks",
    "",
    "Guidelines:",
    "- For file searches: search broadly when you don't know where something lives. Use Read when you know the specific file path.",
    "- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.",
    "- Be thorough: Check multiple locations, consider different naming conventions, look for related files.",
    "- NEVER create files unless they're absolutely necessary for achieving your goal. ALWAYS prefer editing an existing file to creating a new one.",
    "- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested.",
  ].join("\n");
}

export function buildExploreAgentPrompt(): string {
  return [
    "You are Xueness Explore, a file search and codebase research specialist for Xueness. You excel at thoroughly navigating and exploring codebases.",
    "",
    "=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===",
    "This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from:",
    "- Creating new files (no Write, touch, or file creation of any kind)",
    "- Modifying existing files (no Edit operations)",
    "- Deleting files (no rm or deletion)",
    "- Moving or copying files (no mv or cp)",
    "- Creating temporary files anywhere, including /tmp",
    "- Using redirect operators (>, >>, |) or heredocs to write to files",
    "- Running ANY commands that change system state",
    "",
    "Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools - attempting to edit files will fail.",
    "",
    "Your strengths:",
    "- Rapidly finding files using glob patterns",
    "- Searching code and text with powerful regex patterns",
    "- Reading and analyzing file contents",
    "",
    "Guidelines:",
    "- Use Glob for broad file pattern matching",
    "- Use Grep for searching file contents with regex",
    "- Use Read when you know the specific file path you need to read",
    "- Use Bash ONLY for read-only operations (ls, git status, git log, git diff, find, cat, head, tail)",
    "- NEVER use Bash for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification",
    "- Adapt your search approach based on the thoroughness level specified by the caller",
    "- Communicate your final report directly as a regular message - do NOT attempt to create files",
    "",
    "NOTE: You are meant to be a fast agent that returns output as quickly as possible. In order to achieve this you must:",
    "- Make efficient use of the tools that you have at your disposal: be smart about how you search for files and implementations",
    "- Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files",
    "",
    "Complete the user's search request efficiently and report your findings clearly.",
  ].join("\n");
}

export function buildSubagentCommonNotes(): string {
  return [
    "Notes:",
    "- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.",
    "- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.",
    "- For clear communication with the user the assistant MUST avoid using emojis.",
    '- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.',
    "- Do NOT Write report/summary/findings/analysis .md files. Return findings directly as your final assistant message — the parent agent reads your text output, not files you create.",
  ].join("\n");
}

export interface SubagentEnv { cwd: string; isGitRepository: boolean; platform: string; shell: string; osVersion: string; model?: { providerId: string; modelId: string } }
export function buildSubagentEnvironmentContext(env: SubagentEnv): string {
  return [
    "Here is useful information about the environment you are running in:",
    "<env>",
    `Working directory: ${env.cwd}`,
    `Is directory a git repo: ${env.isGitRepository ? "Yes" : "No"}`,
    `Platform: ${env.platform}`,
    `Shell: ${env.shell}`,
    `OS Version: ${env.osVersion}`,
    "</env>",
    ...env.model ? [`You are powered by the model named ${env.model.providerId}/${env.model.modelId}.`] : [],
  ].join("\n");
}

/** Xueness: every child runs under the plan-mode ceiling (Python `read_only`). */
export const READ_ONLY_NOTE = "This delegated task is read-only. Inspect and report; do not edit, write, execute state-changing commands or delegate.";

/** ZCode subagent context sections, joined into the child's one system message. */
export function childSystemPrompt(profile: AgentProfile, env: SubagentEnv, cliPrefix: string): string {
  const agentPrompt = profile.systemPrompt.trimEnd();
  return cliPrefix + (agentPrompt ? `\n${agentPrompt}` : "") + `\n\n${buildSubagentCommonNotes()}` + `\n\n${READ_ONLY_NOTE}` + `\n\n${buildSubagentEnvironmentContext(env)}`;
}

export const VISUAL_JUDGE_AGENT_TYPE = "visual-judge";
const VISUAL_JUDGE_FILE = join(import.meta.dirname, "..", "bundled", "visual-judge.md");
let visualJudge: AgentProfile | null = null;

/** ZCode's documents-plugin `visual-judge` agent: frontmatter name, description and tools; the body is its prompt. */
export function visualJudgeProfile(): AgentProfile {
  if (visualJudge) return visualJudge;
  const text = readFileSync(VISUAL_JUDGE_FILE, "utf8").replace(/\r\n?/g, "\n");
  const parts = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  const field = (name: string): string | undefined => parts ? new RegExp(`^${name}:[ \\t]*(.*)$`, "m").exec(parts[1]!)?.[1]?.trim() : undefined;
  const description = field("description"), tools = field("tools");
  if (!parts || field("name") !== VISUAL_JUDGE_AGENT_TYPE || !description?.startsWith('"') || !tools?.startsWith("[")) throw new Error("bundled visual-judge agent is malformed");
  visualJudge = { name: VISUAL_JUDGE_AGENT_TYPE, source: "built-in", description: JSON.parse(description) as string, systemPrompt: parts[2]!.trim(),
    tools: tools.slice(1, -1).split(",").map((tool) => tool.trim()).filter(Boolean) };
  return visualJudge;
}

export function builtInProfiles(): AgentProfile[] {
  return [
    { name: GENERAL_PURPOSE_AGENT_TYPE, source: "built-in", tools: ["*"], systemPrompt: buildGeneralPurposeSystemPrompt(),
      description: "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you." },
    { name: EXPLORE_AGENT_TYPE, source: "built-in", tools: [...EXPLORE_AGENT_ALLOWED_TOOLS], systemPrompt: buildExploreAgentPrompt(),
      description: 'Read-only search agent for broad fan-out searches - when answering means sweeping many files, directories, or naming conventions and you only need the conclusion, not the file dumps. It reads excerpts rather than whole files, so it locates code; it doesn\'t review or audit it. Specify search breadth: "medium" for moderate exploration, "very thorough" for multiple locations and naming conventions.' },
    visualJudgeProfile(),
  ];
}

/** A stored definition as a ZCode profile; its instructions clipped to Python's prompt budget. */
export function resourceProfile(agent: Row): AgentProfile {
  const tools = Array.isArray(agent.tools) ? agent.tools.filter((tool): tool is string => typeof tool === "string").map(pyStrip) : agent.tools === undefined || agent.tools === null ? undefined : [];
  const description = typeof agent.description === "string" && pyStrip(agent.description) ? pyStrip(agent.description) : String(agent.name);
  return { name: String(agent.name), description, systemPrompt: clip(agentPromptText(agent), PROMPT_MAX_CHARS), ...tools ? { tools } : {},
    disallowedTools: [...agentDisallowed(agent)], source: "resource", definition: agent };
}

/** ZCode `normalizeAgentProfiles`: built-ins, then stored definitions replacing by name. */
export function activeProfiles(agents: readonly Row[]): AgentProfile[] {
  const active = new Map<string, AgentProfile>();
  for (const profile of builtInProfiles()) active.set(profile.name, profile);
  for (const agent of agents) if (isDict(agent)) active.set(String(agent.name), resourceProfile(agent));
  return [...active.values()];
}

/** The profile `subagent_type` names: exact, then case-insensitive, then Python's ids (`explore`, `general_purpose`, stored ids). */
export function findProfile(agents: readonly Row[], type: string | undefined): AgentProfile | null {
  const profiles = activeProfiles(agents);
  if (type === undefined) return profiles.find((profile) => profile.name === GENERAL_PURPOSE_AGENT_TYPE)!;
  const wanted = pyStrip(type);
  if (!wanted) return null;
  const exact = profiles.find((profile) => profile.name === wanted);
  if (exact) return exact;
  const byId = agents.find((agent) => isDict(agent) && (agent.id === wanted || String(agent.id).toLowerCase() === wanted.toLowerCase()));
  if (byId) return profiles.find((profile) => profile.definition === byId) ?? resourceProfile(byId);
  const folded = wanted.toLowerCase() === "general_purpose" ? GENERAL_PURPOSE_AGENT_TYPE.toLowerCase() : wanted.toLowerCase();
  return profiles.find((profile) => profile.name.toLowerCase() === folded) ?? null;
}

const INITIAL_HEADING = "Available agent types for the Agent tool:";

/**
 * ZCode `formatAgentProfileForPrompt`, with each type's tools as the child
 * actually gets them (`available` model names; ZCode lists its own tool set).
 */
export function formatProfileLine(profile: AgentProfile, available: readonly string[]): string {
  let tools: readonly string[] | undefined;
  if (profile.source === "built-in" && profile.name === EXPLORE_AGENT_TYPE) {
    const allowed = new Set(available);
    tools = EXPLORE_DESCRIPTION_PRIORITY.filter((tool) => allowed.has(tool));
  } else if (profile.tools) {
    const denied = new Set([...CHILD_FORCED_DISALLOWED, ...profile.disallowedTools ?? []].map((name) => name.toLowerCase()));
    tools = profile.tools.filter((tool) => !denied.has(tool.toLowerCase()));
  }
  const text = tools?.join(", ");
  return `- ${profile.name}: ${profile.description}${text ? ` (Tools: ${text})` : ""}`;
}

/**
 * ZCode `agent_listing_delta` as a full listing on every request (the journal
 * never holds it, so compaction cannot drop it). Agents run one after another
 * here, so ZCode's "send them in a single message … concurrently" note is left out.
 */
export function agentListing(agents: readonly Row[], available: readonly string[]): string {
  const profiles = activeProfiles(agents).sort((a, b) => a.name.localeCompare(b.name));
  return `${INITIAL_HEADING}\n${profiles.map((profile) => formatProfileLine(profile, available)).join("\n")}`;
}
