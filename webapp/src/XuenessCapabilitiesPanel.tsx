import { t as tr, tf } from './i18n';
import React from "react";
import {
  Bot,
  Cable,
  Puzzle,
  RefreshCw,
  Search,
  Terminal,
  Trash2,
  Upload,
  WandSparkles,
  Workflow,
  X,
} from "lucide-react";
import { Badge } from "./ui/primitives";
import {
  CAPABILITY_LABELS,
  type CapabilityItem,
  type CapabilityKind,
  parsePluginManifestImport,
} from "./xuenessCapabilities";
import "./styles/resources-parity.css";

type CapabilityImportResult = { ok: true; value: CapabilityItem } | { ok: false; error: string };

/**
 * Presentational view of the real resource catalog. The container owns IO and
 * passes handlers only for operations that the current backend/plugin allows.
 * Search, scope labeling and grouping here never fabricate a backing source.
 */
export type CapabilitySectionProps = {
  kind: CapabilityKind;
  label: string;
  items: CapabilityItem[];
  loading?: boolean;
  error?: string;
  userScopeAvailable?: boolean;
  userScopeReason?: string;
  /** Internal list-search behavior: matched lists omit empty group content. */
  hideEmpty?: boolean;
  busyId?: string | null;
  onToggle?: (kind: CapabilityKind, item: CapabilityItem, next: boolean) => void;
  onCreate?: (kind: CapabilityKind) => void;
  onEdit?: (kind: CapabilityKind, item: CapabilityItem) => void;
  onDelete?: (kind: CapabilityKind, item: CapabilityItem) => void;
};

const KIND_ORDER: CapabilityKind[] = ["skills", "commands", "subagents", "mcp", "hooks", "plugins"];

function resourceName(item: CapabilityItem): string {
  const value = item.extra?.name;
  return typeof value === "string" && value.trim() ? value.trim() : item.id;
}

/** Display only user-authored, non-secret summary fields; never stringify config. */
function hasForbiddenPluginCode(item: CapabilityItem): boolean {
  return Boolean(item.command || item.extra?.entrypoint);
}

function resourceDescription(kind: CapabilityKind, item: CapabilityItem): string {
  if (kind === "plugins" && hasForbiddenPluginCode(item)) return tr("清单含有被拒绝的可执行字段，请删除后重新导入数据清单");
  if (typeof item.description === "string" && item.description.trim()) return item.description.trim();
  if (item.event || item.command) {
    const event = item.event?.trim();
    const command = item.command?.trim();
    return [event, command].filter(Boolean).join(" · ");
  }
  return "";
}

function resourceSearchText(kind: CapabilityKind, item: CapabilityItem): string {
  return [item.id, resourceName(item), resourceDescription(kind, item)].join(" ").toLocaleLowerCase();
}

function KindIcon({ kind }: { kind: CapabilityKind }): React.JSX.Element {
  const props = { size: 17, strokeWidth: 1.7, "aria-hidden": true as const };
  switch (kind) {
    case "skills": return <WandSparkles {...props} />;
    case "commands": return <Terminal {...props} />;
    case "subagents": return <Bot {...props} />;
    case "mcp": return <Cable {...props} />;
    case "hooks": return <Workflow {...props} />;
    case "plugins": return <Puzzle {...props} />;
  }
}

function ItemRow({
  kind,
  item,
  busy,
  onToggle,
  onEdit,
  onDelete,
}: {
  kind: CapabilityKind;
  item: CapabilityItem;
  busy: boolean;
  onToggle?: CapabilitySectionProps["onToggle"];
  onEdit?: CapabilitySectionProps["onEdit"];
  onDelete?: CapabilitySectionProps["onDelete"];
}): React.JSX.Element {
  const name = resourceName(item);
  const description = resourceDescription(kind, item);
  const forbiddenPluginCode = kind === "plugins" && hasForbiddenPluginCode(item);
  const editLabel = tf("编辑 {0}", [name]);
  const rowContent = (
    <>
      <span className="xn-resource-item__icon" aria-hidden="true"><KindIcon kind={kind} /></span>
      <span className="xn-resource-item__copy">
        <span className="xn-resource-item__name">{name}</span>
        {description && <span className="xn-resource-item__description">{description}</span>}
      </span>
    </>
  );

  return (
    <li className="xn-resource-item" data-testid={`xn-cap-item-${kind}-${item.id}`}>
      <div className="xn-resource-item__main">
        {onEdit ? (
          <button
            type="button"
            className="xn-resource-item__edit"
            aria-label={editLabel}
            title={editLabel}
            disabled={busy}
            data-testid={`xn-cap-edit-${kind}-${item.id}`}
            onClick={() => onEdit(kind, item)}
          >
            {rowContent}
          </button>
        ) : (
          <div className="xn-resource-item__static">{rowContent}</div>
        )}
      </div>
      <div className="xn-resource-item__actions">
        {onDelete && (
          <button
            type="button"
            className="xn-resource-item__delete"
            aria-label={tf("删除 {0}", [name])}
            title={tf("删除 {0}", [name])}
            disabled={busy}
            data-testid={`xn-cap-delete-${kind}-${item.id}`}
            onClick={() => onDelete(kind, item)}
          >
            <Trash2 size={15} aria-hidden="true" />
          </button>
        )}
        {kind === "plugins" && (
          <Badge tone={forbiddenPluginCode ? "error" : item.enabled === true ? "ok" : "neutral"}>
            {forbiddenPluginCode ? tr("清单字段被拒绝") : item.enabled === true ? tr("清单已启用") : tr("清单已禁用")}
          </Badge>
        )}
        {onToggle ? (
          <button
            type="button"
            role="switch"
            aria-checked={item.enabled === true}
            aria-label={kind === "plugins"
              ? `${item.enabled === true ? tr("禁用插件清单") : tr("启用插件清单")} ${name}`
              : `${item.enabled === true ? tr("禁用") : tr("启用")} ${name}`}
            disabled={busy || Boolean(forbiddenPluginCode && item.enabled !== true)}
            data-testid={`xn-cap-toggle-${kind}-${item.id}`}
            className={`xn-cap-switch ${item.enabled === true ? "xn-cap-switch--on" : ""}`}
            onClick={() => onToggle(kind, item, item.enabled !== true)}
          >
            <span className="xn-cap-switch__knob" aria-hidden="true" />
          </button>
        ) : kind !== "plugins" ? (
          <Badge tone={item.enabled === true ? "ok" : "neutral"}>
            {item.enabled === true ? tr("已启用") : tr("已禁用")}
          </Badge>
        ) : null}
      </div>
    </li>
  );
}

export function CapabilitySection({
  kind,
  label,
  items,
  loading = false,
  error,
  userScopeAvailable = true,
  userScopeReason,
  hideEmpty = false,
  busyId = null,
  onToggle,
  onCreate,
  onEdit,
  onDelete,
}: CapabilitySectionProps): React.JSX.Element {
  return (
    <section className="xn-cap-section" data-testid={`xn-cap-section-${kind}`}>
      <header className="xn-cap-section__head">
        <span className="xn-cap-section__icon" aria-hidden="true"><KindIcon kind={kind} /></span>
        <h3 className="xn-cap-section__title">{label}</h3>
        <span className="xn-cap-section__count" data-testid={`xn-cap-count-${kind}`}>{items.length}</span>
        {userScopeAvailable && <span className="xn-cap-section__scope">{tr("用户级")}</span>}
        {onCreate && (
          <button
            type="button"
            className="xn-cap-section__create"
            data-testid={`xn-cap-create-${kind}`}
            onClick={() => onCreate(kind)}
          >
            <span aria-hidden="true">+</span>{tr("新建")}
          </button>
        )}
      </header>
      {error && <p role="alert" className="xn-cap-error">{error}</p>}
      {loading && !error && <p className="xn-cap-loading">{tr("加载中…")}</p>}
      {!loading && !error && items.length === 0 && !hideEmpty && (
        <div className="xn-cap-empty" data-testid={`xn-cap-empty-${kind}`}>
          <p className="xn-cap-empty__title">{kind === "plugins" ? tr("尚无插件清单") : tr("暂无配置")}</p>
          {kind === "plugins" && <p className="xn-cap-empty__hint">{tr("新建或导入符合 Xueness 内置适配器格式的数据清单。")}</p>}
          {userScopeAvailable === false && (
            <p className="xn-cap-empty__hint">
              {tr("用户级资源目录不可用")}{userScopeReason ? `：${userScopeReason}` : ""}
            </p>
          )}
          {onCreate && <button type="button" className="xn-cap-empty__create" onClick={() => onCreate(kind)}>{tr("新建")}</button>}
        </div>
      )}
      {items.length > 0 && (
        <ul className="xn-cap-list">
          {items.map((item) => (
            <ItemRow
              key={item.id}
              kind={kind}
              item={item}
              busy={busyId === item.id}
              onToggle={onToggle}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export type CapabilitiesPanelProps = {
  sections: CapabilitySectionProps[];
  /** The real backing scope label. Defaults to user scope because /api/resources is user-local. */
  scopeLabel?: string;
  searchPlaceholder?: string;
  /** Optional real resource-API import handler. No import affordance is shown without it. */
  onImportPlugin?: (item: { id: string; fields: Record<string, unknown> }) => void | CapabilityImportResult | Promise<void | CapabilityImportResult>;
  /** Navigate to the existing, trusted data-only marketplace surface. */
  onBrowsePlugins?: () => void;
  /** Refresh the backing resource catalog. */
  onRefreshPlugins?: () => void;
};

export function CapabilitiesPanel({
  sections,
  scopeLabel,
  searchPlaceholder,
  onImportPlugin,
  onBrowsePlugins,
  onRefreshPlugins,
}: CapabilitiesPanelProps): React.JSX.Element {
  const [query, setQuery] = React.useState("");
  const [importError, setImportError] = React.useState("");
  const [importBusy, setImportBusy] = React.useState(false);
  const importInput = React.useRef<HTMLInputElement>(null);
  const pluginSection = sections.find(section => section.kind === "plugins");
  const pluginOnly = sections.length === 1 && pluginSection?.kind === "plugins";
  const visibleScopeLabel = scopeLabel ?? (pluginOnly ? tr("用户") : tr("用户级资源"));
  const visibleSearchPlaceholder = searchPlaceholder ?? (pluginOnly ? tr("搜索插件...") : tr("搜索资源名称或描述"));
  const importPluginFile = async (file?: File) => {
    if (!file || !onImportPlugin) return;
    setImportError("");
    if (file.size > 256 * 1024) {
      setImportError(tr("插件清单不能超过 256 KiB"));
      return;
    }
    setImportBusy(true);
    try {
      const parsed = parsePluginManifestImport(await file.text());
      if (!parsed.ok) {
        setImportError(parsed.error);
        return;
      }
      if (pluginSection?.items.some(item => item.id === parsed.value.id)) {
        setImportError(tr("此插件 ID 已存在；请打开现有清单进行编辑"));
        return;
      }
      const result = await onImportPlugin(parsed.value);
      if (result && !result.ok) setImportError(result.error);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    } finally {
      setImportBusy(false);
      if (importInput.current) importInput.current.value = "";
    }
  };
  const needle = query.trim().toLocaleLowerCase();
  const visibleSections = [...sections]
    .sort((left, right) => KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind))
    .map((section) => ({
      ...section,
      items: needle ? section.items.filter((item) => `${section.label} ${resourceSearchText(section.kind, item)}`.toLocaleLowerCase().includes(needle)) : section.items,
    }));
  const hasMatch = visibleSections.some((section) => section.items.length > 0);
  const isLoading = visibleSections.some((section) => section.loading);
  const hasError = visibleSections.some((section) => Boolean(section.error));

  return (
    <div className="xn-cap-panel" data-testid="xn-cap-panel">
      <div className="xn-resource-toolbar">
        <span className="xn-resource-toolbar__scope" data-testid="xn-cap-scope">{visibleScopeLabel}</span>
        <label className="xn-resource-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder={visibleSearchPlaceholder}
            aria-label={visibleSearchPlaceholder}
            data-testid="xn-cap-search"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && <button type="button" aria-label={tr("清除搜索")} onClick={() => setQuery("")}><X size={14} /></button>}
        </label>
      </div>
      {pluginOnly && (onRefreshPlugins || onBrowsePlugins || onImportPlugin) && (
        <div className="xn-plugin-controls" data-testid="xn-plugin-controls">
          {onRefreshPlugins && <button type="button" className="xn-plugin-control" data-testid="xn-plugin-refresh" onClick={onRefreshPlugins}><RefreshCw size={14} aria-hidden="true" />{tr("刷新")}</button>}
          {onBrowsePlugins && <button type="button" className="xn-plugin-control" data-testid="xn-plugin-browse" onClick={onBrowsePlugins}><Puzzle size={14} aria-hidden="true" />{tr("浏览插件")}</button>}
          {onImportPlugin && (
            <>
              <input
                ref={importInput}
                type="file"
                accept="application/json,.json"
                className="xn-plugin-import__input"
                aria-label={tr("导入插件清单 JSON")}
                data-testid="xn-plugin-import-file"
                onChange={event => void importPluginFile(event.currentTarget.files?.[0])}
              />
              <button
                type="button"
                className="xn-plugin-control"
                disabled={importBusy}
                data-testid="xn-plugin-import"
                onClick={() => importInput.current?.click()}
              >
                <Upload size={14} aria-hidden="true" />{importBusy ? tr("导入中…") : tr("导入 JSON")}
              </button>
            </>
          )}
        </div>
      )}
      {pluginOnly && <p className="xn-plugin-resource-note">{tr("此处显示插件清单资源。清单仅参与 Xueness 内置能力校验，不代表外部插件代码已安装或加载。")}</p>}
      {importError && <p className="xn-cap-error xn-plugin-import__error" role="alert" data-testid="xn-plugin-import-error">{importError}</p>}
      {visibleSections.filter((section) => !needle || section.items.length > 0 || section.loading || Boolean(section.error)).map((section) => (
        <CapabilitySection key={section.kind} {...section} hideEmpty={Boolean(needle)} />
      ))}
      {needle && !hasMatch && !isLoading && !hasError && (
        <div className="xn-cap-search-empty" data-testid="xn-cap-search-empty">{tr("没有匹配的资源")}</div>
      )}
    </div>
  );
}
