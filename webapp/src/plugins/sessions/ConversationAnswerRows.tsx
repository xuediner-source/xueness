import React from 'react';
import { Brain, Check, ChevronRight, TriangleAlert } from 'lucide-react';
import { t as tr, tf, getLocale } from '../../i18n';
import { SimpleMarkdown, MarkdownRenderOptionsContext } from '../../XuenessShell';
import { useStreamingReveal } from '../../ui/StreamingCommitGate';
import { assistantTextForDisplay } from './XuenessTimeline';
import { completionPresentation, isDuplicateCompletionAnswer, shouldHideCompletionCard } from './completionPresentation';
import { reasoningIsActive } from './conversationActivity';
import { formatConversationWorkDuration, conversationElapsedInterval } from './conversationWorkDuration';
import { useDisclosure } from './conversationDisclosure';
import { rowData, streamingMarkdown, settledMarkdown, visibleAssistantText } from './conversationRows';
import type { Assistant, Completion } from './conversationTypes';

export function Reasoning({ row, activityPhase, findActive = false }: { row: Assistant; activityPhase?: string; findActive?: boolean }) {
  const disclosure = useDisclosure(`reasoning:${row.messageId ?? row.messageIndex ?? row.seq}`);
  const open = disclosure.open || findActive;
  const active = reasoningIsActive(row.streaming, activityPhase, row.text);
  const summary = row.reasoning?.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  // Keep the reasoning block independent from the assistant prose while
  // retaining the legacy assistant row identity for old event consumers.
  // Empty streaming reasoning is intentionally absent until the first token.
  if (row.streaming && !row.reasoning?.trim()) return null;
  const durationMs = conversationElapsedInterval(row.startedAt, row.endedAt);
  const duration = durationMs !== undefined ? formatConversationWorkDuration(durationMs, getLocale()) : undefined;
  const state = active ? 'streaming' : row.interrupted ? 'interrupted' : 'complete';
  const label = active ? tr('思考中…') : duration ? tf('思考了 {0}', [duration]) : row.interrupted ? tr('思考已停止') : tr('思考');
  return <details className="xn-zc-reasoning" open={open} onToggle={disclosure.onToggle} {...rowData(row)} data-active={active || undefined}
    data-testid={`timeline-item-reasoning-${row.seq}`} data-state={state}>
    <summary><Brain size={16} /><span className="xn-zc-kind">{label}</span>
      {!open && summary && <span className="xn-zc-reasoning-preview" title={summary}>{summary.slice(-180)}</span>}
      <ChevronRight size={16} className="xn-zc-chevron" /></summary>
    {open && <div className="xn-zc-reasoning-content"><MarkdownRenderOptionsContext.Provider value={row.streaming ? streamingMarkdown : settledMarkdown}><SimpleMarkdown text={row.reasoning ?? ''} /></MarkdownRenderOptionsContext.Provider></div>}
  </details>;
}

export function AssistantText({ row, summary, protocol }: { row: Assistant; summary?: string; protocol: boolean }) {
  // Reveal decoded answer text at an even pace. The streaming presentation is
  // kept until the reveal catches up, so the end of a stream does not pop.
  const target = assistantTextForDisplay(visibleAssistantText(row), row.streaming, summary, protocol);
  const { text: displayed, revealing } = useStreamingReveal(target, row.streaming === true);
  const live = row.streaming === true || revealing;
  return displayed.trim() ? <div className="xn-zc-answer" data-role="assistant" data-live={live || undefined} data-testid={`timeline-item-assistant-${row.seq}`} {...rowData(row)}>
    <MarkdownRenderOptionsContext.Provider value={live ? streamingMarkdown : settledMarkdown}><SimpleMarkdown text={displayed} /></MarkdownRenderOptionsContext.Provider>
  </div> : null;
}

export function CompletionCheck({ row, answer, protocol, findActive = false }: { row: Completion; answer: string; protocol: boolean; findActive?: boolean }) {
  const disclosure = useDisclosure(`completion:${row.seq}`, completionPresentation(row, protocol).detailsOpen);
  const open = disclosure.open || findActive;
  if (shouldHideCompletionCard(row, answer, protocol)) return null;
  const check = completionPresentation(row, protocol);
  const duplicate = isDuplicateCompletionAnswer(check.summary ?? '', answer, protocol);
  return <details className="xn-zc-completion" open={open} onToggle={disclosure.onToggle} {...rowData(row)} data-status={check.status} data-testid={`timeline-item-completion-${row.seq}`}>
    <summary>{check.status === 'ok' ? <Check size={14} /> : <TriangleAlert size={14} />}
      <span>{check.title}</span><ChevronRight size={14} className="xn-zc-chevron" /></summary>
    {open && <div><p>{check.label}</p>{!duplicate && check.summary && <SimpleMarkdown text={check.summary} />}</div>}
  </details>;
}
