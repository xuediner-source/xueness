import { createHash } from "node:crypto";
import { pyEncodeUtf8, pyJsonDumps, PyValueError, validateSchema, type JsonSchema } from "@xueness/contracts";
import type { DynamicActor, DynamicAskResult, DynamicNode, DynamicScriptHost, DynamicWorkflowDriver, DynamicWorkflowRun } from "./dynamic-types.ts";
import { DynamicWorkflowStore } from "./dynamic-store.ts";
import { abortError, DynamicOperationScheduler } from "./dynamic-engine-scheduler.ts";

type HoldStatus = "awaiting_user" | "paused";
export class DynamicWorkflowHold extends Error {
  readonly status: HoldStatus;
  readonly nodeId: string;
  readonly question?: string;
  constructor(status: HoldStatus, nodeId: string, question?: string) {
    super(question ?? (status === "paused" ? "dynamic workflow actor is paused" : "dynamic workflow is awaiting user input"));
    this.name = "DynamicWorkflowHold";
    this.status = status;
    this.nodeId = nodeId;
    if (question !== undefined) this.question = question;
  }
}

const IMPORTED_NODE = "importedCache";
interface NodeTicket { nodeId: string; siteId: string; ordinal: number; kind: DynamicNode["kind"]; inputHash: string; actorId?: string; actorSeq?: number; cached: boolean; value?: unknown; hold?: DynamicWorkflowHold }

function cloneJson(value: unknown): unknown {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { throw new PyValueError("dynamic workflow values must be JSON serializable"); }
  if (encoded === undefined) throw new PyValueError("dynamic workflow values must be JSON serializable");
  try { return JSON.parse(encoded) as unknown; } catch { throw new PyValueError("dynamic workflow values must be JSON serializable"); }
}

function inputHash(value: unknown): string {
  const body = pyJsonDumps(cloneJson(value), { sortKeys: true, ensureAscii: false, separators: [",", ":"] });
  return createHash("sha256").update(pyEncodeUtf8(body)).digest("hex");
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 1000) || error.name;
  return String(error).slice(0, 1000);
}

function personaOf(value: string | { system?: string; model?: string } | undefined): DynamicActor["persona"] {
  if (value === undefined) return {};
  if (typeof value === "string") return { system: value };
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      (value.system !== undefined && typeof value.system !== "string") ||
      (value.model !== undefined && typeof value.model !== "string")) {
    throw new PyValueError("actor persona must contain only string system/model fields");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "system" && key !== "model")) throw new PyValueError("actor persona must contain only system/model fields");
  return { ...(value.system === undefined ? {} : { system: value.system }), ...(value.model === undefined ? {} : { model: value.model }) };
}

function samePersona(left: DynamicActor["persona"], right: DynamicActor["persona"]): boolean {
  return left.system === right.system && left.model === right.model;
}

export class DynamicEngineOperations implements DynamicScriptHost {
  readonly store: DynamicWorkflowStore;
  readonly id: string;
  readonly driver: DynamicWorkflowDriver;
  readonly scheduler: DynamicOperationScheduler;
  readonly signal: AbortSignal;
  #ordinals = new Map<string, number>();

  constructor(store: DynamicWorkflowStore, id: string, driver: DynamicWorkflowDriver, scheduler: DynamicOperationScheduler, signal: AbortSignal) {
    this.store = store; this.id = id; this.driver = driver; this.scheduler = scheduler; this.signal = signal;
  }

  #nextOrdinal(siteId: string): number {
    const ordinal = (this.#ordinals.get(siteId) ?? 0) + 1;
    this.#ordinals.set(siteId, ordinal);
    return ordinal;
  }

  createActor(siteId: string, givenName?: string, givenPersona?: string | { system?: string; model?: string }): DynamicActor {
    const ordinal = this.#nextOrdinal(siteId);
    const actorId = `${siteId}@${ordinal}`;
    const name = givenName ?? actorId;
    if (typeof name !== "string" || !name.trim() || name.length > 120) throw new PyValueError("actor name must be 1..120 characters");
    const persona = personaOf(givenPersona);
    const next = this.store.update(this.id, (run) => {
      const duplicate = Object.values(run.actors).find((actor) => actor.name === name && actor.id !== actorId);
      if (duplicate) throw new PyValueError(`actor name '${name}' is already used`);
      const old = run.actors[actorId];
      if (old && (old.name !== name || !samePersona(old.persona, persona))) {
        if (!run.importedFrom) throw new PyValueError('actor identity changed during recovery');
        old.name = name;
        old.persona = persona;
        delete old.sessionId;
        old.asks = 0;
        for (const [nodeId, node] of Object.entries(run.nodes)) if (node.actorId === actorId) delete run.nodes[nodeId];
        DynamicWorkflowStore.event(run, "actor_reset", { actorId });
      } else if (old) {
        old.name = name;
      } else {
        run.actors[actorId] = { id: actorId, name, persona, asks: 0 };
        DynamicWorkflowStore.event(run, "actor_created", { actorId });
      }
    });
    const actor = next.actors[actorId];
    if (!actor) throw new PyValueError("dynamic actor could not be persisted");
    return { id: actor.id, name: actor.name, persona: { ...actor.persona } };
  }

  ask(siteId: string, actor: DynamicActor, instructions: string, schema?: JsonSchema): Promise<unknown> {
    const ordinal = this.#nextOrdinal(siteId);
    const actorId = actor.id;
    const actorSeq = this.store.update(this.id, (run) => {
      const stored = run.actors[actorId];
      if (!stored || stored.name !== actor.name || !samePersona(stored.persona, actor.persona)) throw new PyValueError("ask references an unknown or changed actor");
      stored.asks += 1;
    }).actors[actorId]!.asks;
    const storedActor = this.store.load(this.id).actors[actorId]!;
    const actualSchema = schema === undefined ? undefined : cloneJson(schema) as JsonSchema;
    const requestInput = {
      actor: { id: actorId, name: storedActor.name, persona: storedActor.persona }, instructions,
      ...(actualSchema === undefined ? {} : { schema: actualSchema }),
    };
    const ticket = this.#ticket(siteId, ordinal, "ask", requestInput, actorId, actorSeq);
    if (ticket.hold) return Promise.reject(ticket.hold);
    if (ticket.cached) return Promise.resolve(ticket.value);
    return this.#dispatch(ticket, actorId, async (signal) => {
      const run = this.store.load(this.id);
      const currentActor = run.actors[actorId];
      const node = run.nodes[ticket.nodeId];
      if (!currentActor || !node) throw new PyValueError("dynamic actor or ask node disappeared");
      const request = {
        run, actor: currentActor, node, instructions, ...(actualSchema === undefined ? {} : { schema: actualSchema }), signal,
        rememberSession: (sessionId: string): void => {
          if (typeof sessionId !== "string" || !/^[a-f0-9]{32}$/.test(sessionId)) throw new PyValueError("driver returned an invalid session id");
          this.store.update(this.id, (record) => {
            const target = record.actors[actorId];
            if (!target) throw new PyValueError("dynamic actor disappeared before session persistence");
            target.sessionId = sessionId;
          });
        },
      };
      const response = await this.driver.ask(request);
      return this.#settleAsk(ticket, response, actualSchema);
    });
  }

  read(siteId: string, operation: "files.read" | "files.glob", args: unknown[]): Promise<unknown> {
    const ordinal = this.#nextOrdinal(siteId);
    const cleanArgs = cloneJson(args) as unknown[];
    const ticket = this.#ticket(siteId, ordinal, "read", { operation, args: cleanArgs });
    if (ticket.hold) return Promise.reject(ticket.hold);
    if (ticket.cached) return Promise.resolve(ticket.value);
    return this.#dispatch(ticket, undefined, async (signal) => this.driver.read(this.store.load(this.id), operation, cleanArgs, signal));
  }

  report(siteId: string, item: unknown): void {
    const ordinal = this.#nextOrdinal(siteId);
    const clean = cloneJson(item);
    const ticket = this.#ticket(siteId, ordinal, "report", { item: clean });
    if (ticket.cached) return;
    if (ticket.hold) throw ticket.hold;
    this.store.update(this.id, (run) => {
      run.nodes[ticket.nodeId] = { id: ticket.nodeId, siteId, ordinal, kind: "report", inputHash: ticket.inputHash, status: "completed", result: clean };
      run.reports.push(clean);
      DynamicWorkflowStore.event(run, "node_completed", { nodeId: ticket.nodeId });
    });
  }

  async hole(siteId: string, name: string, prompt?: string): Promise<unknown> {
    const ordinal = this.#nextOrdinal(siteId);
    const ticket = this.#ticket(siteId, ordinal, "hole", { name, ...(prompt === undefined ? {} : { prompt }) });
    if (ticket.hold) throw ticket.hold;
    if (ticket.cached) return ticket.value;
    return this.#dispatch(ticket, undefined, async () => {
      const question = prompt ?? name;
      this.store.update(this.id, (run) => {
        const node = this.#node(run, ticket);
        node.status = "awaiting_user";
        node.question = question;
        DynamicWorkflowStore.event(run, "node_awaiting_user", { nodeId: ticket.nodeId });
      });
      throw new DynamicWorkflowHold("awaiting_user", ticket.nodeId, question);
    });
  }

  log(message: string): void {
    this.store.update(this.id, (run) => DynamicWorkflowStore.event(run, "log", { message: Array.from(message).slice(0, 2000).join('') }));
  }

  phase(name: string): void {
    this.store.update(this.id, (run) => {
      run.phase = name;
      DynamicWorkflowStore.event(run, "phase", { phase: name });
    });
  }

  #ticket(siteId: string, ordinal: number, kind: DynamicNode["kind"], input: unknown, actorId?: string, actorSeq?: number): NodeTicket {
    const nodeId = `${siteId}@${ordinal}`;
    const digest = inputHash(input);
    let result: NodeTicket = { nodeId, siteId, ordinal, kind, inputHash: digest, ...(actorId === undefined ? {} : { actorId }), ...(actorSeq === undefined ? {} : { actorSeq }), cached: false };
    const run = this.store.load(this.id);
    const old = run.nodes[nodeId] as (DynamicNode & Record<string, unknown>) | undefined;
    if (old && old.kind !== kind) throw new PyValueError("dynamic site changed kind in an existing node");
    if (old && old.inputHash !== digest) {
      if (!old[IMPORTED_NODE]) throw new PyValueError(`dynamic node '${nodeId}' input changed during recovery`);
      if (actorId !== undefined && actorSeq !== undefined) this.#clearActorCache(actorId, actorSeq);
    } else if (old?.status === "completed") {
      result = { ...result, cached: true, value: cloneJson(old.result) };
      return result;
    } else if (old?.status === "awaiting_user") {
      const status: HoldStatus = kind === "hole" ? "awaiting_user" : "awaiting_user";
      return { ...result, hold: new DynamicWorkflowHold(status, nodeId, old.question) };
    }
    return result;
  }

  #clearActorCache(actorId: string, actorSeq: number): void {
    this.store.update(this.id, (run) => {
      for (const [nodeId, node] of Object.entries(run.nodes)) {
        if (node.actorId === actorId && (node.actorSeq ?? 0) >= actorSeq) delete run.nodes[nodeId];
      }
    });
  }

  #node(run: DynamicWorkflowRun, ticket: NodeTicket): DynamicNode {
    let node = run.nodes[ticket.nodeId];
    if (!node) {
      node = { id: ticket.nodeId, siteId: ticket.siteId, ordinal: ticket.ordinal, kind: ticket.kind, inputHash: ticket.inputHash, status: "pending",
        ...(ticket.actorId === undefined ? {} : { actorId: ticket.actorId }), ...(ticket.actorSeq === undefined ? {} : { actorSeq: ticket.actorSeq }) };
      run.nodes[ticket.nodeId] = node;
    }
    node.siteId = ticket.siteId;
    node.ordinal = ticket.ordinal;
    node.kind = ticket.kind;
    node.inputHash = ticket.inputHash;
    if (ticket.actorId === undefined) delete node.actorId; else node.actorId = ticket.actorId;
    if (ticket.actorSeq === undefined) delete node.actorSeq; else node.actorSeq = ticket.actorSeq;
    return node;
  }

  #dispatch<T>(ticket: NodeTicket, actorId: string | undefined, work: (signal: AbortSignal) => Promise<T> | T): Promise<T> {
    return this.scheduler.schedule(actorId, async (signal) => {
      if (signal.aborted) throw abortError(signal);
      this.store.update(this.id, (run) => {
        const node = this.#node(run, ticket);
        node.status = "running"; delete node.error; delete node.question; delete node.result;
        (node as DynamicNode & Record<string, unknown>)[IMPORTED_NODE] = false;
        DynamicWorkflowStore.event(run, "node_running", { nodeId: ticket.nodeId, ...(actorId === undefined ? {} : { actorId }) });
      });
      try {
        const value = cloneJson(await work(signal));
        this.store.update(this.id, (run) => {
          const node = this.#node(run, ticket);
          node.status = "completed"; node.result = value; delete node.error; delete node.question;
          DynamicWorkflowStore.event(run, "node_completed", { nodeId: ticket.nodeId, ...(actorId === undefined ? {} : { actorId }) });
        });
        return value as T;
      } catch (error) {
        if (!(error instanceof DynamicWorkflowHold)) {
          this.store.update(this.id, (run) => {
            const node = this.#node(run, ticket);
            node.status = signal.aborted ? "interrupted" : "failed";
            node.error = errorText(error);
            delete node.question;
            DynamicWorkflowStore.event(run, signal.aborted ? "node_interrupted" : "node_failed", { nodeId: ticket.nodeId, ...(actorId === undefined ? {} : { actorId }) });
          });
        }
        throw error;
      }
    });
  }

  async #settleAsk(ticket: NodeTicket, response: DynamicAskResult, schema?: JsonSchema): Promise<unknown> {
    if (!response || !["completed", "awaiting_user", "paused"].includes(response.status)) throw new PyValueError("driver returned an invalid ask result");
    if (response.status !== "completed") {
      const question = response.question;
      this.store.update(this.id, (run) => {
        const node = this.#node(run, ticket);
        if (response.status === "awaiting_user") {
          node.status = "awaiting_user";
          delete node.error;
          if (question !== undefined) node.question = question;
          else delete node.question;
          DynamicWorkflowStore.event(run, "node_awaiting_user", { nodeId: ticket.nodeId, ...(ticket.actorId === undefined ? {} : { actorId: ticket.actorId }) });
        } else {
          // A permission/provider pause is retryable on an explicit resume;
          // it is not an operator question that can be resolved with text.
          node.status = "pending";
          node.error = question ?? "driver paused before completing the ask";
          delete node.question;
          DynamicWorkflowStore.event(run, "node_paused", { nodeId: ticket.nodeId, ...(ticket.actorId === undefined ? {} : { actorId: ticket.actorId }) });
        }
      });
      throw new DynamicWorkflowHold(response.status, ticket.nodeId, question);
    }
    const value = cloneJson(response.value);
    if (schema) {
      const issues = validateSchema(schema, value);
      if (issues.length) throw new PyValueError(`driver result does not match schema: ${issues.map((issue) => `${issue.path || "(input)"} ${issue.message}`).join("; ")}`);
    }
    return value;
  }
}
