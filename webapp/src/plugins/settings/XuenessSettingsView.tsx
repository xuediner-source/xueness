import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlarmClock,
  Anchor,
  ArrowLeft,
  BarChart3,
  Blocks,
  Bot,
  Cable,
  Brain,
  CircleHelp,
  FolderOpen,
  Globe2,
  Keyboard,
  MoreHorizontal,
  Package,
  Palette,
  Search,
  Settings2,
  ShieldCheck,
  Store,
  Stethoscope,
  Terminal,
  WandSparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { t as tr } from "../../i18n";
import "../../styles/settings.css";

export type XuenessSettingsSection = {
  id: string;
  label: string;
  description: string;
  group?: string;
};

export type XuenessSettingsViewProps = {
  sections: XuenessSettingsSection[];
  activeSection: string;
  onSelect(sectionId: string): void;
  onBack?: () => void;
  children?: React.ReactNode;
  dirty?: boolean;
  saving?: boolean;
  onSave?: () => void | Promise<void>;
  error?: string;
  onRetry?: () => void | Promise<void>;
  loading?: boolean;
};

type SettingsGroup = {
  id: "basics" | "agentCapabilities" | "dataAndStats" | "extensions";
  label: string;
  sections: XuenessSettingsSection[];
};

const PRIMARY_GROUPS = [
  { id: "basics", label: "基础设置", sectionIds: ["general", "appearance", "providers", "browser", "network", "shortcuts"] },
  { id: "agentCapabilities", label: "Agent 能力", sectionIds: ["memory", "subagents", "plugins", "mcp", "skills", "commands", "hooks"] },
  { id: "dataAndStats", label: "数据与统计", sectionIds: ["usage"] },
] as const;

const ICONS: Record<string, LucideIcon> = {
  general: Settings2,
  appearance: Palette,
  providers: Package,
  browser: Globe2,
  network: Globe2,
  shortcuts: Keyboard,
  memory: Brain,
  subagents: Bot,
  plugins: Blocks,
  mcp: Cable,
  skills: WandSparkles,
  commands: Terminal,
  hooks: Anchor,
  usage: BarChart3,
  workspace: FolderOpen,
  agent: ShieldCheck,
  marketplace: Store,
  remote: Cable,
  automations: AlarmClock,
  diagnostics: Stethoscope,
};

export function groupSettingsSections(sections: XuenessSettingsSection[]): SettingsGroup[] {
  const assigned = new Set<string>();
  const groups: SettingsGroup[] = PRIMARY_GROUPS.map((group) => {
    const items = sections.filter((section) => group.sectionIds.includes(section.id as never));
    for (const section of items) assigned.add(section.id);
    return { id: group.id, label: tr(group.label), sections: items };
  }).filter((group) => group.sections.length > 0);

  const extensions = sections.filter((section) => !assigned.has(section.id));
  if (extensions.length) {
    groups.push({ id: "extensions", label: tr("扩展与维护"), sections: extensions });
  }
  return groups;
}

export function filterSettingsSections(
  sections: XuenessSettingsSection[],
  query: string,
): XuenessSettingsSection[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return sections;
  return sections.filter((section) =>
    [section.id, section.label, section.description]
      .some((term) => term.toLocaleLowerCase().includes(needle)),
  );
}

function SettingsSidebarButton({
  section,
  active,
  onClick,
}: {
  section: XuenessSettingsSection;
  active: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const Icon = ICONS[section.id] ?? CircleHelp;
  return (
    <button
      type="button"
      className="xn-settings-view__nav-item"
      aria-label={section.label}
      aria-current={active ? "page" : undefined}
      title={section.label}
      aria-controls="xn-settings-view-content"
      data-testid={`xn-settings-nav-${section.id}`}
      onClick={onClick}
    >
      <Icon className="xn-settings-view__nav-icon" size={16} strokeWidth={1.8} aria-hidden="true" />
      <span className="xn-settings-view__nav-label">{section.label}</span>
    </button>
  );
}

export function XuenessSettingsView({
  sections,
  activeSection,
  onSelect,
  onBack,
  children,
  saving = false,
  error,
  onRetry,
  loading = false,
}: XuenessSettingsViewProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const active = sections.find((section) => section.id === activeSection);
  const allGroups = useMemo(() => groupSettingsSections(sections), [sections]);
  const [search, setSearch] = useState("");
  const searchActive = Boolean(search.trim());
  const visibleSections = useMemo(() => filterSettingsSections(sections, search), [sections, search]);
  const groups = useMemo(() => groupSettingsSections(visibleSections), [visibleSections]);
  const hasActiveExtension = allGroups.some(
    (group) => group.id === "extensions" && group.sections.some((section) => section.id === activeSection),
  );
  const [extensionsExpanded, setExtensionsExpanded] = useState(hasActiveExtension);
  const selectSection = (sectionId: string) => {
    setSearch("");
    onSelect(sectionId);
  };

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    if (hasActiveExtension) setExtensionsExpanded(true);
  }, [activeSection, hasActiveExtension]);

  return (
    <section className={`xn-settings-view${activeSection === "plugins" ? " xn-settings-view--plugin-catalog" : ""}`} aria-label={tr("设置")} data-testid="xn-settings-view" data-searching={searchActive || undefined}>
      <aside className="xn-settings-view__sidebar">
        <div className="xn-settings-view__drag-space" aria-hidden="true" />
        {onBack && (
          <div className="xn-settings-view__back-wrap">
            <button
              type="button"
              className="xn-settings-view__back"
              aria-label={tr("返回工作区")}
              title={tr("返回工作区")}
              data-testid="xn-settings-back"
              onClick={onBack}
            >
              <ArrowLeft size={16} strokeWidth={1.8} aria-hidden="true" />
              <span>{tr("返回工作区")}</span>
            </button>
          </div>
        )}

        <div className="xn-settings-view__search">
          <label>
            <Search size={15} strokeWidth={1.8} aria-hidden="true" />
            <span className="xn-settings-view__visually-hidden">{tr("搜索设置")}</span>
            <input
              type="search"
              aria-label={tr("搜索设置")}
              aria-controls="xn-settings-nav-results"
              data-testid="xn-settings-search"
              value={search}
              placeholder={tr("搜索设置")}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          {search && (
            <button type="button" aria-label={tr("清除搜索")} title={tr("清除搜索")} onClick={() => setSearch("")}>
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>

        <nav className="xn-settings-view__nav" id="xn-settings-nav-results" aria-label={tr("设置分类")}>
          {groups.filter((group) => group.id !== "extensions").map((group, groupIndex) => (
            <div
              className={`xn-settings-view__nav-group${groupIndex > 0 ? " is-separated" : ""}`}
              key={group.id}
              role="group"
              aria-labelledby={`xn-settings-group-${group.id}`}
            >
              <h2 className="xn-settings-view__group-label" id={`xn-settings-group-${group.id}`}>
                {group.label}
              </h2>
              <ul>
                {group.sections.map((section) => (
                  <li key={section.id}>
                    <SettingsSidebarButton
                      section={section}
                      active={section.id === activeSection}
                      onClick={() => selectSection(section.id)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {groups.find((group) => group.id === "extensions") && (
            <details
              className="xn-settings-view__extensions"
              open={searchActive || extensionsExpanded}
              onToggle={(event) => { if (!searchActive) setExtensionsExpanded(event.currentTarget.open); }}
            >
              <summary aria-label={tr("扩展与维护")} title={tr("扩展与维护")}>
                <MoreHorizontal size={16} strokeWidth={1.8} aria-hidden="true" />
                <span>{tr("扩展与维护")}</span>
              </summary>
              <ul>
                {groups.find((group) => group.id === "extensions")?.sections.map((section) => (
                  <li key={section.id}>
                    <SettingsSidebarButton
                      section={section}
                      active={section.id === activeSection}
                      onClick={() => selectSection(section.id)}
                    />
                  </li>
                ))}
              </ul>
            </details>
          )}
          {searchActive && visibleSections.length === 0 && (
            <p className="xn-settings-view__search-empty" role="status" aria-live="polite">
              {tr("没有匹配的设置分类")}
            </p>
          )}
        </nav>
      </aside>

      <div className="xn-settings-view__main">
        <div className="xn-settings-view__topbar">
          <details className="xn-settings-help">
            <summary aria-label={tr("帮助")} title={tr("帮助")}><CircleHelp size={16} strokeWidth={1.5} /></summary>
            <div>{["shortcuts", "workspace", "providers"].map(id => {
              const section = sections.find(item => item.id === id);
              return section && <button key={id} type="button" onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); selectSection(id); }}>{section.label}</button>;
            })}</div>
          </details>
        </div>
        <main
          ref={scrollRef}
          className="xn-settings-view__scroll"
          id="xn-settings-view-content"
          aria-busy={loading}
        >
          <div className="xn-settings-view__frame">
            {active ? (
              <header className="xn-settings-view__header">
                <h1>{active.label}</h1>
                {saving && (
                  <span className="xn-settings-view__saving" role="status" aria-live="polite">
                    <span className="xn-settings-view__saving-mark" aria-hidden="true" />
                    {tr("正在保存")}
                  </span>
                )}
              </header>
            ) : null}

            {error && !loading && (
              <div className="xn-settings-view__error" role="alert">
                <span>{error}</span>
                {onRetry && (
                  <button type="button" onClick={() => void onRetry()}>
                    {tr("重试")}
                  </button>
                )}
              </div>
            )}

            {loading ? (
              <div className="xn-settings-view__loading" role="status" aria-live="polite">
                <span className="xn-settings-view__loading-mark" aria-hidden="true" />
                {tr("正在加载设置")}
              </div>
            ) : active ? (
              <div className="xn-settings-view__body" data-testid="xn-settings-section-content">
                {children}
              </div>
            ) : null}
          </div>
        </main>
      </div>
    </section>
  );
}
