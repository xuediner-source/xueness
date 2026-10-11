import { requestMutation } from "../../xuenessWorkbench";
import { t as tr } from '../../i18n';

export async function editQueuedMessage(sessionId: string, queueId: string, text: string, expectedText: string): Promise<void> {
  const result = await requestMutation<{ id: string; item: { id: string; text: string } }>("PATCH",
    `/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queueId)}`, { text, expectedText });
  if (result.id !== queueId || result.item?.id !== queueId || result.item.text !== text.trim()) throw new Error("Invalid queue edit response");
}

export async function reorderQueuedMessages(sessionId: string, ids: string[], expectedIds: string[]): Promise<void> {
  try {
    const result = await requestMutation<{ ids: string[] }>('PATCH',
      `/api/sessions/${encodeURIComponent(sessionId)}/queue`, { ids, expectedIds });
    if (!Array.isArray(result.ids) || result.ids.length !== ids.length || result.ids.some((id, index) => id !== ids[index])) {
      throw new Error('Invalid queue reorder response');
    }
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 409) {
      throw new Error(tr('队列已发生变化，请根据最新顺序重新调整。'));
    }
    throw error;
  }
}
