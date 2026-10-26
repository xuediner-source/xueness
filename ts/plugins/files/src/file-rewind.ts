/** File-only rewind uses captured before bytes and verifies the last observed after hash. */
import { chmodSync, unlinkSync } from 'node:fs';
import { isDict, pyDeepCopy } from '@xueness/contracts';
import { resolveWorkspacePath, writeFileAtomic } from '@xueness/engine-tools';
import type { Session, SessionStore } from '@xueness/sessions';
import { fileHistoryRows, fileImage, loadFileHistoryRecord, type FileImage, type FileChange } from './file-history.ts';

type Row = Record<string, unknown>;
export class FileRewindError extends Error { readonly status: number; constructor(message: string, status = 409) { super(message); this.status = status; } }
export interface FileRewindPlan { messageId: string; operationIds: string[]; changes: FileChange[] }
export interface FileRewindOutcome { path: string; action: string; restoredHash: string | null }
export function selectFileRewind(stateDir: string, session: Session, messageId: string): FileRewindPlan {
  const messages = Array.isArray(session.messages) ? session.messages.filter(isDict) : [];
  const target = messages.findIndex(m => m._message_id === messageId);
  if (target < 0 || messages[target]!.role !== 'user' || messages[target]!._input_kind === 'guide' || messages[target]!._input_kind === 'background_notice') throw new FileRewindError('File rewind requires a retained human prompt', 400);
  const selected = fileHistoryRows(session).filter(row => row.status !== 'rewound' && messages.findIndex(m => m._message_id === row.messageId) >= target);
  const changes = new Map<string, FileChange>(), operationIds: string[] = [];
  for (const row of selected) {
    const record = loadFileHistoryRecord(stateDir, String(session.id), String(row.id));
    if (record.status === 'captured') throw new FileRewindError('A file operation has no committed after state');
    operationIds.push(record.id);
    for (const change of record.changes) {
      if (!change.after) throw new FileRewindError('File history after state is unavailable');
      const previous = changes.get(change.path);
      if (previous) previous.after = change.after;
      else changes.set(change.path, { ...change });
    }
  }
  return { messageId, operationIds, changes: [...changes.values()].filter(change => change.before.hash !== change.after!.hash || change.before.exists !== change.after!.exists) };
}
export async function previewFileRewind(stateDir: string, session: Session, messageId: string): Promise<Row> {
  const plan = selectFileRewind(stateDir, session, messageId), files: Row[] = [];
  for (const change of plan.changes) {
    const resolved = await resolveWorkspacePath(change.path, String(session.root), [String(session.root)]);
    const current = fileImage(resolved.absolute, false);
    files.push({ path: change.path, action: change.before.exists ? 'restore' : 'delete', conflict: current.exists !== change.after!.exists || current.hash !== change.after!.hash });
  }
  return { messageId, operationIds: plan.operationIds, files, canApply: files.every(file => !file.conflict) };
}
async function restore(path: string, image: FileImage): Promise<void> {
  if (!image.exists) { if (fileImage(path, false).exists) unlinkSync(path); return; }
  if (image.bytes === undefined) throw new FileRewindError('Snapshot bytes are unavailable');
  await writeFileAtomic(path, Buffer.from(image.bytes, 'base64'), { mode: image.mode });
  if (image.mode !== undefined) chmodSync(path, image.mode);
}
/** Compare-and-swap rollback: the write happens only while the file still matches the recorded after image. */
export async function restoreFileChecked(path: string, expected: FileImage, image: FileImage): Promise<void> {
  const current = fileImage(path, false);
  if (current.exists !== expected.exists || current.hash !== expected.hash) throw new FileRewindError('Workspace changed after the recorded operation: ' + path);
  await restore(path, image);
}
export async function applyFileRewind(store: SessionStore, stateDir: string, session: Session, messageId: string): Promise<Row> {
  const plan = selectFileRewind(stateDir, session, messageId), originals: { path: string; image: FileImage }[] = [];
  for (const change of plan.changes) {
    const resolved = await resolveWorkspacePath(change.path, String(session.root), [String(session.root)]), image = fileImage(resolved.absolute);
    if (image.exists !== change.after!.exists || image.hash !== change.after!.hash) throw new FileRewindError('Workspace changed after the recorded operation: ' + change.path);
    originals.push({ path: resolved.absolute, image });
  }
  const previous = pyDeepCopy(session.file_history);
  const previousTrace = pyDeepCopy(session.file_rewind_history);
  const hadRewindLast = Object.hasOwn(session, 'file_rewind_last');
  const previousRewindLast = hadRewindLast ? pyDeepCopy(session.file_rewind_last) : undefined;
  const at = new Date().toISOString();
  const outcomes: FileRewindOutcome[] = [];
  try {
    for (let i = 0; i < plan.changes.length; i++) {
      const change = plan.changes[i]!;
      await restoreFileChecked(originals[i]!.path, change.after!, change.before);
      const restored = fileImage(originals[i]!.path, false);
      if (restored.exists !== change.before.exists || restored.hash !== change.before.hash) throw new FileRewindError('Rewind verification failed: ' + change.path);
      outcomes.push({ path: change.path, action: change.before.exists ? 'restore' : 'delete', restoredHash: restored.hash });
    }
    for (const row of fileHistoryRows(session)) if (plan.operationIds.includes(String(row.id))) row.status = 'rewound';
    session.file_rewind_last = { messageId, operationIds: plan.operationIds, at };
    const trace = Array.isArray(session.file_rewind_history) ? session.file_rewind_history.filter(isDict) : [];
    trace.push({ messageId, operationIds: plan.operationIds, at, results: outcomes });
    session.file_rewind_history = trace.slice(-64);
    await store.save(session);
  } catch (error) {
    for (const original of originals.reverse()) await restore(original.path, original.image);
    session.file_history = previous;
    if (hadRewindLast) session.file_rewind_last = previousRewindLast; else delete session.file_rewind_last;
    if (previousTrace === undefined) delete session.file_rewind_history; else session.file_rewind_history = previousTrace;
    throw error;
  }
  return { ok: true, messageId, restored: plan.changes.map(change => change.path), operationIds: plan.operationIds, results: outcomes };
}
