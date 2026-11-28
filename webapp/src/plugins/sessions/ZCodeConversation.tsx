/**
 * Adapted from Z.AI ZCode v3.14.3, commit 29628c9 (Apache-2.0):
 * ConversationTurnGroup, ConversationRowView, ToolSummaryRow and Reasoning.
 * Modified for Xueness: native disclosure controls, journal row adapter,
 * plugin-scoped callbacks and its existing safe Markdown renderer.
 * See NOTICE.md and docs/zcode-conversation-parity.md for provenance.
 */
import React from 'react';
import { t as tr } from '../../i18n';
import type { TimelineRow } from '../../xuenessWorkbench';
import { conversationActivityLabel } from './conversationActivity';
import { ContextCompactionStatus } from './ContextCompactionStatus';
import { useTimelineVirtualWindow } from './TimelineVirtualWindow';
import { XuenessConversationHistoryRail } from './XuenessConversationHistoryRail';
import { isModKeyPressed } from '../../xuenessShortcutDisplay';
import './zcode-conversation.css';
import './sessions.css';
import {
  applyConversationFindHighlights,
  buildConversationFindMatches,
  ConversationFindBar,
  conversationFindRowKey,
} from './ConversationFind';
import { toolActivityRows } from './toolActivity';
import { zcodeConversationDisclosures, DisclosureContext, SessionIdContext } from './conversationDisclosure';
import { buildConversationTurns } from './conversationRows';
import type { ZCodeConversationProps, ZCodeConversationSelection } from './conversationTypes';
import { Turn } from './ConversationTurnView';
import { OpeningRow } from './ConversationRoleplay';

export { evaluateUserMessageEditKey } from './ConversationUserRows';
export { zcodeConversationDisclosures } from './conversationDisclosure';
export { buildConversationTurns } from './conversationRows';
export type { ConversationTurn, ZCodeConversationProps, ZCodeConversationSelection } from './conversationTypes';

/** Standard and lightweight runtimes use exactly the same conversation view. */
export function ZCodeConversation(props: ZCodeConversationProps) {
  const [disclosures] = React.useState(() => zcodeConversationDisclosures);
  const identityScope = `${props.sessionId ?? ''}:${props.currentTurnId ?? ''}`;
  const identities = React.useRef({ scope: identityScope, calls: new Map<string, string>() });
  if (identities.current.scope !== identityScope) identities.current = { scope: identityScope, calls: new Map() };
  const projectedRows = toolActivityRows(props.rows, props.toolActivity, { running: props.streamingPending,
    currentTurnId: props.currentTurnId, currentStreamId: props.currentStreamId,
    effectivePluginIds: props.effectivePluginIds, identities: identities.current.calls });
  const turns = React.useMemo(() => buildConversationTurns(projectedRows), [projectedRows]);
  // 压缩边界挂在「第一条仍在模型上下文内的行」所属轮次的顶部；归档轮次在前。
  const markerTurnIndex = React.useMemo(() => props.compactionMarker
    ? turns.findIndex(turn => turn.rows.some(row => row.seq >= props.compactionMarker!.boundarySeq))
    : -1, [turns, props.compactionMarker]);
  const { snapshot, streamRef, reveal } = useTimelineVirtualWindow({ count: turns.length, enabled: true,
    initialTail: props.autoScroll !== false, followTail: props.autoScroll !== false, scopeKey: props.sessionId });
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [internalFindQuery, setInternalFindQuery] = React.useState("");
  const findQuery = props.findQuery ?? internalFindQuery;
  const [findOpen, setFindOpen] = React.useState(false);
  const [activeFindIdentity, setActiveFindIdentity] = React.useState<string | null>(null);
  const findMatches = React.useMemo(() => buildConversationFindMatches(props.rows, findQuery), [props.rows, findQuery]);
  const foundActiveIndex = findMatches.findIndex(match => match.identity === activeFindIdentity);
  const activeFindIndex = foundActiveIndex >= 0 ? foundActiveIndex : findMatches.length ? 0 : -1;
  const activeFindMatch = activeFindIndex >= 0 ? findMatches[activeFindIndex] : null;
  const previousFindQuery = React.useRef(findQuery);
  const findHighlightsApplied = React.useRef(false);
  const handledFindRequest = React.useRef<string | null>(null);
  const requestedFindTarget = React.useRef<{ query: string; rowKey: string; occurrence: number } | null>(null);
  React.useEffect(() => {
    const request = props.findRequest;
    if (!request || handledFindRequest.current === request.id) return;
    handledFindRequest.current = request.id;
    setFindOpen(true);
    requestedFindTarget.current = request.rowKey
      ? { query: request.query, rowKey: request.rowKey, occurrence: request.occurrence ?? 0 }
      : null;
    if (props.onFindQueryChange) props.onFindQueryChange(request.query);
    else setInternalFindQuery(request.query);
    const matches = buildConversationFindMatches(props.rows, request.query);
    const target = request.rowKey
      ? matches.find(match => match.rowKey === request.rowKey
        && match.occurrence === (request.occurrence ?? 0))
      : matches[0];
    setActiveFindIdentity(target?.identity ?? matches[0]?.identity ?? null);
  }, [props.findRequest, props.onFindQueryChange, props.rows]);
  React.useEffect(() => {
    const requested = requestedFindTarget.current;
    const requestedMatch = requested && requested.query === findQuery
      ? findMatches.find(match => match.rowKey === requested.rowKey && match.occurrence === requested.occurrence)
      : undefined;
    if (requested && requested.query !== findQuery) requestedFindTarget.current = null;
    if (previousFindQuery.current !== findQuery) {
      previousFindQuery.current = findQuery;
      setActiveFindIdentity(requestedMatch?.identity ?? findMatches[0]?.identity ?? null);
    } else if (requestedMatch && activeFindIdentity !== requestedMatch.identity) {
      setActiveFindIdentity(requestedMatch.identity);
    } else if (foundActiveIndex < 0 && findMatches.length > 0) {
      setActiveFindIdentity(findMatches[0].identity);
    } else if (!findMatches.length && activeFindIdentity !== null) {
      setActiveFindIdentity(null);
    }
  }, [findQuery, findMatches, foundActiveIndex, activeFindIdentity]);
  React.useEffect(() => {
    const conversation = rootRef.current?.querySelector<HTMLElement>(".xn-zcode-conversation");
    if (!conversation) return;
    if (!findQuery.trim() && !findHighlightsApplied.current) return;
    const turnIndex = activeFindMatch
      ? turns.findIndex(turn => turn.rows.some(row => conversationFindRowKey(row) === activeFindMatch.rowKey))
      : -1;
    if (turnIndex >= 0 && (turnIndex < snapshot.start || turnIndex >= snapshot.end)) {
      const frame = window.requestAnimationFrame(() => reveal(turnIndex));
      return () => window.cancelAnimationFrame(frame);
    }
    applyConversationFindHighlights(conversation, findQuery, activeFindMatch?.rowKey ?? null, activeFindMatch?.occurrence ?? -1);
    findHighlightsApplied.current = Boolean(findQuery.trim());
  }, [findQuery, activeFindMatch?.rowKey, activeFindMatch?.occurrence, turns, snapshot.start, snapshot.end, reveal, props.rows]);
  const updateFindQuery = React.useCallback((query: string) => {
    requestedFindTarget.current = null;
    if (props.onFindQueryChange) props.onFindQueryChange(query);
    else setInternalFindQuery(query);
    const matches = buildConversationFindMatches(props.rows, query);
    setActiveFindIdentity(matches[0]?.identity ?? null);
    setFindOpen(true);
  }, [props.onFindQueryChange, props.rows]);
  const moveFind = React.useCallback((direction: -1 | 1) => {
    if (!findMatches.length) return;
    const index = activeFindIndex < 0 ? 0 : (activeFindIndex + direction + findMatches.length) % findMatches.length;
    setActiveFindIdentity(findMatches[index].identity);
  }, [findMatches, activeFindIndex]);
  const [selection, setSelection] = React.useState<ZCodeConversationSelection | null>(null);
  React.useEffect(() => {
    if (!props.renderSelectionAction) { setSelection(null); return; }
    const updateSelection = () => {
      const conversation = rootRef.current?.querySelector<HTMLElement>(".xn-zcode-conversation");
      const selected = window.getSelection();
      const text = selected?.toString().trim() ?? "";
      const anchor = selected?.anchorNode;
      const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement;
      const row = anchorElement?.closest<HTMLElement>("[data-zcode-row-key]");
      const turn = row?.closest<HTMLElement>("[data-zcode-turn-id]");
      const focus = selected?.focusNode;
      const focusElement = focus instanceof Element ? focus : focus?.parentElement;
      const focusRow = focusElement?.closest<HTMLElement>("[data-zcode-row-key]");
      const range = selected?.rangeCount === 1 ? selected.getRangeAt(0) : null;
      const startElement = range?.startContainer instanceof Element ? range.startContainer : range?.startContainer.parentElement;
      const endElement = range?.endContainer instanceof Element ? range.endContainer : range?.endContainer.parentElement;
      const startRow = startElement?.closest<HTMLElement>("[data-zcode-row-key]");
      const endRow = endElement?.closest<HTMLElement>("[data-zcode-row-key]");
      if (!conversation || !text || !anchor || !focus || !conversation.contains(anchor) || !conversation.contains(focus)
        || !row || !turn || row !== focusRow || row !== startRow || row !== endRow
        || !conversation.contains(row) || !conversation.contains(turn)) {
        setSelection(null);
        return;
      }
      const rowSeq = Number(row.dataset.zcodeRowSeq);
      const rowKind = row.dataset.zcodeRowKind as TimelineRow['kind'] | undefined;
      const turnId = turn.dataset.zcodeTurnId;
      if (!Number.isInteger(rowSeq) || !rowKind || !turnId) { setSelection(null); return; }
      setSelection({ text: text.slice(0, 8_001), overLimit: text.length > 8_000,
        turnId, rowKey: row.dataset.zcodeRowKey!, rowKind, rowSeq });
    };
    document.addEventListener("selectionchange", updateSelection);
    return () => document.removeEventListener("selectionchange", updateSelection);
  }, [props.renderSelectionAction]);
  React.useEffect(() => {
    const onFindShortcut = (event: KeyboardEvent) => {
      if (!isModKeyPressed(event) || event.altKey || event.key.toLowerCase() !== 'f') return;
      if (!rootRef.current) return;
      event.preventDefault();
      setFindOpen(true);
    };
    window.addEventListener('keydown', onFindShortcut, true);
    return () => window.removeEventListener('keydown', onFindShortcut, true);
  }, []);
  const requestReveal = React.useCallback((seq: number) => {
    const index = turns.findIndex(turn => turn.userSeq === seq);
    if (index >= 0) reveal(index);
  }, [turns, reveal]);
  return <DisclosureContext.Provider value={disclosures}>
    <SessionIdContext.Provider value={props.sessionId}>
      <div className="xn-timeline-history-layout xn-zc-layout" data-testid="timeline-history-layout">
        <XuenessConversationHistoryRail rows={props.rows} timelineRootRef={rootRef} requestReveal={requestReveal} />
        <div className="xn-timeline-history-layout__content" ref={rootRef}>
          <div className="xn-zcode-conversation" data-testid="zcode-conversation" ref={streamRef} aria-label={tr('会话')}>
            <div className="xn-zc-find__dock">
              <ConversationFindBar open={findOpen || Boolean(findQuery)} query={findQuery} resultCount={findMatches.length}
                activeIndex={activeFindIndex} onOpen={() => setFindOpen(true)} onQueryChange={updateFindQuery}
                onPrevious={() => moveFind(-1)} onNext={() => moveFind(1)} onClose={() => {
                  requestedFindTarget.current = null;
                  setFindOpen(false);
                  if (props.onFindQueryChange) props.onFindQueryChange("");
                  else setInternalFindQuery("");
                  setActiveFindIdentity(null);
                }} />
            </div>
            {props.renderSelectionAction && selection && <div className="xn-zc-selection-action" data-zcode-selection-action="true"
              onMouseDown={event => event.preventDefault()}>{props.renderSelectionAction(selection)}</div>}
            {snapshot.topPad > 0 && <div data-testid="timeline-window-top-spacer" aria-hidden="true" style={{ height: snapshot.topPad }} />}
            {snapshot.start === 0 && props.presentation?.chat && props.presentation.opening && props.effectivePluginIds?.has('sessions') && <OpeningRow presentation={props.presentation} />}
            {turns.slice(snapshot.start, snapshot.end).map((turn, offset) => <div data-window-index={snapshot.start + offset} key={turn.key}>
              <Turn turn={turn} latest={snapshot.start + offset === turns.length - 1} props={props}
                activeFindRowKey={activeFindMatch?.rowKey ?? null}
                compactionMarker={snapshot.start + offset === markerTurnIndex ? props.compactionMarker : null} />
            </div>)}
            {snapshot.bottomPad > 0 && <div data-testid="timeline-window-bottom-spacer" aria-hidden="true" style={{ height: snapshot.bottomPad }} />}
            {!turns.length && props.streamingPending && <p className="xn-zc-live" role="status">{props.activityPhase === 'compacting' ? <ContextCompactionStatus /> : tr(conversationActivityLabel(props.activityPhase))}</p>}
          </div>
        </div>
      </div>
    </SessionIdContext.Provider>
  </DisclosureContext.Provider>;
}
