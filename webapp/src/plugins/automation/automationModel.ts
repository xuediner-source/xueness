import type { AutomationRecord } from "../../xuenessApi";

export type ScheduleMode = "hourly" | "daily" | "weekdays" | "weekly" | "custom";

export type ScheduleDraft = {
  mode: ScheduleMode;
  minute: number;
  hour: number;
  weekday: number;
  custom: string;
};

export type WorkflowNodeDraft = {
  id: string;
  needs: string[];
  kind: "command" | "agent";
  cwd: string;
  timeout: number;
  argv: string[];
  prompt: string;
  provider_id: string;
  model: string;
  writable: boolean;
  phase: string;
};

export type AutomationDraft = {
  name: string;
  schedule: ScheduleDraft;
  timezone: string;
  enabled: boolean;
  root: string;
  workflowName: string;
  nodes: WorkflowNodeDraft[];
  concurrency: number;
};

const DEFAULT_SCHEDULE: ScheduleDraft = {
  mode: "daily",
  minute: 0,
  hour: 9,
  weekday: 1,
  custom: "0 9 * * 1-5",
};

function numericField(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return number >= min && number <= max ? number : null;
}

/** Convert the backend's five-field cron syntax into controls when it is common. */
export function scheduleDraftFromCron(expression: string): ScheduleDraft {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return { ...DEFAULT_SCHEDULE, mode: "custom", custom: expression };
  const [minuteText, hourText, dayOfMonth, month, dayOfWeek] = fields;
  const minute = numericField(minuteText, 0, 59);
  const hour = numericField(hourText, 0, 23);
  if (minute === null) return { ...DEFAULT_SCHEDULE, mode: "custom", custom: expression };
  if (hourText === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return { ...DEFAULT_SCHEDULE, mode: "hourly", minute, custom: expression };
  }
  if (hour === null || dayOfMonth !== "*" || month !== "*") {
    return { ...DEFAULT_SCHEDULE, mode: "custom", custom: expression };
  }
  if (dayOfWeek === "*") return { ...DEFAULT_SCHEDULE, mode: "daily", minute, hour, custom: expression };
  if (dayOfWeek === "1-5") return { ...DEFAULT_SCHEDULE, mode: "weekdays", minute, hour, custom: expression };
  const weekday = numericField(dayOfWeek, 0, 6);
  if (weekday !== null) return { ...DEFAULT_SCHEDULE, mode: "weekly", minute, hour, weekday, custom: expression };
  return { ...DEFAULT_SCHEDULE, mode: "custom", custom: expression };
}

function checkCronField(value: string, min: number, max: number): boolean {
  if (!value) return false;
  return value.split(",").every((chunk) => {
    if (!chunk) return false;
    const [base, stepText, ...extra] = chunk.split("/");
    if (extra.length > 0) return false;
    const step = stepText === undefined ? 1 : numericField(stepText, 1, max + 1);
    if (step === null) return false;
    if (base === "*") return true;
    const range = base.split("-");
    if (range.length === 2) {
      const first = numericField(range[0], min, max);
      const last = numericField(range[1], min, max);
      return first !== null && last !== null && first <= last;
    }
    return range.length === 1 && numericField(base, min, max) !== null;
  });
}

export function validateCron(expression: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return "时间表需要五个 Cron 字段。";
  const bounds: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  return fields.every((field, index) => checkCronField(field, ...bounds[index]))
    ? null
    : "Cron 字段超出范围或格式无效。";
}

export function cronFromScheduleDraft(draft: ScheduleDraft): string {
  if (draft.mode === "custom") {
    const expression = draft.custom.trim();
    const error = validateCron(expression);
    if (error) throw new Error(error);
    return expression;
  }
  if (!Number.isInteger(draft.minute) || draft.minute < 0 || draft.minute > 59) {
    throw new Error("分钟需要是 0 到 59 的整数。");
  }
  if (draft.mode === "hourly") return `${draft.minute} * * * *`;
  if (!Number.isInteger(draft.hour) || draft.hour < 0 || draft.hour > 23) {
    throw new Error("小时需要是 0 到 23 的整数。");
  }
  if (draft.mode === "daily") return `${draft.minute} ${draft.hour} * * *`;
  if (draft.mode === "weekdays") return `${draft.minute} ${draft.hour} * * 1-5`;
  if (!Number.isInteger(draft.weekday) || draft.weekday < 0 || draft.weekday > 6) {
    throw new Error("星期需要是 0 到 6 的整数。");
  }
  return `${draft.minute} ${draft.hour} * * ${draft.weekday}`;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function describeCronSchedule(
  expression: string,
  translate: (key: string) => string = (key) => key,
  format: (key: string, values: unknown[]) => string = (key, values) => key.replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)])),
): string {
  const schedule = scheduleDraftFromCron(expression);
  const clock = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  switch (schedule.mode) {
    case "hourly": return format("每小时第 {0} 分钟", [schedule.minute]);
    case "daily": return `${translate("每天")} · ${clock}`;
    case "weekdays": return `${translate("工作日")} · ${clock}`;
    case "weekly": return `${translate("每周")} ${translate(WEEKDAYS[schedule.weekday])} · ${clock}`;
    case "custom": return `${translate("自定义 Cron")} · ${expression}`;
  }
}

export function emptyAutomationDraft(): AutomationDraft {
  return {
    name: "",
    schedule: { ...DEFAULT_SCHEDULE },
    timezone: "Asia/Shanghai",
    enabled: false,
    root: "",
    workflowName: "",
    nodes: [],
    concurrency: 1,
  };
}

export function newWorkflowNode(id: string): WorkflowNodeDraft {
  return {
    id,
    needs: [],
    kind: "command",
    cwd: ".",
    timeout: 300,
    argv: [""],
    prompt: "",
    provider_id: "",
    model: "",
    writable: false,
    phase: "",
  };
}

export function automationDraftFromRecord(row: AutomationRecord): AutomationDraft {
  return {
    name: row.name,
    schedule: scheduleDraftFromCron(row.schedule),
    timezone: row.timezone,
    enabled: row.enabled,
    root: row.workflow.root,
    workflowName: row.workflow.name,
    concurrency: row.workflow.concurrency ?? 1,
    nodes: row.workflow.nodes.map((value, index) => {
      const node = value as Partial<WorkflowNodeDraft>;
      return {
        ...newWorkflowNode(typeof node.id === "string" ? node.id : `step-${index + 1}`),
        ...node,
        id: typeof node.id === "string" ? node.id : `step-${index + 1}`,
        needs: Array.isArray(node.needs) ? node.needs.filter((item): item is string => typeof item === "string") : [],
        kind: node.kind === "agent" ? "agent" : "command",
        cwd: typeof node.cwd === "string" ? node.cwd : ".",
        timeout: typeof node.timeout === "number" ? node.timeout : 300,
        argv: Array.isArray(node.argv) ? node.argv.filter((item): item is string => typeof item === "string") : [""],
        prompt: typeof node.prompt === "string" ? node.prompt : "",
        provider_id: typeof node.provider_id === "string" ? node.provider_id : "",
        model: typeof node.model === "string" ? node.model : "",
        writable: node.writable === true,
        phase: typeof node.phase === "string" ? node.phase : "",
      };
    }),
  };
}

export function workflowNodesForApi(nodes: WorkflowNodeDraft[]): Array<Record<string, unknown>> {
  return nodes.map((node) => {
    const value: Record<string, unknown> = {
      id: node.id.trim(),
      needs: node.needs,
      kind: node.kind,
      cwd: node.cwd.trim() || ".",
      timeout: node.timeout,
    };
    if (node.phase.trim()) value.phase = node.phase.trim();
    if (node.kind === "command") {
      value.argv = node.argv;
    } else {
      value.prompt = node.prompt;
      if (node.provider_id.trim()) value.provider_id = node.provider_id.trim();
      if (node.model.trim()) value.model = node.model.trim();
      value.writable = node.writable;
    }
    return value;
  });
}

export function validateAutomationDraft(draft: AutomationDraft): string | null {
  if (!draft.name.trim()) return "请填写计划名称。";
  if (draft.name.trim().length > 120) return "计划名称最多 120 个字符。";
  if (!draft.timezone.trim()) return "请填写时区。";
  if (!draft.root.trim()) return "请填写工作区路径。";
  if (!draft.workflowName.trim()) return "请填写工作流名称。";
  if (!Number.isInteger(draft.concurrency) || draft.concurrency < 1 || draft.concurrency > 8) {
    return "并发数需要是 1 到 8 的整数。";
  }
  try {
    cronFromScheduleDraft(draft.schedule);
  } catch (error) {
    return error instanceof Error ? error.message : "时间表无效。";
  }
  if (draft.nodes.length < 1 || draft.nodes.length > 64) return "工作流需要 1 到 64 个执行步骤。";
  const ids = new Set<string>();
  for (const node of draft.nodes) {
    if (node.id !== node.id.trim() || !/^[A-Za-z0-9_-]{1,64}$/.test(node.id)) return "步骤 ID 只能包含英文字母、数字、下划线或连字符。";
    if (ids.has(node.id.trim())) return "步骤 ID 不能重复。";
    ids.add(node.id.trim());
    if (!Number.isInteger(node.timeout) || node.timeout < 1 || node.timeout > 3600) return "步骤超时需要是 1 到 3600 秒。";
    if (!node.cwd.trim()) return "请为每个步骤填写工作目录。";
    if (node.kind === "command" && (!node.argv.length || !node.argv[0]?.trim())) return "命令步骤需要填写可执行命令。";
    if (node.kind === "command" && node.argv.length > 128) return "命令最多包含 128 个参数。";
    if (node.kind === "agent" && (!node.prompt.trim() || node.prompt.length > 5000)) return "代理步骤需要填写 1 到 5000 个字符的提示词。";
    if (node.kind === "agent" && node.writable !== true && node.writable !== false) return "代理步骤的文件写入选项无效。";
  }
  for (const node of draft.nodes) {
    if (new Set(node.needs).size !== node.needs.length) return "每个步骤不能重复依赖同一个步骤。";
    if (node.needs.some((dependency) => !ids.has(dependency) || dependency === node.id.trim())) return "步骤依赖必须指向其他已存在的步骤。";
  }
  const completed = new Set<string>();
  while (completed.size < ids.size) {
    const ready = draft.nodes.filter((node) => !completed.has(node.id.trim()) && node.needs.every((dependency) => completed.has(dependency)));
    if (ready.length === 0) return "步骤依赖中有循环，无法运行。";
    for (const node of ready) completed.add(node.id.trim());
  }
  return null;
}
