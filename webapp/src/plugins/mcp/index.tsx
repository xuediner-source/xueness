import React, { useEffect, useRef, useState } from "react";
import { get, post, listResources } from "../../xuenessApi";
import type { CapabilityItem } from "../../xuenessCapabilities";
import { t as tr } from "../../i18n";
import { shouldDismissModalOnEscape, useModalFocusScope } from "../shared";
import "../../styles/mcp-tools.css";

type Server = CapabilityItem & { name?: string; oauth?: Record<string, unknown>; extra?: Record<string, unknown> };
type OAuthStatus = { authorized: boolean; pending: boolean; expiresAt?: number };

export function parseMcpServers(value: unknown): Server[] {
  if (!Array.isArray(value)) throw new Error("Invalid MCP server response");
  return value.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Invalid MCP server response");
    const item = row as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id.trim()
      || (item.enabled !== undefined && typeof item.enabled !== "boolean")
      || (item.name !== undefined && typeof item.name !== "string")
      || (item.extra !== undefined && (!item.extra || typeof item.extra !== "object" || Array.isArray(item.extra)))
      || (item.oauth !== undefined && (!item.oauth || typeof item.oauth !== "object" || Array.isArray(item.oauth)))) {
      throw new Error("Invalid MCP server response");
    }
    return item as Server;
  });
}

export function parseOAuthStatus(value: unknown): OAuthStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP OAuth status response");
  const status = value as Record<string, unknown>;
  if (typeof status.authorized !== "boolean" || typeof status.pending !== "boolean"
    || (status.expiresAt != null && (typeof status.expiresAt !== "number" || !Number.isFinite(status.expiresAt)))) {
    throw new Error("Invalid MCP OAuth status response");
  }
  return {
    authorized: status.authorized,
    pending: status.pending,
    ...(typeof status.expiresAt === "number" ? { expiresAt: status.expiresAt } : {}),
  };
}

export function parseOAuthStart(value: unknown): { authorizationUrl: string; state: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP OAuth response");
  const result = value as Record<string, unknown>;
  if (typeof result.authorizationUrl !== "string" || typeof result.state !== "string" || !result.state) {
    throw new Error("Invalid MCP OAuth response");
  }
  let authorizationUrl: URL;
  try { authorizationUrl = new URL(result.authorizationUrl); }
  catch { throw new Error("Invalid MCP OAuth response"); }
  if (authorizationUrl.protocol !== "https:") throw new Error(tr("OAuth URL 必须使用 HTTPS"));
  return { authorizationUrl: authorizationUrl.href, state: result.state };
}

export function parseMcpCatalog(value: unknown, kind: "resources" | "prompts", serverId: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP catalog response");
  const rows = (value as Record<string, unknown>)[kind];
  if (!Array.isArray(rows)) throw new Error("Invalid MCP catalog response");
  return rows.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Invalid MCP catalog response");
    const item = row as Record<string, unknown>;
    const name = typeof item.name === "string" ? item.name : undefined;
    const uri = typeof item.uri === "string" ? item.uri : undefined;
    const id = uri ?? name;
    if (!id?.trim()) throw new Error("Invalid MCP catalog response");
    return { id, kind, serverId, name, uri };
  });
}

/** Parse the prompt-arguments editor. A malformed value should read as a
 * form error next to the field, not as the raw JSON.parse message. */
export function parsePromptArguments(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    throw new Error("not an object");
  } catch {
    throw new Error(tr("提示参数不是有效的 JSON，请输入一个对象，例如 {\"key\":\"value\"}。"));
  }
}

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
  const confirmDialogRef = useRef<HTMLElement | null>(null);
  const confirmCancelRef = useRef<HTMLButtonElement | null>(null);
  useModalFocusScope({ open: confirm !== null, dialogRef: confirmDialogRef, initialFocusRef: confirmCancelRef });
  const mounted = useRef(false);
  const lifecycleGeneration = useRef(0);
  const refreshSequence = useRef(0);
  const isCurrent = (generation: number) => mounted.current && lifecycleGeneration.current === generation;
  const refresh = async (generation = lifecycleGeneration.current) => {
    if (!isCurrent(generation)) return;
    const sequence = ++refreshSequence.current;
    try {
      const response = await listResources("mcp");
      const rows = parseMcpServers(response.items);
      if (!isCurrent(generation) || sequence !== refreshSequence.current) return;
      setServers(rows);
      const next: Record<string, OAuthStatus> = {};
      await Promise.all(rows.filter(s => s.extra?.oauth || s.oauth).map(async s => {
        try {
          const status = parseOAuthStatus(await get<unknown>(`/api/mcp/${encodeURIComponent(s.id)}/oauth`));
          if (isCurrent(generation) && sequence === refreshSequence.current) next[s.id] = status;
        } catch { /* shown when an operator starts OAuth */ }
      }));
      if (isCurrent(generation) && sequence === refreshSequence.current) { setStatuses(next); setError(""); }
    } catch (e) {
      if (isCurrent(generation) && sequence === refreshSequence.current) setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    mounted.current = true;
    const generation = ++lifecycleGeneration.current;
    void refresh(generation);
    return () => { mounted.current = false; lifecycleGeneration.current += 1; refreshSequence.current += 1; };
  }, []);
  const action = async (fn: (isActionCurrent: () => boolean) => Promise<unknown>) => {
    const generation = lifecycleGeneration.current;
    const isActionCurrent = () => isCurrent(generation);
    if (!isActionCurrent()) return;
    setBusy(true); setError("");
    try {
      const value = await fn(isActionCurrent);
      if (!isActionCurrent()) return;
      setResult(JSON.stringify(value, null, 2));
      await refresh(generation);
    } catch (e) {
      if (isActionCurrent()) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (isActionCurrent()) setBusy(false);
    }
  };
  const discover = (server: Server, kind: "resources" | "prompts") => setConfirm(() => async () => action(async isActionCurrent => {
    const response = await post<unknown>(`/api/mcp/${encodeURIComponent(server.id)}/${kind}`, { confirmed: true });
    const catalogItems = parseMcpCatalog(response, kind, server.id);
    if (isActionCurrent()) setCatalog(catalogItems);
    return response;
  }));
  const readEntry = (server: Server, item: { id: string; kind: string }) => setConfirm(() => async () => action(async () => {
    const args = item.kind === "prompts" ? parsePromptArguments(argumentText) : {};
    return post(`/api/mcp/${encodeURIComponent(server.id)}/${item.kind}/read`, { confirmed: true, key: item.id, arguments: args });
  }));
  return <section className="xn-mcp-tools" data-testid="mcp-management">
    <header><div><h3>{tr("MCP 管理与诊断")}</h3><p>{tr("只有点击并确认后才连接服务器、读取资源或提示。")}</p></div><button type="button" onClick={() => void refresh(lifecycleGeneration.current)}>{tr("刷新")}</button></header>
    {error && <p role="alert">{error}</p>}
    {!servers.length && <p>{tr("暂无 MCP 配置，请先在上方添加。")}</p>}
    {servers.map(server => {
      const oauth = server.extra?.oauth ?? server.oauth;
      const flow = links[server.id];
      return <article key={server.id}><header><strong>{server.name ?? server.id}</strong><code>{server.id}</code></header>
        {oauth && <div className="xn-mcp-tools__row">
          <span>{statuses[server.id]?.authorized ? tr("OAuth 已授权") : tr("OAuth 未授权")}</span>
          <button type="button" disabled={busy} onClick={() => void action(async isActionCurrent => {
            const data = parseOAuthStart(await post<unknown>(`/api/mcp/${encodeURIComponent(server.id)}/oauth/start`, {}));
            if (isActionCurrent()) setLinks(prev => ({ ...prev, [server.id]: data }));
            const url = new URL(data.authorizationUrl);
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
    {confirm && <div className="xn-marketplace__backdrop"><section
      ref={confirmDialogRef}
      tabIndex={-1}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="xn-mcp-confirm-title"
      aria-describedby="xn-mcp-confirm-description"
      onKeyDown={event => {
        if (event.key !== "Escape") return;
        if (!shouldDismissModalOnEscape(event, busy)) { event.stopPropagation(); return; }
        event.preventDefault(); event.stopPropagation(); setConfirm(null);
      }}
    ><h3 id="xn-mcp-confirm-title">{tr("确认 MCP 操作")}</h3><p id="xn-mcp-confirm-description">{tr("将连接所选服务器并执行此只读目录或内容请求。")}</p><div><button ref={confirmCancelRef} type="button" onClick={() => setConfirm(null)}>{tr("取消")}</button><button type="button" disabled={busy} onClick={() => { const fn = confirm; setConfirm(null); void fn(); }}>{tr("确认")}</button></div></section></div>}
  </section>;
}
