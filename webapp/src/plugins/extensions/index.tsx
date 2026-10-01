import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Download,
  LoaderCircle,
  Package,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { installMarketplaceItem, listMarketplace, type MarketplaceItem } from "../../xuenessApi";
import { t as tr, tf } from "../../i18n";
import "../../styles/marketplace.css";

type MarketplaceFilter = "all" | "installed";
type FocusTarget = { isConnected?: boolean; focus(): void };

/** Keep keyboard behavior small and testable while the component owns DOM focus. */
export function trapMarketplaceDialogTab(
  event: { key: string; shiftKey: boolean; preventDefault(): void },
  activeElement: unknown,
  focusables: FocusTarget[],
  dialog: FocusTarget,
): void {
  if (event.key !== "Tab") return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (!first || !last) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  if (event.shiftKey && (activeElement === first || !focusables.includes(activeElement as FocusTarget))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (activeElement === last || !focusables.includes(activeElement as FocusTarget))) {
    event.preventDefault();
    first.focus();
  }
}

export function restoreMarketplaceDialogFocus(
  opener: FocusTarget | null,
  fallback: FocusTarget | null,
): void {
  if (opener?.isConnected !== false) {
    opener?.focus();
    if (opener) return;
  }
  if (fallback?.isConnected !== false) fallback?.focus();
}

export function shouldDismissMarketplaceDialogOnEscape(
  event: { key: string; isComposing?: boolean },
  busy: boolean,
): boolean {
  return event.key === "Escape" && !event.isComposing && !busy;
}

export function shouldDismissMarketplaceDialogOnBackdrop(
  target: unknown,
  backdrop: unknown,
  busy: boolean,
): boolean {
  return target === backdrop && !busy;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function manifestString(manifest: Record<string, unknown>, key: string): string | null {
  const value = manifest[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function manifestNumber(manifest: Record<string, unknown>, key: string): number | null {
  const value = manifest[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function manifestCapabilities(manifest: Record<string, unknown>): string[] {
  const value = manifest.capabilities;
  return Array.isArray(value) ? value.filter((capability): capability is string => typeof capability === "string") : [];
}

function isInstalled(item: MarketplaceItem): boolean {
  return Boolean(item.installedVersion);
}

function isUpdateAvailable(item: MarketplaceItem): boolean {
  if (!item.installedVersion) return false;
  const installed = item.installedVersion.match(/^(\d+)\.(\d+)\.(\d+)$/);
  const offered = item.version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!installed || !offered) return false;
  for (let index = 1; index <= 3; index += 1) {
    const installedPart = BigInt(installed[index]!);
    const offeredPart = BigInt(offered[index]!);
    if (offeredPart > installedPart) return true;
    if (offeredPart < installedPart) return false;
  }
  return false;
}

function isCurrentVersion(item: MarketplaceItem): boolean {
  return Boolean(item.installedVersion && item.installedVersion === item.version);
}

export function filterMarketplaceItems(
  items: MarketplaceItem[],
  filter: MarketplaceFilter,
  query: string,
): MarketplaceItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  return items.filter(item =>
    (filter === "all" || isInstalled(item)) && matchesSearch(item, normalizedQuery),
  );
}

function matchesSearch(item: MarketplaceItem, query: string): boolean {
  if (!query) return true;
  const searchText = [
    item.id,
    item.name,
    item.description,
    item.version,
    item.installedVersion ?? "",
    item.source,
    manifestString(item.manifest, "builtin") ?? "",
    ...manifestCapabilities(item.manifest),
  ].join(" ").toLowerCase();
  return searchText.includes(query);
}

export function MarketplaceCard({
  item,
  onOpen,
  onAction,
  busy,
}: {
  item: MarketplaceItem;
  onOpen: (item: MarketplaceItem, opener: HTMLButtonElement) => void;
  onAction: (item: MarketplaceItem, opener: HTMLButtonElement) => void;
  busy: boolean;
}): React.JSX.Element {
  const installed = isInstalled(item);
  const updateAvailable = isUpdateAvailable(item);
  const actionLabel = !installed ? tr("安装") : updateAvailable ? tr("更新") : isCurrentVersion(item) ? tr("已是最新版本") : tr("已安装");
  return <article className="xn-marketplace__card" data-testid="marketplace-card" data-plugin-id={item.id}>
    <button
      type="button"
      className="xn-marketplace__card-main"
      data-testid="marketplace-card-detail"
      data-plugin-id={item.id}
      onClick={event => onOpen(item, event.currentTarget)}
      aria-label={`${tr("详情")}：${item.name}`}
    >
      <span className="xn-marketplace__avatar" aria-hidden="true"><Package size={19} /></span>
      <span className="xn-marketplace__card-copy">
        <span className="xn-marketplace__card-title-row">
          <span className="xn-marketplace__card-title">{item.name}</span>
          <span className="xn-marketplace__version">v{item.version}</span>
          {installed && <span className="xn-marketplace__installed"><Check size={12} aria-hidden="true" />{tr("已安装")}</span>}
        </span>
        <span className="xn-marketplace__description">{item.description || item.id}</span>
        <span className="xn-marketplace__source"><span>{tr("来源")}</span><code>{item.source}</code></span>
      </span>
      <ChevronRight className="xn-marketplace__card-chevron" size={16} aria-hidden="true" />
    </button>
    <div className="xn-marketplace__card-action">
      <button
        type="button"
        className={`xn-marketplace__action${installed && !updateAvailable ? " is-current" : ""}`}
        data-testid="marketplace-install"
        data-plugin-id={item.id}
        disabled={busy || (installed && !updateAvailable)}
        onClick={event => onAction(item, event.currentTarget)}
      >
        {busy ? <LoaderCircle size={14} className="is-spinning" aria-hidden="true" /> : updateAvailable ? <RefreshCw size={14} aria-hidden="true" /> : !installed ? <Download size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
        {busy ? tr("处理中…") : actionLabel}
      </button>
    </div>
  </article>;
}

export function MarketplaceDetail({
  item,
  busy,
  onBack,
  onAction,
}: {
  item: MarketplaceItem;
  busy: boolean;
  onBack: () => void;
  onAction: (item: MarketplaceItem, opener: HTMLButtonElement) => void;
}): React.JSX.Element {
  const installed = isInstalled(item);
  const updateAvailable = isUpdateAvailable(item);
  const adapter = manifestString(item.manifest, "builtin");
  const apiVersion = manifestNumber(item.manifest, "apiVersion");
  const capabilities = manifestCapabilities(item.manifest);
  const actionLabel = !installed ? tr("安装") : updateAvailable ? tr("更新") : isCurrentVersion(item) ? tr("已是最新版本") : tr("已安装");
  return <div className="xn-marketplace__detail" data-testid="marketplace-detail" data-plugin-id={item.id}>
    <button type="button" className="xn-marketplace__back" data-testid="marketplace-back" onClick={onBack}>
      <ArrowLeft size={15} aria-hidden="true" />{tr("返回市场")}
    </button>
    <div className="xn-marketplace__detail-heading">
      <span className="xn-marketplace__avatar xn-marketplace__avatar--large" aria-hidden="true"><Package size={25} /></span>
      <div className="xn-marketplace__detail-copy">
        <div className="xn-marketplace__detail-title-row">
          <h2>{item.name}</h2>
          <span className="xn-marketplace__version">v{item.version}</span>
          {installed && <span className="xn-marketplace__installed"><Check size={12} aria-hidden="true" />{tr("已安装")}</span>}
        </div>
        <p>{item.description || item.id}</p>
        <div className="xn-marketplace__detail-source"><span>{tr("来源")}</span><code>{item.source}</code></div>
      </div>
      <button
        type="button"
        className={`xn-marketplace__action xn-marketplace__action--detail${installed && !updateAvailable ? " is-current" : ""}`}
        data-testid="marketplace-detail-install"
        disabled={busy || (installed && !updateAvailable)}
        onClick={event => onAction(item, event.currentTarget)}
      >
        {busy ? <LoaderCircle size={14} className="is-spinning" aria-hidden="true" /> : updateAvailable ? <RefreshCw size={14} aria-hidden="true" /> : !installed ? <Download size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
        {busy ? tr("处理中…") : actionLabel}
      </button>
    </div>
    <section className="xn-marketplace__manifest" aria-labelledby="marketplace-manifest-heading">
      <div className="xn-marketplace__section-heading">
        <h3 id="marketplace-manifest-heading">{tr("清单详情")}</h3>
        <span><ShieldCheck size={14} aria-hidden="true" />{tr("安全数据清单")}</span>
      </div>
      <dl className="xn-marketplace__facts">
        <div><dt>ID</dt><dd><code>{item.id}</code></dd></div>
        <div><dt>{tr("清单版本")}</dt><dd>{item.version}</dd></div>
        {item.installedVersion && <div><dt>{tr("已安装版本")}</dt><dd>{item.installedVersion}</dd></div>}
        {adapter && <div><dt>{tr("适配器")}</dt><dd>{adapter}</dd></div>}
        {apiVersion !== null && <div><dt>{tr("API 版本")}</dt><dd>{apiVersion}</dd></div>}
        <div className="xn-marketplace__fact-wide"><dt>{tr("所需能力")}</dt><dd>{capabilities.length ? capabilities.map(capability => <span className="xn-marketplace__capability" key={capability}>{capability}</span>) : <span className="xn-marketplace__muted">{tr("无额外能力")}</span>}</dd></div>
        <div className="xn-marketplace__fact-wide"><dt>SHA-256</dt><dd><code className="xn-marketplace__digest">{item.sha256}</code></dd></div>
      </dl>
    </section>
    <p className="xn-marketplace__safety"><ShieldCheck size={15} aria-hidden="true" /><span>{tr("安装后默认停用；启用仍受主机策略控制。")} {tr("安装仅写入数据清单，不执行下载的代码。")}</span></p>
  </div>;
}

export function XuenessMarketplace({ onInstalled }: { onInstalled?: () => void }): React.JSX.Element {
  const [items, setItems] = useState<MarketplaceItem[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MarketplaceFilter>("all");
  const [detail, setDetail] = useState<MarketplaceItem | null>(null);
  const [confirm, setConfirm] = useState<MarketplaceItem | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const detailOpenerRef = useRef<FocusTarget | null>(null);
  const dialogOpenerRef = useRef<FocusTarget | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const dialogTitleId = useId();
  const dialogDescriptionId = useId();

  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      setItems((await listMarketplace()).marketplace);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const confirmingId = confirm?.id;
  useEffect(() => {
    if (!confirmingId) return;
    const opener = dialogOpenerRef.current;
    const focusFrame = window.requestAnimationFrame(() => cancelRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (shouldDismissMarketplaceDialogOnEscape(event, busyRef.current === confirmingId)) {
        event.preventDefault();
        setConfirm(null);
        return;
      }
      const dialog = dialogRef.current;
      if (!dialog || event.key !== "Tab") return;
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter(element => element.getAttribute("aria-hidden") !== "true");
      trapMarketplaceDialogTab(event, document.activeElement, focusables, dialog);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown, true);
      window.requestAnimationFrame(() => restoreMarketplaceDialogFocus(opener, searchRef.current));
    };
  }, [confirmingId]);

  const installedCount = useMemo(() => items.filter(isInstalled).length, [items]);
  const visibleItems = useMemo(() => filterMarketplaceItems(items, filter, query), [filter, items, query]);

  const openDetail = (item: MarketplaceItem, opener: HTMLButtonElement) => {
    detailOpenerRef.current = opener;
    setDetail(item);
  };
  const backToList = () => {
    setDetail(null);
    window.requestAnimationFrame(() => restoreMarketplaceDialogFocus(detailOpenerRef.current, searchRef.current));
  };
  const openConfirm = (item: MarketplaceItem, opener: HTMLButtonElement) => {
    dialogOpenerRef.current = opener;
    setError("");
    setConfirm(item);
  };
  const submit = async () => {
    if (!confirm) return;
    const item = confirm;
    setBusy(item.id);
    setError("");
    try {
      const result = await installMarketplaceItem(item.id, item.sha256, Boolean(item.installedVersion));
      setItems(result.marketplace);
      setDetail(current => current?.id === item.id ? result.marketplace.find(candidate => candidate.id === item.id) ?? current : current);
      setConfirm(null);
      onInstalled?.();
    } catch (e) {
      const message = errorText(e);
      setError(message);
      setConfirm(null);
      try {
        const refreshed = await listMarketplace();
        setItems(refreshed.marketplace);
      } catch {
        // Preserve the action error when the best-effort catalog refresh also fails.
      }
    } finally {
      setBusy("");
    }
  };

  const detailItem = detail ? items.find(item => item.id === detail.id) ?? detail : null;
  const visibleCountLabel = tf("显示 {0} 个扩展", [visibleItems.length]);
  return <section className="xn-marketplace" data-testid="marketplace-panel">
    <header className="xn-marketplace__header">
      <div>
        <h3>{tr("扩展市场")}</h3>
        <p>{tr("浏览由主机信任目录提供的功能清单。安装仅写入数据清单，不执行下载的代码。")}</p>
      </div>
      <button type="button" className="xn-marketplace__refresh" disabled={loading} onClick={() => void refresh()}>
        {loading ? <LoaderCircle size={14} className="is-spinning" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}{tr("刷新")}
      </button>
    </header>
    {error && <p className="xn-marketplace__error" role="alert">{tr("市场操作失败：")}{error}</p>}

    {detailItem ? <MarketplaceDetail item={detailItem} busy={busy === detailItem.id} onBack={backToList} onAction={openConfirm} /> : <>
      <div className="xn-marketplace__toolbar">
        <label className="xn-marketplace__search">
          <Search size={15} aria-hidden="true" />
          <span className="xn-marketplace__visually-hidden">{tr("搜索扩展名称、ID 或说明")}</span>
          <input
            ref={searchRef}
            data-testid="marketplace-search"
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={tr("搜索扩展名称、ID 或说明")}
          />
        </label>
        <div className="xn-marketplace__filters" role="group" aria-label={tr("筛选扩展")}>
          <button type="button" data-testid="marketplace-filter-all" aria-pressed={filter === "all"} className={filter === "all" ? "is-selected" : ""} onClick={() => setFilter("all")}>
            {tr("全部")}<span>{items.length}</span>
          </button>
          <button type="button" data-testid="marketplace-filter-installed" aria-pressed={filter === "installed"} className={filter === "installed" ? "is-selected" : ""} onClick={() => setFilter("installed")}>
            {tr("已安装")}<span>{installedCount}</span>
          </button>
        </div>
        <span className="xn-marketplace__count" aria-live="polite">{visibleCountLabel}</span>
      </div>
      {loading && items.length === 0 ? <div className="xn-marketplace__empty" role="status"><LoaderCircle size={17} className="is-spinning" aria-hidden="true" />{tr("正在加载市场清单…")}</div> : visibleItems.length === 0 ? <div className="xn-marketplace__empty" data-testid="marketplace-empty">
        {items.length === 0 ? tr("市场中暂无可用扩展。") : tr("没有符合条件的扩展。")}
      </div> : <div className="xn-marketplace__grid" data-testid="marketplace-list">
        {visibleItems.map(item => <MarketplaceCard key={item.id} item={item} busy={busy === item.id} onOpen={openDetail} onAction={openConfirm} />)}
      </div>}
    </>}

    {confirm && <div
      className="xn-marketplace__backdrop"
      data-testid="marketplace-confirm-backdrop"
      onClick={event => { if (shouldDismissMarketplaceDialogOnBackdrop(event.target, event.currentTarget, busy === confirm.id)) setConfirm(null); }}
    >
      <section
        ref={dialogRef}
        className="xn-marketplace__dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={dialogTitleId}
        aria-describedby={dialogDescriptionId}
        tabIndex={-1}
        data-testid="marketplace-confirm-dialog"
      >
        <div className="xn-marketplace__dialog-icon"><ShieldCheck size={19} aria-hidden="true" /></div>
        <div className="xn-marketplace__dialog-copy">
          <h3 id={dialogTitleId}>{confirm.installedVersion ? tr("确认更新") : tr("确认安装")}</h3>
          <p id={dialogDescriptionId}>{confirm.name} · {tr("将核对目录摘要并安装安全清单。不会载入或执行外部代码。")}</p>
          {error && <p className="xn-marketplace__error" role="alert">{tr("市场操作失败：")}{error}</p>}
          <code className="xn-marketplace__dialog-digest">{confirm.id} · {confirm.version} · SHA-256 {confirm.sha256}</code>
        </div>
        <div className="xn-marketplace__dialog-actions">
          <button ref={cancelRef} type="button" className="xn-marketplace__button-secondary" disabled={busy === confirm.id} onClick={() => setConfirm(null)}>{tr("取消")}</button>
          <button type="button" className="xn-marketplace__button-primary" disabled={busy === confirm.id} onClick={() => void submit()}>
            {busy === confirm.id ? <LoaderCircle size={14} className="is-spinning" aria-hidden="true" /> : null}{busy === confirm.id ? tr("正在安装…") : tr("确认")}
          </button>
        </div>
      </section>
    </div>}
  </section>;
}
