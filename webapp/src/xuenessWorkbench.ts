/**
 * Xueness workbench data layer.
 *
 * Every call goes to the real API through the same-origin bridge. Nothing
 * here invents state: a failure is reported as `{ok:false, error}` rather than
 * thrown, so the workbench can render an honest error instead of a blank pane.
 *
 * Contract: docs/xueness-workbench-contract.md (frozen). The exported types and
 * function signatures are the interface the UI layer builds against — changing
 * them is a contract change, not a refactor.
 *
 * This module is the stable entry point. The implementation lives in the
 * sessions plugin, one module per concern, so the parts only lazy views use
 * (sharing) load with those views instead of with the workbench.
 */
export type { PendingApproval } from './plugins/sessions/approvalTypes';
export type * from './plugins/sessions/workbenchTypes';
export type { FileChange, FileChangeSet } from './plugins/sessions/fileChanges';
export type {
  ConversationShare, ConversationSharePreview, ConversationShareRow, CreatedConversationShare,
} from './plugins/sessions/conversationShareApi';

export { parseConversationSnapshot } from './plugins/sessions/sessionPayloadParsers';
export {
  mergeTimelineRowsByIdentity, stabilizeSession, stabilizeSessionList, stabilizeTimelineRows, withAssistantStream,
} from './plugins/sessions/timelineRowSharing';
export { requestMutation } from './plugins/sessions/sessionHttp';
export { createSessionCommandClient } from './plugins/sessions/startupCommandHandle';
export {
  listArchivedSessions, listSessions, listSessionsIndex, loadConversationSnapshot, loadFilePreview, loadFiles,
  loadJournal, loadOlderConversationPage, loadSession,
} from './plugins/sessions/sessionReadApi';
export { forkSession, loadForkBoundaries } from './plugins/sessions/sessionForkApi';
export {
  createConversationShare, importConversationShare, loadConversationShare, loadConversationSharePreview,
  revokeConversationShare,
} from './plugins/sessions/conversationShareApi';
export {
  answerQuestion, approvePending, cancelQueuedTurn, createSession, deleteSession, pinSession, queueTurn, renameSession,
  restoreSession, runSession, sendTurn, stopSession, updateConversationMessage,
} from './plugins/sessions/sessionWriteApi';
export {
  hydrateTimelineJournalRows, hydrateTimelineTools, toTimelineRows, withInitialUserMessage,
} from './plugins/sessions/timelineProjection';
export { deriveFileChanges, formatCommandArgv } from './plugins/sessions/fileChanges';
