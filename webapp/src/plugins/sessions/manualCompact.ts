import { get } from '../../xuenessApi';
import type { ComposerInput } from '../../xuenessComposer';
import { t as tr, tf } from '../../i18n';

/**
 * `/compact [instructions]` (ZCode v3.15.1 slash command "Compact the current conversation").
 *
 * The composer sends `/compact …` to the sessions compact route instead of starting a
 * run; the backend (ts/apps/server/src/agent-compact.ts) summarizes the conversation with
 * the session model and keeps no recent round. Texts follow ZCode's
 * `i18n/src/locales/zh-CN.ts` (`status.compacted`, `status.compactFailed`,
 * `transcript.compact.skipped`).
 */

const COMMAND = /^\/compact(?:\s+([\s\S]*))?$/;

export type ManualCompactCommand = { instructions: string | null };

function hasComposerContext(input: ComposerInput | undefined): boolean {
  if (!input) return false;
  return input.attachments.length > 0 || (input.attachmentRefs?.length ?? 0) > 0 || input.files.length > 0
    || input.sessions.length > 0 || input.skills.length > 0 || input.plugins.length > 0 || input.goal;
}

/** The backend refuses control characters (line breaks included), so a multi-line note is joined with spaces. */
export function normalizeCompactInstructions(raw: string | undefined): string | null {
  const text = (raw ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return text ? text : null;
}

/** `/compact` with optional instructions and nothing attached; anything else is an ordinary message. */
export function parseCompactCommand(text: string, input?: ComposerInput): ManualCompactCommand | null {
  const match = COMMAND.exec(text.trim());
  if (!match || hasComposerContext(input)) return null;
  return { instructions: normalizeCompactInstructions(match[1]) };
}

export type ManualCompactOutcome =
  | { kind: 'compacted'; beforeTokens: number | null; afterTokens: number | null; summarized: number | null }
  | { kind: 'skipped' }
  | { kind: 'failed'; message: string; running: boolean };

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const count = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
const tokens = (value: unknown): number | null => count(record(value)?.estimatedTokens);

/** Reads every documented reply shape of `POST /api/sessions/:id/compact`. */
export function readCompactReply(status: number, payload: unknown): ManualCompactOutcome {
  const body = record(payload);
  const refusal = record(body?.refusal);
  if (status < 200 || status >= 300 || body?.ok === false) {
    const reason = typeof body?.reason === 'string' ? body.reason : typeof refusal?.reason === 'string' ? refusal.reason : '';
    const detail = typeof refusal?.detail === 'string' && refusal.detail ? refusal.detail
      : typeof body?.error === 'string' && body.error ? body.error : `HTTP ${status}`;
    return { kind: 'failed', message: detail, running: reason === 'run_in_progress' || reason === 'session_busy' };
  }
  if (!body) return { kind: 'failed', message: 'invalid JSON response', running: false };
  if (body.compacted === false) return { kind: 'skipped' };
  return { kind: 'compacted', beforeTokens: tokens(body.before), afterTokens: tokens(body.after), summarized: count(body.summarizedMessageCount) };
}

/** Compaction calls the model and can take a while; the caller keeps the composer busy meanwhile. */
export async function requestManualCompact(sessionId: string, instructions: string | null, fetcher: typeof fetch = fetch): Promise<ManualCompactOutcome> {
  const token = await get<{ csrfToken: string }>('/api/csrf');
  const response = await fetcher(`/api/sessions/${encodeURIComponent(sessionId)}/compact`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token.csrfToken },
    body: JSON.stringify(instructions ? { instructions } : {}),
  });
  let payload: unknown = null;
  try { payload = await response.json(); } catch { /* reported as HTTP status */ }
  return readCompactReply(response.status, payload);
}

/** One line for the session notice area. */
export function manualCompactNotice(outcome: ManualCompactOutcome): string {
  if (outcome.kind === 'skipped') return tr('上下文已是最新，无需压缩');
  if (outcome.kind === 'failed') return outcome.running ? tr('请先停止运行，再压缩上下文。') : tf('上下文压缩失败：{0}', [outcome.message]);
  if (outcome.beforeTokens !== null && outcome.afterTokens !== null && outcome.beforeTokens > 0) {
    return tf('对话已压缩：约 {0} → {1} token', [outcome.beforeTokens.toLocaleString('en-US'), outcome.afterTokens.toLocaleString('en-US')]);
  }
  return tr('对话已压缩。');
}
