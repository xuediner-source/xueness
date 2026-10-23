import { isDict, pyTruthy } from "@xueness/contracts";
import type { Session, SessionStore } from "@xueness/sessions";
import { checkpoint, GitError, repository, type Row } from "./actions.ts";
export const checkpointRecords = (s: Row): Row[] => Array.isArray(s.turn_checkpoints) ? s.turn_checkpoints.filter((r: unknown) => isDict(r) && pyTruthy(r.checkpointId)) : [];
export function resolveCheckpoint(session: Row, id?: string | null, latest = false): Row {
  const records = checkpointRecords(session); if (!records.length) throw new GitError(409, "该会话没有可用的轮次检查点");
  const result = latest || id == null ? records.at(-1) : records.find((r) => r.checkpointId === id);
  if (!result) throw new GitError(404, "未知的轮次检查点"); return result;
}
export async function recordTurn(store: SessionStore, session: Session | null, enabled: (id: string) => boolean, tool = "", kind = ""): Promise<Row | null> {
  try {
    if (!session || !["write", "edit", "exec"].includes(kind) || pyTruthy(session.remote_connection) || !enabled("git")) return null;
    const turn = Array.isArray(session.messages) ? session.messages.filter((r) => isDict(r) && r.role === "user").length : 0, existing = checkpointRecords(session);
    if (!turn || existing.some((r) => r.turn === turn) || !await repository(session.root)) return null;
    const saved = await checkpoint(String(session.root), `Turn ${turn} before first change`);
    const entry = { sessionId: session.id, turn, checkpointId: saved.id, hash: saved.hash, message: saved.message, tool, createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00") };
    session.turn_checkpoints = [...existing, entry].slice(-200); await store.save(session); return entry;
  } catch { return null; }
}
