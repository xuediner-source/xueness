import { deleteSession, type Result } from '../../xuenessWorkbench';

/** Archive through the existing soft-delete API, preserving successful progress on failure. */
export async function archiveProjectSessions(ids: readonly string[], isEnabled: () => boolean,
  archive: (id: string) => Promise<Result<void>> = deleteSession): Promise<{ archivedIds: string[]; error?: string }> {
  const archivedIds: string[] = [];
  for (const id of new Set(ids)) {
    if (!isEnabled()) break;
    const result = await archive(id);
    if (!result.ok) return { archivedIds, error: result.error };
    archivedIds.push(id);
  }
  return { archivedIds };
}
