import React, { useEffect, useState } from "react";
import { AlertTriangle, LoaderCircle, X } from "lucide-react";
import { get } from "../../xuenessApi";
import { toTimelineRows } from "../../xuenessWorkbench";
import { parseEventsEnvelope } from "../../xuenessEvents";
import { t as tr } from "../../i18n";
import { ZCodeConversation } from "../sessions/ZCodeConversation";

type ChildTranscript = {
  childSessionId: string;
  status: string;
  initialPrompt: string;
  rows: ReturnType<typeof toTimelineRows>;
};

/** Strictly validate the read-only projection before it enters the timeline renderer. */
export function parseChildTranscriptResponse(expectedChildId: string, value: unknown): ChildTranscript {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(tr("子会话记录格式无效"));
  const payload = value as Record<string, unknown>;
  const envelope = parseEventsEnvelope(payload.timeline);
  if (payload.childSessionId !== expectedChildId || typeof payload.status !== "string"
    || typeof payload.initialPrompt !== "string" || !envelope
    || envelope.sessionId !== expectedChildId || envelope.status !== payload.status
    || envelope.cursor !== 0 || envelope.hasMore || envelope.nextCursor !== envelope.head
    || envelope.events.length !== envelope.head
    || envelope.events.some((event, index) => event.sessionId !== expectedChildId || event.seq !== index + 1)) {
    throw new Error(tr("子会话记录格式无效"));
  }
  const rows = toTimelineRows(envelope.events);
  if (payload.initialPrompt) {
    const eventWithTurnId = envelope.events.find(event => "turnId" in event && typeof event.turnId === "string");
    const turnId = eventWithTurnId && "turnId" in eventWithTurnId
      && typeof eventWithTurnId.turnId === "string" ? eventWithTurnId.turnId : "turn-1";
    rows.unshift({ kind: "user", seq: 0, turnId, text: payload.initialPrompt });
  }
  return { childSessionId: expectedChildId, status: payload.status, initialPrompt: payload.initialPrompt, rows };
}

export function SubagentTranscript({
  parentSessionId,
  taskId,
  childSessionId,
  onClose,
}: {
  parentSessionId: string;
  taskId: string;
  childSessionId: string;
  onClose: () => void;
}): React.JSX.Element {
  const [transcript, setTranscript] = useState<ChildTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const load = async () => {
      controller = new AbortController();
      try {
        const raw = await get<unknown>(
          `/api/sessions/${encodeURIComponent(parentSessionId)}/tasks/${encodeURIComponent(taskId)}/transcript`,
          controller.signal,
        );
        const next = parseChildTranscriptResponse(childSessionId, raw);
        if (cancelled) return;
        setTranscript(next);
        setError(null);
        if (["pending", "running"].includes(next.status)) timer = setTimeout(() => void load(), 1800);
      } catch (reason) {
        if (!cancelled && !controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
  }, [parentSessionId, taskId, childSessionId]);

  return <section className="xn-subagent-transcript" data-testid={`subagent-transcript-${taskId}`}
    aria-label={tr("子会话记录")}>
    <header className="xn-subagent-transcript__header">
      <strong>{tr("子会话记录")}</strong>
      {transcript && <span>{tr(transcript.status)}</span>}
      <button type="button" aria-label={tr("关闭")} title={tr("关闭")} onClick={onClose}><X size={14} /></button>
    </header>
    {error ? <p className="xn-subagent-transcript__message" role="alert"><AlertTriangle size={14} />{error}</p>
      : !transcript ? <p className="xn-subagent-transcript__message"><LoaderCircle size={14} className="animate-spin" />{tr("正在加载子会话记录…")}</p>
        : <div className="xn-subagent-transcript__conversation">
          <ZCodeConversation sessionId={transcript.childSessionId} rows={transcript.rows} autoScroll />
        </div>}
  </section>;
}
