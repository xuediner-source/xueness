import React, { useMemo, useState } from "react";
import { t as tr, tf, useLocale } from "./i18n";
import type { XuenessPlugin, XuenessPluginFeature } from "./xuenessApi";
import { XUENESS_PLUGIN_REGISTRY } from "./xuenessPluginRegistry";
import "./styles/plugins.css";

export type XuenessPluginManagerProps = {
  plugins: XuenessPlugin[];
  loading: boolean;
  error: string;
  onRefresh: () => Promise<void>;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
};

export type PluginFilter = "all" | "active" | "disabled" | "blocked";

function pluginFeatures(plugin: XuenessPlugin): XuenessPluginFeature[] {
  return Array.isArray(plugin.features) ? plugin.features : [];
}

function pluginTools(plugin: XuenessPlugin): string[] {
  return Array.isArray(plugin.tools) ? plugin.tools : [];
}

function pluginCommands(plugin: XuenessPlugin): string[] {
  return Array.isArray(plugin.commands) ? plugin.commands : [];
}

function featureSearchTerms(plugin: XuenessPlugin): string[] {
  return [
    ...pluginFeatures(plugin).flatMap((feature) => [feature.id, feature.name, feature.nameEn || ""]),
    ...pluginTools(plugin),
    ...pluginCommands(plugin),
  ];
}

function matchesFeatureDetails(plugin: XuenessPlugin, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return Boolean(needle) && featureSearchTerms(plugin).some((term) => term.toLocaleLowerCase().includes(needle));
}

/** The primary Plugins destination always shows the installed runtime catalog.
 * Data manifests are a separate optional view, not the installed plugin list. */
export function XuenessPluginSettingsPanel({ resourceContent, onBrowse, ...managerProps }:
  XuenessPluginManagerProps & { resourceContent?: React.ReactNode; onBrowse?: () => void }) {
  const [view, setView] = useState<"installed" | "resources">("installed");
  return <section className="xn-plugin-settings" data-testid="xn-plugin-settings">
    <nav className="xn-plugin-settings__views" aria-label={tr("插件目录视图")}>
      <button type="button" aria-pressed={view === "installed"} onClick={() => setView("installed")}>
        {tr("已安装功能插件")}<span>{managerProps.plugins.length}</span>
      </button>
      <button type="button" aria-pressed={view === "resources"} onClick={() => setView("resources")}>
        {tr("资源清单")}
      </button>
      {onBrowse && <button type="button" className="xn-plugin-settings__browse" onClick={onBrowse}>{tr("浏览扩展市场")}</button>}
    </nav>
    {view === "installed" ? <XuenessPluginManager {...managerProps} /> : <div className="xn-plugin-settings__resources">
      {resourceContent ?? <p role="status">{tr("资源清单由扩展插件管理；启用扩展插件后可查看。")}</p>}
    </div>}
  </section>;
}

export function pluginState(plugin: XuenessPlugin): "active" | "disabled" | "blocked" | "unavailable" {
  if (plugin.effective) return "active";
  if (!plugin.enabled) return "disabled";
  if (plugin.blockedBy?.length) return "blocked";
  return "unavailable";
}

export function filterPlugins(plugins: XuenessPlugin[], filter: PluginFilter, query: string): XuenessPlugin[] {
  const needle = query.trim().toLocaleLowerCase();
  return plugins.filter((plugin) => {
    const state = pluginState(plugin);
    if (filter !== "all" && state !== filter) return false;
    if (!needle) return true;
    const local = XUENESS_PLUGIN_REGISTRY[plugin.id as keyof typeof XUENESS_PLUGIN_REGISTRY];
    return [plugin.id, plugin.name, plugin.description, ...(plugin.dependencies || []), ...(plugin.blockedBy || []),
      ...featureSearchTerms(plugin),
      ...(local ? [tr(local.name), tr(local.description)] : [])]
      .filter(Boolean).join(" ").toLocaleLowerCase().includes(needle);
  });
}

export function FeatureUnavailable({ feature, onManage }: { feature: string; onManage: () => void }) {
  return (
    <div className="xn-feature-unavailable" role="status">
      <h2>{tr("模块不可用：")}{feature}</h2>
      <p>{tr("此模块已停用或依赖未启用。可在插件管理中调整。")}</p>
      <button type="button" onClick={onManage}>{tr("打开插件管理")}</button>
    </div>
  );
}

export function XuenessPluginManager({ plugins, loading, error, onRefresh, onToggle }: XuenessPluginManagerProps) {
  const locale = useLocale();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PluginFilter>("all");

  const counts = useMemo(() => plugins.reduce((result, plugin) => {
    result.all += 1;
    result[pluginState(plugin)] += 1;
    return result;
  }, { all: 0, active: 0, disabled: 0, blocked: 0, unavailable: 0 }), [plugins]);
  const visiblePlugins = useMemo(() => filterPlugins(plugins, filter, query), [plugins, filter, query, locale]);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [detailsOverrides, setDetailsOverrides] = useState<Record<string, boolean>>({});
  const visibleHasDetails = visiblePlugins.some((plugin) =>
    pluginFeatures(plugin).length + pluginTools(plugin).length + pluginCommands(plugin).length > 0,
  );

  const toggleAllDetails = () => {
    setDetailsExpanded((expanded) => !expanded);
    setDetailsOverrides({});
  };

  const toggle = async (plugin: XuenessPlugin) => {
    setBusyId(plugin.id);
    setActionError("");
    try {
      await onToggle(plugin.id, !plugin.enabled);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="xn-plugins" aria-label={tr("插件管理")}>
      <header className="xn-plugins__header">
        <div>
          <h2>{tr("插件管理")}</h2>
          <p>{tr("启用或停用工作台模块。执行工具仍按每次运行的审批设置决定。")}</p>
        </div>
        <div className="xn-plugins__header-actions">
          {visibleHasDetails && <button
            type="button"
            className="xn-plugins__details-toggle"
            aria-pressed={detailsExpanded}
            onClick={toggleAllDetails}
          >{tr(detailsExpanded ? "折叠全部" : "展开全部")}</button>}
          <button type="button" className="xn-plugins__refresh" onClick={() => void onRefresh()} disabled={loading}>
            {loading ? tr("加载中…") : tr("刷新")}
          </button>
        </div>
      </header>
      {error && <p className="xn-plugins__error" role="alert">{tr("插件列表加载失败：")}{error}</p>}
      {actionError && <p className="xn-plugins__error" role="alert">{tr("插件设置失败：")}{actionError}</p>}
      {loading && plugins.length === 0 && <p className="xn-plugins__empty">{tr("正在加载插件…")}</p>}
      {!loading && !error && plugins.length === 0 && <p className="xn-plugins__empty">{tr("没有可用插件")}</p>}
      {plugins.length > 0 && <div className="xn-plugins__toolbar">
        <label className="xn-plugins__search">
          <span className="xn-visually-hidden">{tr("搜索插件名称、ID、功能、工具或命令…")}</span>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder={tr("搜索插件名称、ID、功能、工具或命令…")} />
        </label>
        <div className="xn-plugins__filters" role="group" aria-label={tr("插件状态筛选")}>
          {([
            ["all", "全部", counts.all],
            ["active", "生效中", counts.active],
            ["disabled", "已禁用", counts.disabled],
            ["blocked", "依赖阻塞", counts.blocked],
          ] as const).map(([value, label, count]) => <button type="button" key={value}
            className={filter === value ? "is-selected" : ""} aria-pressed={filter === value}
            onClick={() => setFilter(value)}>{tr(label)}<span>{count}</span></button>)}
        </div>
        <span className="xn-plugins__count" aria-live="polite">{tf("已显示 {0} / {1} 个插件", [visiblePlugins.length, plugins.length])}</span>
      </div>}
      {plugins.length > 0 && visiblePlugins.length === 0 && <p className="xn-plugins__empty">{tr("没有匹配的插件")}</p>}
      <div className="xn-plugins__list" role="list">
        {visiblePlugins.map((plugin) => {
          const local = XUENESS_PLUGIN_REGISTRY[plugin.id as keyof typeof XUENESS_PLUGIN_REGISTRY];
          const name = local ? tr(local.name) : plugin.name?.trim() || plugin.id;
          const description = local
            ? tr(local.description)
            : plugin.description?.trim() || tr("通用目录模块。没有专用工作台面板；不会载入服务器提供的远程界面或代码。");
          const blocked = plugin.blockedBy?.length ? plugin.blockedBy.join(", ") : "";
          const dependencies = plugin.dependencies?.length ? plugin.dependencies.join(", ") : "";
          const state = pluginState(plugin);
          const features = pluginFeatures(plugin);
          const tools = pluginTools(plugin);
          const commands = pluginCommands(plugin);
          const detailCount = features.length + tools.length + commands.length;
          return (
            <article className={`xn-plugin-card is-${state}`} key={plugin.id} data-testid={`xn-installed-plugin-${plugin.id}`} data-effective={plugin.effective} role="listitem">
              <div className="xn-plugin-card__content">
                <div className="xn-plugin-card__title-row">
                  <h3>{name}</h3>
                  {!local && <span className="xn-plugin-card__fallback">{tr("通用模块")}</span>}
                  <span className={`xn-plugin-card__state ${state === "active" ? "is-effective" : ""}`}>
                    {state === "active" ? tr("生效中") : state === "disabled" ? tr("已禁用") :
                      state === "blocked" ? tr("等待依赖") : tr("不可用")}
                  </span>
                </div>
                <p>{description}</p>
                <div className="xn-plugin-card__meta">
                  <code>{plugin.id}</code><span>v{plugin.version}</span>
                  {dependencies && <span>{tr("依赖：")}{dependencies}</span>}
                  {blocked && <span className="xn-plugin-card__blocked">{tr("依赖未启用：")}{blocked}</span>}
                </div>
                {detailCount > 0 && <details className="xn-plugin-card__details" data-testid={`xn-plugin-details-${plugin.id}`}
                  open={matchesFeatureDetails(plugin, query) || (detailsOverrides[plugin.id] ?? detailsExpanded)}>
                  <summary
                    onClick={(event) => {
                      // The native `toggle` event is deferred and also fires after
                      // controlled, programmatic changes. Only this user action
                      // should update per-card overrides.
                      event.preventDefault();
                      if (matchesFeatureDetails(plugin, query)) return;
                      setDetailsOverrides((current) => ({
                        ...current,
                        [plugin.id]: !(current[plugin.id] ?? detailsExpanded),
                      }));
                    }}
                    onKeyDown={(event) => {
                      // Keep native Enter/Space activation. During IME composition
                      // those keys commit text and must not toggle the disclosure.
                      if ((event.key === "Enter" || event.key === " ") &&
                        (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) {
                        event.preventDefault();
                      }
                    }}
                  >{tf("功能与接口（{0}）", [detailCount])}</summary>
                  <div className="xn-plugin-card__details-grid">
                    {features.length > 0 && <section>
                      <h4>{tr("插件功能")}</h4>
                      <ul>{features.map((feature) => <li key={feature.id}>
                        <code>{feature.id}</code>
                        <span>{locale === "en" ? feature.nameEn || feature.name : feature.name}</span>
                      </li>)}</ul>
                    </section>}
                    {tools.length > 0 && <section>
                      <h4>{tr("插件模型工具")}</h4>
                      <ul>{tools.map((tool) => <li key={tool}><code>{tool}</code></li>)}</ul>
                    </section>}
                    {commands.length > 0 && <section>
                      <h4>{tr("插件命令")}</h4>
                      <ul>{commands.map((command) => <li key={command}><code>{command}</code></li>)}</ul>
                    </section>}
                  </div>
                </details>}
              </div>
              <label className="xn-plugin-card__toggle">
                <span className="xn-visually-hidden">{plugin.enabled ? tr("已启用") : tr("已禁用")}</span>
                <input
                  type="checkbox"
                  aria-label={`${tr("启用插件")}: ${name}`}
                  aria-describedby={blocked ? `${plugin.id}-blocked` : undefined}
                  checked={plugin.enabled}
                  disabled={loading || busyId !== null}
                  onChange={() => void toggle(plugin)}
                />
              </label>
              {blocked && <span id={`${plugin.id}-blocked`} className="xn-visually-hidden">{tr("依赖未启用：")}{blocked}</span>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
