import { requestMutation } from '../../xuenessWorkbench';
import { t as tr } from '../../i18n';

/** Permanent deletion is separate from the live session's soft archive API. */
export async function deleteArchivedSession(id: string, expectedRevision: string, signal?: AbortSignal): Promise<void> {
  if (!/^[0-9a-f]{32}$/u.test(id) || !/^[0-9a-f]{64}$/u.test(expectedRevision)) {
    throw new Error(tr('归档记录缺少有效版本，请刷新列表后重试。'));
  }
  try {
    const result = await requestMutation<{ id: string; deleted: boolean; permanent: boolean }>('DELETE',
      `/api/sessions/archived/${encodeURIComponent(id)}`, { confirmed: true, expectedRevision }, signal);
    if (result.id !== id || result.deleted !== true || result.permanent !== true) {
      throw new Error(tr('删除结果暂时无法确认，请刷新列表查看。'));
    }
  } catch (error) {
    if (error instanceof Error && 'status' in error) {
      if (error.status === 404) throw new Error(tr('该归档会话已删除或已恢复，请刷新列表。'));
      if (error.status === 409) {
        if (error.message.includes('in use') || error.message.includes('run already')) {
          throw new Error(tr('会话正在被其他窗口使用，请稍后重试。'));
        }
        throw new Error(tr('归档记录已变化或会话已恢复，请刷新列表后重试。'));
      }
    }
    throw error;
  }
}
