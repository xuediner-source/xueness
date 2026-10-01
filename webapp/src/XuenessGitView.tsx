import { t as tr, tf } from './i18n';
/**
 * Git panel view. The container owns transport; every mutating affordance
 * first opens an operation review dialog and appears only with a handler.
 *
 * Three sections over the data the container loads: branch + porcelain status,
 * the real working-tree diff (clearly distinct from the journal-derived intent
 * diff), recent commits, and checkpoint recovery controls.
 *
 * Anti-fake-control rule: the refresh button renders only when ``onRefresh``
 * was passed. A "该工作区不是 git 仓库" error collapses the whole panel into
 * one honest empty state instead of three sections full of fake data.
 */
import React, { useMemo, useState } from "react";
import { CodeContent } from "./ui/CodeContent";
import "./styles/git.css";
import type { GitCheckpoint, GitCommit, GitDiff, GitStatus } from "./xuenessGit";

const NOT_A_REPO = () => (tr("该工作区不是 git 仓库"));

export type GitViewProps = {
  status: GitStatus | null;
  statusError?: string;
  statusLoading?: boolean;
  diff: GitDiff | null;
  diffError?: string;
  diffLoading?: boolean;
  log: GitCommit[] | null;
  logError?: string;
  logLoading?: boolean;
  onRefresh?: () => void;
  checkpoints?: GitCheckpoint[];
  actionError?: string;
  actionBusy?: boolean;
  onInit?: () => void;
  onStage?: (paths: string[]) => void;
  onUnstage?: (paths: string[]) => void;
  onCommit?: (message: string) => void;
  onBranch?: (name: string, create: boolean) => void;
  onStash?: () => void;
  onCheckpoint?: (message: string) => void;
  onRestore?: (id: string) => void;
};

/** True when the backend's 404 body says this workspace is not a repository. */
export function isNotRepoError(error?: string): boolean {
  return typeof error === "string" && error.includes(NOT_A_REPO());
}

/**
 * Porcelain XY code -> badge tone, using existing design tokens.
 * M/modified -> warn, A/added -> ok, D/deleted -> error, ??/untracked ->
 * neutral, R(C)/renamed/copied -> info; anything else reads as modified.
 */
function badgeTone(code: string): "warn" | "ok" | "error" | "info" | "neutral" {
  const c = (code || "").trim();
  if (c === "??") return "neutral";
  if (c.includes("D")) return "error";
  if (c.includes("A")) return "ok";
  if (c.includes("R") || c.includes("C")) return "info";
  return "warn";
}

function SectionError({ error }: { error: string }): React.JSX.Element {
  return (
    <p role="alert" className="xn-git__error">
      {error}
    </p>
  );
}

function SectionLoading(): React.JSX.Element {
  return <p className="xn-git__loading">{tr("加载中…")}</p>;
}

function StatusSection({
  status,
  error,
  loading,
}: {
  status: GitStatus | null;
  error?: string;
  loading?: boolean;
}): React.JSX.Element {
  return (
    <section className="xn-git__section" data-testid="git-status">
      <h4 className="xn-git__section-title">{tr("分支与状态")}</h4>
      {error ? (
        <SectionError error={error} />
      ) : loading ? (
        <SectionLoading />
      ) : status ? (
        <>
          <p className="xn-git__branchline">
            <span className="xn-git__branch" data-testid="git-branch">
              {status.branch || "HEAD"}
            </span>
            {status.clean ? (
              <span className="xn-git__clean">{tr("工作区干净")}</span>
            ) : (
              <span className="xn-git__muted">{status.entries.length}{tr("个变更")}</span>
            )}
          </p>
          {status.entries.length > 0 && (
            <ul className="xn-git__list">
              {status.entries.map((entry, index) => (
                <li key={`${entry.path}-${index}`} className="xn-git__row">
                  <span className={`xn-git__badge xn-git__badge--${badgeTone(entry.code)}`}>
                    {entry.code}
                  </span>
                  <span className="xn-git__path">{entry.path}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}

function DiffSection({
  diff,
  error,
  loading,
}: {
  diff: GitDiff | null;
  error?: string;
  loading?: boolean;
}): React.JSX.Element {
  return (
    <section className="xn-git__section" data-testid="git-diff">
      <h4 className="xn-git__section-title">{tr("工作树 Diff")}</h4>
      {error ? (
        <SectionError error={error} />
      ) : loading ? (
        <SectionLoading />
      ) : diff ? (
        <>
          {diff.truncated && <p className="xn-git__truncated">{tr("补丁过长，已截断")}</p>}
          {!diff.stat && !diff.patch ? (
            <p className="xn-git__muted">{tr("无改动")}</p>
          ) : (
            <>
              {diff.stat && <pre className="xn-git__pre">{diff.stat}</pre>}
              {diff.patch && <CodeContent text={diff.patch} language="diff" />}
            </>
          )}
        </>
      ) : null}
    </section>
  );
}

function LogSection({
  log,
  error,
  loading,
}: {
  log: GitCommit[] | null;
  error?: string;
  loading?: boolean;
}): React.JSX.Element {
  return (
    <section className="xn-git__section" data-testid="git-log">
      <h4 className="xn-git__section-title">{tr("最近提交")}</h4>
      {error ? (
        <SectionError error={error} />
      ) : loading ? (
        <SectionLoading />
      ) : log ? (
        log.length === 0 ? (
          <p className="xn-git__muted">{tr("暂无提交")}</p>
        ) : (
          <ul className="xn-git__commits">
            {log.map((commit) => (
              <li key={commit.hash} className="xn-git__commit">
                <span className="xn-git__commit-subject">{commit.subject}</span>
                <span className="xn-git__commit-meta">
                  {commit.short} · {commit.author} · {commit.date}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}

export function XuenessGitView({
  status,
  statusError,
  statusLoading,
  diff,
  diffError,
  diffLoading,
  log,
  logError,
  logLoading,
  onRefresh,
  checkpoints = [], actionError, actionBusy, onInit, onStage, onUnstage, onCommit, onBranch, onStash, onCheckpoint, onRestore,
}: GitViewProps): React.JSX.Element {
  const [selected, setSelected] = useState<string[]>([]);
  const [commitMessage, setCommitMessage] = useState("");
  const [branchName, setBranchName] = useState("");
  const [checkpointMessage, setCheckpointMessage] = useState("");
  const [confirmation, setConfirmation] = useState<{ title: string; detail: string; run: () => void } | null>(null);
  const entries = useMemo(() => status?.entries ?? [], [status]);
  const confirmAction = (title: string, detail: string, run: () => void) => setConfirmation({ title, detail, run });
  const action = (title: string, detail: string, run: () => void) => confirmAction(title, detail, run);
  // The not-a-repo state is a property of the workspace, not of one endpoint:
  // all three loaders fail with the same message, so the panel collapses into
  // a single honest empty state rather than three identical error rows.
  const notRepo =
    isNotRepoError(statusError) || isNotRepoError(diffError) || isNotRepoError(logError);
  return (
    <div className="xn-git" data-testid="git-view">
      <div className="xn-git__head">
        <h3 className="xn-git__title">Git</h3>
        {onRefresh && (
          <button
            type="button"
            className="xn-git__refresh"
            data-testid="git-refresh"
            onClick={onRefresh}
          >{tr("刷新")}</button>
        )}
      </div>
      {notRepo ? (
        <div className="xn-git__empty" data-testid="git-empty">
          <p className="xn-git__empty-title">{NOT_A_REPO()}</p>
          <p className="xn-git__empty-hint">{tr("初始化本地仓库后，可在此暂存、提交和创建检查点。")}</p>
          {onInit && <button type="button" disabled={actionBusy} onClick={() => action(tr("初始化 Git 仓库"), tr("将在当前会话工作区创建本地 Git 仓库。"), onInit)}>{tr("初始化仓库")}</button>}
        </div>
      ) : (
        <>
          {actionError && <SectionError error={actionError} />}
          <StatusSection status={status} error={statusError} loading={statusLoading} />
          {status && (onStage || onUnstage || onCommit || onBranch || onStash || onCheckpoint || onRestore) && <section className="xn-git__section" aria-label={tr("本地操作")}>
            <h4 className="xn-git__section-title">{tr("本地操作")}</h4>
            <div className="xn-git__controls">
              {entries.map(entry => <label key={entry.path}><input type="checkbox" checked={selected.includes(entry.path)} onChange={e => setSelected(prev => e.target.checked ? [...prev, entry.path] : prev.filter(p => p !== entry.path))} /> <code>{entry.path}</code></label>)}
            </div>
            <div className="xn-git__controls">
              <button type="button" disabled={!selected.length || actionBusy || !onStage} onClick={() => action(tr("暂存所选文件"), selected.join("\n"), () => onStage?.(selected))}>{tr("暂存")}</button>
              <button type="button" disabled={!selected.length || actionBusy || !onUnstage} onClick={() => action(tr("取消暂存所选文件"), selected.join("\n"), () => onUnstage?.(selected))}>{tr("取消暂存")}</button>
              <input aria-label={tr("提交说明")} value={commitMessage} onChange={e => setCommitMessage(e.target.value)} placeholder={tr("提交说明")} />
              <button type="button" disabled={!commitMessage.trim() || actionBusy || !onCommit} onClick={() => action(tr("创建提交"), commitMessage, () => { onCommit?.(commitMessage); setCommitMessage(""); })}>{tr("提交")}</button>
            </div>
            <div className="xn-git__controls">
              <input aria-label={tr("分支名称")} value={branchName} onChange={e => setBranchName(e.target.value)} placeholder={tr("分支名称")} />
              <button type="button" disabled={!branchName.trim() || actionBusy || !onBranch} onClick={() => action(tr("切换分支"), branchName, () => onBranch?.(branchName, false))}>{tr("切换")}</button>
              <button type="button" disabled={!branchName.trim() || actionBusy || !onBranch} onClick={() => action(tr("创建分支"), branchName, () => onBranch?.(branchName, true))}>{tr("创建分支")}</button>
              <button type="button" disabled={status.clean || actionBusy || !onStash} onClick={() => action(tr("暂存工作区更改"), tr("当前未提交改动将保存到本地 stash。"), () => onStash?.())}>{tr("Stash")}</button>
            </div>
          </section>}
          {onCheckpoint && <section className="xn-git__section" aria-label={tr("检查点")}>
            <h4 className="xn-git__section-title">{tr("检查点")}</h4>
            <div className="xn-git__controls"><input aria-label={tr("检查点说明")} value={checkpointMessage} onChange={e => setCheckpointMessage(e.target.value)} placeholder={tr("检查点说明")} /><button type="button" disabled={!checkpointMessage.trim() || actionBusy || !onCheckpoint} onClick={() => action(tr("创建检查点"), checkpointMessage, () => { onCheckpoint?.(checkpointMessage); setCheckpointMessage(""); })}>{tr("创建检查点")}</button></div>
            {checkpoints.map(cp => <div className="xn-git__checkpoint" key={cp.id}><span>{cp.message} <code>{cp.hash.slice(0, 10)}</code></span><button type="button" disabled={actionBusy || !onRestore} onClick={() => action(tr("恢复检查点"), `${cp.message}\n${cp.hash}\n${tr("恢复前会自动创建当前状态的恢复检查点。")}`, () => onRestore?.(cp.id))}>{tr("恢复")}</button></div>)}
          </section>}
          <DiffSection diff={diff} error={diffError} loading={diffLoading} />
          <LogSection log={log} error={logError} loading={logLoading} />
        </>
      )}
      {confirmation && <div className="xn-git__modal-backdrop" role="presentation"><section className="xn-git__confirm" role="alertdialog" aria-modal="true" aria-labelledby="git-confirm-title"><h4 id="git-confirm-title">{confirmation.title}</h4><pre>{confirmation.detail}</pre><div className="xn-git__controls"><button type="button" onClick={() => setConfirmation(null)}>{tr("取消")}</button><button type="button" disabled={actionBusy} onClick={() => { const run = confirmation.run; setConfirmation(null); run(); }}>{tr("确认操作")}</button></div></section></div>}
    </div>
  );
}
