import type React from 'react';
import type { TimelineRow } from '../../xuenessWorkbench';
import type { AttachmentPreviewTransport } from './composerAttachmentPreviewModel';
import type { MessageEditAttachmentTransport } from './messageEditAttachments';
import type { ConversationCompactionMarker } from './conversationCompaction';

export type Assistant = Extract<TimelineRow, { kind: 'assistant' }>;
export type Tool = Extract<TimelineRow, { kind: 'tool' }>;
export type Completion = Extract<TimelineRow, { kind: 'completion' }>;
export type User = Extract<TimelineRow, { kind: 'user' }>;
export type ConversationTurn = { key: string; rows: TimelineRow[]; userSeq?: number };

export type ZCodeConversationSelection = {
  text: string;
  turnId: string;
  rowKey: string;
  rowKind: TimelineRow['kind'];
  rowSeq: number;
  overLimit: boolean;
};

export type ZCodeConversationProps = {
  toolActivity?: unknown;
  currentStreamId?: string;
  currentTurnId?: string;
  workActivity?: unknown;
  sessionId?: string;
  rows: TimelineRow[];
  /** 上下文压缩边界（由快照的 compactions 与归档行推导）；缺省不渲染分隔行。 */
  compactionMarker?: ConversationCompactionMarker | null;
  timelineMarkers?: unknown;
  findQuery?: string;
  onFindQueryChange?(query: string): void;
  findRequest?: { id: string; query: string; rowKey?: string; occurrence?: number };
  renderSelectionAction?(selection: ZCodeConversationSelection): React.ReactNode;
  streamingPending?: boolean;
  activityPhase?: string;
  jsonToolProtocol?: boolean;
  showReasoning?: boolean;
  collapseTools?: boolean;
  autoScroll?: boolean;
  pendingToolIds?: ReadonlySet<string>;
  /** Effective plugin IDs from the backend catalog. Renderer dependencies
   * fail closed when files/shell is disabled or blocked. */
  effectivePluginIds?: ReadonlySet<string>;
  isSessionsEffective?: () => boolean;
  onFork?(row: Assistant): void;
  onFeedback?(row: Assistant, feedback: 'like' | 'dislike' | null): Promise<void>;
  messageEditSessionId?: string;
  messageEditPreviewTransport?: AttachmentPreviewTransport;
  messageEditTransport?: MessageEditAttachmentTransport;
  onEdit?(row: User, text: string, onAccepted: () => void, attachments?: { preparedToken: string }): Promise<boolean>;
  onRetry?(row?: Tool): void | Promise<unknown>;
};
