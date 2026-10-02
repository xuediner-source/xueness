import React, { useEffect, useState } from "react";
import { get, post } from "../../xuenessApi";
import { useLocale } from "../../i18n";
import "./network.css";

export type NetworkSettingsValue = {
  searchEndpoint: string;
  dohEndpoint: string;
  searchMode: "service" | "model";
  searchModelEndpoint: string;
  searchModel: string;
  hasSearchKey: boolean;
  hasSavedSearchKey: boolean;
  hasEnvironmentSearchKey: boolean;
  searchKeySource: "saved" | "environment" | "none";
  hasSearchModelKey: boolean;
  hasSavedSearchModelKey: boolean;
};

export type NetworkDiagnostic = {
  ok: boolean;
  operation: "dns" | "search";
  host?: string;
  addressCount?: number;
  dnsSource?: "system" | "configured_doh";
  sourceType?: "search_service" | "search_model";
  message?: string;
  error?: string;
  error_code?: string;
  retryable?: boolean;
  user_reason?: string;
};

const DEFAULT_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export async function readNetworkSettings(enabled: boolean): Promise<NetworkSettingsValue | null> {
  if (!enabled) return null;
  const result = await get<{ settings: NetworkSettingsValue }>("/api/network/settings");
  if (!result.settings || typeof result.settings.searchEndpoint !== "string"
      || typeof result.settings.dohEndpoint !== "string"
      || typeof result.settings.searchMode !== "string"
      || typeof result.settings.searchModelEndpoint !== "string"
      || typeof result.settings.searchModel !== "string"
      || typeof result.settings.hasSearchKey !== "boolean"
      || typeof result.settings.hasSearchModelKey !== "boolean") {
    throw new Error("网络工具设置响应无效。");
  }
  return result.settings;
}

export async function saveNetworkSettings(values: {
  searchEndpoint: string;
  dohEndpoint: string;
  searchMode: "service" | "model";
  searchModelEndpoint: string;
  searchModel: string;
  searchKey?: string;
  searchModelKey?: string;
}): Promise<NetworkSettingsValue> {
  const payload = { ...values };
  if (!payload.searchKey) delete payload.searchKey;
  if (!payload.searchModelKey) delete payload.searchModelKey;
  const result = await post<{ settings: NetworkSettingsValue }>("/api/network/settings", payload);
  return result.settings;
}

export async function clearSavedNetworkKey(): Promise<NetworkSettingsValue> {
  const result = await post<{ settings: NetworkSettingsValue }>("/api/network/settings", { clearSearchKey: true });
  return result.settings;
}

export async function clearSavedSearchModelKey(): Promise<NetworkSettingsValue> {
  const result = await post<{ settings: NetworkSettingsValue }>("/api/network/settings", { clearSearchModelKey: true });
  return result.settings;
}

export async function diagnoseNetwork(operation: "dns" | "search"): Promise<NetworkDiagnostic> {
  return post<NetworkDiagnostic>("/api/network/diagnostics", { operation });
}

type Props = { enabled: boolean; disabled?: boolean };

export function NetworkSettings({ enabled, disabled = false }: Props): React.JSX.Element {
  const locale = useLocale();
  const en = locale === "en";
  const tr = (zh: string, english: string) => en ? english : zh;
  const [settings, setSettings] = useState<NetworkSettingsValue | null>(null);
  const [searchEndpoint, setSearchEndpoint] = useState(DEFAULT_ENDPOINT);
  const [dohEndpoint, setDohEndpoint] = useState("");
  const [searchMode, setSearchMode] = useState<"service" | "model">("service");
  const [searchModelEndpoint, setSearchModelEndpoint] = useState("");
  const [searchModel, setSearchModel] = useState("");
  const [searchKey, setSearchKey] = useState("");
  const [searchModelKey, setSearchModelKey] = useState("");
  const [loading, setLoading] = useState(enabled);
  const [saving, setSaving] = useState(false);
  const [diagnostic, setDiagnostic] = useState<"dns" | "search" | null>(null);
  const [result, setResult] = useState<NetworkDiagnostic | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let disposed = false;
    if (!enabled) {
      setSettings(null);
      setSearchKey("");
      setSearchModelKey("");
      setResult(null);
      setError("");
      setLoading(false);
      return () => { disposed = true; };
    }
    setLoading(true);
    void readNetworkSettings(enabled).then(value => {
      if (disposed || !value) return;
      setSettings(value);
      setSearchEndpoint(value.searchEndpoint);
      setDohEndpoint(value.dohEndpoint);
      setSearchMode(value.searchMode);
      setSearchModelEndpoint(value.searchModelEndpoint);
      setSearchModel(value.searchModel);
      setError("");
    }).catch(cause => {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [enabled]);

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!enabled || disabled || saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const updated = await saveNetworkSettings({ searchEndpoint, dohEndpoint, searchMode,
        searchModelEndpoint, searchModel,
        ...(searchKey ? { searchKey } : {}), ...(searchModelKey ? { searchModelKey } : {}) });
      setSettings(updated);
      setSearchKey("");
      setSearchModelKey("");
      setNotice(tr("设置已保存。密钥只保存在本机服务端，不会回显。", "Settings saved. The key stays on this server and is never returned."));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const clearModelKey = async () => {
    if (!enabled || disabled || saving || !settings?.hasSavedSearchModelKey) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const updated = await clearSavedSearchModelKey();
      setSettings(updated);
      setNotice(tr("已删除本地保存的搜索模型密钥。", "Saved SearchModel key removed."));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    if (!enabled || disabled || saving || !settings?.hasSavedSearchKey) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const updated = await clearSavedNetworkKey();
      setSettings(updated);
      setNotice(updated.hasEnvironmentSearchKey
        ? tr("已删除本地保存的密钥；服务端环境变量仍可提供密钥。", "Saved key removed; the server environment variable can still provide a key.")
        : tr("已删除本地保存的搜索密钥。", "Saved search key removed."));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const runDiagnostic = async (operation: "dns" | "search") => {
    if (!enabled || disabled || saving || diagnostic !== null) return;
    if (operation === "search") {
      const prompt = searchMode === "model"
        ? tr("这会向独立搜索模型发送一次测试请求；服务商可能按其规则计费。模型联网能力不会因此得到验证。继续？",
          "This sends one test request to the separate search model; the provider may charge according to its plan. It does not verify web access. Continue?")
        : tr("这会向所选搜索服务发送一次测试搜索请求；服务商可能按其规则计费。继续？",
          "This sends one test search to the selected service; the provider may charge according to its plan. Continue?");
      if (typeof window !== "undefined" && !window.confirm(prompt)) return;
    }
    setDiagnostic(operation);
    setError("");
    setNotice("");
    setResult(null);
    try {
      const checked = await diagnoseNetwork(operation);
      setResult(checked);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDiagnostic(null);
    }
  };

  return <section className="xn-network-settings" data-testid="network-settings">
    {!enabled ? <p className="xn-network-settings__disabled">{tr("网络工具已关闭；保存的设置仍保留。", "Network tools are disabled; saved settings are retained.")}</p> : <>
      <p className="xn-network-settings__intro">{tr(
        "选择 Brave 兼容搜索服务或独立 OpenAI 兼容搜索模型。搜索和页面读取仍需每次通过运行批准。搜索凭据与主模型配置相互独立。",
        "Choose a Brave-compatible search service or a separate OpenAI-compatible search model. Searches and page reads still require run approval. Search credentials are separate from the main model configuration.",
      )}</p>
      {error && <p className="xn-network-settings__feedback is-error" role="alert">{error}</p>}
      {notice && <p className="xn-network-settings__feedback is-success" role="status">{notice}</p>}
      {loading ? <p role="status">{tr("正在读取网络工具设置…", "Loading network settings…")}</p> : <>
        <form className="xn-network-settings__form" onSubmit={event => void save(event)}>
          <label>
            <span>{tr("搜索方式", "Search provider")}</span>
            <select value={searchMode} disabled={disabled || saving} onChange={event => setSearchMode(event.currentTarget.value as "service" | "model")}>
              <option value="service">{tr("Brave 兼容搜索服务", "Brave-compatible search service")}</option>
              <option value="model">{tr("独立搜索模型", "Separate SearchModel")}</option>
            </select>
          </label>
          {searchMode === "service" ? <>
            <label>
              <span>{tr("搜索服务 HTTPS 地址", "Search service HTTPS endpoint")}</span>
              <input type="url" required maxLength={2048} value={searchEndpoint} disabled={disabled || saving}
                onChange={event => setSearchEndpoint(event.currentTarget.value)} autoComplete="url" />
            </label>
            <label>
              <span>{tr("搜索服务密钥", "Search service key")}</span>
              <input type="password" maxLength={4096} value={searchKey} disabled={disabled || saving}
                onChange={event => setSearchKey(event.currentTarget.value)} autoComplete="new-password"
                placeholder={settings?.hasSavedSearchKey
                  ? tr("已保存；留空以保留当前密钥", "Saved; leave blank to keep the current key")
                  : settings?.hasEnvironmentSearchKey
                    ? tr("由服务端环境变量提供", "Provided by the server environment")
                    : tr("输入搜索服务提供的密钥", "Enter the key from the search service")} />
            </label>
            <div className="xn-network-settings__key-state" aria-live="polite">
              {settings?.hasSearchKey
                ? tr("密钥已配置，界面不会读取或回显密钥。", "A key is configured. The interface never reads or displays it.")
                : tr("尚未配置密钥。", "No key is configured.")}
              {settings?.hasSavedSearchKey && <button type="button" disabled={disabled || saving} onClick={() => void clearKey()}>
                {tr("删除本地密钥", "Remove saved key")}
              </button>}
            </div>
          </> : <>
            <label>
              <span>{tr("OpenAI-compatible Chat Completions HTTPS 地址", "OpenAI-compatible Chat Completions HTTPS endpoint")}</span>
              <input type="url" required maxLength={2048} value={searchModelEndpoint} disabled={disabled || saving}
                onChange={event => setSearchModelEndpoint(event.currentTarget.value)} autoComplete="url" />
            </label>
            <label>
              <span>{tr("搜索模型 ID", "SearchModel ID")}</span>
              <input type="text" required maxLength={200} value={searchModel} disabled={disabled || saving}
                onChange={event => setSearchModel(event.currentTarget.value)} autoComplete="off" />
            </label>
            <label>
              <span>{tr("搜索模型 API 密钥", "SearchModel API key")}</span>
              <input type="password" maxLength={4096} value={searchModelKey} disabled={disabled || saving}
                onChange={event => setSearchModelKey(event.currentTarget.value)} autoComplete="new-password"
                placeholder={settings?.hasSavedSearchModelKey
                  ? tr("已保存；留空以保留当前密钥", "Saved; leave blank to keep the current key")
                  : tr("输入搜索模型服务提供的密钥", "Enter the key for the SearchModel service")} />
            </label>
            <div className="xn-network-settings__key-state" aria-live="polite">
              {settings?.hasSearchModelKey
                ? tr("独立搜索模型密钥已配置，且不会覆盖主模型设置。", "A separate SearchModel key is configured; main model settings are unchanged.")
                : tr("尚未配置搜索模型密钥。", "No SearchModel key is configured.")}
              {settings?.hasSavedSearchModelKey && <button type="button" disabled={disabled || saving} onClick={() => void clearModelKey()}>
                {tr("删除搜索模型密钥", "Remove SearchModel key")}
              </button>}
            </div>
            <p className="xn-network-settings__help">{tr(
              "模型生成的摘要和来源不会视为已验证网页搜索；Xueness 不会验证模型是否访问互联网。模型端点只允许公网 HTTPS，本机或私网接口暂不支持。",
              "Model-generated summaries and sources are not treated as verified web search. Xueness cannot confirm that the model accessed the internet. Only public HTTPS model endpoints are supported; local and private endpoints are not.",
            )}</p>
          </>}
          <label>
            <span>{tr("FakeIP 代理的可选 DoH 解析地址", "Optional DoH resolver for FakeIP proxies")}</span>
            <input type="url" maxLength={2048} value={dohEndpoint} disabled={disabled || saving}
              onChange={event => setDohEndpoint(event.currentTarget.value)} placeholder="https://cloudflare-dns.com/dns-query" />
          </label>
          <p className="xn-network-settings__help">{tr(
            "留空时只用系统 DNS。仅当系统 DNS 全部返回 198.18.0.0/15 FakeIP 地址时才会请求此解析服务；私人、混合或其他非公网地址仍会被阻止。解析服务必须公开、无凭据并支持 application/dns-json。",
            "System DNS is used when this is blank. This resolver is contacted only when every system answer is a 198.18.0.0/15 FakeIP address. Private, mixed, and other non-public answers remain blocked. The resolver must be public, credential-free, and support application/dns-json.",
          )}</p>
          <button type="submit" disabled={disabled || saving || loading} aria-busy={saving}>
            {saving ? tr("正在保存…", "Saving…") : tr("保存网络设置", "Save network settings")}
          </button>
        </form>
        <section className="xn-network-settings__diagnostics" aria-labelledby="xn-network-diagnostics-title">
          <h2 id="xn-network-diagnostics-title">{tr("按需诊断", "On-demand diagnostics")}</h2>
          <p>{tr("打开页面和读取配置不会发起外部网络请求。选择下列操作后才会运行对应检查。", "Opening this page and reading settings make no external request. Choose an action below to run a check.")}</p>
          <div className="xn-network-settings__actions">
            <button type="button" disabled={disabled || saving || diagnostic !== null || loading}
              aria-busy={diagnostic === "dns"} onClick={() => void runDiagnostic("dns")}>
              {diagnostic === "dns" ? tr("正在检查 DNS…", "Checking DNS…") : tr("检查搜索服务 DNS", "Check search service DNS")}
            </button>
            <button type="button" disabled={disabled || saving || diagnostic !== null || loading
              || (searchMode === "model" ? !settings?.hasSearchModelKey : !settings?.hasSearchKey)}
              aria-busy={diagnostic === "search"} onClick={() => void runDiagnostic("search")}>
              {diagnostic === "search" ? tr("正在测试搜索…", "Testing search…") : tr("发送一次测试搜索", "Send one test search")}
            </button>
          </div>
          {!(searchMode === "model" ? settings?.hasSearchModelKey : settings?.hasSearchKey)
            && <p className="xn-network-settings__help">{tr("配置当前所选搜索方式的密钥后才能测试。", "Configure a key for the selected search provider before testing.")}</p>}
          {result && <div className={`xn-network-settings__result${result.ok ? " is-success" : " is-error"}`} role={result.ok ? "status" : "alert"}>
            <strong>{result.ok ? tr("诊断完成", "Diagnostic complete") : tr("诊断失败", "Diagnostic failed")}</strong>
            <span>{result.ok ? result.message : result.user_reason || result.error}</span>
            {result.ok && result.operation === "dns" && <small>{result.host} · {result.addressCount} {tr("个公网地址", "public address(es)")} · {result.dnsSource === "configured_doh" ? "DoH" : tr("系统 DNS", "system DNS")}</small>}
            {result.ok && result.operation === "search" && <small>{result.dnsSource === "configured_doh" ? "DoH" : tr("系统 DNS", "system DNS")}
              {result.sourceType === "search_model" && ` · ${tr("联网能力未证实", "web access unverified")}`}</small>}
          </div>}
        </section>
      </>}
    </>}
  </section>;
}

export default NetworkSettings;
