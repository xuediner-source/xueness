import React from 'react';
import { ChevronRight, Cpu, LoaderCircle, Plus, Server, ShieldCheck } from 'lucide-react';
import type { ProviderSummary } from '../../xuenessApi';
import { t as tr } from '../../i18n';
import { ENVIRONMENT_KEY } from './providerDraft';

export function ModelProviderNavigation({
  providers,
  selectedKey,
  loading,
  busy,
  onSelect,
  onAdd,
}: {
  providers: ProviderSummary[];
  selectedKey: string;
  loading: boolean;
  busy: boolean;
  onSelect: (key: string) => void;
  onAdd: () => void;
}) {
  return <nav className="xn-provider-nav" aria-label={tr('模型服务商 (Providers)')} data-testid="model-provider-navigation">
    <div className="xn-provider-nav__group">
      <div className="xn-provider-nav__heading">{tr('内置')}</div>
      <button
        type="button"
        className="xn-provider-nav__item"
        data-state={selectedKey === ENVIRONMENT_KEY ? 'selected' : 'idle'}
        aria-current={selectedKey === ENVIRONMENT_KEY ? 'page' : undefined}
        aria-label={tr('环境模型')}
        title={tr('环境模型')}
        disabled={busy}
        onClick={() => onSelect(ENVIRONMENT_KEY)}
      >
        <Server size={16} aria-hidden="true" />
        <span className="xn-provider-nav__label">{tr('环境模型')}</span>
        {selectedKey === ENVIRONMENT_KEY && <ChevronRight size={14} className="xn-provider-nav__current" aria-hidden="true" />}
      </button>
    </div>
    <div className="xn-provider-nav__group xn-provider-nav__group--custom">
      <div className="xn-provider-nav__heading">
        <span>{tr('自定义')}</span>
        <span className="xn-provider-nav__count">{providers.length}</span>
      </div>
      {loading && providers.length === 0 && <div className="xn-provider-nav__loading"><LoaderCircle size={14} className="xn-provider-spin" />{tr('加载中…')}</div>}
      {providers.map(provider => <button
        type="button"
        key={provider.id}
        className="xn-provider-nav__item"
        data-state={selectedKey === provider.id ? 'selected' : 'idle'}
        aria-current={selectedKey === provider.id ? 'page' : undefined}
        aria-label={provider.name}
        title={`${provider.name} · ${provider.model}`}
        disabled={busy}
        onClick={() => onSelect(provider.id)}
      >
        <Cpu size={16} aria-hidden="true" />
        <span className="xn-provider-nav__provider-copy">
          <span className="xn-provider-nav__label">{provider.name}</span>
          <span className="xn-provider-nav__model">{provider.model}</span>
        </span>
        <span className="xn-provider-nav__key-indicator" data-configured={provider.hasKey} aria-label={provider.hasKey ? tr('已配置密钥') : tr('未配置密钥')} title={provider.hasKey ? tr('已配置密钥') : tr('未配置密钥')} />
      </button>)}
      {!loading && providers.length === 0 && <p className="xn-provider-nav__empty">{tr('添加第一个模型配置')}</p>}
      <button type="button" className="xn-provider-nav__add" title={tr('添加配置')} aria-label={tr('添加配置')} disabled={busy} onClick={onAdd}>
        <Plus size={15} aria-hidden="true" /><span>{tr('添加配置')}</span>
      </button>
    </div>
  </nav>;
}

/** In-repo model guide. The workbench origin does not serve `docs/`, so this is the public copy of that file. */
export const CUSTOM_MODEL_DOCS_HREF = 'https://github.com/xuediner-source/xueness/blob/main/docs/xueness-local-lightweight-mode.md';

/** Inline illustration for the empty custom-model list. No image asset. */
function CustomModelEmptyArt(): React.JSX.Element {
  return <svg className="xn-provider-empty__art" viewBox="0 0 160 112" aria-hidden="true">
    <rect x="28" y="22" width="104" height="70" rx="12" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <rect x="44" y="38" width="56" height="8" rx="4" fill="currentColor" opacity="0.35" />
    <rect x="44" y="54" width="36" height="6" rx="3" fill="currentColor" opacity="0.22" />
    <circle cx="112" cy="70" r="14" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M112 64v12M106 70h12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>;
}

/**
 * Empty custom-model list. Shown only when the saved-provider catalog is empty.
 * Both Add buttons call the same existing create flow; View Docs opens the repo guide.
 */
export function ProviderEmptyState({ onAdd, busy = false }: { onAdd: () => void; busy?: boolean }) {
  return <div className="xn-provider-empty" data-testid="provider-custom-empty">
    <div className="xn-provider-empty__toolbar">
      <button type="button" className="xn-provider-button" data-testid="provider-custom-empty-add" disabled={busy} onClick={onAdd}>
        <Plus size={15} aria-hidden="true" /><span>{tr('+ 添加')}</span>
      </button>
      <a
        className="xn-provider-empty__docs"
        data-testid="provider-custom-empty-docs"
        href={CUSTOM_MODEL_DOCS_HREF}
        target="_blank"
        rel="noopener noreferrer"
      >{tr('本地模型文档')}</a>
    </div>
    <CustomModelEmptyArt />
    <p className="xn-provider-empty__title">{tr('还没有自定义模型配置')}</p>
    <p className="xn-provider-empty__description">{tr('添加一个 API 配置后，可随时切换当前运行使用的模型。')}</p>
    <ProviderSetupGuide />
    <button type="button" className="xn-provider-button xn-provider-button--primary" data-testid="provider-custom-empty-action" disabled={busy} onClick={onAdd}>
      {tr('添加')}
    </button>
  </div>;
}

/** Provider-owned setup help; available offline and never starts a request. */
export function ProviderSetupGuide() {
  return <details className="xn-provider-setup-guide" data-testid="provider-setup-guide">
    <summary>{tr('第一次配置模型？从这里开始')}</summary>
    <ol>
      <li><strong>{tr('使用在线 API')}</strong><p>{tr('准备服务商提供的 API 地址、API 密钥和准确的模型名称。显示名称可以自己取；接口协议按服务商说明选择，运行档位通常用“标准”。')}</p></li>
      <li><strong>{tr('使用本地模型')}</strong><p>{tr('先在本机启动模型服务，再填入它的地址和已加载的模型名称，选择“本地轻量”。上下文窗口要与本地服务一致；这里不会下载或启动模型。')}</p></li>
      <li><strong>{tr('保存后开始聊天')}</strong><p>{tr('点击“保存配置”，再点击“用于当前运行”。返回会话后确认输入框下方显示所选模型，再发送第一条消息。高级参数可以先保留默认值。')}</p></li>
    </ol>
    <p>{tr('不确定模型名称时，请从服务商的模型列表复制，避免把显示名称当作模型 ID。')}</p>
  </details>;
}

export function EnvironmentProviderDetail({ onSelect }: { onSelect: () => void }) {
  return <div className="xn-provider-environment" data-testid="model-provider-environment-detail">
    <div className="xn-provider-detail__eyebrow"><Server size={15} aria-hidden="true" />{tr('服务器默认值')}</div>
    <h3>{tr('环境模型')}</h3>
    <p>{tr('使用服务器环境中的默认模型配置')}</p>
    <div className="xn-provider-environment__note">
      <ShieldCheck size={18} aria-hidden="true" />
      <span>{tr('此选项由服务端环境提供；环境变量和密钥不会在浏览器中读取或显示。')}</span>
    </div>
    <button type="button" className="xn-provider-button xn-provider-button--primary" onClick={onSelect}>{tr('用于当前运行')}</button>
  </div>;
}
