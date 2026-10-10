import { requestMutation } from "../../xuenessWorkbench";

export async function editQueuedMessage(sessionId: string, queueId: string, text: string, expectedText: string): Promise<void> {
  const result = await requestMutation<{ id: string; item: { id: string; text: string } }>("PATCH",
    `/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queueId)}`, { text, expectedText });
  if (result.id !== queueId || result.item?.id !== queueId || result.item.text !== text.trim()) throw new Error("Invalid queue edit response");
}
