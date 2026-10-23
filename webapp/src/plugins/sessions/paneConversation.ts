import type { ConversationSnapshot, TimelineRow } from '../../xuenessWorkbench';
import {
  hydrateTimelineJournalRows,
  hydrateTimelineTools,
  toTimelineRows,
  withInitialUserMessage,
} from '../../xuenessWorkbench';
import { markArchivedToolRows } from './conversationCompaction';
import { projectReferenceRows } from './referenceRows';
import { projectSubagentRows } from './subagentRows';

/** Project one conversation snapshot into timeline rows. Each pane calls this
 * on its own transport snapshot; it does not read or write another pane. */
export function projectSnapshotTimelineRows(snapshot: ConversationSnapshot, filesEffective: boolean): TimelineRow[] {
  const journal = snapshot.journal;
  const history = Array.isArray(journal.reasoning_history)
    ? journal.reasoning_history as { message_index: number; text: string }[]
    : snapshot.session.reasoning_history ?? [];
  const timing = Array.isArray(journal.reasoning_timing)
    ? journal.reasoning_timing as { message_index: number; started_at: string; ended_at: string }[]
    : snapshot.session.reasoning_timing ?? [];
  const rowsWithTask = withInitialUserMessage(
    hydrateTimelineTools(toTimelineRows(snapshot.timeline.events), journal),
    journal,
    snapshot.session.task,
  );
  const rows = hydrateTimelineJournalRows(rowsWithTask, journal, history, timing);
  return projectSubagentRows(projectReferenceRows(markArchivedToolRows(rows, journal), journal, { filesEffective }), journal);
}
