import { useCallback, useEffect, useReducer, useRef } from 'react';
import { loadGitStatus, loadGitDiff, loadGitLog, loadGitCheckpoints, type GitStatus, type GitDiff, type GitCommit, type GitCheckpoint } from '../../xuenessGit';
import type { Result } from '../../xuenessWorkbench';

type GitPanelState = {
  gitStatus: GitStatus | null; gitStatusError: string;
  gitDiff: GitDiff | null; gitDiffError: string;
  gitLog: GitCommit[] | null; gitLogError: string;
  gitCheckpoints: GitCheckpoint[]; gitCheckpointError: string;
  gitLoading: boolean; gitActionBusy: boolean;
};
const initialState = (): GitPanelState => ({ gitStatus: null, gitStatusError: '', gitDiff: null, gitDiffError: '',
  gitLog: null, gitLogError: '', gitCheckpoints: [], gitCheckpointError: '', gitLoading: false, gitActionBusy: false });

/** Git owns its panel state and request lifecycle; the shell only mounts it. */
export function useGitPanel(sessionId: string | null, visible: boolean, enabled: boolean) {
  const [state, patch] = useReducer((previous: GitPanelState, next: Partial<GitPanelState>) => ({ ...previous, ...next }), undefined, initialState);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const active = useRef({ sessionId, enabled });
  active.current = { sessionId, enabled };
  const current = () => mounted.current && active.current.sessionId === sessionId && active.current.enabled;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => {
    patch(initialState());
    return () => { controller.current?.abort(); };
  }, [sessionId, enabled]);
  const loadGitPanel = useCallback(async () => {
    if (!sessionId || !current()) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    patch({ gitLoading: true, gitStatusError: '', gitDiffError: '', gitLogError: '' });
    const [status, diff, log, checkpoints] = await Promise.all([
      loadGitStatus(sessionId, request.signal), loadGitDiff(sessionId, request.signal),
      loadGitLog(sessionId, request.signal), loadGitCheckpoints(sessionId, request.signal),
    ]);
    if (request.signal.aborted || !current()) return;
    patch({ gitStatus: status.ok ? status.value : null, gitStatusError: status.ok ? '' : status.error,
      gitDiff: diff.ok ? diff.value : null, gitDiffError: diff.ok ? '' : diff.error,
      gitLog: log.ok ? log.value : null, gitLogError: log.ok ? '' : log.error,
      gitCheckpoints: checkpoints.ok ? checkpoints.value : [], gitCheckpointError: checkpoints.ok ? '' : checkpoints.error,
      gitLoading: false });
  }, [sessionId, enabled]);
  const runGitAction = useCallback(async (action: () => Promise<Result<unknown>>) => {
    if (!sessionId || !current() || state.gitActionBusy) return;
    patch({ gitActionBusy: true });
    try {
      const result = await action();
      if (!current()) return;
      patch({ gitCheckpointError: result.ok ? '' : result.error });
      await loadGitPanel();
    } finally { if (current()) patch({ gitActionBusy: false }); }
  }, [sessionId, enabled, state.gitActionBusy, loadGitPanel]);
  useEffect(() => { if (visible) void loadGitPanel(); }, [visible, loadGitPanel]);
  return { ...state, loadGitPanel, runGitAction };
}
