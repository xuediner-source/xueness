/**
 * H02.05 — Critic-Solver dual-model orchestration.
 *
 * A Solver model proposes a patch for a task; a separate Critic model
 * reviews the proposal against the task and answers with a structured
 * verdict. The pairing loops until the Critic accepts, the Critic rejects
 * a proposal as unrecoverable, or a round budget is exhausted.
 *
 * Models are injected (`HarnessModel`), so the orchestration itself never
 * opens a network connection: the host provides adapters (e.g. the H01
 * reasoning bridge) and this module only pairs, prompts and parses.
 */

/** Minimal model adapter the orchestration needs from the host. */
export interface HarnessModel {
  readonly id: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export interface ModelRequest {
  /** Role label recorded in the trajectory ("solver" | "critic" | host-defined). */
  role: string;
  /** Fully rendered prompt; prefix-stable across rounds for KV reuse. */
  prompt: string;
  /** Monotonic call index within the session, for cache accounting. */
  callIndex: number;
}

export interface ModelResponse {
  text: string;
  usage?: TokenUsage;
}

/** DeepSeek-style usage split; cachedTokens is the KV prefix-cache hit part. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
}

export type Verdict = "accept" | "reject";

/** The patch artifact a Solver round produces. */
export interface SolverPatch {
  /** Workspace-relative file path the patch targets. */
  path: string;
  /** Proposed new file content, or null when the solver only explains. */
  content: string | null;
  summary: string;
}

/** Structured result of one Critic review. */
export interface CriticReview {
  verdict: Verdict;
  /** 0..1 confidence the Critic reports; defaults from the verdict when absent. */
  score: number;
  reasons: string[];
  /** True when the critic output could not be parsed as a review. */
  malformed: boolean;
}

export interface CriticSolverOptions {
  task: string;
  solver: HarnessModel;
  critic: HarnessModel;
  /** Context the solver patches (current file contents), by path. */
  files?: Record<string, string>;
  /** Maximum solver/critic rounds; default 3. */
  maxRounds?: number;
  /** Called after each model call with the exchange, for trajectory recording. */
  onExchange?: (exchange: ModelExchange) => void;
}

export interface ModelExchange {
  round: number;
  role: string;
  modelId: string;
  callIndex: number;
  prompt: string;
  response: string;
  usage: TokenUsage;
}

export interface SolverRound {
  round: number;
  patch: SolverPatch | null;
  review: CriticReview;
}

export interface CriticSolverResult {
  /** Final decision: an accepted patch, or the last rejection. */
  verdict: Verdict;
  /** Final patch when accepted, otherwise the last proposal (possibly null). */
  patch: SolverPatch | null;
  rounds: SolverRound[];
  /** True when the round budget ran out before an acceptance. */
  exhausted: boolean;
}

const DEFAULT_ROUNDS = 3;

const SOLVER_INSTRUCTION = [
  "You are the Solver. Produce exactly one JSON object on the last line of your reply:",
  '{"path": "<workspace-relative file>", "content": "<full proposed file content>", "summary": "<one line>"}',
  "Only the JSON object is evaluated; keep any explanation before it short.",
].join(" ");

const CRITIC_INSTRUCTION = [
  "You are the Critic. Review the Solver's proposal against the task and answer with exactly one JSON object:",
  '{"verdict": "accept" | "reject", "score": <0..1>, "reasons": ["..."]}',
  "Accept only if the patch completes the task; otherwise reject with concrete reasons.",
].join(" ");

function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
}

const mergeUsage = (response: ModelResponse): TokenUsage => {
  const usage = response.usage ?? emptyUsage();
  return {
    promptTokens: usage.promptTokens ?? 0,
    completionTokens: usage.completionTokens ?? 0,
    cachedTokens: usage.cachedTokens ?? 0,
  };
};

/**
 * Extract the last balanced JSON object in a model reply, or null.
 *
 * The scan is forward and string-aware, so braces inside string literals
 * (`"if (x) {"`, `"say \"}\""`) never affect depth and an escaped quote is
 * not mistaken for a delimiter. Each complete top-level object is tried from
 * last to first, so prose before the payload cannot break parsing.
 */
export function extractJson(text: string): Record<string, unknown> | null {
  const candidates: Array<[number, number]> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) candidates.push([start, i]);
    }
  }
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const [from, to] = candidates[index] as [number, number];
    try {
      const parsed: unknown = JSON.parse(text.slice(from, to + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* try the previous candidate */ }
  }
  return null;
}

/** Parse a Solver reply into a patch; null when no usable object is found. */
export function parseSolverPatch(text: string): SolverPatch | null {
  const object = extractJson(text);
  if (!object) return null;
  const path = object.path;
  const summary = object.summary;
  if (typeof path !== "string" || path.length === 0 || path.startsWith("/") || path.split("/").includes("..")) return null;
  if (summary !== undefined && typeof summary !== "string") return null;
  const content = object.content;
  if (content !== undefined && content !== null && typeof content !== "string") return null;
  return { path, content: content ?? null, summary: typeof summary === "string" ? summary : "" };
}

const asScore = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;

/** Parse a Critic reply into a review; malformed output becomes a rejection. */
export function parseCriticReview(text: string): CriticReview {
  const object = extractJson(text);
  if (!object) {
    return { verdict: "reject", score: 0, reasons: ["critic reply contained no JSON review"], malformed: true };
  }
  const verdict = object.verdict;
  if (verdict !== "accept" && verdict !== "reject") {
    return { verdict: "reject", score: 0, reasons: [`critic verdict ${JSON.stringify(verdict)} is neither accept nor reject`], malformed: true };
  }
  const fallback = verdict === "accept" ? 1 : 0;
  const reasons = Array.isArray(object.reasons) ? object.reasons.filter((item): item is string => typeof item === "string") : [];
  return { verdict, score: asScore(object.score, fallback), reasons, malformed: false };
}

function renderTask(options: CriticSolverOptions): string {
  const files = Object.entries(options.files ?? {})
    .map(([path, content]) => `--- ${path} ---\n${content}`)
    .join("\n\n");
  return `Task:\n${options.task}${files ? `\n\nCurrent files:\n${files}` : ""}`;
}

function renderProposal(task: string, patch: SolverPatch | null, round: number): string {
  const proposal = patch
    ? `Proposal (round ${round}):\npath: ${patch.path}\nsummary: ${patch.summary || "(none)"}\ncontent:\n${patch.content ?? "(explanation only)"}`
    : `Proposal (round ${round}): the Solver produced no parseable patch.`;
  return `${task}\n\n${proposal}`;
}

async function callModel(
  model: HarnessModel,
  role: string,
  prompt: string,
  callIndex: number,
  round: number,
  onExchange: ((exchange: ModelExchange) => void) | undefined,
): Promise<ModelResponse> {
  const response = await model.complete({ role, prompt, callIndex });
  onExchange?.({ round, role, modelId: model.id, callIndex, prompt, response: response.text, usage: mergeUsage(response) });
  return response;
}

/**
 * Run the Solver/Critic pairing for one task. Each round is one Solver call
 * and one Critic call; the prompt prefix (instruction + task + files) is
 * byte-identical across rounds and models so a shared KV prefix cache can
 * serve it, which the trajectory recorder then measures.
 */
export async function runCriticSolver(options: CriticSolverOptions): Promise<CriticSolverResult> {
  if (!options.task.trim()) throw new Error("critic-solver requires a non-empty task");
  const maxRounds = options.maxRounds ?? DEFAULT_ROUNDS;
  if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new Error("critic-solver requires maxRounds >= 1");
  const task = renderTask(options);
  const rounds: SolverRound[] = [];
  let callIndex = 0;
  let patch: SolverPatch | null = null;

  for (let round = 1; round <= maxRounds; round += 1) {
    const solverPrompt = `${SOLVER_INSTRUCTION}\n\n${task}\n\nPrevious reviews: ${
      rounds.length ? JSON.stringify(rounds.map((item) => ({ verdict: item.review.verdict, reasons: item.review.reasons }))) : "none"
    }`;
    const solverReply = await callModel(options.solver, "solver", solverPrompt, callIndex += 1, round, options.onExchange);
    patch = parseSolverPatch(solverReply.text);

    const criticPrompt = `${CRITIC_INSTRUCTION}\n\n${renderProposal(task, patch, round)}`;
    const criticReply = await callModel(options.critic, "critic", criticPrompt, callIndex += 1, round, options.onExchange);
    const review = parseCriticReview(criticReply.text);
    rounds.push({ round, patch, review });
    if (review.verdict === "accept") return { verdict: "accept", patch, rounds, exhausted: false };
  }
  // Reaching here means every round was spent without an acceptance, so the
  // budget is exhausted whether the last review was a rejection or malformed.
  return { verdict: "reject", patch, rounds, exhausted: true };
}
