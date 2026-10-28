import type { ConversationTurn, ZCodeConversationProps } from './ZCodeConversation';
import type { ConversationCompactionMarker } from './conversationCompaction';

const turnPropKeys = [
  'showReasoning', 'jsonToolProtocol',
  'onFork', 'onFeedback', 'onEdit', 'onRetry', 'streamingPending', 'workActivity',
  'timelineMarkers', 'activityPhase', 'sessionId', 'collapseTools',
  'messageEditSessionId', 'messageEditPreviewTransport', 'messageEditTransport', 'isSessionsEffective',
] as const satisfies readonly (keyof ZCodeConversationProps)[];

function sameStringSet(a?: ReadonlySet<string>, b?: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}


type TurnProps = { turn: ConversationTurn; latest: boolean; props: ZCodeConversationProps; activeFindRowKey: string | null; compactionMarker?: ConversationCompactionMarker | null };
export function conversationTurnPropsEqual(previous: TurnProps, next: TurnProps): boolean {
  return previous.latest === next.latest && previous.activeFindRowKey === next.activeFindRowKey
  && previous.compactionMarker === next.compactionMarker
  && sameStringSet(previous.props.pendingToolIds, next.props.pendingToolIds)
  && sameStringSet(previous.props.effectivePluginIds, next.props.effectivePluginIds)
  && previous.turn.key === next.turn.key && previous.turn.rows.length === next.turn.rows.length
  && previous.turn.rows.every((row, index) => row === next.turn.rows[index])
  && turnPropKeys.every(key => Object.is(previous.props[key], next.props[key]));
}
