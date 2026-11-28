/**
 * Durable swarm state under `<state>/swarms/<id>/`: `swarm.json` (written
 * whole and atomically), `board.jsonl` (append-only, one post per line) and
 * the members' sessions in `sessions/`. A restart loses nothing: a torn last
 * board line is ignored on load (the A9 lesson — in-memory registries vanish).
 */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isDict, pyJsonDumps, pyJsonLoads } from "@xueness/contracts";
import { BOARD_MAX, type Post } from "./board.ts";
import type { JudgeChoice, MemberPlan } from "./plan.ts";

export const SWARM_ID = /^swarm-[0-9a-f]{12}$/;
export const STATUSES = ["running", "paused", "interrupted", "stalled", "completed", "failed", "cancelled"] as const;
export type SwarmStatus = (typeof STATUSES)[number];
export const TERMINAL: ReadonlySet<SwarmStatus> = new Set(["completed", "failed", "cancelled"]);
export type MemberState = "active" | "waiting" | "done" | "killed";
export type FailureKind = "quota" | "error";
export type WakeMode = "mentions" | "any";

export interface SwarmChannel { name: string; topic: string; createdBy: string; archived?: boolean }
export interface Limits { maxActive: number; memberMaxSteps: number; memberMaxTurns: number; nudgeLimit: number; wallMinutes: number }
export interface MemberRecord extends MemberPlan {
  sessionId: string | null; state: MemberState;
  /** Highest board seq this member has been given. */
  delivered: number; turns: number; steps: number; summary: string; lastActiveAt: string | null; error: string | null;
  wakeMode?: WakeMode;
  waitSince?: number;
  failureKind?: FailureKind | null;
  forkFromSessionId?: string | null;
  addedBy?: string;
}
/** The verifier's grade for one acceptance criterion: what it checked itself, not what a member claimed. */
export interface CriterionResult { criterion: number; met: boolean; evidence: string }
export interface SwarmRecord {
  v: 1; id: string; parentSessionId: string; root: string; status: SwarmStatus; pauseReason: string | null;
  createdAt: string; updatedAt: string; startedAt: string; digest: string; goal: string; judge: JudgeChoice; limits: Limits;
  title?: string;
  channels?: SwarmChannel[];
  approvedOwns?: string[];
  approvedCommands?: string[];
  /** Models the user approved in the plan; a coordinator may only switch a member to one of these (or to inherit). */
  approvedModels?: { providerId: string; model: string | null }[];
  members: MemberRecord[]; monitor: { nudges: number; lastProgressSeq: number };
  /** The plan's done-contract, numbered from 1 in prompts and reports. */
  acceptance?: string[];
  verification: { verdict: "pass" | "fail"; findings: string; at: string; criteria?: CriterionResult[] } | null;
  outcome: { status: "completed" | "failed"; summary: string } | null;
  /** Status notices already shown to the parent conversation, by key. */
  noticed: Record<string, true>;
  /** The server process that runs this swarm; another process sharing the state directory leaves it alone. */
  ownerPid?: number;
}

export class SwarmStoreError extends Error { override name = "SwarmStoreError"; }

const QUOTA_RE = /RESOURCE_EXHAUSTED|quota|\b429\b|exhausted your capacity|rate.?limit|insufficient_quota/i;
export function classifyFailure(error: string | null | undefined): FailureKind | null {
  const msg = typeof error === "string" ? error.trim() : "";
  if (!msg) return null;
  return QUOTA_RE.test(msg) ? "quota" : "error";
}

export const swarmsDirectory = (stateDir: string): string => join(stateDir, "swarms");
export function swarmDirectory(stateDir: string, id: string): string {
  if (!SWARM_ID.test(id)) throw new SwarmStoreError("invalid swarm id");
  return join(swarmsDirectory(stateDir), id);
}
export const memberSessionsDirectory = (stateDir: string, id: string): string => join(swarmDirectory(stateDir, id), "sessions");

function refuseLink(path: string): void {
  try { if (lstatSync(path).isSymbolicLink()) throw new SwarmStoreError("swarm storage must not be a link"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function writeAtomic(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, path); } catch (error) { rmSync(temporary, { force: true }); throw error; }
}

export function saveSwarm(stateDir: string, record: SwarmRecord): void {
  const directory = swarmDirectory(stateDir, record.id);
  refuseLink(swarmsDirectory(stateDir)); refuseLink(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  record.updatedAt = new Date().toISOString();
  writeAtomic(join(directory, "swarm.json"), pyJsonDumps(record, { indent: 2 }));
}

export function loadSwarm(stateDir: string, id: string): SwarmRecord {
  const path = join(swarmDirectory(stateDir, id), "swarm.json");
  refuseLink(path);
  let value: unknown;
  try { value = pyJsonLoads(readFileSync(path, "utf8")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new SwarmStoreError("swarm not found");
    throw new SwarmStoreError("swarm record is unreadable");
  }
  if (!isDict(value) || value.v !== 1 || value.id !== id || !Array.isArray(value.members) || !(STATUSES as readonly unknown[]).includes(value.status)) throw new SwarmStoreError("swarm record is invalid");
  return value as unknown as SwarmRecord;
}

/** Every readable swarm, newest first; unreadable ones are skipped. */
export function listSwarms(stateDir: string, limit = 200): SwarmRecord[] {
  const root = swarmsDirectory(stateDir);
  if (!existsSync(root)) return [];
  refuseLink(root);
  const out: SwarmRecord[] = [];
  for (const name of readdirSync(root).filter((entry) => SWARM_ID.test(entry))) {
    try { out.push(loadSwarm(stateDir, name)); } catch { /* skipped */ }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

export function readPosts(stateDir: string, id: string, after = 0): Post[] {
  const path = join(swarmDirectory(stateDir, id), "board.jsonl");
  refuseLink(path);
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const posts: Post[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = pyJsonLoads(line); } catch { continue; } // a torn last line from a crash
    if (!isDict(value) || typeof value.seq !== "number" || typeof value.from !== "string" || typeof value.text !== "string" || !isDict(value.to) || !Array.isArray(value.recipients)) continue;
    if (value.seq > after) posts.push(value as unknown as Post);
  }
  return posts.sort((a, b) => a.seq - b.seq);
}

export function appendPost(stateDir: string, id: string, post: Post): void {
  const directory = swarmDirectory(stateDir, id);
  refuseLink(directory);
  if (post.seq > BOARD_MAX) throw new SwarmStoreError(`the board is full (${BOARD_MAX} posts)`);
  const path = join(directory, "board.jsonl");
  refuseLink(path);
  // One append handle that writes and syncs (Windows refuses fsync on a read-only handle).
  const fd = openSync(path, "a", 0o600);
  try { writeSync(fd, pyJsonDumps(post) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
}
