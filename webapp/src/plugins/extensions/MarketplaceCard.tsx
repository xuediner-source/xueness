import React from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Download,
  LoaderCircle,
  Package,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { MarketplaceItem } from "../../xuenessApi";
import { isImeComposingEvent } from "../../xuenessShortcutDisplay";
import { t as tr } from "../../i18n";

export type MarketplaceFilter = "all" | "installed";
export type FocusTarget = { isConnected?: boolean; focus(): void };

/** Local presentation copy applies only to the catalog shipped with this app. */
export function marketplaceDisplayCopy(item: MarketplaceItem): { name: string; description: string } {
  const bundled: Record<string, [string, string]> = {
    skills: ['技能', '用可复用的操作指南帮助模型完成特定任务。'],
    hooks: ['钩子', '在任务关键阶段执行你配置的自动化操作。'],
    mcp: ['MCP 连接器', '连接外部工具和服务，拓展任务能力。'],
    subagents: ['协作代理', '让多个代理分工处理任务，并汇总进度和结果。'],
    magpie: ['Magpie 模型网关', '原版 magpie 本机网关：统一管理 API 密钥、订阅登录账号与路由组，查看额度与用量，并在会话中使用它的模型。'],
    model_monitor: ['返回模型监测', '随会话显示请求型号与上游返回型号，判断一致或不同；不自动发送额外请求。'],
    tavern: ['酒馆', '导入 SillyTavern 兼容的角色卡与世界书，从角色设定开始一段角色扮演对话。'],
  };
  const kind = typeof item.manifest.builtin === 'string' ? item.manifest.builtin : '';
  const copy = (item.source === 'bundled' || item.delivery === 'official') && item.id === (kind === 'model_monitor' ? 'xueness-model-monitor' : `xueness-${kind}`) ? bundled[kind] : undefined;
  return copy ? { name: tr(copy[0]), description: tr(copy[1]) } : { name: item.name, description: item.description };
}

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
  event: {
    key: string;
    isComposing?: boolean;
    keyCode?: number;
    nativeEvent?: { isComposing?: boolean; keyCode?: number };
    compositionActive?: boolean;
  },
  busy: boolean,
): boolean {
  return event.key === "Escape" && !isImeComposingEvent(event) && !busy;
}

export function shouldDismissMarketplaceDialogOnBackdrop(
  target: unknown,
  backdrop: unknown,
  busy: boolean,
): boolean {
  return target === backdrop && !busy;
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

export function isInstalled(item: MarketplaceItem): boolean {
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
    ...Object.values(marketplaceDisplayCopy(item)),
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
  const copy = marketplaceDisplayCopy(item);
  const installed = isInstalled(item);
  const updateAvailable = isUpdateAvailable(item);
  const actionLabel = item.delivery === "official"
    ? !installed ? tr("下载并安装") : updateAvailable ? tr("更新插件") : tr("已安装")
    : !installed ? tr("安装清单") : updateAvailable ? tr("更新清单") : isCurrentVersion(item) ? tr("清单已是最新版本") : tr("清单已安装");
  const actionClass = installed && !updateAvailable ? " is-current" : " is-primary";
  return <article className="xn-marketplace__card" data-testid="marketplace-card" data-plugin-id={item.id}>
    <button
      type="button"
      className="xn-marketplace__card-main"
      data-testid="marketplace-card-detail"
      data-plugin-id={item.id}
      onClick={event => onOpen(item, event.currentTarget)}
      aria-label={`${tr("详情")}：${copy.name}`}
    >
      <span className="xn-marketplace__avatar" aria-hidden="true"><Package size={19} /></span>
      <span className="xn-marketplace__card-copy">
        <span className="xn-marketplace__card-title-row">
          <span className="xn-marketplace__card-title">{copy.name}</span>
          <span className="xn-marketplace__badge is-version">v{item.version}</span>
          {installed && <span className="xn-marketplace__badge is-installed"><Check size={11} aria-hidden="true" />{item.delivery === "official" ? tr("已安装") : tr("清单已安装")}</span>}
          {updateAvailable && <span className="xn-marketplace__badge is-update"><RefreshCw size={11} aria-hidden="true" />{tr("更新")}</span>}
        </span>
        <span className="xn-marketplace__description">{copy.description || item.id}</span>
        <span className="xn-marketplace__source"><span>{tr("来源")}</span><code>{item.source}</code></span>
      </span>
      <ChevronRight className="xn-marketplace__card-chevron" size={16} aria-hidden="true" />
    </button>
    <div className="xn-marketplace__card-action">
      <button
        type="button"
        className={`xn-marketplace__action${actionClass}`}
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
  const copy = marketplaceDisplayCopy(item);
  const installed = isInstalled(item);
  const updateAvailable = isUpdateAvailable(item);
  const adapter = manifestString(item.manifest, "builtin");
  const apiVersion = manifestNumber(item.manifest, "apiVersion");
  const capabilities = manifestCapabilities(item.manifest);
  const actionLabel = item.delivery === "official"
    ? !installed ? tr("下载并安装") : updateAvailable ? tr("更新插件") : tr("已安装")
    : !installed ? tr("安装清单") : updateAvailable ? tr("更新清单") : isCurrentVersion(item) ? tr("清单已是最新版本") : tr("清单已安装");
  const actionClass = installed && !updateAvailable ? " is-current" : " is-primary";
  return <div className="xn-marketplace__detail" data-testid="marketplace-detail" data-plugin-id={item.id}>
    <button type="button" className="xn-marketplace__back" data-testid="marketplace-back" onClick={onBack}>
      <ArrowLeft size={15} aria-hidden="true" />{tr("返回市场")}
    </button>
    <div className="xn-marketplace__detail-heading">
      <span className="xn-marketplace__avatar xn-marketplace__avatar--large" aria-hidden="true"><Package size={25} /></span>
      <div className="xn-marketplace__detail-copy">
        <div className="xn-marketplace__detail-title-row"><h2>{copy.name}</h2></div>
        <div className="xn-marketplace__detail-title-row">
          <span className="xn-marketplace__badge is-version">v{item.version}</span>
          {installed && <span className="xn-marketplace__badge is-installed"><Check size={11} aria-hidden="true" />{item.delivery === "official" ? tr("已安装") : tr("清单已安装")}</span>}
          {updateAvailable && <span className="xn-marketplace__badge is-update"><RefreshCw size={11} aria-hidden="true" />{tr("更新")}</span>}
        </div>
        <p>{copy.description || item.id}</p>
        <div className="xn-marketplace__detail-source"><span>{tr("来源")}</span><code>{item.source}</code></div>
      </div>
      <button
        type="button"
        className={`xn-marketplace__action xn-marketplace__action--detail${actionClass}`}
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
        <h3 id="marketplace-manifest-heading">{item.delivery === "official" ? tr("插件详情") : tr("清单详情")}</h3>
        <span><ShieldCheck size={14} aria-hidden="true" />{item.delivery === "official" ? tr("官方 GitHub 插件") : tr("安全数据清单")}</span>
      </div>
      <dl className="xn-marketplace__facts">
        <div><dt>ID</dt><dd><code>{item.id}</code></dd></div>
        <div><dt>{tr("清单版本")}</dt><dd>{item.version}</dd></div>
        {item.installedVersion && <div><dt>{tr("已安装清单版本")}</dt><dd>{item.installedVersion}</dd></div>}
        {adapter && <div><dt>{tr("适配器")}</dt><dd>{adapter}</dd></div>}
        {apiVersion !== null && <div><dt>{tr("API 版本")}</dt><dd>{apiVersion}</dd></div>}
        <div className="xn-marketplace__fact-wide"><dt>{tr("所需能力")}</dt><dd>{capabilities.length ? capabilities.map(capability => <span className="xn-marketplace__capability" key={capability}>{capability}</span>) : <span className="xn-marketplace__muted">{tr("无额外能力")}</span>}</dd></div>
        <div className="xn-marketplace__fact-wide"><dt>SHA-256</dt><dd><code className="xn-marketplace__digest">{item.sha256}</code></dd></div>
      </dl>
    </section>
    <p className="xn-marketplace__safety"><ShieldCheck size={15} aria-hidden="true" /><span>{tr("安装后默认停用；启用仍受主机策略控制。")} {item.delivery === "official" ? tr("从 GitHub 下载，经校验后安装；在插件管理中启用即可使用。") : tr("安装仅写入数据清单，不执行下载的代码。")}</span></p>
  </div>;
}
