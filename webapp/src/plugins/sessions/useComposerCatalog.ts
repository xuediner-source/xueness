/**
 * The primary composer's scope: run choices (model, permission, browser,
 * remote), the workspace catalog for the draft root, and the slash-command
 * candidates for that workspace. Moved unchanged out of
 * XuenessWorkbenchContainer; effects keep their order.
 */
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t as tr, type useLocale } from "../../i18n";
import { listCommandCatalog, type XuenessPlugin } from "../../xuenessApi";
import { getRunChoices, mergeRunChoices, setRunChoices, type RunChoices } from "../../xuenessBridge";
import { emptyComposerCatalog, runtimeProfileFromSession, type ComposerCatalog } from "../../xuenessComposer";
import type { WorkbenchSession } from "../../xuenessWorkbench";
import { createComposerCatalogLoader, clearWorkspaceComposerCatalog } from './composerCatalogLifecycle';
import { readPersistedDraft } from "./composerDraftStore";
import { shouldPreservePersistedDefaultDraftScope } from "./workbenchDrafts";
import type { WorkbenchSettings } from "../settings/useWorkbenchSettings";

type ComposerCatalogInput = {
  activeId: string | null;
  activeIdRef: React.MutableRefObject<string | null>;
  session: WorkbenchSession | null;
  executingSessions: Set<string>;
  isPluginEffective: (id: string) => boolean;
  pluginCatalogReady: boolean;
  pluginCatalog: XuenessPlugin[];
  locale: ReturnType<typeof useLocale>;
  setRunError: (message: string) => void;
  settings: WorkbenchSettings;
};

export function useComposerCatalog({ activeId, activeIdRef, session, executingSessions, isPluginEffective, pluginCatalogReady, pluginCatalog, locale, setRunError, settings }: ComposerCatalogInput) {
  const { settingsHaveLoaded, settingsAvailable, settingsLoading, settingsError, settingsValues } = settings;
  const [choices, setChoices] = useState<RunChoices>(getRunChoices);
  const [composerCatalog, setComposerCatalog] = useState<ComposerCatalog>(emptyComposerCatalog);
  const [composerCatalogLoading, setComposerCatalogLoading] = useState(false);
  const [composerCatalogError, setComposerCatalogError] = useState("");
  const [draftRoot, setDraftRoot] = useState<string | undefined>();
  const [preserveDefaultDraftScope, setPreserveDefaultDraftScope] = useState(() =>
    shouldPreservePersistedDefaultDraftScope(readPersistedDraft('default', 'new-task')));
  const [isolatedWorkspace, setIsolatedWorkspace] = useState(false);
  const [composerRequests] = useState(() => createComposerCatalogLoader());
  const [composerRefreshTick, setComposerRefreshTick] = useState(0);
  const defaultModelChosen = useRef(false);
  const initialBrowserPreferenceLoaded = useRef(false);
  const loadedSessionChoices = useRef<string | null>(null);
  // 斜杠命令候选：与能力面板同源的 commands 资源。
  const [commandItems, setCommandItems] = useState<{ id: string; description?: string }[]>([]);

  // 斜杠命令候选取自 `xueness commands list` 的同一份合并清单：内建提示命令、文件命令与
  // 资源条目在后端一次汇合，被遮蔽或已停用的行不列出，所以界面不需要维护第二份命令名单。
  // 工作区决定内建命令能否出现（它们必须有写入目标），界面语言决定其描述文案。
  const commandRoot = session?.root ?? draftRoot ?? composerCatalog.root ?? "";
  const primaryPaneRoot = !activeId && preserveDefaultDraftScope ? '' : draftRoot ?? composerCatalog.root ?? '';
  useEffect(() => {
    if (!pluginCatalogReady || !isPluginEffective("commands")) {
      setCommandItems([]);
      return;
    }
    let settled = false;
    void (async () => {
      try {
        const rows = await listCommandCatalog(commandRoot || undefined, locale);
        if (settled) return;
        setCommandItems(rows.filter(row => !row.shadowed && row.enabled !== false)
          .map(row => ({ id: row.id, description: row.description })));
      } catch {
        if (!settled) setCommandItems([]);
      }
    })();
    return () => { settled = true; };
  }, [pluginCatalogReady, pluginCatalog, isPluginEffective, commandRoot, locale]);

  // Run-choice failures surface through this event (bridge dispatches it);
  // Native run choices are supplied by the composer toolbar.
  useEffect(() => {
    const onError = (event: Event) => {
      const message = (event as CustomEvent<{ message?: string }>).detail?.message;
      setRunError(message || tr("运行失败，请检查服务器配置与任务状态"));
    };
    window.addEventListener("xueness-run-error", onError);
    return () => window.removeEventListener("xueness-run-error", onError);
  }, []);

  const updateChoices = useCallback((patch: Partial<RunChoices>) => {
    const next = mergeRunChoices(getRunChoices(), patch);
    setRunChoices(next);
    setChoices(next);
    setRunError("");
  }, []);

  useEffect(() => {
    if (!isPluginEffective("skills") && choices.skill_catalog) updateChoices({ skill_catalog: false });
    if (!isPluginEffective("browser") && choices.browser) updateChoices({ browser: false });
  }, [choices.browser, choices.skill_catalog, isPluginEffective, updateChoices]);

  const refreshComposerCatalog = useCallback(async () => {
    if (!isPluginEffective("sessions")) {
      composerRequests.cancel();
      setComposerCatalog(emptyComposerCatalog);
      setComposerCatalogLoading(false);
      return;
    }
    setComposerCatalogError("");
    await composerRequests.load({ root: draftRoot, sessionId: activeId ?? undefined,
      onLoading: setComposerCatalogLoading,
      onCatalog: next => {
        setComposerCatalog(next);
        const current = getRunChoices();
        if (!defaultModelChosen.current && !current.provider_id && !next.models.some(model => model.id === "" && model.configured)) {
          const first = next.models.find(model => model.configured);
          if (first) updateChoices({ provider_id: first.id || undefined, model: undefined, reasoning_effort: undefined });
        }
        defaultModelChosen.current = true;
      },
      onError: reason => {
        setComposerCatalog(clearWorkspaceComposerCatalog);
        setComposerCatalogError(reason instanceof Error ? reason.message : String(reason));
      },
    });
  }, [activeId, draftRoot, isPluginEffective, updateChoices, composerRequests]);
  const selectProviderForCurrentRun = useCallback((id: string) => {
    updateChoices({ provider: "real", provider_id: id || undefined, model: undefined, reasoning_effort: undefined });
    void refreshComposerCatalog();
  }, [refreshComposerCatalog, updateChoices]);
  useEffect(() => { void refreshComposerCatalog(); return () => composerRequests.cancel(); }, [refreshComposerCatalog, composerRequests, composerRefreshTick]);
  useEffect(() => {
    if (!session || session.id !== activeId || executingSessions.has(session.id) || loadedSessionChoices.current === session.id) return;
    loadedSessionChoices.current = session.id;
    updateChoices({
      remote: session.remote_connection?.id,
      browser: session.browser_enabled === true && isPluginEffective("browser"),
      ...(session.model_selection ? {
        provider_id: session.model_selection.provider_id || undefined,
        model: session.model_selection.model || undefined,
        reasoning_effort: session.model_selection.reasoning_effort || undefined,
      } : {}),
      runtime_profile: runtimeProfileFromSession(session.runtime_profile),
      ...(session.permission_mode ? { permission_mode: session.permission_mode } : {}),
      mode: session.mode === "plan" ? "plan" : "build",
    });
  }, [session, activeId, executingSessions, updateChoices, isPluginEffective]);

  useEffect(() => {
    if (!settingsHaveLoaded.current || !settingsAvailable || settingsLoading || settingsError || initialBrowserPreferenceLoaded.current) return;
    initialBrowserPreferenceLoaded.current = true;
    if (!activeIdRef.current) updateChoices({ browser: settingsValues.browserControlEnabled === true && isPluginEffective("browser") });
  }, [settingsAvailable, settingsLoading, settingsError, settingsValues.browserControlEnabled, isPluginEffective, updateChoices]);

  return {
    choices, setChoices, updateChoices, composerCatalog, setComposerCatalog, composerCatalogLoading, setComposerCatalogLoading,
    composerCatalogError, composerRequests, setComposerRefreshTick, loadedSessionChoices, refreshComposerCatalog, selectProviderForCurrentRun,
    draftRoot, setDraftRoot, preserveDefaultDraftScope, setPreserveDefaultDraftScope, isolatedWorkspace, setIsolatedWorkspace,
    commandRoot, primaryPaneRoot, commandItems,
  };
}

export type ComposerCatalogState = ReturnType<typeof useComposerCatalog>;
