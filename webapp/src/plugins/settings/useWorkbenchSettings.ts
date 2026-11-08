/**
 * Workbench settings: the loaded settings map, its serialized write queue, and
 * the document-level effects it drives (language, font size, tab size, word
 * wrap, reduced motion, theme, colour palette, app zoom). Moved unchanged out
 * of XuenessWorkbenchContainer.
 */
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { setLocale } from "../../i18n";
import type { XuenessPlugin } from "../../xuenessApi";
import { loadWorkbenchSettings, readAgentCapabilities, saveWorkbenchSettings, type AgentCapabilities, type SettingsMap } from "../../xuenessSettings";
import { settingsNavigation } from "../../xuenessSettingsNavigation";
import { applyDocumentTheme, applyDocumentColorPalette, applyDocumentMotion } from "./themeBoot";
import { useAppZoom } from "./workbenchShortcutActions";

/** Settings defaults. Capabilities default OFF and are read fail-closed. */
const SETTINGS_DEFAULTS: SettingsMap = {
  allowMcp: false,
  allowSubagents: false,
  allowHooks: false,
  subagentCancelOneEnabled: false,
  theme: "system",
  colorPalette: "xueness",
  fontSize: 14,
  tabSize: 2,
  wordWrap: true,
  autoScroll: true,
  showTodos: true,
  collapseTools: true,
  browserControlEnabled: false,
  sendShortcut: "enter",
  terminalFontSize: 13,
  toolGroupingExploreEnabled: true,
  toolGroupingTerminalEnabled: true,
  toolGroupingChangesEnabled: false,
  taskAutoArchiveEnabled: false,
  taskAutoArchiveOlderThanDays: 7,
  bindings: {},
};

type WorkbenchSettingsInput = {
  isPluginEffective: (id: string) => boolean;
  pluginEffectiveRef: React.MutableRefObject<(id: string) => boolean>;
  pluginCatalog: XuenessPlugin[];
  effectiveIds: Set<string>;
};

export function useWorkbenchSettings({ isPluginEffective, pluginEffectiveRef, pluginCatalog, effectiveIds }: WorkbenchSettingsInput) {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const settingsHaveLoaded = useRef(false);
  const [settingsValues, setSettingsValues] = useState<SettingsMap>(SETTINGS_DEFAULTS);
  const [systemDark, setSystemDark] = useState(() => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches));
  const [capabilities, setCapabilities] = useState<AgentCapabilities>({
    allowMcp: false,
    allowSubagents: false,
    allowHooks: false,
  });
  const [settingsError, setSettingsError] = useState("");
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsSection, setSettingsSection] = useState("general");
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);

  useEffect(() => {
    if (settingsValues.language === "zh" || settingsValues.language === "en") setLocale(settingsValues.language);
  }, [settingsValues.language]);

  useEffect(() => {
    document.documentElement.style.setProperty("--xn-ui-font-size", `${Math.min(24, Math.max(12, Number(settingsValues.fontSize) || 14))}px`);
    document.documentElement.dataset.xnTabSize = String([2, 4, 8].includes(Number(settingsValues.tabSize)) ? Number(settingsValues.tabSize) : 2);
    document.documentElement.dataset.xnWordWrap = settingsValues.wordWrap === false ? "off" : "on";
    if (settingsHaveLoaded.current && !settingsLoading) applyDocumentMotion(settingsValues.reduceMotion === true);
  }, [settingsValues.fontSize, settingsValues.tabSize, settingsValues.wordWrap, settingsValues.reduceMotion, settingsLoading]);

  useEffect(() => {
    if (!settingsHaveLoaded.current || settingsLoading) return;
    applyDocumentTheme(settingsValues.theme);
  }, [settingsValues.theme, settingsLoading]);

  useEffect(() => {
    if (!settingsHaveLoaded.current || settingsLoading || settingsValues.theme !== "system" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (event: MediaQueryListEvent | MediaQueryList) => {
      applyDocumentTheme(settingsValues.theme);
      setSystemDark(event.matches);
    };
    apply(query);
    query.addEventListener?.("change", apply);
    return () => query.removeEventListener?.("change", apply);
  }, [settingsValues.theme, settingsLoading]);

  useEffect(() => {
    if (!settingsHaveLoaded.current || settingsLoading) return;
    applyDocumentColorPalette(settingsValues.colorPalette);
  }, [settingsValues.colorPalette, settingsLoading]);

  const pendingSettings = useRef<SettingsMap>({});
  const settingsWriteQueue = useRef<Promise<void>>(Promise.resolve());
  const settingsWriteCount = useRef(0);
  const persistSettings = useCallback((patch: SettingsMap): Promise<void> => {
    Object.assign(pendingSettings.current, patch);
    settingsWriteCount.current += 1;
    setSettingsSaving(true);
    setSettingsDirty(true);
    const operation = settingsWriteQueue.current.then(async () => {
      if (!pluginEffectiveRef.current('settings')
        || ('sidebarPreferences' in patch && !pluginEffectiveRef.current('sessions'))) return;
      const result = await saveWorkbenchSettings(SETTINGS_DEFAULTS, patch);
      if (!mountedRef.current) return;
      if (result.ok) {
        for (const [key, value] of Object.entries(patch)) {
          if (JSON.stringify(pendingSettings.current[key]) === JSON.stringify(value)) delete pendingSettings.current[key];
        }
        if (Object.keys(pendingSettings.current).length === 0) setSettingsError("");
      } else setSettingsError(result.error);
    }).finally(() => {
      if (!mountedRef.current) return;
      settingsWriteCount.current -= 1;
      setSettingsSaving(settingsWriteCount.current > 0);
      setSettingsDirty(Object.keys(pendingSettings.current).length > 0);
    });
    settingsWriteQueue.current = operation.catch(reason => {
      if (mountedRef.current) setSettingsError(String(reason));
    });
    return settingsWriteQueue.current;
  }, []);

  const handleToggleCapability = useCallback((key: keyof AgentCapabilities, value: boolean) => {
    setCapabilities(prev => ({ ...prev, [key]: value }));
    setSettingsValues(prev => ({ ...prev, [key]: value }));
    void persistSettings({ [key]: value });
  }, [persistSettings]);

  const handleUpdateSetting = useCallback((key: string, value: unknown) => {
    setSettingsValues(prev => ({ ...prev, [key]: value }));
    return persistSettings({ [key]: value });
  }, [persistSettings]);

  useAppZoom(isPluginEffective("settings"), settingsValues.appZoom);

  const handleSaveSettings = useCallback(() => persistSettings({ ...pendingSettings.current }), [persistSettings]);

  // The whole settings map is loaded (all five sections), not just capabilities:
  // the settings view renders sections the agent-only read never returned.
  const handleLoadAllSettings = useCallback(async () => {
    setSettingsLoading(true);
    const res = await loadWorkbenchSettings(SETTINGS_DEFAULTS);
    if (!mountedRef.current) return;
    setSettingsLoading(false);
    if (res.ok) {
      setSettingsValues(res.value);
      setCapabilities(readAgentCapabilities(res.value));
      setSettingsError("");
      settingsHaveLoaded.current = true;
    } else {
      setSettingsError(res.error);
    }
  }, []);

  const settingsAvailable = isPluginEffective("settings");
  useEffect(() => {
    // Appearance and shortcuts affect the whole workbench, so load them as soon
    // as the settings plugin is available rather than waiting for its panel to
    // open. The catalog gate keeps disabled settings endpoints untouched.
    if (settingsAvailable) void handleLoadAllSettings();
  }, [settingsAvailable, handleLoadAllSettings]);

  const settingsSections = settingsNavigation(effectiveIds, new Set(pluginCatalog.map(plugin => plugin.id)));
  const settingsSectionIds = settingsSections.map(section => section.id).join(",");
  useEffect(() => {
    if (!settingsSections.some(section => section.id === settingsSection)) setSettingsSection(settingsSections[0]?.id ?? "general");
  }, [settingsSectionIds, settingsSection]);

  const shortcutBindings = (settingsValues.bindings && typeof settingsValues.bindings === "object" ? settingsValues.bindings : {}) as Record<string, string>;
  const darkTheme = String(settingsValues.theme) === "dark" || (settingsValues.theme === "system" && systemDark);

  return {
    settingsValues, setSettingsValues, capabilities, settingsError, settingsDirty, settingsSection, setSettingsSection,
    settingsLoading, settingsSaving, settingsHaveLoaded, settingsAvailable, settingsSections, shortcutBindings, darkTheme,
    handleToggleCapability, handleUpdateSetting, handleSaveSettings, handleLoadAllSettings,
  };
}

export type WorkbenchSettings = ReturnType<typeof useWorkbenchSettings>;
