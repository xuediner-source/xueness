import React from 'react';
import { ChevronRight, TrendingUpDown } from 'lucide-react';
import { t as tr, getLocale, useLocale } from '../../i18n';
import { conversationTurnPropsEqual } from './conversationTurnPropsEqual';
import { ConversationMarkers } from './conversationMarkers';
import { assistantTextForDisplay } from './XuenessTimeline';
import type { ConversationCompactionMarker } from './conversationCompaction';
import { conversationActivityLabel } from './conversationActivity';
import { CompactionBoundary, ContextCompactionStatus } from './ContextCompactionStatus';
import { conversationWorkSegments, conversationActiveDuration, conversationWorkLabel } from './conversationWorkSegments';
import { formatConversationWorkDuration, conversationElapsedInterval } from './conversationWorkDuration';
import { conversationFindRowKey } from './ConversationFind';
import { ReferenceRowView } from './referenceRowView';
import { isReferenceTimelineRow } from './referenceRows';
import { SubagentRowView } from './SubagentRowView';
import { LiveElapsed } from './SessionMotion';
import { useDisclosure } from './conversationDisclosure';
import { rowData, timelineRowTurnId, visibleAssistantText } from './conversationRows';
import type { Assistant, Completion, ConversationTurn, User, ZCodeConversationProps } from './conversationTypes';
import { ToolRow } from './ConversationToolRow';
import { Reasoning, AssistantText, CompletionCheck } from './ConversationAnswerRows';
import { CopyAction, UserMessage, FeedbackActions } from './ConversationUserRows';

/** 上下文压缩边界：归档历史与仍在模型上下文中的消息之间的浅色分隔行。
 * 纯展示、无动画；文案与计数由 sessions 插件的 compaction 记录推导。 */
function TurnView({ turn, latest, props, activeFindRowKey, compactionMarker }: { turn: ConversationTurn; latest: boolean; props: ZCodeConversationProps; activeFindRowKey: string | null; compactionMarker?: ConversationCompactionMarker | null }) {
  useLocale();
  const { showReasoning = true, jsonToolProtocol = false, pendingToolIds, effectivePluginIds, onFork, onFeedback, onEdit, onRetry } = props;
  const canShowReasoning = showReasoning && (!effectivePluginIds || effectivePluginIds.has('sessions'));
  const assistantRows: Assistant[] = [];
  let completion: Completion | undefined;
  let lastToolIndex = -1;
  for (const [index, row] of turn.rows.entries()) {
    if (row.kind === 'assistant') assistantRows.push(row);
    else if (row.kind === 'completion') completion = row;
    else if (row.kind === 'tool') lastToolIndex = index;
  }
  // Stopped partials stay in the work segment, not the final answer.
  let final: Assistant | undefined;
  for (let index = turn.rows.length - 1; index > lastToolIndex; index -= 1) {
    const row = turn.rows[index];
    if (row.kind === 'assistant' && !row.interrupted
      && assistantTextForDisplay(visibleAssistantText(row), row.streaming, completion?.summary, jsonToolProtocol).trim()) {
      final = row;
      break;
    }
  }
  const work = turn.rows.filter(row => {
    if (row.kind === 'tool') return true;
    if (row.kind === 'subagent' && effectivePluginIds?.has('sessions')) return true;
    if (row.kind === 'assistant' && row !== final) {
      const hasText = Boolean(assistantTextForDisplay(visibleAssistantText(row), row.streaming, completion?.summary, jsonToolProtocol).trim());
      const hasReasoning = Boolean(canShowReasoning && row.reasoning);
      return hasText || hasReasoning;
    }
    return false;
  });
  const workPending = work.some(row => row.kind === 'tool' && pendingToolIds?.has(row.toolCallId));
  const workFailed = work.some(row => row.kind === 'tool' && row.status === 'error' && !pendingToolIds?.has(row.toolCallId)
    || row.kind === 'subagent' && row.status === 'failed');
  const subagentRunning = work.some(row => row.kind === 'subagent' && row.status === 'running');
  const workDisclosure = useDisclosure(`work:${turn.key}`, workFailed || workPending || subagentRunning);
  const workFindActive = work.some(row => conversationFindRowKey(row) === activeFindRowKey);
  const workOpen = workDisclosure.open || workFindActive;
  const running = latest && props.streamingPending === true;
  const interrupted = assistantRows.some(row => row.interrupted === true);
  const firstTime = assistantRows[0]?.startedAt;
  const lastTime = assistantRows.at(-1)?.endedAt;
  const elapsedMs = conversationElapsedInterval(firstTime, lastTime);
  const duration = elapsedMs !== undefined && elapsedMs > 0 ? formatConversationWorkDuration(elapsedMs, getLocale()) : null;
  const facts = effectivePluginIds?.has('sessions') ? conversationWorkSegments(props.workActivity, turn.rows.map(timelineRowTurnId).find(Boolean)) : [];
  const activeMs = conversationActiveDuration(facts);
  const factualLabel = conversationWorkLabel(facts, getLocale(), activeMs === undefined ? null : formatConversationWorkDuration(activeMs, getLocale()));
  const workLabel = factualLabel ?? (workPending ? tr('等待批准') : interrupted ? tr('已停止') : running || subagentRunning ? tr('工作中') : workFailed ? tr('运行失败') : duration ? (getLocale() === 'en' ? `Elapsed ${duration}` : `经过 ${duration}`) : tr('已完成'));
  const answer = final ? assistantTextForDisplay(visibleAssistantText(final), final.streaming, completion?.summary, jsonToolProtocol) : '';
  const streamingRow = props.activityPhase !== 'compacting' && assistantRows.some(row => row.streaming);
  const liveLabel = props.activityPhase === 'compacting' ? <ContextCompactionStatus /> : tr(conversationActivityLabel(props.activityPhase));
  const copyText = () => assistantRows.map(row => assistantTextForDisplay(visibleAssistantText(row), row.streaming, completion?.summary, jsonToolProtocol)).filter(text => text.trim()).join('\n\n');
  const referenceRows = turn.rows.filter(isReferenceTimelineRow);
  const userReferences = referenceRows.filter(row => row.anchorRole === 'user');
  const assistantReferences = referenceRows.filter(row => row.anchorRole !== 'user');
  const workRows = work.map(row => row.kind === 'tool'
    ? <ToolRow key={`tool:${row.toolActivityId ?? row.toolCallId}`} row={row} pending={pendingToolIds?.has(row.toolCallId) ?? false} effectivePluginIds={effectivePluginIds} defaultOpen={props.collapseTools === false || row.status === 'error' && !pendingToolIds?.has(row.toolCallId)} findActive={activeFindRowKey === conversationFindRowKey(row)} onRetry={onRetry} />
    : row.kind === 'subagent' ? <SubagentRowView key={`subagent:${row.toolCallId}:${row.taskId}`} row={row}
      sessionId={props.sessionId} effectivePluginIds={effectivePluginIds} findActive={activeFindRowKey === conversationFindRowKey(row)} />
    : row.kind === 'assistant' ? <React.Fragment key={`response:${row.messageId ?? row.messageIndex ?? row.seq}`}>
      {canShowReasoning && row.reasoning && <Reasoning row={row} activityPhase={props.activityPhase} findActive={activeFindRowKey === conversationFindRowKey(row)} />}
      {Boolean(assistantTextForDisplay(visibleAssistantText(row), row.streaming, completion?.summary, jsonToolProtocol).trim()) && (
        <div className="xn-zc-work-response"><AssistantText row={row} summary={completion?.summary} protocol={jsonToolProtocol} /></div>
      )}
    </React.Fragment> : null);
  const stableTurnId = turn.rows.map(timelineRowTurnId).find(Boolean) ?? turn.key;
  return <section className="xn-zc-turn" data-turn-key={turn.key} data-zcode-turn-id={stableTurnId}>
    {compactionMarker && <CompactionBoundary marker={compactionMarker} />}
    <ConversationMarkers facts={props.timelineMarkers} rows={turn.rows} placement="before_user" enabled={effectivePluginIds?.has('sessions') === true} />
    {turn.rows.filter((row): row is User => row.kind === 'user').map(row => <div key={`user:${row.messageId ?? row.messageIndex ?? row.seq}`} {...rowData(row)}><UserMessage editSessionId={props.messageEditSessionId} previewTransport={props.messageEditPreviewTransport} attachmentTransport={props.messageEditTransport} row={row} onEdit={onEdit} enabled={effectivePluginIds?.has('sessions') === true} isSessionsEffective={props.isSessionsEffective} /></div>)}
    {userReferences.map(row => <ReferenceRowView key={`${row.kind}:${row.seq}`} row={row} sessionId={props.sessionId} effectivePluginIds={effectivePluginIds} />)}
    {(work.length > 0 || facts.length > 0) && (running || !final ? <div className="xn-zc-work"><div className="xn-zc-work-status" role="status" data-running={running && !workPending || undefined}>{workLabel}{facts.length > 1 && <span> · {facts.length} {getLocale() === 'en' ? 'segments' : '段工作'}</span>}{running && !workPending && <LiveElapsed since={firstTime} />}</div><div className="xn-zc-work-content">{workRows}</div></div>
      : <details className="xn-zc-work" open={workOpen} onToggle={workDisclosure.onToggle}><summary className="xn-zc-work-status"><span>{workLabel}{facts.length > 1 && ` · ${facts.length} ${getLocale() === 'en' ? 'segments' : '段工作'}`}</span><ChevronRight size={16} className="xn-zc-chevron" /></summary>
        {workOpen && <div className="xn-zc-work-content">{workRows}</div>}</details>)}
    <ConversationMarkers facts={props.timelineMarkers} rows={turn.rows} placement="work_tail" enabled={effectivePluginIds?.has('sessions') === true} />
    {final && <div className="xn-zc-final">
      {canShowReasoning && final.reasoning && <Reasoning row={final} activityPhase={props.activityPhase} findActive={activeFindRowKey === conversationFindRowKey(final)} />}
      <AssistantText row={final} summary={completion?.summary} protocol={jsonToolProtocol} />
      {/* While the turn runs, the action row is reserved (it is invisible until
          hover anyway); a settling turn shows its status there, so finishing
          does not add or remove a line below the answer. Distinct keys keep the
          reserved row's opacity from fading through the new buttons. */}
      {running ? <div key="reserved" className="xn-zc-actions xn-zc-actions--reserved" aria-hidden={streamingRow ? true : undefined}>
        {!streamingRow && <span className="xn-zc-live" role="status" data-testid="timeline-stream-loading">{liveLabel}</span>}
      </div>
      : <div key="actions" className="xn-zc-actions"><CopyAction text={copyText} />
        {onFeedback && final.messageRevision && final.messageIndex !== undefined && <FeedbackActions row={final} onFeedback={onFeedback} />}
        {onFork && <button type="button" className="xn-zc-action" aria-label={tr('分叉会话')} title={tr('分叉会话')} onClick={() => onFork(final)}><TrendingUpDown size={14} /></button>}
      </div>}
    </div>}
    {assistantReferences.map(row => <ReferenceRowView key={`${row.kind}:${row.seq}`} row={row} sessionId={props.sessionId} effectivePluginIds={effectivePluginIds} />)}
    {completion && <CompletionCheck row={completion} answer={answer} protocol={jsonToolProtocol} findActive={activeFindRowKey === conversationFindRowKey(completion)} />}
    {turn.rows.filter(row => row.kind === 'pending_question').map(row => row.kind === 'pending_question' ? <p key={`question:${row.seq}`} {...rowData(row)} role="status" className="xn-zc-question">{tr('等待回答')} · {row.question}</p> : null)}
    {running && !streamingRow && !final && <p className="xn-zc-live" role="status" data-testid="timeline-stream-loading">{liveLabel}{work.length === 0 && <LiveElapsed since={firstTime} />}</p>}
  </section>;
}

export const Turn = React.memo(TurnView, conversationTurnPropsEqual);
