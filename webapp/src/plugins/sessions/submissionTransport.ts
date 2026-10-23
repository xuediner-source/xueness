import { t as tr } from '../../i18n';

export class DeliveryUnconfirmedError extends Error {
  constructor() {
    super(tr('消息接收状态暂时无法确认，请先查看会话与队列再重试。'));
    this.name = 'DeliveryUnconfirmedError';
  }
}

export function couldHaveBeenAccepted(error: unknown): boolean {
  if (error instanceof Error && 'requestNotSent' in error && error.requestNotSent === true) return false;
  const status = error instanceof Error && 'status' in error ? Number(error.status) : undefined;
  return error instanceof TypeError || error instanceof DeliveryUnconfirmedError
    || (error instanceof Error && (error.name === 'TimeoutError' || error.message === 'invalid JSON response'
      || ('responseUnreadable' in error && error.responseUnreadable === true)))
    || (status !== undefined && (status >= 500 || status === 408));
}

type QueueRequest = (path: string, body: unknown, signal: AbortSignal) => Promise<unknown>;

/** Replay once with the original identity; only the queue API deduplicates it. */
export async function submitQueuedTurn(send: QueueRequest, sessionId: string, text: string, preparedToken?: string): Promise<unknown> {
  const body = { text, request_id: crypto.randomUUID().replaceAll('-', ''), ...(preparedToken ? { prepared_token: preparedToken } : {}) };
  for (let attempt = 0; ; attempt++) {
    try {
      return await send(`/api/sessions/${encodeURIComponent(sessionId)}/queue`, body, AbortSignal.timeout(20000));
    } catch (error) {
      // A refusal of the replay says nothing about the original lost response.
      if (attempt > 0) throw new DeliveryUnconfirmedError();
      if (!couldHaveBeenAccepted(error)) throw error;
    }
  }
}
