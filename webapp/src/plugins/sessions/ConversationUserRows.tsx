import React from 'react';
import { Check, Copy, Pencil, ThumbsUp, ThumbsDown } from 'lucide-react';
import { t as tr } from '../../i18n';
import { isImeComposingEvent, isModKeyPressed } from '../../xuenessShortcutDisplay';
import type { AttachmentPreviewTransport } from './composerAttachmentPreviewModel';
import type { MessageEditAttachmentTransport } from './messageEditAttachments';
import { SessionIdContext } from './conversationDisclosure';
import type { Assistant, User, ZCodeConversationProps } from './conversationTypes';

export function evaluateUserMessageEditKey(
  event: {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    keyCode?: number;
    isComposing?: boolean;
    nativeEvent?: { isComposing?: boolean; keyCode?: number };
    compositionActive?: boolean;
  },
  options: { saving?: boolean; platform?: string } = {},
): 'save' | 'cancel' | null {
  if (isImeComposingEvent(event)) return null;
  if (event.key === 'Escape' && !options.saving) return 'cancel';
  if (event.key === 'Enter' && !event.altKey && !event.shiftKey && isModKeyPressed(event, options.platform)) return 'save';
  return null;
}

export function CopyAction({ text }: { text: string | (() => string) }) {
  const [copied, setCopied] = React.useState(false);
  const [error, setError] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = React.useRef(true);
  React.useEffect(() => () => {
    mounted.current = false;
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return <><button type="button" className="xn-zc-action" aria-label={tr('复制')} title={tr('复制')}
    onClick={async () => {
      try {
        await navigator.clipboard.writeText(typeof text === 'function' ? text() : text);
        if (!mounted.current) return;
        setError(false); setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          if (mounted.current) setCopied(false);
        }, 1500);
      } catch {
        if (mounted.current) setError(true);
      }
    }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
    {error && <span role="alert" className="xn-zc-action-error">{tr('复制失败')}</span>}</>;
}

const UserMessageEditor = React.lazy(() => import('./UserMessageEditor'));

export function UserMessage({ row, onEdit, enabled, isSessionsEffective, attachmentTransport, editSessionId, previewTransport }: { row: User; editSessionId?: string; previewTransport?: AttachmentPreviewTransport; attachmentTransport?: MessageEditAttachmentTransport; onEdit?: ZCodeConversationProps['onEdit']; enabled: boolean; isSessionsEffective?: () => boolean }) {
  const [editing, setEditing] = React.useState(false);
  const sessionId = React.useContext(SessionIdContext);
  return <div className="xn-zc-user" data-history-user-seq={row.seq} data-role="user" data-testid={`timeline-item-user-${row.seq}`}>
    {editing && enabled ? <React.Suspense fallback={null}><UserMessageEditor previewTransport={previewTransport} attachmentTransport={attachmentTransport} row={row} sessionId={editSessionId ?? sessionId} enabled={enabled} isSessionsEffective={isSessionsEffective}
      onEdit={onEdit} onClose={() => setEditing(false)} evaluateKey={evaluateUserMessageEditKey} /></React.Suspense>
      : <>{(row.displayText ?? row.text).trim() ? <div className="xn-zc-user-bubble">{row.displayText ?? row.text}</div> : null}<div className="xn-zc-actions"><CopyAction text={(row.displayText ?? row.text).trim() ? (row.displayText ?? row.text) : row.text} />
      {enabled && onEdit && row.messageRevision && row.messageIndex !== undefined && <button type="button" className="xn-zc-action"
        aria-label={tr('编辑消息')} title={tr('编辑消息')} onClick={() => { if (isSessionsEffective?.() !== false) setEditing(true); }}><Pencil size={14} /></button>}
    </div></>}
  </div>;
}

export function FeedbackActions({ row, onFeedback }: { row: Assistant; onFeedback: NonNullable<ZCodeConversationProps['onFeedback']> }) {
  const [feedback, setFeedback] = React.useState(row.feedback);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const mounted = React.useRef(true);
  React.useEffect(() => () => { mounted.current = false; }, []);
  React.useEffect(() => setFeedback(row.feedback), [row.feedback]);
  const submit = async (value: 'like' | 'dislike') => {
    if (busy) return;
    const previous = feedback;
    const next = feedback === value ? undefined : value;
    setFeedback(next); setBusy(true); setError('');
    try { await onFeedback(row, next ?? null); }
    catch (reason) {
      if (mounted.current) {
        setFeedback(previous);
        setError(reason instanceof Error ? reason.message : tr('反馈保存失败'));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return <>{(['like', 'dislike'] as const).map(value => <button key={value} type="button" className="xn-zc-action" disabled={busy}
    aria-label={tr(value === 'like' ? '有帮助' : '没有帮助')} title={tr(value === 'like' ? '有帮助' : '没有帮助')}
    aria-pressed={feedback === value} data-feedback={value} onClick={() => void submit(value)}>
    {value === 'like' ? <ThumbsUp size={14} /> : <ThumbsDown size={14} />}</button>)}
    {error && <span className="xn-zc-action-error" role="alert">{error}</span>}</>;
}
