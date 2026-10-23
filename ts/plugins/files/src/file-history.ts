/** Before/after bytes for authorized file-tool changes; no command-side inference. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isDict, pyJsonLoads, uuid4Hex } from '@xueness/contracts';
import { parseStructuredPatch, PathOutsideWorkspaceError, resolveWorkspacePath } from '@xueness/engine-tools';
import { atomicWriteJson, type Session } from '@xueness/sessions';
import type { AgentContext, AgentExtension, Row } from '@xueness/agent';
type ToolCall = Parameters<NonNullable<AgentExtension['toolExecutionStarted']>>[1];

export interface FileImage { exists: boolean; hash: string | null; bytes?: string; mode?: number }
export interface FileChange { path: string; before: FileImage; after?: FileImage }
export interface FileHistoryRecord { id: string; callId: string; messageId: string; at: string; status: string; changes: FileChange[] }
export const fileHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export function fileImage(path: string, includeBytes = true): FileImage {
  if (!existsSync(path)) return { exists: false, hash: null };
  const info = statSync(path);
  if (!info.isFile()) throw new Error('File rewind only supports regular files');
  const bytes = readFileSync(path);
  return { exists: true, hash: fileHash(bytes), mode: info.mode & 0o7777, ...(includeBytes ? { bytes: bytes.toString('base64') } : {}) };
}
function recordPath(stateDir: string, sessionId: string, id: string): string {
  if (!/^[0-9a-f]{32}$/.test(sessionId) || !/^[0-9a-f]{32}$/.test(id)) throw new Error('Invalid file history identity');
  return join(stateDir, 'file-history', sessionId, id + '.json');
}
export function loadFileHistoryRecord(stateDir: string, sid: string, id: string): FileHistoryRecord {
  return pyJsonLoads(readFileSync(recordPath(stateDir, sid, id), 'utf8')) as unknown as FileHistoryRecord;
}
const history = (session: Session): Row[] => Array.isArray(session.file_history) ? session.file_history.filter(isDict) : [];
export function fileHistoryRows(session: Session): Row[] { return history(session); }
function pathsFor(call: ToolCall): string[] {
  if (!isDict(call.input)) return [];
  if (['write', 'edit'].includes(call.name)) return typeof call.input.path === 'string' ? [call.input.path] : [];
  if (call.name !== 'apply_patch') return [];
  const patch = call.input.patch_text;
  if (typeof patch !== 'string') return [];
  return parseStructuredPatch(patch).flatMap(part => part.type === 'update' && part.movePath ? [part.path, part.movePath] : [part.path]);
}
export function filesHistoryExtension(): AgentExtension {
  const pending = new WeakMap<AgentContext, Map<string, FileHistoryRecord>>();
  return { id: 'files', capabilities: ['files.rewind_snapshots'],
    async toolExecutionStarted(context, call) {
      const paths = [...new Set(pathsFor(call))];
      if (!paths.length) return;
      const changes: FileChange[] = [];
      for (const path of paths) {
        let resolved: Awaited<ReturnType<typeof resolveWorkspacePath>>;
        try { resolved = await resolveWorkspacePath(path, context.root, [context.root]); }
        catch (error) { if (error instanceof PathOutsideWorkspaceError) continue; throw error; }
        changes.push({ path: resolved.display, before: fileImage(resolved.absolute) });
      }
      if (!changes.length) return;
      const messages = (context.session.messages as Row[]).filter(isDict);
      const assistant = messages.findLast(m => Array.isArray(m.tool_calls) && m.tool_calls.some(c => isDict(c) && c.id === call.id));
      const record: FileHistoryRecord = { id: uuid4Hex(), callId: call.id, messageId: String(assistant?._message_id ?? ''), at: new Date().toISOString(), status: 'captured', changes };
      atomicWriteJson(recordPath(context.stateDir, String(context.session.id), record.id), record as unknown as Row);
      const rows = history(context.session);
      rows.push({ id: record.id, callId: call.id, messageId: record.messageId, at: record.at, status: record.status, paths: changes.map(c => c.path) });
      context.session.file_history = rows;
      await context.save();
      let calls = pending.get(context); if (!calls) pending.set(context, calls = new Map()); calls.set(call.id, record);
    },
    async toolResultRecorded(context, call, result) {
      const record = pending.get(context)?.get(call.id); if (!record) return;
      for (const change of record.changes) {
        const resolved = await resolveWorkspacePath(change.path, context.root, [context.root]);
        change.after = fileImage(resolved.absolute, false);
      }
      record.status = result.ok === true ? 'completed' : 'failed';
      atomicWriteJson(recordPath(context.stateDir, String(context.session.id), record.id), record as unknown as Row);
      const row = history(context.session).find(item => item.id === record.id); if (row) row.status = record.status;
      await context.save(); pending.get(context)?.delete(call.id);
    },
    close(context) { pending.delete(context); },
  };
}
