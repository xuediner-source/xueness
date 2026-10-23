import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { isDict, pyLen, pyStrip, uuid4Hex } from "@xueness/contracts";
import { attachmentMetadata, type Attachment, type SessionStore, withAttachments } from "@xueness/sessions";
import { MessageQueue } from "./queue.ts";
import { SteeringInbox } from "./steering.ts";
import { snapshot } from "./composer-attachments.ts";
import { listWorkspacePaths } from "./tui-files.ts";
import { readClipboardPng, writeClipboardText } from "./tui-clipboard.ts";
import type { TuiAttachment, TuiChoice, TuiMenuKind, TuiPort, TuiQueuedInput, TuiRow, TuiSidebar, TuiSnapshot } from "./tui-types.ts";

export interface TuiSessionPortOptions {
  store: SessionStore;
  stateDir: string;
  root(): string;
  sessionId(): string | null;
  enabled(id: string): boolean;
  commands(): readonly TuiChoice[];
  selection(): { providerId?: string | null; model?: string | null; effort?: string | null };
  reasoningLevels?(): readonly string[];
  api(method: string, path: string, data?: TuiRow): Promise<[number, TuiRow]>;
  setMode(mode: string): Promise<string>;
  stop(): void;
  workflows?(): Promise<readonly TuiRow[]>;
}

const sha256 = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const row = (value: unknown): TuiRow => isDict(value) ? value : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const validNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const relevantStateFile = (filename: string | Buffer | null): boolean => {
  if (filename == null) return false;
  const parts = filename.toString().replace(/\\/gu, "/").split("/").filter(Boolean).map((part) => part.toLowerCase());
  const leaf = parts.at(-1) ?? "";
  if (/\.(?:lock|runner|tmp)$/u.test(leaf) || leaf.startsWith(".workflow-") || leaf.startsWith(".queue-")) return false;
  const sessionJournal = /^[0-9a-f]{32}\.(?:json|jsonl|journal)$/u.test(leaf);
  if (sessionJournal && (parts.length === 1 || parts.some((part) => ["sessions", "deleted-sessions", "subagent-sessions", "journal"].includes(part)))) return true;
  const workflowLog = parts.includes("workflows") && leaf.endsWith(".log");
  if (!workflowLog && !/\.(?:json|jsonl|journal)$/u.test(leaf)) return false;
  return parts.some((part) => ["sessions", "deleted-sessions", "journal", "tasks", "subagent-sessions", "session-message-queues", "session-turn-inputs", "workflows", "dynamic-workflows", "providers", "mcp", "mcp-oauth"].includes(part))
    || parts.includes("resources") && parts.includes("subagents");
};

export function createTuiSessionPort(o: TuiSessionPortOptions): {
  port: TuiPort;
  consumeAttachments(items: readonly TuiAttachment[]): Attachment[];
} {
  const cached = new Map<string, Attachment>();
  const subscriptions = new Set<() => void>();
  let imageNumber = 0;

  const requireSessions = (): void => {
    if (!o.enabled("sessions")) throw new Error("sessions plugin is disabled or unavailable");
  };
  function activeId(): string;
  function activeId(required: true): string;
  function activeId(required: false): string | null;
  function activeId(required = true): string | null {
    requireSessions();
    const sid = o.sessionId();
    if (sid == null && !required) return null;
    if (typeof sid !== "string" || !/^[0-9a-f]{32}$/.test(sid)) throw new Error("No active session is available");
    return sid;
  }
  const api = async (method: string, path: string, data?: TuiRow): Promise<TuiRow> => {
    const [status, body] = await o.api(method, path, data);
    if (status < 200 || status >= 300) {
      const detail = typeof body?.error === "string" ? body.error : `${method} ${path} failed (${status})`;
      throw new Error(detail);
    }
    return body;
  };
  const pickAttachments = (items: readonly TuiAttachment[], consume: boolean): Attachment[] => {
    requireSessions();
    const selected = items.map((item) => {
      const found = cached.get(item.id);
      if (!found) throw new Error(`Attachment is no longer available: ${item.label}`);
      return found;
    });
    if (consume) for (const item of items) cached.delete(item.id);
    return selected;
  };
  const mcpRows = async (): Promise<TuiRow[]> => {
    if (!o.enabled("mcp")) return [];
    const body = await api("GET", "/api/resources/mcp");
    return (Array.isArray(body.items) ? body.items : []).filter(isDict).map((item: TuiRow) => ({
      ...item,
      status: item.status ?? (item.enabled === false ? "disabled" : "configured"),
    }));
  };

  const choices = async (kind: TuiMenuKind, query: string): Promise<readonly TuiChoice[]> => {
    requireSessions();
    if (kind === "slash") return o.commands();
    if (kind === "mode") return [
      { id: "plan", label: "plan", value: "/mode plan", description: "计划工作 / Plan work" },
      { id: "build", label: "build", value: "/mode build", description: "构建实现 / Build an implementation" },
      { id: "edit", label: "edit", value: "/mode edit", description: "编辑现有内容 / Edit existing content" },
      { id: "yolo", label: "yolo", value: "/mode yolo", description: "自主执行模式 / Autonomous execution mode" },
      { id: "guarded", label: "guarded", value: "/mode guarded", description: "常规命令自动执行，已识别危险命令每次确认 / Ordinary commands run automatically; recognized dangerous commands require approval each time" },
    ];
    if (kind === "file") {
      if (!o.enabled("files")) return [];
      return listWorkspacePaths(o.root(), query);
    }
    if (kind === "model" || kind === "effort") {
      if (!o.enabled("providers")) return [];
      const body = await api("GET", "/api/providers");
      const profiles = (Array.isArray(body.providers) ? body.providers : []).filter(isDict) as TuiRow[];
      if (kind === "model") {
        const options: TuiChoice[] = profiles.flatMap((profile) => {
          const id = text(profile.id), model = text(profile.model);
          if (!id || !model) return [];
          const name = text(profile.name) || id;
          return [{ id, label: `${name}/${model}`, value: `/model ${id} ${model}`, keywords: [id] }];
        });
        const selected = o.selection();
        const envModel = selected.providerId == null && selected.model ? selected.model : process.env.XUENESS_MODEL;
        if (typeof envModel === "string" && pyStrip(envModel)) options.push({
          id: "env", label: `Environment/${envModel}`, value: "/model env", description: "Environment model", keywords: ["env", "environment"],
        });
        return options;
      }
      const selected = o.selection();
      const selectedId = selected.providerId ?? "";
      const profile = profiles.find((item) => item.id === selectedId && (selected.model == null || item.model === selected.model));
      const levels = o.reasoningLevels
        ? o.reasoningLevels()
        : (Array.isArray(profile?.reasoningLevels) ? profile.reasoningLevels : []);
      return levels
        .filter((level: unknown): level is string => typeof level === "string" && !!level)
        .map((level: string) => ({ id: level, label: level, value: `/effort ${level}` }));
    }
    if (kind === "session") {
      const choices: TuiChoice[] = [];
      for (const item of await o.store.list()) {
        if (typeof item.id !== "string") continue;
        const session = await o.store.load(item.id);
        const title = text(session.title) || text(session.task) || item.id;
        const details = [text(session.status), text(session.root)].filter(Boolean).join(" · ");
        choices.push({ id: item.id, label: title, value: `/resume ${item.id}`, ...(details ? { description: details } : []) });
      }
      return choices;
    }
    if (kind === "child") {
      if (!o.enabled("subagents")) return [];
      const sid = activeId(false);
      if (!sid) return [];
      const body = await api("GET", `/api/sessions/${sid}/tasks`);
      return (Array.isArray(body.tasks) ? body.tasks : []).filter(isDict).flatMap((task: TuiRow) => {
        if (typeof task.id !== "string") return [];
        const label = text(task.description) || text(task.summary) || text(task.label) || task.id;
        const description = [text(task.status), text(task.agent)].filter(Boolean).join(" · ");
        return [{ id: task.id, label, value: task.id, ...(description ? { description } : []) }];
      });
    }
    return [];
  };

  const sidebar = async (): Promise<TuiSidebar> => {
    const sid = activeId(false);
    const result: TuiSidebar = { files: [], todos: [], subagents: [], mcp: await mcpRows(), workflows: [], apis: [], queued: [] };
    if (!sid) return result;
    if (o.enabled("subagents")) {
      const live = await api("GET", `/api/sessions/${sid}/tasks`);
      result.subagents = (Array.isArray(live.tasks) ? live.tasks : []).filter(isDict);
    }
    if (o.enabled("workflows") && o.workflows) result.workflows = [...await o.workflows()];
    if (o.enabled("git")) {
      const path = `/api/sessions/${sid}/git/status`;
      const [status, git] = await o.api("GET", path);
      if (status !== 404) {
        if (status >= 400) throw new Error(typeof git?.error === "string" ? git.error : `GET ${path} failed (${status})`);
        if (typeof git.branch === "string") result.branch = git.branch;
        result.files = (Array.isArray(git.entries) ? git.entries : []).filter(isDict)
          .map((entry: TuiRow) => ({ code: entry.code, path: entry.path }));
      }
    }

    const queue = new MessageQueue(o.store, { stateDir: o.stateDir, enabled: o.enabled });
    const steering = new SteeringInbox(o.store, { stateDir: o.stateDir, enabled: o.enabled });
    const [queued, guided] = await Promise.all([queue.snapshot(sid), steering.snapshot(sid)]);
    // Read the session after the asynchronous panel queries so old approval snapshots cannot replace a completed result.
    const session = await o.store.load(sid);
    if (typeof session.status === "string") result.status = session.status;
    if (Array.isArray(session.messages)) result.messages = session.messages.filter(isDict);
    if (Array.isArray(session.stream_history)) result.streams = session.stream_history.filter(isDict);
    result.todos = Array.isArray(session.todos) ? session.todos.filter(isDict) : [];
    if (isDict(session.results)) result.toolResults = Object.fromEntries(Object.entries(session.results).filter((entry): entry is [string, TuiRow] => isDict(entry[1])));
    if (o.enabled("subagents")) {
      const saved = Array.isArray(session.task_runs) ? session.task_runs.filter(isDict) : [];
      result.subagents = [...new Map([...saved, ...result.subagents].filter((task) => typeof task.id === "string").map((task) => [task.id, task])).values()];
    }
    const pending = (value: unknown, kind: "queue" | "steer"): TuiQueuedInput[] =>
      (Array.isArray(value) ? value : []).filter(isDict)
        .filter((item: TuiRow) => ["queued", "paused"].includes(String(item.status)))
        .map((item: TuiRow) => ({ id: String(item.id), text: String(item.text ?? ""), kind, status: String(item.status) }));
    result.queued = [...pending(queued.queued_messages, "queue"), ...pending(guided.queued_messages, "steer")];

    const usages = Array.isArray(session.provider_usage) ? session.provider_usage.filter(isDict) : [];
    const usage = { ...row(usages.at(-1)?.usage) };
    const activity = row(session.runtime_activity);
    for (const key of ["reportedInputTokens", "reportedOutputTokens", "reportedCachedTokens", "reportedReasoningTokens"] as const) {
      if (Object.hasOwn(activity, key)) usage[key] = activity[key];
    }
    if (Object.keys(usage).length) result.usage = usage;

    const context = row(session.context_usage ?? session.contextUsage ?? session.context);
    const used = context.totalTokens ?? session.contextUsed ?? session.context_used ?? context.contextUsed ?? context.used;
    const window = session.contextWindow ?? session.context_window ?? context.contextWindow ?? context.window;
    if (validNumber(used)) result.contextUsed = used;
    if (validNumber(window)) result.contextWindow = window;

    const history = Array.isArray(session.runtime_activity_history) ? session.runtime_activity_history.filter(isDict) : [];
    const requestHistory = session.requestHistory ?? session.request_history ?? session.networkHistory ?? session.network_history;
    const recorded = Array.isArray(requestHistory) ? requestHistory.filter(isDict) : history;
    result.apis = recorded.slice(-8).map((entry: TuiRow) => ({ ...entry, ...(entry.status == null && entry.phase != null ? { status: entry.phase } : {}) }));
    if (isDict(session.runtime_activity) && !recorded.some((entry: TuiRow) => entry.startedAt === activity.startedAt)) {
      result.apis.unshift({ ...activity, ...(activity.status == null && activity.phase != null ? { status: activity.phase } : {}) });
    }
    result.apis = result.apis.slice(0, 8);
    return result;
  };

  const childTranscript = async (taskId: string): Promise<TuiSnapshot> => {
    const sid = activeId();
    if (!o.enabled("subagents")) throw new Error("subagents plugin is disabled or unavailable");
    const body = await api("GET", `/api/sessions/${sid}/tasks/${encodeURIComponent(taskId)}/transcript`);
    const timeline = row(body.timeline);
    const events = (Array.isArray(timeline.events) ? timeline.events : []).filter(isDict) as TuiRow[];
    const initialPrompt = text(body.initialPrompt);
    const messages: TuiRow[] = initialPrompt ? [{ role: "user", content: initialPrompt }] : [];
    for (const event of events) {
      const preview = text(event.preview);
      if (!preview) continue;
      const type = text(event.type);
      if (type === "turn.user") messages.push({ role: "user", content: preview });
      else if (type === "assistant.text") messages.push({ role: "assistant", content: preview });
    }
    const childSessionId = text(timeline.sessionId) || text(body.childSessionId);
    if (!childSessionId) throw new Error("Subagent transcript did not include a session id");
    return { sessionId: childSessionId, messages, events };
  };

  const sendInput = async (input: string, attachments: readonly TuiAttachment[], delivery: "queue" | "steer"): Promise<TuiQueuedInput> => {
    const sid = activeId();
    if (pyLen(input) < 1 || pyLen(input) > 5000 || !pyStrip(input)) throw new Error("Message must contain 1..5000 characters");
    const session = await o.store.load(sid);
    const selected = pickAttachments(attachments, false);
    const prepared = selected.length ? {
      text: withAttachments(input, selected),
      metadata: { files: selected.map(attachmentMetadata) },
    } : null;
    const requestId = uuid4Hex();
    const fingerprint = sha256(JSON.stringify({ text: input, prepared }));
    let receipt: TuiRow;
    if (delivery === "queue") {
      const queue = new MessageQueue(o.store, { stateDir: o.stateDir, enabled: o.enabled });
      receipt = await queue.enqueue(sid, input, prepared, { activeRun: true, requestId, fingerprint, session });
    } else {
      const turnId = text(session.active_turn_id);
      if (!turnId) throw new Error("There is no active turn to guide");
      const inbox = new SteeringInbox(o.store, { stateDir: o.stateDir, enabled: o.enabled });
      [receipt] = await inbox.locked(sid, () => inbox.admitLocked(sid, input, turnId, requestId, fingerprint, prepared));
    }
    if (typeof receipt.id !== "string" || !["queued", "paused"].includes(String(receipt.status))) throw new Error("Input was not accepted into the pending queue");
    for (const item of attachments) cached.delete(item.id);
    if (typeof receipt.text !== "string") throw new Error("Accepted input receipt did not include its text");
    return { id: receipt.id, text: receipt.text, kind: delivery, status: String(receipt.status) };
  };

  const cancelInput = async (id: string, kind: "queue" | "steer"): Promise<void> => {
    const sid = activeId();
    const session = await o.store.load(sid);
    const current = session.current_queue_item_id;
    const queue = kind === "queue"
      ? new MessageQueue(o.store, { stateDir: o.stateDir, enabled: o.enabled })
      : new SteeringInbox(o.store, { stateDir: o.stateDir, enabled: o.enabled });
    const result = await queue.locked(sid, () => queue.cancelLocked(sid, id, current));
    if (result === "not_found") throw new Error("Queued input was not found");
    if (result === "claimed") throw new Error("Queued input is already claimed and cannot be withdrawn");
  };

  const subscribe = (onChange: () => void, onError?: (error: Error) => void): (() => void) => {
    requireSessions();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const watcher = watch(o.stateDir, { recursive: true }, (_event, filename) => {
      if (closed || !relevantStateFile(filename)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (!closed && o.enabled("sessions")) onChange();
      }, 80);
    });
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      watcher.close();
      subscriptions.delete(close);
    };
    watcher.on("error", (error) => {
      close();
      if (onError) onError(error);
    });
    subscriptions.add(close);
    return close;
  };

  const port: TuiPort = {
    stop() { requireSessions(); o.stop(); },
    subscribe,
    choices,
    sidebar,
    childTranscript,
    sendInput,
    cancelInput,
    async captureImage() {
      requireSessions();
      const image = await readClipboardPng();
      if (!image) return null;
      imageNumber += 1;
      const attachment: Attachment = {
        path: `clipboard-image-${imageNumber}.png`, content: "", size: image.length,
        sha256: sha256(image), mimeType: "image/png", dataBase64: image.toString("base64"),
      };
      const id = uuid4Hex();
      cached.set(id, attachment);
      return { id, label: `[image #${imageNumber}]`, path: attachment.path };
    },
    async attach(path: string) {
      requireSessions();
      if (!o.enabled("files")) throw new Error("files plugin is disabled or unavailable");
      const attachment = await snapshot(o.root(), path);
      const id = sha256(attachment.path);
      cached.set(id, attachment);
      return { id, label: `@${attachment.path}`, path: attachment.path };
    },
    async writeClipboard(value: string) { requireSessions(); await writeClipboardText(value); },
    async setMode(mode: string) { requireSessions(); return o.setMode(mode); },
    async taskAction(taskId: string, action: "cancel" | "resume" | "message", value = "") {
      const sid = activeId();
      if (!o.enabled("subagents")) throw new Error("subagents plugin is disabled or unavailable");
      const data = action === "message" ? { requestId: uuid4Hex(), message: value } : {};
      const body = await api("POST", `/api/sessions/${sid}/tasks/${encodeURIComponent(taskId)}/${action}`, data);
      return JSON.stringify(body);
    },
  };

  return { port, consumeAttachments: (items) => pickAttachments(items, true) };
}
