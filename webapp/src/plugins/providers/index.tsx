import React, { useEffect, useMemo, useState } from 'react';
import { Check, Cpu, Plus, RefreshCw } from 'lucide-react';
import { adoptProviderCompatibility, deleteProvider, discoverProviderModels, getDefaultModelSelection, listProviders, saveDefaultModelSelection, saveProvider, testProviderCompatibility, testProviderConnection } from '../../xuenessApi';
import type { ProviderCompatibilityTest, ProviderCompatibilityTestMode, ProviderConnectionTest, ProviderDiscoveredModel, ProviderSummary } from '../../xuenessApi';
import { t as tr, tf } from '../../i18n';
import { OperationHeader } from '../shared';
import { EnvironmentProviderDetail, ExternalProviderDetail, ProviderEmptyState, ModelProviderNavigation } from './ProviderPanels';
import { ProviderEditor } from './ProviderEditor';
import {
  canAdoptProviderCompatibility, canTestProviderCompatibility, compatibilityOptionsKey, createProviderDraft, draftsEqual, emptyProviderDraft,
  ENVIRONMENT_KEY, errorText, NEW_PROVIDER_KEY, newProviderDraftChanged, providerDraftFromSummary, providerSavePayload, validateProviderDraft,
} from './providerDraft';
import type { ProviderDraft } from './providerDraft';
import '../../styles/operations.css';
import '../../styles/provider-settings.css';

// Load setup translations with the providers panel, not the startup bundle.


export type { ProviderDraft } from './providerDraft';
export {
  adjustedLightweightOutput, canAdoptProviderCompatibility, canTestProviderCompatibility, createProviderDraft, emptyProviderDraft,
  isLoopbackHttpEndpoint, lightweightBudgetPreview, providerDraftFromSummary, providerDraftWithEndpoint, providerDraftWithLocalEndpoint,
  providerSavePayload, validateProviderDraft,
} from './providerDraft';
export { CUSTOM_MODEL_DOCS_HREF, ModelProviderNavigation, ProviderEmptyState, ProviderSetupGuide } from './ProviderPanels';
export { ProviderEditor } from './ProviderEditor';

export function ModelManager({ onSelect, runtimeMonitorEnabled = false, focusProviderId, onManageSource, onRefreshExternal }: {
  onSelect: (id: string) => void;
  runtimeMonitorEnabled?: boolean;
  /** When set, select this saved profile once the catalog includes it. */
  focusProviderId?: string;
  /** Open the plugin that supplies a read-only profile (`subscriptionId`, e.g. "magpie"). */
  onManageSource?: (subscriptionId: string) => void;
  onRefreshExternal?: () => Promise<void>;
}) {
  const [items, setItems] = useState<ProviderSummary[]>([]);
  // Profiles a plugin supplies (Magpie) are listed read-only beside the editable ones.
  const [external, setExternal] = useState<ProviderSummary[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState(ENVIRONMENT_KEY);
  const [draft, setDraft] = useState<ProviderDraft>(emptyProviderDraft);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<string | null>(null);
  const [testingProviderId, setTestingProviderId] = useState('');
  const [connectionTest, setConnectionTest] = useState<{ id: string; result?: ProviderConnectionTest; error?: string } | null>(null);
  const [compatibilityMode, setCompatibilityMode] = useState<ProviderCompatibilityTestMode>('conversation');
  const [compatibilityTestingMode, setCompatibilityTestingMode] = useState<ProviderCompatibilityTestMode | ''>('');
  const [adoptingCompatibility, setAdoptingCompatibility] = useState(false);
  const [compatibilityChecks, setCompatibilityChecks] = useState(new Map<string, {
    compatibilityKey: string;
    result?: ProviderCompatibilityTest;
    error?: string;
  }>());
  const [discovery, setDiscovery] = useState<{ id: string; models: ProviderDiscoveredModel[]; error?: string } | null>(null);
  const [discoveringProviderId, setDiscoveringProviderId] = useState('');
  const discoveryRequest = React.useRef(0);
  const issuedProviderIds = React.useRef(new Set<string>());

  const currentProvider = useMemo(() => items.find(provider => provider.id === selectedKey) ?? null, [items, selectedKey]);
  const currentExternal = useMemo(() => external.find(provider => provider.id === selectedKey) ?? null, [external, selectedKey]);
  const isNew = selectedKey === NEW_PROVIDER_KEY;
  const currentConnectionTest = connectionTest?.id === currentProvider?.id ? connectionTest : null;
  const compatibilityKey = compatibilityOptionsKey(draft.compatibility);
  const currentCompatibilityCheck = currentProvider
    ? compatibilityChecks.get(`${currentProvider.id}\0${compatibilityMode}`)
    : undefined;
  const currentCompatibilityResult = currentCompatibilityCheck?.compatibilityKey === compatibilityKey
    ? currentCompatibilityCheck.result ?? null
    : null;
  const currentCompatibilityError = currentCompatibilityCheck?.compatibilityKey === compatibilityKey
    ? currentCompatibilityCheck.error ?? ''
    : '';
  const currentCompatibilityGroup = currentProvider?.compatibilityDiagnostics?.find(group =>
    compatibilityOptionsKey(group.compatibility) === compatibilityKey);
  const currentCompatibilityHistory = currentCompatibilityGroup?.checks ?? [];
  const compatibilityAdoptionReady = canAdoptProviderCompatibility(draft, currentProvider);
  const currentDiscovery = discovery?.id === currentProvider?.id ? discovery : null;
  const discoveryStillApplies = Boolean(currentProvider && draftsEqual(
    { ...draft, model: providerDraftFromSummary(currentProvider).model },
    providerDraftFromSummary(currentProvider),
  ) && !draft.apiKey);
  const currentDraftChanged = isNew
    ? newProviderDraftChanged(draft)
    : (currentProvider !== null && !draftsEqual(draft, providerDraftFromSummary(currentProvider)));

  const mountedRef = React.useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError('');
    try {
      await onRefreshExternal?.().catch(() => undefined);
      const [result, savedDefault] = await Promise.all([listProviders(), getDefaultModelSelection().catch(() => null)]);
      if (!mountedRef.current) return;
      setItems(result.providers.filter(provider => provider.source !== 'subscription'));
      setExternal(result.providers.filter(provider => provider.source === 'subscription'));
      setDefaultId(savedDefault?.providerId ?? null);
      if (selectedKey !== ENVIRONMENT_KEY && selectedKey !== NEW_PROVIDER_KEY && !result.providers.some(provider => provider.id === selectedKey)) {
        setSelectedKey(ENVIRONMENT_KEY);
        setDraft(emptyProviderDraft());
      } else if (selectedKey !== ENVIRONMENT_KEY && selectedKey !== NEW_PROVIDER_KEY && !currentDraftChanged) {
        const provider = result.providers.find(item => item.id === selectedKey && item.source !== 'subscription');
        if (provider) setDraft(providerDraftFromSummary(provider));
      }
    } catch (reason) {
      if (mountedRef.current) setError(errorText(reason));
    } finally {
      if (mountedRef.current && !quiet) setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    if (!focusProviderId || selectedKey === focusProviderId || pendingSelection === focusProviderId) return;
    const saved = items.find(item => item.id === focusProviderId);
    const target = saved ?? external.find(item => item.id === focusProviderId);
    if (!target) return;
    if (currentDraftChanged) {
      setPendingSelection(focusProviderId);
      return;
    }
    setSelectedKey(target.id);
    setDraft(saved ? providerDraftFromSummary(saved) : emptyProviderDraft());
    setError('');
    setNotice('');
    setConfirmDelete(false);
    setConnectionTest(null);
    setDiscovery(null);
  }, [focusProviderId, items, external, selectedKey, pendingSelection, currentDraftChanged]);

  const commitNavigationItem = (key: string) => {
    setPendingSelection(null);
    setSelectedKey(key);
    setError('');
    setNotice('');
    setConfirmDelete(false);
    setConnectionTest(null);
    setDiscovery(null);
    const provider = items.find(item => item.id === key);
    if (provider) {
      setDraft(providerDraftFromSummary(provider));
    } else if (key === NEW_PROVIDER_KEY) {
      const nextDraft = createProviderDraft([...items.map(item => item.id), ...issuedProviderIds.current]);
      issuedProviderIds.current.add(nextDraft.id);
      setDraft(nextDraft);
    } else {
      setDraft(emptyProviderDraft());
    }
  };

  const requestNavigationItem = (key: string) => {
    if (key === selectedKey) return;
    if (currentDraftChanged) {
      setPendingSelection(key);
      return;
    }
    commitNavigationItem(key);
  };

  const addProvider = () => requestNavigationItem(NEW_PROVIDER_KEY);
  const discardEditorChanges = () => {
    if (isNew) {
      commitNavigationItem(ENVIRONMENT_KEY);
      return;
    }
    if (currentProvider) setDraft(providerDraftFromSummary(currentProvider));
    setError('');
    setNotice('');
  };
  const chooseForRun = (id: string, label: string) => {
    onSelect(id);
    setNotice(tf('已选择 {0}', [label]));
    setError('');
  };

  const runConnectionTest = async (id: string) => {
    setTestingProviderId(id);
    setConnectionTest({ id });
    setError('');
    try {
      const result = await testProviderConnection(id);
      if (!mountedRef.current) return;
      setConnectionTest({ id, result });
    } catch (reason) {
      if (!mountedRef.current) return;
      const message = errorText(reason);
      setConnectionTest({ id, error: message.includes('details suppressed')
        ? tr('请检查 API 地址、密钥和模型名称。')
        : message.includes('real model requests are disabled') ? tr('服务端已关闭模型请求。')
        : message });
    } finally {
      if (mountedRef.current) setTestingProviderId('');
    }
  };

  const runCompatibilityTest = async () => {
    if (!currentProvider || !canTestProviderCompatibility(draft, currentProvider)
      || busy || testingProviderId || compatibilityTestingMode) return;
    const { id } = currentProvider;
    const mode = compatibilityMode;
    const compatibilityCandidate = { ...(draft.compatibility ?? {}) };
    const candidateKey = compatibilityOptionsKey(compatibilityCandidate);
    const checkKey = `${id}\0${mode}`;
    setCompatibilityTestingMode(mode);
    setCompatibilityChecks(previous => {
      const next = new Map(previous);
      next.set(checkKey, { compatibilityKey: candidateKey });
      return next;
    });
    setError('');
    try {
      const result = await testProviderCompatibility(id, mode, compatibilityCandidate);
      setCompatibilityChecks(previous => {
        const next = new Map(previous);
        next.set(checkKey, { compatibilityKey: candidateKey, result });
        return next;
      });
      setItems(previous => previous.map(provider => provider.id === id
        ? { ...provider, compatibilityDiagnostics: result.providerCompatibilityDiagnostics }
        : provider));
    } catch (reason) {
      setCompatibilityChecks(previous => {
        const next = new Map(previous);
        next.set(checkKey, { compatibilityKey: candidateKey, error: errorText(reason) });
        return next;
      });
    } finally {
      setCompatibilityTestingMode('');
    }
  };

  const runAdoptCompatibility = async () => {
    if (!currentProvider || !compatibilityAdoptionReady || !currentCompatibilityGroup
      || busy || testingProviderId || compatibilityTestingMode || adoptingCompatibility) return;
    setAdoptingCompatibility(true);
    setError('');
    setNotice('');
    try {
      const result = await adoptProviderCompatibility(currentProvider.id, currentCompatibilityGroup.optionsHash);
      setItems(previous => [...previous.filter(provider => provider.id !== result.provider.id), result.provider]
        .sort((left, right) => left.id.localeCompare(right.id)));
      setSelectedKey(result.provider.id);
      setDraft(providerDraftFromSummary(result.provider));
      setNotice(tr('已采用通过全部兼容诊断的参数；当前运行模型选择未更改。'));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setAdoptingCompatibility(false);
    }
  };

  const runModelDiscovery = async (id: string) => {
    if (!currentProvider || currentProvider.id !== id || currentProvider.protocol === 'anthropic'
      || draft.protocol !== 'openai' || currentDraftChanged || busy || testingProviderId) return;
    const requestId = ++discoveryRequest.current;
    setDiscoveringProviderId(id);
    setDiscovery({ id, models: [] });
    setError('');
    try {
      const result = await discoverProviderModels(id);
      if (discoveryRequest.current === requestId) setDiscovery({ id, models: result.models });
    } catch (reason) {
      const message = errorText(reason);
      if (discoveryRequest.current === requestId) setDiscovery({ id, models: [], error: message.includes('real model requests are disabled')
        ? tr('服务端已关闭模型请求。')
        : message.includes('not supported for Anthropic')
          ? tr('模型发现暂不支持 Anthropic 配置。')
          : message.includes('details suppressed')
            ? tr('发现模型失败，请检查 API 地址、密钥和服务商响应。')
            : message });
    } finally {
      if (discoveryRequest.current === requestId) setDiscoveringProviderId('');
    }
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validationError = validateProviderDraft(draft);
    if (validationError) { setError(validationError); return; }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await saveProvider(providerSavePayload(draft));
      const provider = result.provider;
      setItems(previous => [...previous.filter(item => item.id !== provider.id), provider].sort((a, b) => a.id.localeCompare(b.id)));
      setSelectedKey(provider.id);
      setDraft(providerDraftFromSummary(provider));
      setConfirmDelete(false);
      setConnectionTest(null);
      setDiscovery(null);
      setCompatibilityChecks(previous => {
        const next = new Map(previous);
        for (const key of next.keys()) if (key.startsWith(`${provider.id}\0`)) next.delete(key);
        return next;
      });
      setNotice(tr('配置已保存'));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const removeProvider = async () => {
    if (!currentProvider) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    setBusy(true);
    setError('');
    try {
      await deleteProvider(currentProvider.id);
      setItems(previous => previous.filter(provider => provider.id !== currentProvider.id));
      setSelectedKey(ENVIRONMENT_KEY);
      setDraft(emptyProviderDraft());
      setConfirmDelete(false);
      setConnectionTest(null);
      setDiscovery(null);
      setNotice(tr('模型配置已删除'));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  return <section className="xn-operations xn-provider-settings" data-testid="model-provider-settings">
    <OperationHeader icon={<Cpu size={21} />} title={tr('模型配置')} description={tr('保存常用模型，随时切换当前运行的配置。')} />
    <div className="xn-provider-resource-intro">
      <p>{tr('管理服务器默认模型和自定义 API 配置。更改仅在保存后生效。')}</p>
      <div className="xn-provider-resource-actions">
        <button type="button" className="xn-provider-button" disabled={loading || busy} onClick={() => void refresh()}>
          <RefreshCw size={14} aria-hidden="true" className={loading ? 'xn-provider-spin' : undefined} />{tr(loading ? '正在刷新' : '刷新')}
        </button>
        <button type="button" className="xn-provider-button xn-provider-button--primary" disabled={busy} onClick={addProvider}>
          <Plus size={15} aria-hidden="true" />{tr('添加配置')}
        </button>
      </div>
    </div>
    {error && <p className="xn-provider-feedback xn-provider-feedback--error" role="alert">{error}</p>}
    {notice && <p className="xn-provider-feedback" role="status"><Check size={15} aria-hidden="true" />{notice}</p>}
    <div className="xn-provider-split" data-model-provider-split-panel="true" data-testid="model-provider-split-panel">
          <ModelProviderNavigation providers={items} external={external} selectedKey={selectedKey} loading={loading} busy={busy || Boolean(testingProviderId) || Boolean(compatibilityTestingMode) || adoptingCompatibility} onSelect={requestNavigationItem} onAdd={addProvider} />
      <main className="xn-provider-detail" data-model-provider-detail-scroll="true">
        {pendingSelection !== null && <div className="xn-provider-unsaved" role="alertdialog" aria-modal="false" aria-label={tr('未保存的更改')}>
          <div><strong>{tr('有未保存的更改')}</strong><p>{tr('切换配置会放弃当前表单中的更改。')}</p></div>
          <div><button type="button" className="xn-provider-button" onClick={() => setPendingSelection(null)}>{tr('继续编辑')}</button><button type="button" className="xn-provider-button xn-provider-button--danger" disabled={busy} onClick={() => commitNavigationItem(pendingSelection)}>{tr('放弃更改并切换')}</button></div>
        </div>}
        {selectedKey === ENVIRONMENT_KEY ? <>
          {!loading && items.length === 0 && <ProviderEmptyState onAdd={addProvider} busy={busy} />}
          <EnvironmentProviderDetail onSelect={() => chooseForRun('', tr('环境模型'))} />
        </> : currentExternal ? <ExternalProviderDetail provider={currentExternal}
          isDefault={defaultId === currentExternal.id}
          onSelect={() => chooseForRun(currentExternal.id, currentExternal.name)}
          onSetDefault={() => void saveDefaultModelSelection({ providerId: currentExternal.id, model: currentExternal.model, reasoningEffort: null }).then(saved => { if (saved) { setDefaultId(saved.providerId ?? null); setNotice(tf('已将 {0} 设为默认模型', [currentExternal.name.replace(/^Magpie · /, '')])); } }).catch(r => setError(errorText(r)))}
          onManage={onManageSource && currentExternal.subscriptionId ? () => onManageSource(currentExternal.subscriptionId!) : undefined} />
        : <ProviderEditor
          key={selectedKey}
          draft={draft}
          original={currentProvider}
          hasKey={Boolean(currentProvider?.hasKey)}
          busy={busy}
          testing={testingProviderId === currentProvider?.id}
          testResult={currentConnectionTest?.result ?? null}
          testError={currentConnectionTest?.error ?? ''}
          compatibilityMode={compatibilityMode}
          compatibilityResult={currentCompatibilityResult}
          compatibilityError={currentCompatibilityError}
          compatibilityTesting={compatibilityTestingMode === compatibilityMode}
          compatibilityTestReady={canTestProviderCompatibility(draft, currentProvider)}
          compatibilityHistory={currentCompatibilityHistory}
          compatibilityGroups={currentProvider?.compatibilityDiagnostics ?? []}
          compatibilityAdoptionReady={compatibilityAdoptionReady}
          adoptingCompatibility={adoptingCompatibility}
          onCompatibilityModeChange={setCompatibilityMode}
          onCompatibilityTest={() => void runCompatibilityTest()}
          onAdoptCompatibility={() => void runAdoptCompatibility()}
          onLoadCompatibilityCandidate={compatibility => setDraft(current => ({ ...current, compatibility: { ...compatibility } }))}
          discovering={discoveringProviderId === currentProvider?.id}
          discoveredModels={discoveryStillApplies ? currentDiscovery?.models ?? null : null}
          discoveryError={discoveryStillApplies ? currentDiscovery?.error ?? '' : ''}
          deleting={confirmDelete}
          onDraftChange={setDraft}
          runtimeMonitorEnabled={runtimeMonitorEnabled}
          onSave={submit}
          onUse={() => currentProvider && chooseForRun(currentProvider.id, currentProvider.name)}
          onTest={() => currentProvider && void runConnectionTest(currentProvider.id)}
          onDiscover={() => currentProvider && void runModelDiscovery(currentProvider.id)}
          onSelectDiscoveredModel={model => setDraft(current => ({ ...current, model }))}
          onDelete={removeProvider}
          onCancelDelete={() => setConfirmDelete(false)}
          onCancelEdit={discardEditorChanges}
        />}
      </main>
    </div>
  </section>;
}
