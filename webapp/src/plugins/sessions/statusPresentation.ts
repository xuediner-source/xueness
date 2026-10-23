import { t as tr } from '../../i18n';

export type SessionStatusTone = 'idle' | 'running' | 'paused' | 'error' | 'done';
export type SessionStatusPresentation = { label: string; tone: SessionStatusTone };

const STATUS: Record<string, { label: string; tone: SessionStatusTone }> = {
  created: { label: '待执行', tone: 'idle' },
  pending: { label: '等待中', tone: 'paused' },
  queued: { label: '等待中', tone: 'paused' },
  running: { label: '运行中', tone: 'running' },
  streaming: { label: '运行中', tone: 'running' },
  pausing: { label: '正在暂停', tone: 'paused' },
  paused: { label: '已暂停', tone: 'paused' },
  stopping: { label: '正在停止', tone: 'running' },
  stopped: { label: '已停止', tone: 'idle' },
  awaiting_user: { label: '等待答复', tone: 'paused' },
  awaiting_approval: { label: '等待批准', tone: 'paused' },
  needs_review: { label: '需要复核', tone: 'paused' },
  stalled: { label: '运行停滞', tone: 'paused' },
  interrupted: { label: '已中断', tone: 'paused' },
  blocked: { label: '受阻', tone: 'paused' },
  completed: { label: '已完成', tone: 'done' },
  failed: { label: '失败', tone: 'error' },
  error: { label: '失败', tone: 'error' },
  provider_error: { label: '模型连接失败', tone: 'error' },
  cancelled: { label: '已取消', tone: 'idle' },
  closed: { label: '已关闭', tone: 'idle' },
  idle: { label: '空闲', tone: 'idle' },
};

function pendingInteractionLabel(value: unknown): string | undefined {
  if (value === true) return tr('待处理');
  if (typeof value === 'string') return value.trim() || undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const interaction = value as Record<string, unknown>;
  if (interaction.kind === 'permission') return tr('等待批准');
  if (interaction.kind === 'userInput') return tr('等待答复');
  return typeof interaction.label === 'string' ? interaction.label.trim() || undefined : undefined;
}

function localized(status: { label: string; tone: SessionStatusTone }): SessionStatusPresentation {
  return { label: tr(status.label), tone: status.tone };
}

/**
 * Shared wording for queue, search and lightweight status. A needs_review
 * record means the host wants review; without completion evidence it does not
 * prove that execution or validation failed.
 */
export function sessionStatusPresentation(
  status: string | null | undefined,
  context: { stopping?: boolean; interrupted?: boolean; pendingInteraction?: unknown; queueCount?: number } = {},
): SessionStatusPresentation | undefined {
  if (context.stopping) return localized(STATUS.stopping);
  const value = typeof status === 'string' ? status.trim() : '';
  if (value === 'running' || value === 'streaming') return localized(STATUS.running);

  const interaction = pendingInteractionLabel(context.pendingInteraction);
  if (interaction) return { label: interaction, tone: 'paused' };

  if (value === 'pending' || value === 'queued') return localized(STATUS.queued);
  if (value === 'paused') return localized(STATUS.paused);
  if (value === 'needs_review') return localized(STATUS.needs_review);
  if (value === 'awaiting_approval') return localized(STATUS.awaiting_approval);
  if (value === 'awaiting_user') return localized(STATUS.awaiting_user);
  if (value === 'stalled') return localized(STATUS.stalled);
  if (value === 'interrupted' || context.interrupted) return localized(STATUS.interrupted);
  if (value === 'failed' || value === 'error' || value === 'provider_error') return localized(STATUS[value]);
  if (value === 'cancelled') return localized(STATUS.cancelled);
  if (value === 'completed') return localized(STATUS.completed);
  if (value === 'blocked') return localized(STATUS.blocked);
  if (value === 'pausing') return localized(STATUS.pausing);
  if (value === 'stopping') return localized(STATUS.stopping);
  if (value === 'stopped') return localized(STATUS.stopped);
  if (value === 'closed') return localized(STATUS.closed);
  if (value === 'created') return localized(STATUS.created);
  if (value === 'idle') return context.queueCount ? { label: tr('队列中'), tone: 'paused' } : localized(STATUS.idle);
  if (!value && (context.queueCount ?? 0) > 0) return { label: tr('队列中'), tone: 'paused' };
  return undefined;
}
