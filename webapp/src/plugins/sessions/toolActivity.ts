import type { TimelineRow } from '../../xuenessWorkbench';
import { resolveToolRenderer } from './toolRenderers';

export const TOOL_INPUT_PREVIEW_LIMIT = 4096;
const SAFE_INPUT_TOOLS = new Set(['read', 'read_file', 'read_text', 'list', 'glob', 'grep', 'exec', 'exec_start', 'exec_poll']);
type Tool = Extract<TimelineRow, { kind: 'tool' }>;
export type ToolActivityOptions = {
  running?: boolean;
  currentTurnId?: string;
  currentStreamId?: string;
  effectivePluginIds?: ReadonlySet<string>;
  /** Call identities only, never raw input. Scoped to the mounted session. */
  identities?: Map<string, string>;
};

/** Ephemeral presentation only. Partial input is text, never executable arguments. */
export function toolActivityRows(rows: TimelineRow[], value: unknown, options: ToolActivityOptions): TimelineRow[] {
  const withIdentities = () => options.identities?.size ? rows.map(row => row.kind === 'tool' && options.identities?.has(row.toolCallId)
    ? { ...row, toolActivityId: options.identities.get(row.toolCallId) } : row) : rows;
  if (!options.running || !options.effectivePluginIds?.has('sessions') || !Array.isArray(value)) return withIdentities();
  const latestTurn = [...rows].reverse().find(row => 'turnId' in row && row.turnId);
  const currentTurnId = options.currentTurnId ?? (latestTurn && 'turnId' in latestTurn ? latestTurn.turnId : undefined);
  if (!currentTurnId) return rows;
  const finalized = new Set(rows.filter((row): row is Tool => row.kind === 'tool').map(row => row.toolCallId));
  const previews = new Map<string, Tool>();
  let seq = Math.max(-1, ...rows.map(row => row.seq)) + 1;
  for (const raw of value.slice(-32)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (item.phase !== 'input_streaming' || typeof item.id !== 'string' || item.id.length > 200 || typeof item.stream_id !== 'string'
      || !item.stream_id || !item.id.startsWith(`${item.stream_id}:`) || !/^\d+$/.test(item.id.slice(item.stream_id.length + 1))
      || item.turn_id !== currentTurnId || options.currentStreamId && item.stream_id !== options.currentStreamId
      || typeof item.name !== 'string' || !item.name || item.name.length > 160
      || typeof item.input_chars !== 'number' || !Number.isSafeInteger(item.input_chars) || item.input_chars < 0) continue;
    const callId = typeof item.call_id === 'string' && item.call_id ? item.call_id : undefined;
    if (callId) {
      options.identities?.set(callId, item.id);
      if (options.identities && options.identities.size > 256) options.identities.delete(options.identities.keys().next().value!);
    }
    if (callId && finalized.has(callId) || finalized.has(item.id)) continue;
    const renderer = resolveToolRenderer(item.name, options.effectivePluginIds);
    const allowed = SAFE_INPUT_TOOLS.has(item.name) && renderer.id !== 'fallback';
    const rawInput = allowed && typeof item.partial_input === 'string' ? item.partial_input : '';
    const previous = previews.get(item.id);
    previews.set(item.id, { kind: 'tool', seq: previous?.seq ?? seq++, turnId: currentTurnId,
      toolCallId: item.id, toolActivityId: item.id, name: item.name, subject: '', status: 'running', error: '', errorCode: '',
      inputActivity: { phase: 'input_streaming', inputChars: item.input_chars,
        partialInput: rawInput.slice(0, TOOL_INPUT_PREVIEW_LIMIT), truncated: allowed && (item.truncated === true || rawInput.length > TOOL_INPUT_PREVIEW_LIMIT) } });
  }
  const settled = withIdentities();
  return previews.size ? [...settled, ...previews.values()] : settled;
}
