/** Explicit, reviewable project-memory curation over selected local session evidence. */
import { createHash } from "node:crypto";
import { isDict, pyEncodeUtf8, pyJsonDumps, pyLen } from "@xueness/contracts";
import { foldHostPath, realish } from "@xueness/sessions";
import { MemoryDreamStore } from "./memory-dream-store.ts";
import { dreamKeyDiff, type MemoryDreamDiff } from "./memory-dream-diff.ts";
import { redactSecrets, runDreamToolLoop } from "./memory-dream-tools.ts";
import type { MemoryDreamApproval, MemoryDreamApplyApproval, MemoryDreamCandidate, MemoryDreamMessage, MemoryDreamOptions, MemoryDreamProposeOptions, MemoryDreamRecord, MemoryDreamRow, MemoryDreamSource, MemoryDreamView } from "./memory-dream-types.ts";

const SESSION_ID = /^[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_SOURCES = 20, DEFAULT_SOURCES = 5, MAX_TRANSCRIPT_CODEPOINTS = 40_000;
const MAX_MESSAGES_PER_SOURCE = 40, MAX_CANDIDATE_BYTES = 100_000;
const now = (): string => new Date().toISOString();
const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const stableHash = (value: unknown): string => sha256(pyJsonDumps(value, { sortKeys: true, ensureAscii: false, separators: [",", ":"] }));
const truthy = (value: unknown): boolean => value !== null && value !== undefined && value !== false && value !== "";
const rowId = (row: MemoryDreamRow): string | null => typeof row.id === "string" ? row.id : typeof row.sessionId === "string" ? row.sessionId : null;

export class MemoryDreamServiceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

interface ActiveDream { controller: AbortController; done: Promise<void>; lease: { release(): void | Promise<void> } }
interface OwnerContext { owner: MemoryDreamRow; root: string }

function fail(status: number, message: string): never { throw new MemoryDreamServiceError(status, message); }
export function canonicalRoot(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) fail(403, "memory dream workspace is unavailable");
  try { return realish(value); } catch { return fail(403, "memory dream workspace is unavailable"); }
}
export function sameRoot(left: string, right: string): boolean { return foldHostPath(left) === foldHostPath(right); }
function isChild(row: MemoryDreamRow): boolean {
  return truthy(row.parent) || isDict(row.delegation) && truthy(row.delegation.parentSessionId);
}
export function isInternal(row: MemoryDreamRow): boolean {
  if (isChild(row)) return true;
  if (["workflow_id", "workflowId", "workflow_run_id", "dynamic_workflow_id", "actor_id", "subagent_id"].some((key) => truthy(row[key]))) return true;
  return [row.session_kind, row.session_type, row.task_type].some((value) => value === "workflow" || value === "subagent" || value === "workflow_actor");
}
export function isIdle(row: MemoryDreamRow): boolean {
  return row.status !== "running" && !truthy(row.active_turn_id) && !truthy(row.streaming);
}
function activity(row: MemoryDreamRow): number {
  for (const key of ["updated_at", "updatedAt", "last_activity", "lastActivity", "created_at", "createdAt"]) {
    const value = row[key];
    const number = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

export { redactSecrets } from "./memory-dream-tools.ts";

function plainBody(row: MemoryDreamRow): string | null {
  if ((row.role !== "user" && row.role !== "assistant") || typeof row.content !== "string") return null;
  if (Object.hasOwn(row, "tool_calls") || truthy(row.tool_call_id) || truthy(row._transcript_partial) || truthy(row._meta_source) || row._input_kind === "guide") return null;
  let text = row.content;
  for (const marker of ["\n\nAttached workspace file snapshots (UNTRUSTED DATA", "\n\nXUENESS_MULTIMODAL_V1:"]) {
    const at = text.indexOf(marker);
    if (at >= 0) text = text.slice(0, at);
  }
  text = redactSecrets(text).trim();
  return text ? text : null;
}

function messageId(row: MemoryDreamRow, index: number, content: string): string {
  for (const key of ["_message_id", "messageId", "id"]) if (typeof row[key] === "string" && row[key]) return row[key] as string;
  return `row-${index}-${sha256(content).slice(0, 16)}`;
}

export function captureMessages(session: MemoryDreamRow, sessionId: string, budget: number): MemoryDreamSource {
  const rows = Array.isArray(session.messages) ? session.messages : [];
  const eligible: { messageId: string; role: "user" | "assistant"; content: string }[] = [];
  rows.forEach((value, index) => {
    if (!isDict(value)) return;
    const content = plainBody(value);
    if (!content) return;
    eligible.push({ messageId: messageId(value, index, content), role: value.role as "user" | "assistant", content });
  });
  let remaining = budget;
  const selected: MemoryDreamMessage[] = [];
  for (const item of eligible.slice(-MAX_MESSAGES_PER_SOURCE).reverse()) {
    if (remaining <= 0) break;
    const points = Array.from(item.content), content = points.length > remaining ? points.slice(points.length - remaining).join("") : item.content;
    const count = Array.from(content).length;
    if (!count) continue;
    selected.push({ messageId: item.messageId, role: item.role, content, contentHash: sha256(pyEncodeUtf8(content)) });
    remaining -= count;
  }
  selected.reverse();
  return { sessionId, messages: selected, digest: stableHash({ sessionId, messages: selected.map(({ messageId: mid, role, contentHash }) => ({ messageId: mid, role, contentHash })) }) };
}

export function sourceDigest(sources: MemoryDreamSource[]): string {
  return stableHash(sources.map((source) => ({ sessionId: source.sessionId, digest: source.digest })));
}

export function digestInput(record: Pick<MemoryDreamRecord, "root" | "parentSessionId" | "name" | "sourceSessionIds" | "sources" | "baseKeyDigest">): string {
  return stableHash({ root: foldHostPath(record.root), parentSessionId: record.parentSessionId, name: record.name,
    sourceSessionIds: record.sourceSessionIds, sourceDigest: sourceDigest(record.sources), baseKeyDigest: record.baseKeyDigest });
}

export function startDigest(record: Pick<MemoryDreamRecord, "parentSessionId" | "root" | "name" | "sourceSessionIds" | "baseKeyDigest" | "inputDigest">): string {
  return stableHash({ parentSessionId: record.parentSessionId, root: foldHostPath(record.root), name: record.name,
    sourceSessionIds: record.sourceSessionIds, baseKeyDigest: record.baseKeyDigest, inputDigest: record.inputDigest });
}

export function applyDigest(record: MemoryDreamRecord, candidate: MemoryDreamCandidate): string {
  return stableHash({ parentSessionId: record.parentSessionId, root: foldHostPath(record.root), sourceSessionIds: record.sourceSessionIds,
    sourceDigest: sourceDigest(record.sources), baseKeyDigest: record.baseKeyDigest, candidate });
}

export function validateKey(value: unknown): { content: string; digest: string } {
  if (!isDict(value) || typeof value.content !== "string" || typeof value.digest !== "string" || !DIGEST.test(value.digest)) fail(500, "project memory could not be read");
  if (sha256(pyEncodeUtf8(value.content)) !== value.digest) fail(500, "project memory digest is invalid");
  return { content: value.content, digest: value.digest };
}

export function validateCandidate(value: unknown, chosen: readonly string[]): MemoryDreamCandidate {
  if (!isDict(value) || Object.keys(value).length !== 3 || !["content", "summary", "sourceSessionIds"].every((key) => Object.hasOwn(value, key))) fail(502, "model returned an invalid memory candidate");
  if (typeof value.content !== "string" || typeof value.summary !== "string" || !Array.isArray(value.sourceSessionIds)
      || value.sourceSessionIds.some((id) => typeof id !== "string" || !chosen.includes(id))
      || new Set(value.sourceSessionIds).size !== value.sourceSessionIds.length) fail(502, "model returned an invalid memory candidate");
  const content = redactSecrets(value.content), summary = redactSecrets(value.summary);
  let bytes: Buffer;
  try { bytes = pyEncodeUtf8(content); } catch { return fail(502, "model returned an invalid memory candidate"); }
  if (bytes.length > MAX_CANDIDATE_BYTES || pyLen(summary) > 1200) fail(502, "model returned an invalid memory candidate");
  return { content, summary, sourceSessionIds: [...value.sourceSessionIds] as string[] };
}

export class MemoryDreamService {
  readonly store: MemoryDreamStore;
  readonly #options: MemoryDreamOptions;
  readonly #active = new Map<string, ActiveDream>();
  #closed = false;

  constructor(options: MemoryDreamOptions) { this.#options = options; this.store = new MemoryDreamStore(options.stateDir); }

  async #owner(sessionId: string): Promise<OwnerContext> {
    if (this.#closed) fail(409, "memory dream host is closed");
    if (!this.#options.enabled("memory") || !this.#options.enabled("sessions")) fail(403, "memory and sessions must be enabled");
    if (!SESSION_ID.test(sessionId)) fail(400, "invalid session id");
    const owner = await this.#options.owner(sessionId);
    if (owner.id !== undefined && owner.id !== sessionId || truthy(owner.remote_connection) || isInternal(owner)) fail(403, "memory dreams require a local main session");
    return { owner, root: canonicalRoot(owner.root) };
  }

  async #owned(sessionId: string, id: string): Promise<{ record: MemoryDreamRecord; owner: MemoryDreamRow; root: string }> {
    const { owner, root } = await this.#owner(sessionId), record = await this.store.load(id);
    if (record.parentSessionId !== sessionId || !sameRoot(record.root, root)) fail(403, "memory dream belongs to another session or workspace");
    return { record, owner, root };
  }

  async #session(sessionId: string, expectedRoot: string, currentId: string, currentOwner: MemoryDreamRow): Promise<MemoryDreamRow> {
    const row = sessionId === currentId ? currentOwner : await this.#options.owner(sessionId);
    if (row.id !== undefined && row.id !== sessionId || truthy(row.remote_connection) || isInternal(row)) fail(400, "selected source is not a local main session");
    const root = canonicalRoot(row.root);
    if (!sameRoot(root, expectedRoot)) fail(400, "selected source belongs to another workspace");
    return row;
  }

  async #select(sessionId: string, root: string, owner: MemoryDreamRow, requested?: string[]): Promise<string[]> {
    const listed = await this.#options.listSessions(root);
    const local = listed.filter((row) => {
      const id = rowId(row);
      if (!id || !SESSION_ID.test(id) || id === sessionId || truthy(row.remote_connection) || isInternal(row)) return false;
      try { return sameRoot(canonicalRoot(row.root), root); } catch { return false; }
    }).sort((a, b) => activity(b) - activity(a) || String(rowId(a)).localeCompare(String(rowId(b))));
    if (requested !== undefined) {
      if (!Array.isArray(requested) || requested.length < 1 || requested.length > MAX_SOURCES || requested.some((id) => typeof id !== "string" || !SESSION_ID.test(id)) || new Set(requested).size !== requested.length) fail(400, "sourceSessionIds must contain 1..20 unique local session ids");
      const listedIds = new Set(local.map(rowId));
      for (const id of requested) {
        if (id === sessionId) {
          if (!isIdle(owner)) fail(409, "the current session must be idle when explicitly selected");
        } else if (!listedIds.has(id)) fail(400, "selected source is not available in this workspace");
      }
      return [...requested];
    }
    const ids = local.slice(0, DEFAULT_SOURCES).map(rowId).filter((id): id is string => id !== null);
    if (!ids.length) fail(400, "select at least one project session");
    return ids;
  }

  async #capture(sessionId: string, root: string, owner: MemoryDreamRow, sourceIds: string[]): Promise<MemoryDreamSource[]> {
    let remaining = MAX_TRANSCRIPT_CODEPOINTS;
    const sources: MemoryDreamSource[] = [];
    for (let index = 0; index < sourceIds.length; index += 1) {
      const id = sourceIds[index]!;
      const session = await this.#session(id, root, sessionId, owner);
      if (id === sessionId && !isIdle(session)) fail(409, "the current session must be idle when explicitly selected");
      const budget = Math.floor(remaining / (sourceIds.length - index));
      const source = captureMessages(session, id, budget);
      remaining -= source.messages.reduce((sum, message) => sum + pyLen(message.content), 0);
      sources.push(source);
    }
    return sources;
  }

  #view(record: MemoryDreamRecord): MemoryDreamView {
    return { ...record, applyDigest: record.applyDigest ?? null, active: this.#active.has(record.id) };
  }

  async propose(sessionId: string, options: MemoryDreamProposeOptions = {}): Promise<MemoryDreamView> {
    const { owner, root } = await this.#owner(sessionId);
    if (options.name !== undefined && (typeof options.name !== "string" || !options.name.trim() || pyLen(options.name) > 120)) fail(400, "name must be 1..120 characters");
    const sourceIds = await this.#select(sessionId, root, owner, options.sourceSessionIds);
    const [key, sources] = await Promise.all([this.#options.readKey(root).then(validateKey), this.#capture(sessionId, root, owner, sourceIds)]);
    const name = options.name?.trim() || "Project memory curation";
    const inputDigest = digestInput({ root, parentSessionId: sessionId, name, sourceSessionIds: sourceIds, sources, baseKeyDigest: key.digest });
    const timestamp = now();
    const identity = { parentSessionId: sessionId, root, name, sourceSessionIds: sourceIds, baseKeyDigest: key.digest, inputDigest };
    const record = await this.store.create({ schemaVersion: 1, ...identity, status: "draft", sources,
      baseKeyContent: key.content, startDigest: startDigest(identity), createdAt: timestamp, updatedAt: timestamp });
    return this.#view(record);
  }

  async list(sessionId: string): Promise<MemoryDreamView[]> {
    const { owner, root } = await this.#owner(sessionId);
    if (owner.root === undefined) fail(403, "memory dream workspace is unavailable");
    return (await this.store.list()).filter((record) => record.parentSessionId === sessionId && sameRoot(record.root, root)).map((record) => this.#view(record));
  }

  async get(sessionId: string, id: string): Promise<MemoryDreamView> {
    const { record } = await this.#owned(sessionId, id);
    return this.#view(record);
  }

  async #revalidate(record: MemoryDreamRecord, sessionId: string, owner: MemoryDreamRow): Promise<void> {
    if (sha256(pyEncodeUtf8(record.baseKeyContent)) !== record.baseKeyDigest || digestInput(record) !== record.inputDigest || startDigest(record) !== record.startDigest) {
      fail(409, "memory dream snapshot is invalid; create a new proposal");
    }
    const [key, sources] = await Promise.all([this.#options.readKey(record.root).then(validateKey), this.#capture(sessionId, record.root, owner, record.sourceSessionIds)]);
    if (key.digest !== record.baseKeyDigest || sourceDigest(sources) !== sourceDigest(record.sources)) fail(409, "memory dream inputs changed; create a new proposal");
  }

  async start(sessionId: string, id: string, approval: MemoryDreamApproval): Promise<MemoryDreamView> {
    const { record, owner } = await this.#owned(sessionId, id);
    if (approval.confirmed !== true || approval.digest !== record.startDigest) fail(409, "review and confirm the current memory dream digest");
    if (approval.allowReal !== true || !this.#options.allowRealHost || !this.#options.enabled("providers")) fail(403, "real model execution requires the host switch and explicit allowReal");
    if (record.status !== "draft" || this.#active.has(id)) fail(409, "only a draft memory dream can be started");
    let lease: Awaited<ReturnType<MemoryDreamStore["acquireWorkspace"]>>;
    try { lease = await this.store.acquireWorkspace(record.root); }
    catch { return fail(409, "another memory dream owns this workspace"); }
    const controller = new AbortController();
    try {
      await this.#revalidate(record, sessionId, owner);
      const running = await this.store.update(id, (value) => {
        if (value.status !== "draft") fail(409, "memory dream is no longer a draft");
        value.status = "running"; value.startedAt = now(); delete value.error;
      });
      const active: ActiveDream = { controller, lease, done: Promise.resolve() };
      this.#active.set(id, active);
      active.done = Promise.resolve().then(() => this.#execute(running, active)).finally(async () => {
        this.#active.delete(id);
        await lease.release();
      });
      void active.done.catch(() => {});
      return this.#view(running);
    } catch (error) { await lease.release(); throw error; }
  }

  async #execute(record: MemoryDreamRecord, active: ActiveDream): Promise<void> {
    const { controller } = active;
    const monitor = setInterval(() => {
      try {
        if (this.#closed || !this.#options.enabled("memory") || !this.#options.enabled("providers")) controller.abort();
      } catch { controller.abort(); }
    }, 50);
    try {
      const result = await runDreamToolLoop({
        record, tools: this.#options.tools ?? [], signal: controller.signal,
        synthesize: (sessionId, prompt, signal) => this.#options.synthesize(sessionId, prompt, signal),
        onToolCall: () => {},
        fail,
      });
      if (controller.signal.aborted || this.#closed || !this.#options.enabled("memory") || !this.#options.enabled("providers")) {
        await this.store.update(record.id, (value) => { value.status = "cancelled"; value.settledAt = now(); delete value.candidate; delete value.applyDigest; });
        return;
      }
      const candidate = validateCandidate(result?.value, record.sourceSessionIds);
      const usage = result && Object.hasOwn(result, "usage") && result.usage !== undefined && result.usage !== null ? result.usage : "unknown";
      await this.store.update(record.id, (value) => {
        value.status = "ready"; value.candidate = candidate; value.usage = usage;
        value.applyDigest = applyDigest(value, candidate); value.settledAt = now(); delete value.error;
      });
    } catch (error) {
      await this.store.update(record.id, (value) => {
        value.status = controller.signal.aborted ? "cancelled" : "failed";
        value.settledAt = now();
        if (!controller.signal.aborted) value.error = error instanceof MemoryDreamServiceError && error.status === 502 ? "model returned an invalid candidate" : "model synthesis failed";
        delete value.candidate; delete value.applyDigest;
      });
    } finally { clearInterval(monitor); }
  }

  async cancel(sessionId: string, id: string): Promise<MemoryDreamView> {
    if (!SESSION_ID.test(sessionId)) fail(400, "invalid session id");
    let record = await this.store.load(id);
    if (record.parentSessionId !== sessionId) fail(403, "memory dream belongs to another session");
    if (!this.#closed) {
      const owner = await this.#options.owner(sessionId);
      if (owner.id !== undefined && owner.id !== sessionId || truthy(owner.remote_connection) || isInternal(owner)
          || !sameRoot(record.root, canonicalRoot(owner.root))) fail(403, "memory dream belongs to another session or workspace");
    }
    const active = this.#active.get(id);
    if (active) {
      active.controller.abort(); await active.done;
      return this.#view(await this.store.load(id));
    }
    if (record.status === "applied" || record.status === "reverted") fail(409, "an applied or reverted memory dream cannot be cancelled");
    if (record.status === "running") {
      let lease: Awaited<ReturnType<MemoryDreamStore["acquireWorkspace"]>>;
      try { lease = await this.store.acquireWorkspace(record.root); }
      catch { return fail(409, "another host owns this running memory dream"); }
      try { record = await this.store.update(id, (value) => { if (value.status === "running") { value.status = "cancelled"; value.settledAt = now(); } }); }
      finally { await lease.release(); }
    } else if (record.status === "ready") {
      let lease: Awaited<ReturnType<MemoryDreamStore["acquireWorkspace"]>>;
      try { lease = await this.store.acquireWorkspace(record.root); }
      catch { return fail(409, "another memory dream owns this workspace"); }
      try { record = await this.store.update(id, (value) => { value.status = "cancelled"; value.settledAt = now(); }); }
      finally { await lease.release(); }
    } else {
      record = await this.store.update(id, (value) => { value.status = "cancelled"; value.settledAt = now(); });
    }
    return this.#view(record);
  }

  async wait(id: string): Promise<void> { await this.#active.get(id)?.done; }

  async apply(sessionId: string, id: string, approval: MemoryDreamApplyApproval): Promise<MemoryDreamView> {
    const { record, owner } = await this.#owned(sessionId, id);
    if (approval.confirmed !== true) fail(409, "explicit confirmation is required to apply memory");
    if (record.status === "applied") {
      if (approval.digest !== record.applyDigest) fail(409, "memory dream apply digest does not match");
      return this.#view(record);
    }
    if (owner.mode === "plan" || owner.permission_mode === "plan" || owner.read_only === true) fail(403, "plan mode cannot write project memory");
    if (record.status !== "ready" || !record.candidate || !record.applyDigest) fail(409, "only a ready memory dream can be applied");
    if (approval.digest !== record.applyDigest) fail(409, "review and confirm the current candidate digest");
    if (applyDigest(record, record.candidate) !== record.applyDigest) fail(409, "memory dream candidate digest is invalid");
    let lease: Awaited<ReturnType<MemoryDreamStore["acquireWorkspace"]>>;
    try { lease = await this.store.acquireWorkspace(record.root); }
    catch { return fail(409, "another memory dream owns this workspace"); }
    try {
      const latest = await this.store.load(id);
      if (latest.status === "applied" && latest.applyDigest === approval.digest) return this.#view(latest);
      if (latest.status !== "ready" || latest.applyDigest !== approval.digest || !latest.candidate) fail(409, "memory dream candidate changed");
      if (applyDigest(latest, latest.candidate) !== latest.applyDigest) fail(409, "memory dream candidate digest is invalid");
      await this.#revalidate(latest, sessionId, owner);
      let result: unknown;
      try { result = await this.#options.writeKey(latest.root, { content: latest.candidate.content, digest: latest.baseKeyDigest, confirmed: true }); }
      catch (error) {
        if ((error as { status?: unknown } | null)?.status === 409) fail(409, "project memory changed; reload before applying");
        throw error;
      }
      const written = validateKey(result);
      const applied = await this.store.update(id, (value) => {
        if (value.status !== "ready" || value.applyDigest !== approval.digest) fail(409, "memory dream candidate changed");
        value.status = "applied"; value.appliedAt = now(); value.settledAt = value.appliedAt; value.appliedKeyDigest = written.digest;
        value.provenance = { source: "memory-dream", sourceSessionIds: [...value.sourceSessionIds], sourceDigest: sourceDigest(value.sources),
          baseKeyDigest: value.baseKeyDigest, applyDigest: value.applyDigest, appliedAt: value.appliedAt };
      });
      return this.#view(applied);
    } finally { await lease.release(); }
  }

  /** Review-only unified diff between the captured KEY baseline and the stored candidate. */
  async diff(sessionId: string, id: string): Promise<MemoryDreamDiff> {
    const { record } = await this.#owned(sessionId, id);
    if (!record.candidate) fail(409, "memory dream has no candidate to diff");
    return dreamKeyDiff(
      { content: record.baseKeyContent, digest: record.baseKeyDigest },
      { content: record.candidate.content, digest: "" },
    );
  }

  /** Restores the pre-apply KEY baseline; the CAS anchor is the digest this dream actually applied. */
  async revert(sessionId: string, id: string, approval: MemoryDreamApplyApproval): Promise<MemoryDreamView> {
    const { record, owner } = await this.#owned(sessionId, id);
    if (approval.confirmed !== true) fail(409, "explicit confirmation is required to revert memory");
    if (record.status === "reverted") {
      if (approval.digest !== record.applyDigest) fail(409, "memory dream apply digest does not match");
      return this.#view(record);
    }
    if (owner.mode === "plan" || owner.permission_mode === "plan" || owner.read_only === true) fail(403, "plan mode cannot write project memory");
    if (record.status !== "applied" || !record.candidate || !record.applyDigest || !record.appliedKeyDigest) fail(409, "only an applied memory dream can be reverted");
    if (approval.digest !== record.applyDigest) fail(409, "review and confirm the applied candidate digest");
    let lease: Awaited<ReturnType<MemoryDreamStore["acquireWorkspace"]>>;
    try { lease = await this.store.acquireWorkspace(record.root); }
    catch { return fail(409, "another memory dream owns this workspace"); }
    try {
      const latest = await this.store.load(id);
      if (latest.status === "reverted" && latest.applyDigest === approval.digest) return this.#view(latest);
      if (latest.status !== "applied" || latest.applyDigest !== approval.digest || !latest.appliedKeyDigest) fail(409, "memory dream candidate changed");
      let result: unknown;
      try { result = await this.#options.writeKey(latest.root, { content: latest.baseKeyContent, digest: latest.appliedKeyDigest, confirmed: true }); }
      catch (error) {
        if ((error as { status?: unknown } | null)?.status === 409) fail(409, "project memory changed; reload before reverting");
        throw error;
      }
      const written = validateKey(result);
      const reverted = await this.store.update(id, (value) => {
        if (value.status !== "applied" || value.applyDigest !== approval.digest) fail(409, "memory dream candidate changed");
        value.status = "reverted"; value.revertedAt = now();
        value.provenance = { ...(value.provenance ?? {}), revertedAt: value.revertedAt, revertKeyDigest: written.digest };
      });
      return this.#view(reverted);
    } finally { await lease.release(); }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const active = [...this.#active.values()];
    for (const dream of active) dream.controller.abort();
    await Promise.allSettled(active.map((dream) => dream.done));
    await this.store.close();
  }
}
