/**
 * Workbench session request state: which sessions have a run, stop, queue or
 * create request in flight, plus the workbench-wide busy/error flags those
 * requests drive. Moved unchanged out of XuenessWorkbenchContainer.
 */
import type React from "react";
import { useCallback, useRef, useState } from "react";
import { tf } from "../../i18n";
import type { FileChangeSet, FilePreview, Result } from "../../xuenessWorkbench";
import type { GitCheckpoint, GitCommit, GitDiff, GitStatus } from "../../xuenessGit";

export function trackSessionId(
  ref: React.MutableRefObject<Set<string>>,
  setValue: (value: Set<string>) => void,
  id: string,
  present: boolean,
): void {
  if (!id || ref.current.has(id) === present) return;
  const next = new Set(ref.current);
  if (present) next.add(id);
  else next.delete(id);
  ref.current = next;
  setValue(next);
}

export function shouldIgnoreSessionResponse(
  requestSessionId: string | null,
  activeSessionId: string | null,
  isMounted = true,
  signal?: AbortSignal,
): boolean {
  if (!isMounted) return true;
  if (signal?.aborted) return true;
  return requestSessionId !== activeSessionId;
}

export function createCleanSessionTransientState() {
  return {
    files: [] as { path: string; size: number }[],
    filesTruncated: false,
    selectedPath: null as string | null,
    preview: null as FilePreview | null,
    previewError: "",
    changeSet: null as FileChangeSet | null,
    changesError: "",
    gitStatus: null as GitStatus | null,
    gitStatusError: "",
    gitDiff: null as GitDiff | null,
    gitDiffError: "",
    gitLog: null as GitCommit[] | null,
    gitLogError: "",
    gitCheckpoints: [] as GitCheckpoint[],
    gitCheckpointError: "",
    runError: "",
  };
}

export function selectedTextPrompt(sourceTitle: string, turnId: string, text: string, sideChat = false): string {
  const turnNumber = /^turn-([1-9][0-9]*)$/u.exec(turnId)?.[1] ?? turnId;
  const quote = text.split(/\r?\n/u).map(line => `> ${line}`).join('\n');
  const heading = sideChat
    ? tf('请围绕“{0}”第 {1} 轮中的选段提问：', [sourceTitle, turnNumber])
    : tf('引用自“{0}”第 {1} 轮：', [sourceTitle, turnNumber]);
  return `${heading}\n\n${quote}`;
}

export type SessionQueueError = { sessionId: string; message: string; compact?: 'running' | 'complete' };

/** Request bookkeeping shared by the session list, actions and views. */
export function useSessionActivity() {
  const [error, setError] = useState("");
  const [runError, setRunError] = useState("");
  const [busy, setBusy] = useState(false);
  const [executingSessions, setExecutingSessions] = useState<Set<string>>(() => new Set());
  const executingSessionsRef = useRef(new Set<string>());
  const [runRequestSessions, setRunRequestSessions] = useState<Set<string>>(() => new Set());
  const runRequestSessionsRef = useRef(new Set<string>());
  const [creatingSession, setCreatingSession] = useState(false);
  const createGenerationRef = useRef(0);
  const activeCreateRef = useRef<number | null>(null);
  const [stoppingSessions, setStoppingSessions] = useState<Set<string>>(() => new Set());
  const stoppingSessionsRef = useRef(new Set<string>());
  const [queueSubmittingSessions, setQueueSubmittingSessions] = useState<Set<string>>(() => new Set());
  const queueSubmittingSessionsRef = useRef(new Set<string>());
  const [queueContinuingSessions, setQueueContinuingSessions] = useState<Set<string>>(() => new Set());
  const queueContinuingSessionsRef = useRef(new Set<string>());
  const [queueCancelling, setQueueCancelling] = useState<{ sessionId: string; queueId: string } | null>(null);
  const [queueError, setQueueError] = useState<SessionQueueError | null>(null);

  /** Run an action, surface its error on failure, and report whether to reload. */
  const run = useCallback(async (action: () => Promise<Result<unknown>>) => {
    setBusy(true);
    setError("");
    try {
      const res = await action();
      if (!res.ok) {
        setError(res.error);
        return false;
      }
      return true;
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    error, setError, runError, setRunError, busy, setBusy, run,
    executingSessions, setExecutingSessions, executingSessionsRef,
    runRequestSessions, setRunRequestSessions, runRequestSessionsRef,
    creatingSession, setCreatingSession, createGenerationRef, activeCreateRef,
    stoppingSessions, setStoppingSessions, stoppingSessionsRef,
    queueSubmittingSessions, setQueueSubmittingSessions, queueSubmittingSessionsRef,
    queueContinuingSessions, setQueueContinuingSessions, queueContinuingSessionsRef,
    queueCancelling, setQueueCancelling, queueError, setQueueError,
  };
}

export type SessionActivity = ReturnType<typeof useSessionActivity>;
