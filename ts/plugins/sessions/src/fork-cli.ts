/**
 * The operator CLI's fork adapters (Python `forking.fork_turn` and
 * `fork_at_checkpoint` with `enforce_workspace=False`): the CLI reads the local
 * journal, so the web workspace allowlist does not apply; the lease, stream and
 * boundary rules do.
 */
import { existsSync, statSync } from "node:fs";
import { isPyIntValue, pyEquals, pyTruthy } from "@xueness/contracts";
import { pyExceptionName, type SessionStore } from "@xueness/sessions";
import { ForkError, readForkSnapshot, validForkText, type Row } from "./fork-common.ts";
import { forkBoundaries } from "./fork-boundaries.ts";
import { makeFork } from "./forking.ts";
import type { SessionsApiOptions } from "./http-api.ts";
import { validateTitle } from "./session-management.ts";

export interface ForkCliContext { store: SessionStore; stateDir: string }

function checkedTitle(title: unknown): string | undefined {
  if (title === null || title === undefined) return undefined;
  try { return validateTitle(title); } catch (error) { throw new ForkError((error as Error).message); }
}

async function withSource<T>(context: ForkCliContext, sid: string, body: (source: Row, revision: string) => Promise<T>): Promise<T> {
  let lease: Awaited<ReturnType<SessionStore["lease"]>>;
  try { lease = await context.store.lease(sid); }
  catch (error) { if (pyExceptionName(error) === "BlockingIOError") throw new ForkError("session is in use by another process", 409); throw error; }
  try {
    const [source, revision] = readForkSnapshot(context.store, sid);
    if (pyTruthy(source.streaming)) throw new ForkError("session has an active or interrupted stream", 409);
    if (!existsSync(source.root) || !statSync(source.root).isDirectory()) throw new ForkError("session workspace is unavailable", 409);
    return await body(source, revision);
  } finally { await lease.release(); }
}

const options = (context: ForkCliContext): SessionsApiOptions => ({ store: context.store, stateDir: context.stateDir }) as unknown as SessionsApiOptions;

/** `fork_turn`: a server-derived ordinal, or the latest safe one. */
export async function forkTurn(context: ForkCliContext, sid: string, request: { turn?: number | null; title?: string | null }): Promise<Row> {
  if (request.turn != null && (!isPyIntValue(request.turn) || request.turn < 1)) throw new ForkError("turn must be a positive integer");
  const title = checkedTitle(request.title);
  return withSource(context, sid, async (source, revision) => {
    const candidates = forkBoundaries(source, revision).boundaries as Row[];
    const boundary = request.turn != null ? candidates.find((item) => item.turn === request.turn) : candidates.at(-1);
    if (!boundary) throw new ForkError(request.turn != null ? "requested turn is not a safe closed boundary" : "session has no safe closed turn to fork");
    return makeFork(options(context), source, revision, boundary, title);
  });
}

/** `fork_at_checkpoint`: the closed turns before one automatic workspace snapshot. */
export async function forkAtCheckpoint(context: ForkCliContext, sid: string, request: { checkpoint?: string | null; latest?: boolean; turn?: number | null; title?: string | null }): Promise<Row> {
  const latest = request.latest ?? false;
  if (request.checkpoint != null && latest) throw new ForkError("choose either a checkpoint id or --latest, not both");
  if (request.checkpoint != null && !validForkText(request.checkpoint, 32)) throw new ForkError("invalid checkpoint id");
  if (request.turn != null && (!isPyIntValue(request.turn) || request.turn < 1)) throw new ForkError("turn must be a positive integer");
  const title = checkedTitle(request.title);
  return withSource(context, sid, async (source, revision) => {
    const records = (Array.isArray(source.turn_checkpoints) ? source.turn_checkpoints : []).filter((r: unknown) => r !== null && typeof r === "object" && pyTruthy((r as Row).checkpointId)) as Row[];
    let chosen: Row | undefined;
    if (request.turn != null) { chosen = records.find((r) => pyEquals(r.turn, request.turn)); if (!chosen) throw new ForkError("requested turn has no workspace checkpoint", 409); }
    else {
      if (!records.length) throw new ForkError("该会话没有可用的轮次检查点", 409);
      chosen = latest || request.checkpoint == null ? records.at(-1) : records.find((r) => r.checkpointId === request.checkpoint);
      if (!chosen) throw new ForkError("未知的轮次检查点", 404);
    }
    if (typeof chosen.checkpointId !== "string" || !/^[0-9a-f]{32}$/.test(chosen.checkpointId)) throw new ForkError("checkpoint record is invalid", 409);
    if (!isPyIntValue(chosen.turn) || Number(chosen.turn) < 2) throw new ForkError("that checkpoint has no earlier turn to fork from", 409);
    const boundary = (forkBoundaries(source, revision).boundaries as Row[]).find((item) => item.turn === Number(chosen.turn) - 1);
    if (!boundary) throw new ForkError("the turn before that checkpoint is not a safe closed boundary", 409);
    const linked = { checkpointId: chosen.checkpointId, turn: chosen.turn };
    const result = await makeFork(options(context), source, revision, boundary, title, linked);
    result.checkpoint = linked;
    return result;
  });
}
