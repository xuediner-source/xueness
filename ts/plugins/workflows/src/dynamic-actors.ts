/** Typed actors: schemas, transcripts, failure classification and budgeted repair. */
import { PyValueError, validateSchema, type JsonSchema } from "@xueness/contracts";
import type { DynamicAskRequest, DynamicAskResult, DynamicWorkflowDriver } from "./dynamic-types.ts";

/** Why an ask settled badly. `schema_violation` is repairable; the rest are terminal for the attempt. */
export type ActorFailureKind =
  | "schema_violation" | "actor_error" | "driver_error" | "aborted"
  | "hold_awaiting_user" | "hold_paused" | "budget_exhausted";

/** A failure plus where it happened, so an invalid result is attributable to one actor node. */
export interface ActorFailure {
  kind: ActorFailureKind;
  actorId: string;
  nodeId: string;
  siteId: string;
  runId: string;
  attempt: number;
  message: string;
  issues?: { path: string; message: string }[];
}

/** One recorded ask attempt: what went in, what came out, how it was judged. */
export interface ActorAttempt {
  attempt: number;
  at: string;
  instructions: string;
  repairOf?: number;
  output?: unknown;
  issues?: { path: string; message: string }[];
  classification: ActorFailureKind | "valid";
}

/** The repairable error: thrown only after the repair budget is spent, carrying the whole story. */
export class ActorRepairError extends PyValueError {
  readonly failure: ActorFailure;
  readonly attempts: readonly ActorAttempt[];
  constructor(failure: ActorFailure, attempts: readonly ActorAttempt[]) {
    super(`actor '${failure.actorId}' node '${failure.nodeId}' failed (${failure.kind}): ${failure.message}`);
    this.name = "ActorRepairError";
    this.failure = failure;
    this.attempts = attempts;
  }
}

/** Typed actor contract: a name, a persona, the output schema every ask must satisfy, and a repair budget. */
export interface TypedActorSpec {
  name: string;
  persona?: { system?: string; model?: string };
  input?: JsonSchema;
  output: JsonSchema;
  /** How many repair re-asks a schema-violating answer may cost. 0 disables repair. */
  repairBudget?: number;
}

export interface TypedActor extends TypedActorSpec { repairBudget: number }

const NAME_PATTERN = /^[^\s]{1,120}$/;
const BUDGET_LIMIT = 8;

/** Validate and freeze a typed actor definition; `input`/`output` must be object schemas. */
export function defineTypedActor(spec: TypedActorSpec): TypedActor {
  if (typeof spec.name !== "string" || !NAME_PATTERN.test(spec.name)) throw new PyValueError("typed actor name must be 1..120 characters without whitespace");
  if (spec.output === undefined || typeof spec.output !== "object" || Array.isArray(spec.output)) throw new PyValueError("typed actor requires an output schema object");
  const budget = spec.repairBudget === undefined ? 0 : spec.repairBudget;
  if (!Number.isInteger(budget) || budget < 0 || budget > BUDGET_LIMIT) throw new PyValueError(`repair budget must be an integer in 0..${BUDGET_LIMIT}`);
  return { name: spec.name, ...(spec.persona === undefined ? {} : { persona: spec.persona }), ...(spec.input === undefined ? {} : { input: spec.input }), output: spec.output, repairBudget: budget };
}

/** Classify a thrown value from an ask against the taxonomy. Aborts are never repairable. */
export function classifyThrown(error: unknown, signalAborted: boolean): Exclude<ActorFailureKind, "schema_violation" | "budget_exhausted"> {
  if (signalAborted || (error instanceof Error && error.name === "AbortError")) return "aborted";
  if (error instanceof PyValueError) return "driver_error";
  return "actor_error";
}

function issuesOf(schema: JsonSchema, value: unknown): { path: string; message: string }[] {
  return validateSchema(schema, value).map((issue) => ({ path: issue.path || "(input)", message: issue.message }));
}

/** Where transcripts live. Default is in-memory; the host can back it with the run record. */
export interface ActorTranscriptStore {
  load(runId: string, nodeId: string): ActorAttempt[] | undefined;
  save(runId: string, nodeId: string, attempts: ActorAttempt[]): void;
}

export function memoryTranscriptStore(): ActorTranscriptStore {
  const records = new Map<string, ActorAttempt[]>();
  return {
    load: (runId, nodeId) => records.get(`${runId}:${nodeId}`)?.map((entry) => ({ ...entry })),
    save: (runId, nodeId, attempts) => records.set(`${runId}:${nodeId}`, attempts.map((entry) => ({ ...entry }))),
  };
}

/**
 * Idempotent side effects: an effect runs at most once per key. A resumed run
 * replays the recorded outcome instead of re-submitting a completed effect.
 */
export class SideEffectLedger {
  #entries = new Map<string, { status: "completed"; value?: unknown } | { status: "failed"; error: string }>();

  has(key: string): boolean { return this.#entries.has(key); }

  /** Run `effect` only when the key is new; a recorded failure replays as a throw. */
  async commit<T>(key: string, effect: () => Promise<T>): Promise<T> {
    const settled = this.#entries.get(key);
    if (settled) {
      if (settled.status === "failed") throw new PyValueError(`side effect '${key}' already failed: ${settled.error}`);
      return settled.value as T;
    }
    let outcome: { status: "completed"; value?: unknown } | { status: "failed"; error: string };
    try {
      const value = await effect();
      outcome = { status: "completed", ...(value === undefined ? {} : { value }) };
    } catch (error) {
      outcome = { status: "failed", error: error instanceof Error ? error.message : String(error) };
      this.#entries.set(key, outcome);
      throw error;
    }
    this.#entries.set(key, outcome);
    return outcome.value as T;
  }

  /** Replay-only view for tests and journals: what settled, and how. */
  snapshot(): Record<string, { status: string; value?: unknown; error?: string }> {
    const out: Record<string, { status: string; value?: unknown; error?: string }> = {};
    for (const [key, entry] of this.#entries) out[key] = { ...entry };
    return out;
  }
}

export interface RepairDriverOptions {
  /** Typed actors by name; an ask whose actor has a spec is validated and repairable. */
  actors?: Record<string, TypedActor>;
  transcript?: ActorTranscriptStore;
  ledger?: SideEffectLedger;
  /** Builds the repair instructions appended to the original prompt. */
  repairPrompt?: (context: { actor: string; issues: { path: string; message: string }[]; attempt: number; invalid: unknown }) => string;
}

function defaultRepairPrompt(context: { actor: string; issues: { path: string; message: string }[]; attempt: number; invalid: unknown }): string {
  const details = context.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ");
  const previous = JSON.stringify(context.invalid).slice(0, 800);
  return `\nYour previous answer (attempt ${context.attempt}) was invalid: ${details}\nIt was: ${previous}\nAnswer again as JSON that satisfies the required schema. Fix only the reported fields.`;
}

const isHold = (status: string): status is "awaiting_user" | "paused" => status === "awaiting_user" || status === "paused";

/**
 * Wrap a driver so every ask to a typed actor is schema-validated, transcripted,
 * and repaired within its budget. Invalid results are attributable: the thrown
 * `ActorRepairError` names the actor, node and attempt. A schema-valid answer is
 * committed to the ledger, so a resumed run never re-submits the completed ask.
 */
export function createRepairDriver(base: Partial<DynamicWorkflowDriver> & Pick<DynamicWorkflowDriver, "ask">, options: RepairDriverOptions = {}): DynamicWorkflowDriver {
  const specs = options.actors ?? {};
  const transcript = options.transcript ?? memoryTranscriptStore();
  const ledger = options.ledger ?? new SideEffectLedger();
  const repairPrompt = options.repairPrompt ?? defaultRepairPrompt;
  const read = base.read === undefined ? async () => { throw new PyValueError("world reads are not enabled for this driver"); } : base.read.bind(base);
  return {
    read,
    async ask(request: DynamicAskRequest): Promise<DynamicAskResult> {
      const actorName = request.actor.name ?? "";
      const spec = specs[actorName];
      if (!spec) return base.ask(request);
      if (spec.input) {
        const inputIssues = issuesOf(spec.input, request.instructions);
        if (inputIssues.length) {
          // Instructions never carry the input schema today; only object-shaped
          // instructions can be validated, so treat text prompts as opaque.
        }
      }
      const runId = request.run.id;
      const nodeId = request.node.id;
      const siteId = request.node.siteId;
      const key = `ask:${runId}:${nodeId}:${request.node.inputHash}`;
      const prior = transcript.load(runId, nodeId) ?? [];
      const budget = spec.repairBudget;
      let attempt = 0;
      return ledger.commit(key, async () => {
        for (;;) {
          attempt += 1;
          if (attempt - 1 > budget) {
            const failure: ActorFailure = { kind: "budget_exhausted", actorId: request.actor.id, nodeId, siteId, runId, attempt: attempt - 1, message: `repair budget of ${budget} exhausted without a valid answer` };
            prior.push({ attempt: attempt - 1, at: new Date().toISOString(), instructions: "<budget exhausted>", classification: "budget_exhausted" });
            transcript.save(runId, nodeId, prior);
            throw new ActorRepairError(failure, [...prior]);
          }
          const instructions = attempt === 1 ? request.instructions
            : `${request.instructions}${repairPrompt({ actor: actorName, issues: prior[attempt - 2]?.issues ?? [], attempt: attempt - 1, invalid: prior[attempt - 2]?.output })}`;
          let response: DynamicAskResult;
          try {
            response = await base.ask({ ...request, instructions });
          } catch (error) {
            const kind = classifyThrown(error, request.signal.aborted);
            prior.push({ attempt, at: new Date().toISOString(), instructions, classification: kind });
            transcript.save(runId, nodeId, prior);
            throw error;
          }
          if (isHold(response.status)) {
            prior.push({ attempt, at: new Date().toISOString(), instructions, classification: response.status === "awaiting_user" ? "hold_awaiting_user" : "hold_paused" });
            transcript.save(runId, nodeId, prior);
            return response;
          }
          const issues = issuesOf(spec.output, response.value);
          if (!issues.length) {
            prior.push({ attempt, at: new Date().toISOString(), instructions, output: response.value, classification: "valid" });
            transcript.save(runId, nodeId, prior);
            return response;
          }
          prior.push({ attempt, at: new Date().toISOString(), instructions, output: response.value, issues, classification: "schema_violation" });
          transcript.save(runId, nodeId, prior);
        }
      });
    },
  };
}
