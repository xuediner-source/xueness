import React, { useEffect, useState } from "react";
import { get, post, listResources } from "../../xuenessApi";
import type { CapabilityItem } from "../../xuenessCapabilities";
import { t as tr } from "../../i18n";
import "../../styles/mcp-tools.css";

type Server = CapabilityItem & { name?: string; oauth?: Record<string, unknown>; extra?: Record<string, unknown> };
type OAuthStatus = { authorized: boolean; pending: boolean; expiresAt?: number };

export function XuenessMcpTools(): React.JSX.Element {
  const [servers, setServers] = useState<Server[]>([]);
  const [statuses, setStatuses] = useState<Record<string, OAuthStatus>>({});
  const [links, setLinks] = useState<Record<string, { authorizationUrl: string; state: string }>>({});
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [stateCodes, setStateCodes] = useState<Record<string, string>>({});
  const [catalog, setCatalog] = useState<{ id: string; kind: string; serverId: string; name?: string; uri?: string }[]>([]);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<(() => Promise<void>) | null>(null);
  const [argumentText, setArgumentText] = useState("{}");
  const refresh = async () => {
    try {
      const response = await listResources("mcp");
      const rows = response.items as Server[];
      setServers(rows);
      const next: Record<string, OAuthStatus> = {};
      await Promise.all(rows.filter(s => s.extra?.oauth || s.oauth).map(async s => {
        try { next[s.id] = await get<OAuthStatus>(`/api/mcp/${encodeURIComponent(s.id)}/oauth`); } catch { /* shown when an operator starts OAuth */ }
      }));
      setStatuses(next); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { void refresh(); }, []);
  const action = async (fn: () => Promise<unknown>) => { setBusy(true); setError(""); try { setResult(JSON.stringify(await fn(), null, 2)); await refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const discover = (server: Server, kind: "resources" | "prompts") => setConfirm(() => async () => action(async () => {
    const response = await post<Record<string, unknown>>(`/api/mcp/${encodeURIComponent(server.id)}/${kind}`, { confirmed: true });
    const rows = Array.isArray(response[kind]) ? response[kind] as Record<string, unknown>[] : [];
    setCatalog(rows.map(row => ({ id: String(row.uri ?? row.name ?? ""), kind, serverId: server.id, name: typeof row.name === "string" ? row.name : undefined, uri: typeof row.uri === "string" ? row.uri : undefined })));
    return response;
  }));
  const readEntry = (server: Server, item: { id: string; kind: string }) => setConfirm(() => async () => action(async () => {
    const args = item.kind === "prompts" ? JSON.parse(argumentText) : {};
    return post(`/api/mcp/${encodeURIComponent(server.id)}/${item.kind}/read`, { confirmed: true, key: item.id, arguments: args });
  }));
  return <section className="xn-mcp-tools" data-testid="mcp-management">
    <header><div><h3>{tr("MCP 管理与诊断")}</h3><p>{tr("只有点击并确认后才连接服务器、读取资源或提示。")}</p></div><button type="button" onClick={() => void refresh()}>{tr("刷新")}</button></header>
    {error && <p role="alert">{error}</p>}
    {!servers.length && <p>{tr("暂无 MCP 配置，请先在上方添加。")}</p>}
    {servers.map(server => {
      const oauth = server.extra?.oauth ?? server.oauth;
      const flow = links[server.id];
      return <article key={server.id}><header><strong>{server.name ?? server.id}</strong><code>{server.id}</code></header>
        {oauth && <div className="xn-mcp-tools__row">
          <span>{statuses[server.id]?.authorized ? tr("OAuth 已授权") : tr("OAuth 未授权")}</span>
          <button type="button" disabled={busy} onClick={() => void action(async () => {
            const data = await post<{ authorizationUrl: string; state: string }>(`/api/mcp/${encodeURIComponent(server.id)}/oauth/start`, {});
            const url = new URL(data.authorizationUrl);
            if (url.protocol !== "https:") throw new Error("OAuth URL must use HTTPS");
            setLinks(prev => ({ ...prev, [server.id]: data }));
            return { authorizationUrl: url.origin + url.pathname, expiresIn: 600 };
          })}>{tr("开始 OAuth")}</button>
          {flow && <><a href={flow.authorizationUrl} target="_blank" rel="noopener noreferrer">{tr("打开 OAuth 授权页")}</a><input aria-label={tr("OAuth 授权码")} value={codes[server.id] ?? ""} onChange={e => setCodes(p => ({ ...p, [server.id]: e.target.value }))} placeholder={tr("OAuth 授权码")} /><input aria-label={tr("OAuth 状态码")} value={stateCodes[server.id] ?? flow.state} onChange={e => setStateCodes(p => ({ ...p, [server.id]: e.target.value }))} placeholder={tr("OAuth 状态码")} /><button type="button" disabled={busy || !codes[server.id]} onClick={() => void action(() => post(`/api/mcp/${encodeURIComponent(server.id)}/oauth/finish`, { code: codes[server.id], state: stateCodes[server.id] ?? flow.state }))}>{tr("完成授权")}</button></>}
          {statuses[server.id]?.authorized && <button type="button" disabled={busy} onClick={() => setConfirm(() => async () => action(() => post(`/api/mcp/${encodeURIComponent(server.id)}/oauth/revoke`, {})))}>{tr("撤销授权")}</button>}
        </div>}
        <div className="xn-mcp-tools__row"><button type="button" disabled={busy || server.enabled === false} onClick={() => discover(server, "resources")}>{tr("发现资源")}</button><button type="button" disabled={busy || server.enabled === false} onClick={() => discover(server, "prompts")}>{tr("发现提示")}</button></div>
      </article>;
    })}
    {catalog.length > 0 && <article><h4>{tr("发现的内容")}</h4>{catalog.map((item, i) => <div className="xn-mcp-tools__row" key={`${item.kind}-${item.id}-${i}`}><code>{item.name ?? item.id}</code><button type="button" disabled={busy} onClick={() => { const server = servers.find(s => s.id === item.serverId); if (server) readEntry(server, item); }}>{tr("读取")}</button></div>)}{catalog.some(item => item.kind === "prompts") && <label>{tr("提示参数 JSON")}<textarea value={argumentText} onChange={e => setArgumentText(e.target.value)} /></label>}</article>}
    {result && <pre role="status">{result}</pre>}
    {confirm && <div className="xn-marketplace__backdrop"><section role="alertdialog" aria-modal="true"><h3>{tr("确认 MCP 操作")}</h3><p>{tr("将连接所选服务器并执行此只读目录或内容请求。")}</p><div><button type="button" onClick={() => setConfirm(null)}>{tr("取消")}</button><button type="button" disabled={busy} onClick={() => { const fn = confirm; setConfirm(null); void fn(); }}>{tr("确认")}</button></div></section></div>}
  </section>;
}
