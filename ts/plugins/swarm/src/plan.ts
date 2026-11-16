/**
 * The swarm plan the user approves once (owner decision, 2026-11-14).
 *
 * A plan names a coordinator, workers (including sharded groups via `tasks` or
 * `count`), and optional verifiers. Each member's brief says what it does, which
 * folders or files it owns, which commands it may run, and which channels it
 * follows. After approval the permission layer enforces `memberRules` under an
 * always-deny approver — also under full access, because ownership is a contract
 * between workers, not an approval.
 */
import { createHash } from "node:crypto";
import { isDict, pyJsonDumps } from "@xueness/contracts";

export const ROLES = ["coordinator", "worker", "verifier"] as const;
export type Role = (typeof ROLES)[number];
export interface ModelChoice { providerId: string; model: string | null }
export interface MemberPlan {
  name: string;
  role: Role;
  task: string;
  owns: string[];
  commands: string[];
  groups: string[];
  channels: string[];
  model: ModelChoice | null;
}
export type JudgeChoice = "inherit" | "off" | ModelChoice;
/**
 * `acceptance` is the done-contract: checkable statements agreed before any work starts. The verifier
 * grades each one separately and the swarm cannot be finished as completed until all are met.
 */
export interface SwarmPlan { goal: string; members: MemberPlan[]; judge: JudgeChoice; acceptance?: string[] }

export const PLAN_LIMITS = Object.freeze({ members: 6, owns: 12, commands: 8, groups: 4, channels: 6, task: 4000, goal: 2000, path: 300, command: 300, acceptance: 8, criterion: 300 });
export const NAME = /^[a-z][a-z0-9-]{0,23}$/;
/** Addresses the board keeps for itself. */
export const RESERVED_NAMES = new Set(["user", "all", "workers", "coordinator", "verifier", "system", "swarm"]);
const PROFILE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const GLOB = /[*?[\]{}]/;

export class PlanError extends Error { override name = "PlanError"; }

const text = (value: unknown, field: string, max: number, required = true): string => {
  if (value === undefined || value === null) { if (required) throw new PlanError(`${field} is required`); return ""; }
  if (typeof value !== "string") throw new PlanError(`${field} must be text`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new PlanError(`${field} must not be empty`);
  if (Array.from(trimmed).length > max) throw new PlanError(`${field} is limited to ${max} characters`);
  return trimmed;
};
const list = (value: unknown, field: string, max: number): unknown[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PlanError(`${field} must be a list`);
  if (value.length > max) throw new PlanError(`${field} is limited to ${max} entries`);
  return value;
};

export function normalizeModel(value: unknown, field: string): ModelChoice | null {
  if (value === undefined || value === null || value === "inherit") return null;
  if (!isDict(value)) throw new PlanError(`${field} must be {provider_id, model}`);
  const providerId = value.provider_id ?? value.providerId;
  if (typeof providerId !== "string" || !PROFILE_ID.test(providerId)) throw new PlanError(`${field}.provider_id must be a saved model profile id`);
  const model = value.model === undefined || value.model === null ? null : text(value.model, `${field}.model`, 200, false) || null;
  return { providerId, model };
}

/** A workspace-relative path with forward slashes, or a refusal. */
export function normalizeOwnedPath(value: unknown, field: string): string {
  const raw = text(value, field, PLAN_LIMITS.path).replace(/\\/g, "/");
  if (/^[A-Za-z]:/.test(raw) || raw.startsWith("/")) throw new PlanError(`${field} must be relative to the workspace`);
  const parts = raw.split("/").filter((part) => part && part !== ".");
  if (!parts.length) throw new PlanError(`${field} must name a folder or file inside the workspace, not the whole workspace`);
  if (parts.some((part) => part === "..")) throw new PlanError(`${field} must not contain ..`);
  if (GLOB.test(raw)) throw new PlanError(`${field} must be a plain folder or file path without wildcards`);
  if (parts.some((part) => /[\u0000-\u001f]/.test(part))) throw new PlanError(`${field} contains control characters`);
  return parts.join("/");
}

/** Whether two owned paths overlap: equal, or one inside the other (case-folded on Windows). */
export function pathsOverlap(a: string, b: string, foldCase: boolean): boolean {
  const x = foldCase ? a.toLowerCase() : a, y = foldCase ? b.toLowerCase() : b;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

function pathWithinApproved(path: string, approved: ReadonlySet<string>, foldCase: boolean): boolean {
  const norm = foldCase ? path.toLowerCase() : path;
  for (const item of approved) {
    const base = foldCase ? item.toLowerCase() : item;
    if (norm === base || norm.startsWith(`${base}/`)) return true;
  }
  return false;
}

/** Every overlapping pair across members, for one refusal that lists them all. */
export function ownershipOverlaps(members: readonly { name: string; owns: readonly string[] }[], foldCase: boolean): string[] {
  const out: string[] = [];
  for (let i = 0; i < members.length; i += 1) for (let j = i + 1; j < members.length; j += 1) {
    for (const a of members[i]!.owns) for (const b of members[j]!.owns) if (pathsOverlap(a, b, foldCase)) out.push(`${members[i]!.name}:${a} ↔ ${members[j]!.name}:${b}`);
  }
  return out;
}

export function normalizeChannelName(value: unknown, field: string): string {
  const name = text(value, field, 24).replace(/^#/, "").toLowerCase();
  if (name === "main") return "main";
  if (!NAME.test(name) || RESERVED_NAMES.has(name)) throw new PlanError(`${field} is not a usable channel name`);
  return name;
}

function expandShards(rawMembers: unknown[], limit: number): Record<string, unknown>[] {
  const expanded: Record<string, unknown>[] = [];
  for (let index = 0; index < rawMembers.length; index += 1) {
    const raw = rawMembers[index];
    const field = `members[${index}]`;
    if (!isDict(raw)) throw new PlanError(`${field} must be an object`);
    const hasTasks = raw.tasks !== undefined && raw.tasks !== null;
    const hasCount = raw.count !== undefined && raw.count !== null;
    if (!hasTasks && !hasCount) { expanded.push(raw); continue; }
    if (hasTasks && hasCount) throw new PlanError(`${field}: specify either tasks or count, not both`);
    if (raw.role !== "worker") throw new PlanError(`${field}: only workers can be sharded with tasks or count`);
    const baseName = text(raw.name, `${field}.name`, 20).toLowerCase();
    if (!NAME.test(baseName) || RESERVED_NAMES.has(baseName)) throw new PlanError(`${field}.name is not usable for sharding`);
    let slices: string[];
    if (hasTasks) {
      const items = list(raw.tasks, `${field}.tasks`, limit);
      if (!items.length) throw new PlanError(`${field}.tasks must not be empty`);
      slices = items.map((item, at) => text(item, `${field}.tasks[${at}]`, PLAN_LIMITS.task));
    } else {
      if (typeof raw.count !== "number" || !Number.isInteger(raw.count) || raw.count < 1 || raw.count > limit) {
        throw new PlanError(`${field}.count must be an integer from 1 to ${limit}`);
      }
      slices = Array.from({ length: raw.count }, (_, idx) => `Shard ${idx + 1} of ${raw.count}`);
    }
    const baseOwns = list(raw.owns, `${field}.owns`, limit * PLAN_LIMITS.owns);
    if (baseOwns.length && baseOwns.length !== slices.length) throw new PlanError(`${field}.owns must be empty or have one entry per shard (${slices.length})`);
    const baseGroups = Array.isArray(raw.groups) ? raw.groups : [];
    const baseTask = text(raw.task, `${field}.task`, PLAN_LIMITS.task, !hasTasks);
    for (let i = 0; i < slices.length; i += 1) {
      const shardOwns = !baseOwns.length ? [] : Array.isArray(baseOwns[i]) ? baseOwns[i] : [baseOwns[i]];
      const shardTask = baseTask && hasTasks ? `${baseTask}\n\nAssigned slice: ${slices[i]}` : hasTasks ? slices[i]! : `${baseTask} (${slices[i]})`;
      expanded.push({ ...raw, name: `${baseName}-${i + 1}`, task: shardTask, owns: shardOwns, groups: [...baseGroups, baseName], tasks: undefined, count: undefined });
    }
  }
  if (expanded.length > limit) throw new PlanError(`expanded members (${expanded.length}) exceed limit (${limit})`);
  return expanded;
}

export interface NormalizeOptions {
  foldCase: boolean;
  /** The permission layer's own check of a rule for a command subject; null when the rule is fine. */
  commandIssue(rule: string): string | null;
  maxMembers?: number;
}

export function normalizePlan(input: unknown, options: NormalizeOptions): SwarmPlan {
  if (!isDict(input)) throw new PlanError("the plan must be an object");
  const goal = text(input.goal, "goal", PLAN_LIMITS.goal);
  const limit = Math.min(PLAN_LIMITS.members, options.maxMembers ?? PLAN_LIMITS.members);
  const rawList = list(input.members, "members", limit);
  const rawMembers = expandShards(rawList, limit);
  if (rawMembers.length < 2) throw new PlanError("a swarm needs a coordinator and at least one worker");
  const names = new Set<string>();
  const members: MemberPlan[] = rawMembers.map((raw, index) => {
    const field = `members[${index}]`;
    const name = text(raw.name, `${field}.name`, 24).toLowerCase();
    if (!NAME.test(name)) throw new PlanError(`${field}.name must be lowercase letters, digits and hyphens, starting with a letter`);
    if (RESERVED_NAMES.has(name)) throw new PlanError(`${field}.name ${name} is reserved`);
    if (names.has(name)) throw new PlanError(`two members are named ${name}`);
    names.add(name);
    const role = raw.role;
    if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) throw new PlanError(`${field}.role must be coordinator, worker or verifier`);
    const owns = list(raw.owns, `${field}.owns`, PLAN_LIMITS.owns).map((path, at) => normalizeOwnedPath(path, `${field}.owns[${at}]`));
    if (role !== "worker" && owns.length) throw new PlanError(`${field}: only workers own paths; the ${role} reads and reports`);
    const commands = list(raw.commands, `${field}.commands`, PLAN_LIMITS.commands).map((command, at) => {
      const value = text(command, `${field}.commands[${at}]`, PLAN_LIMITS.command);
      if (/[\r\n]/.test(value)) throw new PlanError(`${field}.commands[${at}] must be one line`);
      const issue = options.commandIssue(`exec(${value})`);
      if (issue) throw new PlanError(`${field}.commands[${at}]: ${issue}`);
      return value;
    });
    const groups = list(raw.groups, `${field}.groups`, PLAN_LIMITS.groups).map((group, at) => {
      const value = text(group, `${field}.groups[${at}]`, 24).toLowerCase();
      if (!NAME.test(value) || RESERVED_NAMES.has(value)) throw new PlanError(`${field}.groups[${at}] is not a usable group name`);
      return value;
    });
    const rawChans = list(raw.channels, `${field}.channels`, PLAN_LIMITS.channels).map((chan, at) => normalizeChannelName(chan, `${field}.channels[${at}]`));
    const channels = role === "worker" ? [...new Set(["main", ...rawChans])] : [...new Set(["*", "main", ...rawChans])];
    return { name, role: role as Role, task: text(raw.task, `${field}.task`, PLAN_LIMITS.task), owns: [...new Set(owns)], commands: [...new Set(commands)], groups: [...new Set(groups)], channels, model: normalizeModel(raw.model, `${field}.model`) };
  });
  for (const group of new Set(members.flatMap((member) => member.groups))) if (names.has(group)) throw new PlanError(`group ${group} has the same name as a member`);
  if (members.filter((member) => member.role === "coordinator").length !== 1) throw new PlanError("a swarm needs exactly one coordinator");
  if (!members.some((member) => member.role === "worker")) throw new PlanError("a swarm needs at least one worker");
  const overlaps = ownershipOverlaps(members, options.foldCase);
  if (overlaps.length) throw new PlanError(`owned paths overlap: ${overlaps.slice(0, 8).join("; ")}`);
  let judge: JudgeChoice = "inherit";
  if (input.judge === "off" || input.judge === "inherit") judge = input.judge;
  else if (input.judge !== undefined && input.judge !== null) judge = normalizeModel(input.judge, "judge") ?? "inherit";
  const acceptance = [...new Set(list(input.acceptance, "acceptance", PLAN_LIMITS.acceptance).map((item, at) => text(item, `acceptance[${at}]`, PLAN_LIMITS.criterion)))];
  if (acceptance.length && !members.some((member) => member.role === "verifier")) throw new PlanError("acceptance criteria need a verifier to grade them");
  return { goal, members, judge, ...(acceptance.length ? { acceptance } : {}) };
}

/** Validate a path/command reassignment without widening the user-approved plan scope. */
export function validateReassignment(
  currentMembers: readonly { name: string; state?: string; owns: readonly string[] }[],
  targetName: string,
  nextOwns: readonly string[],
  nextCommands: readonly string[],
  approvedOwns: ReadonlySet<string>,
  approvedCommands: ReadonlySet<string>,
  foldCase: boolean,
): { owns: string[]; commands: string[] } {
  const normalizedOwns = [...new Set(nextOwns.map((p, i) => normalizeOwnedPath(p, `owns[${i}]`)))];
  if (normalizedOwns.length > PLAN_LIMITS.owns) throw new PlanError(`owns is limited to ${PLAN_LIMITS.owns} entries`);
  for (const p of normalizedOwns) {
    if (!pathWithinApproved(p, approvedOwns, foldCase)) throw new PlanError(`reassigned path ${p} was not approved in the swarm plan`);
  }
  const normalizedCmds = [...new Set(nextCommands.map((c, i) => text(c, `commands[${i}]`, PLAN_LIMITS.command)))];
  if (normalizedCmds.length > PLAN_LIMITS.commands) throw new PlanError(`commands is limited to ${PLAN_LIMITS.commands} entries`);
  for (const c of normalizedCmds) {
    if (!approvedCommands.has(c)) throw new PlanError(`reassigned command ${c} was not approved in the swarm plan`);
  }
  const peers = currentMembers.filter((m) => m.name !== targetName && m.state !== "killed");
  const overlaps = ownershipOverlaps([...peers, { name: targetName, owns: normalizedOwns }], foldCase);
  if (overlaps.length) throw new PlanError(`owned paths overlap: ${overlaps.slice(0, 8).join("; ")}`);
  return { owns: normalizedOwns, commands: normalizedCmds };
}

/** The allow rules a member runs under: its owned paths (and their contents) and its listed commands. */
export function memberRules(member: Pick<MemberPlan, "owns" | "commands">): string[] {
  return [...member.owns.map((path) => `edit(/${path})`), ...member.commands.map((command) => `exec(${command})`)];
}

export function planDigest(plan: SwarmPlan): string {
  return createHash("sha256").update(pyJsonDumps(plan, { sortKeys: true, separators: [",", ":"] })).digest("hex").slice(0, 16);
}

const ROLE_LABEL: Record<Role, string> = { coordinator: "协调者", worker: "工作者", verifier: "验证者" };
const modelLabel = (model: ModelChoice | null): string => (model ? `${model.providerId}${model.model ? ` / ${model.model}` : ""}` : "与当前会话相同");

/** The text the user approves: who does what, owns what and may run what. */
export function renderPlanSubject(plan: SwarmPlan): string {
  const lines = [`蜂群计划 ${planDigest(plan)}：${plan.goal}`];
  for (const member of plan.members) {
    const chans = member.channels.filter((c) => c !== "*" && c !== "main");
    lines.push(`@${member.name}（${ROLE_LABEL[member.role]}，模型：${modelLabel(member.model)}${chans.length ? `，频道：#${chans.join(" #")}` : ""}）`);
    lines.push(`  任务：${Array.from(member.task).slice(0, 240).join("")}${Array.from(member.task).length > 240 ? "…" : ""}`);
    lines.push(`  可写：${member.owns.length ? member.owns.join("、") : "无（只读）"}`);
    lines.push(`  可运行命令：${member.commands.length ? member.commands.join("；") : "无"}`);
  }
  const judge = plan.judge === "inherit" ? "沿用设置" : plan.judge === "off" ? "关闭" : modelLabel(plan.judge);
  lines.push(`工具调用判定：${judge}`);
  if (plan.acceptance?.length) {
    lines.push("验收标准（验证者逐条评定，全部满足后才能以「完成」结束）：");
    plan.acceptance.forEach((item, index) => lines.push(`  ${index + 1}. ${item}`));
  }
  lines.push("批准后每个成员只能写自己的路径、只能运行列出的命令（完全访问模式下也一样）。注意：列出的命令本身可能写入任何位置（例如构建输出）。");
  const out = lines.join("\n");
  return Array.from(out).length > 4000 ? Array.from(out).slice(0, 3999).join("") + "…" : out;
}
