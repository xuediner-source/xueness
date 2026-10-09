/** Labels describe the host's current request phase; missing metadata is unknown. */
export function conversationActivityLabel(phase?: string): string {
  switch (phase) {
    case 'waiting_model': return '等待模型响应…';
    case 'thinking': return '思考中…';
    case 'generating': return '正在生成回复…';
    case 'tools': return '正在执行工具…';
    case 'repairing': return '正在修复工具调用格式…';
    default: return '正在处理请求…';
  }
}

export function reasoningIsActive(streaming: boolean | undefined, phase: string | undefined, text: string): boolean {
  return streaming === true && (phase ? phase === 'thinking' : !text.trim());
}
