/** Durable sessions facts. No timers, wall-clock subtraction, or transcript guessing. */
export type ConversationWorkSegment = {
  id: string;
  turn_id: string;
  state: 'running' | 'completed' | 'stopped' | 'failed' | 'waiting_approval' | 'waiting_user' | 'paused' | 'unknown' | 'continued';
  active_ms: number | null;
  anchor_message_id?: string;
  reason?: string;
  prefix_missing?: boolean;
};

export function conversationWorkSegments(facts: unknown, turnId: string | undefined): ConversationWorkSegment[] {
  if (!turnId || !Array.isArray(facts)) return [];
  const states = new Set(['running', 'completed', 'stopped', 'failed', 'waiting_approval', 'waiting_user', 'paused', 'unknown', 'continued']);
  const seen = new Set<string>();
  return facts.slice(-256).filter((row): row is ConversationWorkSegment => {
    if (!row || typeof row !== 'object' || row.turn_id !== turnId || typeof row.id !== 'string'
      || !row.id || row.id.length > 128 || !states.has(row.state) || seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  }).map(row => ({ ...row, active_ms: row.state !== 'running' && typeof row.active_ms === 'number'
    && Number.isFinite(row.active_ms) && row.active_ms >= 0 ? row.active_ms : null }));
}

export function conversationActiveDuration(segments: ConversationWorkSegment[]): number | undefined {
  if (!segments.length || segments.some(row => row.active_ms === null || row.state === 'unknown' || row.prefix_missing === true)) return undefined;
  const value = segments.reduce((total, row) => total + (row.active_ms ?? 0), 0);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function conversationWorkLabel(segments: ConversationWorkSegment[], locale: 'zh' | 'en', duration: string | null): string | null {
  const last = segments.at(-1);
  if (!last) return null;
  const en = locale === 'en';
  const labels = {
    running: en ? 'Working' : '工作中', completed: en ? 'Completed' : '已完成',
    stopped: en ? 'Stopped' : '已停止', failed: en ? 'Failed' : '运行失败',
    waiting_approval: en ? 'Waiting for approval' : '等待批准', waiting_user: en ? 'Waiting for your answer' : '等待回复',
    paused: en ? 'Paused' : '已暂停', unknown: en ? 'Work status unknown' : '工作状态未知',
    continued: en ? 'Continued' : '已继续',
  };
  const suffix = duration ? (en ? ` · Active ${duration}` : ` · 活跃 ${duration}`) : '';
  return labels[last.state] + suffix;
}
