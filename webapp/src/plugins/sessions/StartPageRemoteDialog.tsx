import React, { useEffect, useMemo, useRef, useState } from "react";
import { Cloud, Search, X } from "lucide-react";
import { messages, t as tr } from "../../i18n";
import { get } from "../../xuenessApi";
import "./StartPageRemoteDialog.css";
import { connectRemote, type RemoteSessionAdapter } from "../remote/remoteSessionAdapter";

// Loaded with this chunk so startup catalog does not carry dialog phrases.
messages["搜索远程连接"] = "Search remote connections";
messages["没有匹配的远程连接"] = "No matching remote connections";
messages["管理连接"] = "Manage connections";
messages["当前工作区"] = "Current workspace";
messages["连接远程工作区"] = "Connect remote workspace";
messages["已保存的远程连接"] = "Saved remote connections";
messages["重连"] = "Reconnect";

export type RemoteConnectionInfo = {
  id: string;
  label?: string;
  host?: string;
  user?: string;
  port?: number;
  directory?: string;
  digest?: string;
  connectionState?: string;
  connected?: boolean;
};

export type StartPageRemoteDialogProps = {
  open: boolean;
  onClose(): void;
  onSelectRemote(remoteId: string, adapter: RemoteSessionAdapter): void;
  currentRemoteId?: string | null;
  connections?: readonly RemoteConnectionInfo[] | null;
  onManageRemote?(): void;
  allowRemote?: boolean;
};

export function filterRemoteConnections(
  items: readonly RemoteConnectionInfo[] | null | undefined,
  query = "",
): RemoteConnectionInfo[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!items) return [];
  if (!needle) return [...items];
  return items.filter((item) => {
    const text = `${item.id} ${item.label ?? ""} ${item.host ?? ""} ${item.user ?? ""} ${item.directory ?? ""}`.toLocaleLowerCase();
    return text.includes(needle);
  });
}

export function StartPageRemoteDialog({
  open,
  onClose,
  onSelectRemote,
  currentRemoteId,
  connections = [],
  onManageRemote,
  allowRemote = true,
}: StartPageRemoteDialogProps): React.JSX.Element | null {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const pendingRef = useRef<AbortController | null>(null);
  useEffect(() => { if (!open || !allowRemote) pendingRef.current?.abort(); }, [open, allowRemote]);
  useEffect(() => () => pendingRef.current?.abort(), []);
  const close = () => { pendingRef.current?.abort(); onClose(); };
  const connect = async (item: RemoteConnectionInfo) => {
    if (pendingRef.current) return;
    if (!item.digest) { setError('Connection configuration must be refreshed before connecting.'); return; }
    const controller = new AbortController(); pendingRef.current = controller;
    setPending(item.id); setError('');
    try {
      const adapter = await connectRemote(item.id, item.digest, controller.signal, () => undefined);
      if (!controller.signal.aborted) { onSelectRemote(item.id, adapter); onClose(); }
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (pendingRef.current === controller) { pendingRef.current = null; setPending(null); } }
  };
  const [query, setQuery] = useState("");
  const [fetchedItems, setFetchedItems] = useState<RemoteConnectionInfo[] | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || !allowRemote) return;
    let cancelled = false;
    void get<unknown>("/api/remote")
      .then((payload) => {
        if (cancelled || !payload || typeof payload !== "object") return;
        const rows = (payload as Record<string, unknown>).connections;
        if (!Array.isArray(rows)) return;
        const parsed: RemoteConnectionInfo[] = rows.map((raw) => {
          const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
          return {
            id: typeof item.id === "string" ? item.id : "",
            host: typeof item.host === "string" ? item.host : "",
            user: typeof item.user === "string" ? item.user : "",
            port: typeof item.port === "number" ? item.port : 22,
            directory: typeof item.directory === "string" ? item.directory : ".",
            digest: typeof item.digest === "string" ? item.digest : "",
          };
        }).filter((item) => item.id.length > 0);
        setFetchedItems(parsed);
      })
      .catch(() => {
        // Fall back to initial connections prop on error.
      });
    return () => {
      cancelled = true;
    };
  }, [open, allowRemote]);

  const items = useMemo<RemoteConnectionInfo[]>(() => {
    const map = new Map<string, RemoteConnectionInfo>();
    for (const item of connections ?? []) {
      if (item?.id) map.set(item.id, { ...item });
    }
    for (const item of fetchedItems ?? []) {
      if (!item?.id) continue;
      const existing = map.get(item.id);
      map.set(item.id, {
        ...existing,
        ...item,
        connectionState: existing?.connectionState ?? item.connectionState,
        connected: existing?.connected ?? item.connected,
      });
    }
    return Array.from(map.values());
  }, [connections, fetchedItems]);

  const visible = useMemo(() => filterRemoteConnections(items, query), [items, query]);

  if (!open || !allowRemote) return null;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  };

  return (
    <div
      className="xn-dialog-overlay"
      onClick={close}
      role="presentation"
      data-testid="start-page-remote-backdrop"
    >
      <div
        className="xn-dialog xn-remote-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={tr("连接远程工作区")}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
        data-testid="start-page-remote-dialog"
      >
        <div className="xn-remote-dialog__header">
          <div className="xn-remote-dialog__title-group">
            <Cloud size={18} aria-hidden="true" />
            <h2 className="xn-dialog__title" style={{ margin: 0 }}>{tr("连接远程工作区")}</h2>
          </div>
          <button
            type="button"
            className="xn-dialog__close"
            onClick={close}
            aria-label={tr("关闭")}
            data-testid="remote-close-btn"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {pending && <p role="status" data-testid="remote-connect-progress">Connecting {pending}…</p>}
        {error && <p role="alert" data-testid="remote-connect-error">{error}</p>}
        <div className="xn-remote-dialog__search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="search"
            value={query}
            placeholder={tr("搜索远程连接")}
            aria-label={tr("搜索远程连接")}
            data-testid="remote-connection-search"
            onChange={(event) => setQuery(event.currentTarget.value)}
            autoFocus
          />
        </div>

        <div
          className="xn-remote-dialog__list"
          role="listbox"
          aria-label={tr("已保存的远程连接")}
        >
          {visible.map((item) => {
            const isCurrent = item.id === currentRemoteId;
            const isDisconnected = item.connectionState === "disconnected" || item.connected === false;
            return (
              <div
                key={item.id}
                className="xn-remote-dialog__item"
                data-testid={`remote-connection-item-${item.id}`}
                role="option"
                aria-selected={isCurrent}
              >
                <div className="xn-remote-dialog__item-info">
                  <div className="xn-remote-dialog__item-title">
                    <strong>{item.id}</strong>
                    {item.connectionState && item.connectionState !== "unknown" && (
                      <span className="xn-remote-dialog__badge" data-connection-state={item.connectionState}>
                        {item.connectionState === "disconnected"
                          ? tr("已断开")
                          : item.connectionState === "connected"
                            ? tr("已连接")
                            : item.connectionState === "reconnecting"
                              ? tr("正在重连")
                              : tr("正在连接")}
                      </span>
                    )}
                    {isCurrent && (
                      <span className="xn-remote-dialog__badge xn-remote-dialog__badge--current">
                        {tr("当前工作区")}
                      </span>
                    )}
                  </div>
                  <div className="xn-remote-dialog__item-meta">
                    <span>{item.user ? `${item.user}@${item.host}:${item.port ?? 22}` : (item.label ?? item.id)}</span>
                    {item.directory && <code>{item.directory}</code>}
                  </div>
                </div>
                <div className="xn-remote-dialog__item-actions">
                  {isDisconnected ? (
                    <button
                      type="button"
                      className="xn-btn xn-btn--sm xn-btn--secondary"
                      data-testid={`remote-reconnect-btn-${item.id}`}
                      disabled={pending !== null}
                      onClick={() => void connect(item)}
                    >
                      {tr("重连")}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={`xn-btn xn-btn--sm ${isCurrent ? "xn-btn--secondary" : "xn-btn--primary"}`}
                      data-testid={`remote-connect-btn-${item.id}`}
                      disabled={pending !== null}
                      onClick={() => void connect(item)}
                    >
                      {isCurrent ? tr("当前工作区") : tr("连接")}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {visible.length === 0 && (
            <p className="xn-start-page__workspace-empty">{tr("没有匹配的远程连接")}</p>
          )}
        </div>

        <div className="xn-dialog__actions xn-remote-dialog__footer">
          {onManageRemote && (
            <button
              type="button"
              className="xn-btn xn-btn--md xn-btn--secondary"
              data-testid="remote-manage-btn"
              onClick={onManageRemote}
            >
              {tr("管理连接")}
            </button>
          )}
          <button
            type="button"
            className="xn-btn xn-btn--md xn-btn--secondary"
            data-testid="remote-cancel-btn"
            onClick={close}
          >
            {tr("取消")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default StartPageRemoteDialog;
