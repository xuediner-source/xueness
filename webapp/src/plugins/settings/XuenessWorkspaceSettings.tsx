import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import { t as tr, tf } from "../../i18n";
import {
  confirmWorkspaceRoot,
  chooseNativeWorkspace,
  loadNativeWorkspacePicker,
  createWorkspaceDirectory,
  isAbsoluteWorkspacePath,
  isWorkspacePathAllowed,
  loadWorkspaceCatalog,
  saveDefaultWorkspaceRoot,
  workspaceBreadcrumbs,
  type WorkspaceCatalog,
} from "../../xuenessWorkspaces";
import "../../styles/workspaces.css";

export type XuenessWorkspaceSettingsProps = {
  /** Called only after the host validates and records the selected directory. */
  onChoose?: (root: string, isolated?: boolean) => void;
  /** Active workspace shown for context; changing the default never changes it. */
  currentRoot?: string | null;
  /** Start-picker mode adds an explicit Use/Cancel flow. */
  picking?: boolean;
  onCancel?: () => void;
  onDefaultChanged?: (root: string) => void;
  /** SSH workspaces are managed by the host's remote connection panel. */
  remote?: boolean;
  /** Used by the accessible picker dialog wrapper. */
  dialogTitleId?: string;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatLastUsed(value: string | number): string {
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function XuenessWorkspaceSettings({
  onChoose,
  currentRoot,
  picking = false,
  onCancel,
  onDefaultChanged,
  remote = false,
  dialogTitleId,
}: XuenessWorkspaceSettingsProps): React.ReactElement {
  const [catalog, setCatalog] = useState<WorkspaceCatalog | null>(null);
  const [rootInput, setRootInput] = useState(currentRoot ?? "");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [newDirectoryName, setNewDirectoryName] = useState("");
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const requestSequence = useRef(0);

  const refresh = useCallback(async (path?: string) => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError("");
    try {
      const next = await loadWorkspaceCatalog(path);
      if (sequence !== requestSequence.current) return null;
      setCatalog(next);
      if (path && next.picker.path) setRootInput(next.picker.path);
      return next;
    } catch (reason) {
      if (sequence === requestSequence.current) setError(errorText(reason));
      return null;
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let live = true;
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError("");
    void (async () => {
      try {
        let next = await loadWorkspaceCatalog();
        if (!live || sequence !== requestSequence.current) return;
        const preferred = currentRoot && isWorkspacePathAllowed(currentRoot, next.allowedRoots)
          ? currentRoot
          : next.defaultRoot && isWorkspacePathAllowed(next.defaultRoot, next.allowedRoots)
            ? next.defaultRoot
            : next.allowedRoots[0]?.path ?? "";
        if (preferred && next.picker.path !== preferred) {
          const scoped = await loadWorkspaceCatalog(preferred);
          if (!live || sequence !== requestSequence.current) return;
          next = scoped;
        }
        setCatalog(next);
        setRootInput(preferred || next.picker.path || "");
      } catch (reason) {
        if (live && sequence === requestSequence.current) setError(errorText(reason));
      } finally {
        if (live && sequence === requestSequence.current) setLoading(false);
      }
    })();
    return () => {
      live = false;
      if (sequence === requestSequence.current) requestSequence.current += 1;
    };
  }, [currentRoot]);

  useEffect(() => {
    let live = true;
    void loadNativeWorkspacePicker().then(value => { if (live) setNativeAvailable(value.available); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const selectNative = async () => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await chooseNativeWorkspace(candidate || currentRoot);
      if (!result.cancelled) {
        setRootInput(result.root);
        await refresh(result.root);
        if (picking) onChoose?.(result.root, false);
      }
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  };

  const candidate = rootInput.trim();
  const servicePort = typeof window !== "undefined" && window.location?.port ? window.location.port : "8137";
  const candidateValid = isAbsoluteWorkspacePath(candidate);
  const candidateWithinListedRoots = Boolean(catalog && isWorkspacePathAllowed(candidate, catalog.allowedRoots));
  const breadcrumbs = useMemo(
    () => workspaceBreadcrumbs(catalog?.picker.path ?? null, catalog?.allowedRoots ?? []),
    [catalog?.allowedRoots, catalog?.picker.path],
  );
  const pickerPath = catalog?.picker.path ?? null;
  const canNavigateParent = Boolean(
    catalog?.picker.parent && isWorkspacePathAllowed(catalog.picker.parent, catalog.allowedRoots),
  );

  const navigate = useCallback(async (path: string) => {
    if (!catalog || !isAbsoluteWorkspacePath(path)) {
      setError(tr("请输入完整的绝对路径。"));
      return;
    }
    setNotice("");
    const next = await refresh(path);
    if (next?.picker.path) setRootInput(next.picker.path);
  }, [catalog, refresh]);

  const confirmSelection = useCallback(async () => {
    if (!candidateValid || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await confirmWorkspaceRoot(candidate);
      setRootInput(result.root);
      setNotice(tr("工作区已通过主机范围校验。"));
      onChoose?.(result.root, false);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }, [busy, candidate, candidateValid, onChoose]);

  const saveDefault = useCallback(async () => {
    if (!candidateValid || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await saveDefaultWorkspaceRoot(candidate);
      setRootInput(result.root);
      await refresh(result.root);
      setNotice(tr("已保存新任务的默认工作区。当前运行中的任务没有更改。"));
      onDefaultChanged?.(result.root);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }, [busy, candidate, candidateValid, onDefaultChanged, refresh]);

  const createDirectory = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    const name = newDirectoryName.trim();
    if (!catalog || !pickerPath || !name || busy) return;
    if (name === "." || name === ".." || /[\\/\0]/.test(name)) {
      setError(tr("文件夹名称只能是单个路径段。"));
      return;
    }
    if (!isAbsoluteWorkspacePath(pickerPath)) {
      setError(tr("当前目录不是完整的绝对路径。"));
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const created = await createWorkspaceDirectory(pickerPath, name);
      setNewDirectoryName("");
      await refresh(created.path);
      setNotice(tr("文件夹已创建。"));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }, [busy, catalog, newDirectoryName, pickerPath, refresh]);

  const pickerEntries = (catalog?.picker.entries ?? [])
    .filter((entry) => entry.type === "directory")
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <section className="xn-workspace-settings" data-testid="workspace-settings">
      <header className="xn-workspace-settings__header">
        <div>
          <p className="xn-workspace-settings__eyebrow">{tr("工作区设置")}</p>
          <h2 id={dialogTitleId} tabIndex={picking ? -1 : undefined} data-workspace-picker-title={picking ? "true" : undefined}>
            {picking ? tr("选择工作区") : tr("默认工作区")}
          </h2>
          <p>{picking
            ? tr("为新任务选择一个主机允许访问的目录。确认后只影响新任务。")
            : tr("设置新任务的默认目录。保存默认值不会更改当前正在运行的任务。")}</p>
        </div>
        {picking && onCancel && <button type="button" className="xn-workspace-settings__button" onClick={onCancel}>{tr("取消")}</button>}
      </header>

      {remote ? (
        <div className="xn-workspace-settings__notice" role="status">
          {tr("远程 SSH 工作区由连接选择器管理；此处只浏览本机主机批准的目录。")}
        </div>
      ) : null}

      {error && <p className="xn-workspace-settings__error" role="alert">{error}</p>}
      {notice && <p className="xn-workspace-settings__success" role="status">{notice}</p>}

      <div className="xn-workspace-settings__layout">
        <div className="xn-workspace-settings__main">
          <section className="xn-workspace-settings__card" aria-labelledby="workspace-root-heading">
            <div className="xn-workspace-settings__card-heading">
              <div><h3 id="workspace-root-heading">{tr("目录路径")}</h3><p>{tr("输入完整绝对路径，主机会再次校验范围。")}</p></div>
              {candidate === catalog?.defaultRoot && <span className="xn-workspace-settings__tag">{tr("当前默认")}</span>}
            </div>
            {nativeAvailable && !remote && <button type="button" className="xn-workspace-settings__button" disabled={busy || loading} onClick={() => void selectNative()}><FolderOpen size={15} /> {tr(busy ? "请在系统窗口中选择文件夹…" : "在此电脑添加文件夹")}</button>}
            {currentRoot && <p className="xn-workspace-settings__current"><strong>{tr("当前工作区")}</strong><code>{currentRoot}</code></p>}
            <label className="xn-workspace-settings__path-field">
              <span>{tr("完整路径")}</span>
              <input
                aria-label={tr("完整路径")}
                data-testid="workspace-root-input"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(candidate && !candidateValid)}
                value={rootInput}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void navigate(candidate);
                  }
                }}
                onChange={(event) => { setRootInput(event.target.value); setNotice(""); }}
              />
            </label>
            {candidate && !candidateValid && <p className="xn-workspace-settings__error">{tr("请输入完整的绝对路径。")}</p>}
            {candidateValid && !candidateWithinListedRoots && catalog && (
              <div className="xn-workspace-settings__validation" role="status">
                <p>{tr("该路径不在已列出的批准范围内；最终权限由主机校验。")}</p>
                {nativeAvailable
                  ? <p>{tr("使用系统窗口选择此文件夹，即可添加到项目。")}</p>
                  : <><p>{tr("要添加工作区范围，请在服务启动时配置一个已存在的项目目录：")}</p><code>{`python3 -m xueness.web --port ${servicePort} --workspace-root "<目录>"`}</code><p>{tr("更改需要重启服务后生效。")}</p></>}
              </div>
            )}
            <div className="xn-workspace-settings__actions">
              <button type="button" className="xn-workspace-settings__button" disabled={!candidateValid || busy || loading} onClick={() => void navigate(candidate)}>{tr("浏览此路径")}</button>
              {onChoose && <button type="button" className="xn-workspace-settings__button xn-workspace-settings__button--primary" disabled={!candidateValid || busy || loading || remote} onClick={() => void confirmSelection()}>{tr("使用此文件夹")}</button>}
              {!picking && <button type="button" className="xn-workspace-settings__button" disabled={!candidateValid || busy || loading || remote} onClick={() => void saveDefault()}>{tr("保存为默认目录")}</button>}
            </div>
          </section>

          <section className="xn-workspace-settings__card" aria-labelledby="workspace-picker-heading">
            <div className="xn-workspace-settings__card-heading">
              <div><h3 id="workspace-picker-heading">{tr("浏览批准的目录")}</h3><p>{tr("文件夹列表由主机按允许范围提供。")}</p></div>
              <div className="xn-workspace-settings__picker-actions">
                {catalog?.picker.truncated && <span className="xn-workspace-settings__tag">{tr("列表已截断")}</span>}
                <button type="button" className="xn-workspace-settings__button" disabled={loading || busy} onClick={() => void refresh(pickerPath ?? undefined)}>{tr("刷新目录")}</button>
              </div>
            </div>
            {catalog && catalog.allowedRoots.length > 0 && <div className="xn-workspace-settings__scopes" aria-label={tr("主机批准范围")}>
              <span>{tr("主机批准范围")}</span>
              {catalog.allowedRoots.map((root) => <button type="button" key={root.path} title={root.path} disabled={loading || busy} onClick={() => void navigate(root.path)}>{root.label}<code>{root.path}</code></button>)}
            </div>}
            <div className="xn-workspace-settings__breadcrumbs" aria-label={tr("目录路径导航")}>
              {catalog?.picker.parent && canNavigateParent && <button type="button" disabled={loading || busy} onClick={() => void navigate(catalog.picker.parent!)}>{tr("上一级")}</button>}
              {breadcrumbs.map((crumb, index) => <React.Fragment key={crumb.path}>
                {index > 0 && <span aria-hidden="true">/</span>}
                {index === breadcrumbs.length - 1
                  ? <strong title={crumb.path}>{crumb.label}</strong>
                  : <button type="button" title={crumb.path} disabled={loading || busy} onClick={() => void navigate(crumb.path)}>{crumb.label}</button>}
              </React.Fragment>)}
            </div>
            {loading ? <p className="xn-workspace-settings__empty" role="status">{tr("正在加载目录…")}</p> : (
              <ul className="xn-workspace-settings__folders" aria-label={tr("可选文件夹")}>
                {pickerEntries.map((entry) => <li key={entry.path}>
                  <button type="button" disabled={entry.isSymlink || loading || busy} title={entry.path} onClick={() => void navigate(entry.path)}>
                    <span className="xn-workspace-settings__folder-icon" aria-hidden="true">▸</span><span>{entry.name}</span>
                    {entry.isSymlink && <small>{tr("符号链接不可浏览")}</small>}
                  </button>
                </li>)}
                {!pickerEntries.length && <li className="xn-workspace-settings__empty">{tr("当前目录没有可浏览的子文件夹。")}</li>}
              </ul>
            )}
            <form className="xn-workspace-settings__create" onSubmit={(event) => void createDirectory(event)}>
              <label><span>{tr("新建文件夹")}</span><input value={newDirectoryName} onChange={(event) => setNewDirectoryName(event.target.value)} aria-label={tr("新建文件夹名称")} placeholder={tr("文件夹名称")} /></label>
              <button type="submit" className="xn-workspace-settings__button" disabled={!pickerPath || !newDirectoryName.trim() || busy || loading || remote}>{tr("创建")}</button>
            </form>
          </section>
        </div>

        <aside className="xn-workspace-settings__side">
          <section className="xn-workspace-settings__card" aria-labelledby="workspace-recent-heading">
            <div className="xn-workspace-settings__card-heading"><div><h3 id="workspace-recent-heading">{tr("最近使用的目录")}</h3><p>{tr("选择后可再次浏览并确认。")}</p></div></div>
            {!catalog?.recentDirectories.length ? <p className="xn-workspace-settings__empty">{tr("暂无最近目录。")}</p> : (
              <ul className="xn-workspace-settings__recent">
                {catalog.recentDirectories.map((item) => <li key={item.path}>
                  <button type="button" title={item.path} onClick={() => void navigate(item.path)} disabled={loading || busy}>
                    <strong>{item.label}</strong><code>{item.path}</code><small>{tf("最近使用：{0}", [formatLastUsed(item.lastUsed)])}</small>
                  </button>
                </li>)}
              </ul>
            )}
          </section>
          <p className="xn-workspace-settings__footnote">{tr("更改默认目录只供之后新建的任务使用，不会移动或更改任何现有工作区文件。")}</p>
        </aside>
      </div>
    </section>
  );
}
