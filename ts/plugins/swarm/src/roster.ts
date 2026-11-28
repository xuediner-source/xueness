/**
 * Dynamic mid-flight roster management modelled on Antigravity's `swarm`
 * (`add`, `title`, `models`, `fork`, and worker-added helpers),
 * while preserving Xueness's user-approved scope ceiling (`approvedOwns`,
 * `approvedCommands`, `approvedModels`) for non-user callers.
 */
import {
  NAME, normalizeChannelName, normalizeModel, normalizeOwnedPath,
  ownershipOverlaps, pathWithinApproved, PLAN_LIMITS, PlanError, RESERVED_NAMES, validateReassignment,
  type ModelChoice, type Role,
} from "./plan.ts";
import { SwarmServiceError } from "./service.ts";
import { TERMINAL, type MemberRecord, type SwarmRecord } from "./store.ts";

export interface SwarmModelOption {
  providerId: string;
  model: string | null;
  name?: string;
  source?: string;
}

export interface AddMemberInput {
  name: string;
  role?: Role;
  task?: string;
  tasks?: readonly string[];
  count?: number;
  n?: number;
  owns?: readonly unknown[];
  commands?: readonly string[];
  groups?: readonly string[];
  channels?: readonly string[];
  fork?: string;
  model?: unknown;
}

const clip = (text: string, max: number): string => (Array.from(text).length <= max ? text : Array.from(text).slice(0, max - 1).join("") + "…");

export function checkKillPermission(record: SwarmRecord, target: MemberRecord, by: string): void {
  if (target.role === "coordinator") {
    throw new SwarmServiceError(400, "the coordinator cannot be killed; stop the swarm instead");
  }
  if (by === "user") return;
  const caller = record.members.find((m) => m.name === by);
  if (!caller) throw new SwarmServiceError(403, `unknown caller @${by}`);
  if (caller.role === "coordinator") return;
  if (caller.role === "worker" && target.role === "worker" && target.addedBy === caller.name) return;
  throw new SwarmServiceError(403, "a worker may stop only helpers it added; ask @coordinator on the board");
}

export function checkModelSwitchPermission(record: SwarmRecord, target: MemberRecord, by: string): void {
  if (by === "user") return;
  const caller = record.members.find((m) => m.name === by);
  if (!caller) throw new SwarmServiceError(403, `unknown caller @${by}`);
  if (caller.role === "coordinator") return;
  if (target.name === caller.name) return;
  if (caller.role === "worker" && target.role === "worker" && target.addedBy === caller.name) return;
  throw new SwarmServiceError(403, "a worker may switch only its own model or helpers it added");
}

export function applySwarmTitle(record: SwarmRecord, rawTitle: string, by: string): void {
  if (TERMINAL.has(record.status)) throw new SwarmServiceError(409, `the swarm is ${record.status}`);
  if (by !== "user" && by !== "parent") {
    const caller = record.members.find((m) => m.name === by);
    if (!caller || caller.role !== "coordinator") {
      throw new SwarmServiceError(403, "only the coordinator or user sets the swarm title");
    }
  }
  const trimmed = typeof rawTitle === "string" ? rawTitle.trim() : "";
  if (!trimmed) throw new SwarmServiceError(400, "title must not be empty");
  record.title = clip(trimmed, 120);
}

export function applyMemberReassignment(
  record: SwarmRecord,
  source: MemberRecord,
  target: MemberRecord,
  input: { from: string; to: string; task?: string; owns?: readonly string[]; commands?: readonly string[]; fork?: boolean; model?: ModelChoice | null },
  by: string,
  options: { foldCase: boolean; commandIssue?(rule: string): string | null; requireApprovedModel(model: ModelChoice | null, by: string): void },
): string {
  if (source.role === "coordinator" || target.role === "coordinator") throw new SwarmServiceError(400, "the coordinator cannot participate in task reassignment");
  if (target.state === "killed") throw new SwarmServiceError(409, `target member @${target.name} is killed`);
  const byUser = by === "user";
  if (!byUser && source.role !== "worker") throw new SwarmServiceError(403, `only the user can reassign a ${source.role}; ask on the board`);
  if (input.model !== undefined) options.requireApprovedModel(input.model, by);
  const rawOwns = input.owns ?? [...new Set([...target.owns, ...source.owns])];
  const rawCommands = input.commands ?? [...new Set([...target.commands, ...source.commands])];
  if (target.role !== "worker" && rawOwns.length) throw new SwarmServiceError(400, `only workers own paths; @${target.name} is a ${target.role}`);
  const approvedOwns = new Set(byUser ? record.approvedOwns ?? record.members.flatMap((m) => m.owns) : [...source.owns, ...target.owns]);
  const approvedCommands = new Set(byUser ? record.approvedCommands ?? record.members.flatMap((m) => m.commands) : [...source.commands, ...target.commands]);
  let validated: { owns: string[]; commands: string[] };
  try {
    validated = validateReassignment(record.members.map((m) => m === source ? { ...m, state: "killed" } : m), target.name, rawOwns, rawCommands, approvedOwns, approvedCommands, options.foldCase);
  } catch (error) {
    throw new SwarmServiceError(error instanceof PlanError ? 400 : 500, (error as Error).message);
  }
  for (const cmd of validated.commands) {
    const issue = options.commandIssue?.(`exec(${cmd})`);
    if (issue) throw new SwarmServiceError(400, `reassigned command ${cmd}: ${issue}`);
  }
  source.state = "killed"; source.error = clip(`reassigned to @${target.name}`, 300); source.failureKind = null;
  target.owns = validated.owns; target.commands = validated.commands;
  target.error = null; target.failureKind = null;
  if (target.state === "done") target.state = "waiting";
  const brief = input.task?.trim() ? clip(input.task.trim(), PLAN_LIMITS.task) : "";
  if (brief) target.task = brief;
  if (input.model !== undefined) target.model = input.model;
  if (input.fork && source.sessionId && !target.sessionId && !target.forkFromSessionId) target.forkFromSessionId = source.sessionId;
  return `Task reassigned from @${source.name} to @${target.name} by ${byUser ? "the user" : `@${by}`}.${target.owns.length ? ` Owned paths: ${target.owns.join(", ")}.` : ""}${brief ? ` Task: ${clip(brief, 800)}` : ""}`;
}

function resolveForkSession(record: SwarmRecord, forkSpec: string | undefined): string | null {
  if (!forkSpec || !forkSpec.trim()) return null;
  const clean = forkSpec.trim().replace(/^@/, "").toLowerCase();
  const source = clean === "coordinator"
    ? record.members.find((m) => m.role === "coordinator")
    : record.members.find((m) => m.name === clean);
  if (!source) throw new SwarmServiceError(404, `fork source @${clean} not found in this swarm`);
  return source.sessionId ?? null;
}

export function prepareAddedMembers(
  record: SwarmRecord,
  input: AddMemberInput,
  by: string,
  options: {
    maxMembers: number;
    foldCase: boolean;
    commandIssue?(rule: string): string | null;
    requireApprovedModel(model: ModelChoice | null, by: string): void;
  },
): { added: MemberRecord[]; briefText: string; postFrom: string } {
  if (TERMINAL.has(record.status)) throw new SwarmServiceError(409, `the swarm is ${record.status}`);
  const byUser = by === "user";
  const caller = byUser || by === "parent" ? null : record.members.find((m) => m.name === by) ?? null;
  if (!byUser && by !== "parent" && !caller) throw new SwarmServiceError(403, `unknown caller @${by}`);
  if (caller?.role === "verifier") throw new SwarmServiceError(403, "verifiers cannot add swarm members");

  const role: Role = input.role ?? "worker";
  if (role === "coordinator") throw new SwarmServiceError(400, "a swarm already has a coordinator");
  if (role === "verifier" && !byUser) throw new SwarmServiceError(403, "only the user can add a verifier");

  const rawBaseName = typeof input.name === "string" ? input.name.trim().replace(/^@/, "").toLowerCase() : "";
  if (!NAME.test(rawBaseName) || RESERVED_NAMES.has(rawBaseName)) {
    throw new PlanError(`name "${rawBaseName}" must be lowercase letters, digits and hyphens, starting with a letter`);
  }

  const count = input.count ?? input.n;
  const hasTasks = Array.isArray(input.tasks) && input.tasks.length > 0;
  const hasCount = count !== undefined && count !== null;
  if (hasTasks && hasCount) throw new PlanError("specify either tasks or count/n, not both");
  if ((hasTasks || hasCount) && role !== "worker") throw new PlanError("only workers can be sharded with tasks or count");

  let slices: string[] | null = null;
  if (hasTasks) {
    if (input.tasks!.length > options.maxMembers) throw new PlanError(`tasks is limited to ${options.maxMembers} entries`);
    slices = input.tasks!.map((item, idx) => {
      if (typeof item !== "string" || !item.trim()) throw new PlanError(`tasks[${idx}] must be non-empty text`);
      return clip(item.trim(), PLAN_LIMITS.task);
    });
  } else if (hasCount) {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > options.maxMembers) {
      throw new PlanError(`count must be an integer from 1 to ${options.maxMembers}`);
    }
    if (count > 1) slices = Array.from({ length: count }, (_, idx) => `Shard ${idx + 1} of ${count}`);
  }

  const baseTask = typeof input.task === "string" ? clip(input.task.trim(), PLAN_LIMITS.task) : "";
  if (!baseTask && !slices) throw new PlanError("task is required");

  const model = normalizeModel(input.model, "model");
  options.requireApprovedModel(model, byUser ? "user" : by);

  const forkSessionId = resolveForkSession(record, input.fork);
  const existingNames = new Set(record.members.map((m) => m.name));
  const existingGroups = new Set(record.members.flatMap((m) => m.groups));

  const approvedOwns = new Set(
    byUser
      ? []
      : caller?.role === "worker"
        ? caller.owns
        : (record.approvedOwns ?? record.members.flatMap((m) => m.owns)),
  );
  const approvedCommands = new Set(
    byUser
      ? []
      : caller?.role === "worker"
        ? caller.commands
        : (record.approvedCommands ?? record.members.flatMap((m) => m.commands)),
  );

  const rawCommands = input.commands ?? (caller?.role === "worker" ? caller.commands : []);
  const commands = [...new Set(rawCommands.map((cmd, idx) => {
    if (typeof cmd !== "string" || !cmd.trim() || /[\r\n]/.test(cmd)) throw new PlanError(`commands[${idx}] must be one non-empty line`);
    const clean = clip(cmd.trim(), PLAN_LIMITS.command);
    const issue = options.commandIssue?.(`exec(${clean})`);
    if (issue) throw new PlanError(`commands[${idx}]: ${issue}`);
    if (!byUser && !approvedCommands.has(clean)) {
      throw new SwarmServiceError(403, `command "${clean}" was not approved in the swarm plan`);
    }
    return clean;
  }))];
  if (commands.length > PLAN_LIMITS.commands) throw new PlanError(`commands is limited to ${PLAN_LIMITS.commands} entries`);

  const rawChannels = (input.channels ?? []).map((c, idx) => normalizeChannelName(c, `channels[${idx}]`));
  const channels = role === "worker" ? [...new Set(["main", ...rawChannels])] : [...new Set(["*", "main", ...rawChannels])];
  const rawGroups = (input.groups ?? []).map((g, idx) => {
    const val = typeof g === "string" ? g.trim().toLowerCase() : "";
    if (!NAME.test(val) || RESERVED_NAMES.has(val)) throw new PlanError(`groups[${idx}] is not a usable group name`);
    return val;
  });

  const specs: { name: string; task: string; ownsRaw: unknown[]; groups: string[] }[] = [];
  if (slices) {
    const rawOwns = Array.isArray(input.owns) ? input.owns : [];
    if (rawOwns.length && rawOwns.length !== slices.length) {
      throw new PlanError(`owns must be empty or have one entry per shard (${slices.length})`);
    }
    for (let i = 0; i < slices.length; i += 1) {
      const shardName = `${rawBaseName}-${i + 1}`;
      const shardOwns = !rawOwns.length ? [] : Array.isArray(rawOwns[i]) ? (rawOwns[i] as unknown[]) : [rawOwns[i]];
      const shardTask = baseTask && hasTasks ? `${baseTask}\n\nAssigned slice: ${slices[i]}` : hasTasks ? slices[i]! : `${baseTask} (${slices[i]})`;
      specs.push({ name: shardName, task: shardTask, ownsRaw: shardOwns, groups: [...new Set([...rawGroups, rawBaseName])] });
    }
  } else {
    specs.push({
      name: rawBaseName,
      task: baseTask,
      ownsRaw: Array.isArray(input.owns) ? [...input.owns] : [],
      groups: [...new Set(rawGroups)],
    });
  }

  const aliveCount = record.members.filter((m) => m.state !== "killed").length;
  if (aliveCount + specs.length > options.maxMembers) {
    throw new SwarmServiceError(400, `active swarm members (${aliveCount + specs.length}) would exceed maxMembers (${options.maxMembers})`);
  }

  const added: MemberRecord[] = [];
  for (const spec of specs) {
    if (!NAME.test(spec.name) || RESERVED_NAMES.has(spec.name)) throw new PlanError(`name ${spec.name} is invalid or reserved`);
    if (existingNames.has(spec.name) || existingGroups.has(spec.name)) throw new PlanError(`member or group @${spec.name} already exists`);
    for (const grp of spec.groups) if (existingNames.has(grp)) throw new PlanError(`group ${grp} collides with an existing member name`);
    const owns = [...new Set(spec.ownsRaw.map((p, idx) => normalizeOwnedPath(p, `${spec.name}.owns[${idx}]`)))];
    if (role !== "worker" && owns.length) throw new PlanError(`only workers own paths`);
    if (owns.length > PLAN_LIMITS.owns) throw new PlanError(`owns is limited to ${PLAN_LIMITS.owns} entries`);
    if (!byUser) {
      for (const p of owns) {
        if (!pathWithinApproved(p, approvedOwns, options.foldCase)) {
          throw new SwarmServiceError(403, `path "${p}" is outside the approved scope`);
        }
      }
    }
    existingNames.add(spec.name);
    const reportTarget = caller?.role === "worker" ? `@${caller.name}` : "@coordinator";
    const taskWithReporting = caller?.role === "worker" ? `${spec.task}\n\n(Helper added by ${reportTarget}: report results back to ${reportTarget} on the board.)` : spec.task;
    added.push({
      name: spec.name,
      role,
      task: clip(taskWithReporting, PLAN_LIMITS.task),
      owns,
      commands,
      groups: spec.groups,
      channels,
      model,
      sessionId: null,
      state: "waiting",
      delivered: 0,
      turns: 0,
      steps: 0,
      summary: "",
      lastActiveAt: null,
      error: null,
      wakeMode: "mentions",
      failureKind: null,
      forkFromSessionId: forkSessionId,
      addedBy: byUser ? "user" : (caller?.name ?? "coordinator"),
    });
  }

  const activePeers = record.members.filter((m) => m.state !== "killed");
  const overlaps = ownershipOverlaps([...activePeers, ...added], options.foldCase);
  if (overlaps.length) throw new PlanError(`owned paths overlap: ${overlaps.slice(0, 8).join("; ")}`);

  const recordChannels = record.channels ? [...record.channels] : [{ name: "main", topic: "General swarm board", createdBy: "system" }];
  for (const member of added) {
    for (const chan of member.channels) {
      if (chan !== "*" && chan !== "main" && !recordChannels.some((c) => c.name === chan)) {
        recordChannels.push({ name: chan, topic: "", createdBy: member.name });
      }
    }
  }
  record.channels = recordChannels;

  if (byUser) {
    record.approvedOwns = [...new Set([...(record.approvedOwns ?? []), ...added.flatMap((m) => m.owns)])];
    record.approvedCommands = [...new Set([...(record.approvedCommands ?? []), ...commands])];
    if (model) {
      const models = record.approvedModels ?? [];
      if (!models.some((item) => item.providerId === model.providerId && (item.model ?? null) === (model.model ?? null))) {
        record.approvedModels = [...models, { providerId: model.providerId, model: model.model ?? null }];
      }
    }
  }

  const coordinatorName = record.members.find((m) => m.role === "coordinator")?.name ?? "user";
  const postFrom = byUser ? "user" : (caller?.name ?? coordinatorName);
  const mentions = added.map((m) => `@${m.name}`).join(" ");
  const forkBadge = input.fork ? ` [forked from @${input.fork.replace(/^@/, "")}]` : "";
  const briefText = `${mentions}${forkBadge} — Assignment: ${clip(baseTask || slices![0]!, 1200)}`;
  return { added, briefText, postFrom };
}
