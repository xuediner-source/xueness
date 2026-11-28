import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  LoaderCircle,
  Package,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { installMarketplaceItem, listMarketplace, type MarketplaceItem } from "../../xuenessApi";
import { t as tr, tf } from "../../i18n";
import {
  filterMarketplaceItems,
  isInstalled,
  MarketplaceCard,
  MarketplaceDetail,
  marketplaceDisplayCopy,
  restoreMarketplaceDialogFocus,
  shouldDismissMarketplaceDialogOnBackdrop,
  shouldDismissMarketplaceDialogOnEscape,
  trapMarketplaceDialogTab,
  type FocusTarget,
  type MarketplaceFilter,
} from "./MarketplaceCard";
import "../../styles/marketplace.css";

export {
  filterMarketplaceItems,
  MarketplaceCard,
  MarketplaceDetail,
  marketplaceDisplayCopy,
  restoreMarketplaceDialogFocus,
  shouldDismissMarketplaceDialogOnBackdrop,
  shouldDismissMarketplaceDialogOnEscape,
  trapMarketplaceDialogTab,
} from "./MarketplaceCard";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `embedded`: inside a settings page that already shows the title, so only the note and actions remain. */
export function XuenessMarketplace({ onInstalled, onManagePlugins, embedded = false }: { onInstalled?: () => void; onManagePlugins?: () => void; embedded?: boolean }): React.JSX.Element {
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
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await listMarketplace();
      if (!mountedRef.current) return;
      setItems(res.marketplace);
    } catch (e) {
      if (mountedRef.current) setError(errorText(e));
    } finally {
      if (mountedRef.current) setLoading(false);
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
        event.stopPropagation();
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
      if (!mountedRef.current) return;
      setItems(result.marketplace);
      setDetail(current => current?.id === item.id ? result.marketplace.find(candidate => candidate.id === item.id) ?? current : current);
      setConfirm(null);
      onInstalled?.();
    } catch (e) {
      if (!mountedRef.current) return;
      const message = errorText(e);
      setError(message);
      setConfirm(null);
      try {
        const refreshed = await listMarketplace();
        if (mountedRef.current) setItems(refreshed.marketplace);
      } catch {
        // Preserve the action error when the best-effort catalog refresh also fails.
      }
    } finally {
      if (mountedRef.current) setBusy("");
    }
  };

  const detailItem = detail ? items.find(item => item.id === detail.id) ?? detail : null;
  const visibleCountLabel = tf("显示 {0} 个扩展", [visibleItems.length]);
  return <section className="xn-marketplace" data-testid="marketplace-panel" data-embedded={embedded || undefined}>
    <header className="xn-marketplace__header">
      <div className="xn-marketplace__title">
        {!embedded && <><h3>{tr("扩展市场")}</h3>
        <p>{tr("浏览可安装的扩展，在详情中查看能力和使用说明。")}</p></>}
        <p className="xn-marketplace__status-note">{tr("发现可选插件，按需从 GitHub 下载。安装后前往插件管理启用，内置功能无需重复安装。")}</p>
      </div>
      <div className="xn-marketplace__header-actions">
        {onManagePlugins && <button type="button" className="xn-marketplace__refresh" onClick={onManagePlugins}>{tr('管理已安装插件')}</button>}
        <button type="button" className="xn-marketplace__refresh" disabled={loading} onClick={() => void refresh()}>
          {loading ? <LoaderCircle size={14} className="is-spinning" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}{tr("刷新")}
        </button>
      </div>
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
      {loading && items.length === 0 ? <div className="xn-marketplace__empty" role="status">
        <span className="xn-marketplace__empty-icon" aria-hidden="true"><LoaderCircle size={22} className="is-spinning" /></span>
        <h4>{tr("正在加载市场清单…")}</h4>
      </div> : visibleItems.length === 0 ? <div className="xn-marketplace__empty" data-testid="marketplace-empty">
        <span className="xn-marketplace__empty-icon" aria-hidden="true"><Package size={22} /></span>
        <h4>{items.length === 0 ? tr("市场中暂无可用扩展。") : tr("没有符合条件的扩展。")}</h4>
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
          <h3 id={dialogTitleId}>{confirm.delivery === "official" ? tr("下载安装插件") : confirm.installedVersion ? tr("确认更新清单") : tr("确认安装清单")}</h3>
          <p id={dialogDescriptionId}>{marketplaceDisplayCopy(confirm).name} · {confirm.delivery === "official" ? tr("将从官方 GitHub 下载插件并校验完整性。安装后默认停用。") : tr("将核对目录摘要并安装安全清单。不会载入或执行外部代码。")}</p>
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
