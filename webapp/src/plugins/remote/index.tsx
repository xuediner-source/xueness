import React, { useEffect, useRef, useState } from "react";
import { get, post } from "../../xuenessApi";
import { t as tr } from "../../i18n";
import { OperationHeader } from "../shared";
import { IconTerminal, IconRefresh } from "../../ui/icons";

type Connection = { id: string; host: string; user: string; port: number; directory: string; digest: string };
type ConnectionFields = { id: string; host: string; user: string; port: number; directory: string };

const blank = (): ConnectionFields => ({ id: "", host: "", user: "", port: 22, directory: "." });

const FIELDS = [
  ["id", "连接名称", "office"],
  ["host", "主机地址", "example.internal"],
  ["user", "SSH 用户", "deploy"],
  ["directory", "远程目录", "~/projects/app"],
] as const;

export function parseRemoteConnections(payload: unknown): Connection[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid remote connections response");
  const rows = (payload as Record<string, unknown>).connections;
  if (!Array.isArray(rows)) throw new Error("Invalid remote connections response");
  return rows.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Invalid remote connections response");
    const value = row as Record<string, unknown>;
    const port = value.port === undefined ? 22 : value.port;
    const directory = value.directory === undefined ? "." : value.directory;
    if (typeof value.id !== "string" || typeof value.host !== "string" || typeof value.user !== "string"
      || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535
      || typeof directory !== "string" || typeof value.digest !== "string") {
      throw new Error("Invalid remote connections response");
    }
    return { id: value.id, host: value.host, user: value.user, port, directory, digest: value.digest };
  });
}

export function RemoteConnections({ onUse }: { onUse: (id: string) => void }) {
  const [items, setItems] = useState<Connection[]>([]);
  const [fields, setFields] = useState(blank);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(false);
  const lifecycleGeneration = useRef(0);
  const refreshSequence = useRef(0);

  const isCurrent = (generation: number) => mounted.current && lifecycleGeneration.current === generation;
  const refresh = async (generation = lifecycleGeneration.current) => {
    if (!isCurrent(generation)) return;
    const sequence = ++refreshSequence.current;
    const payload = await get<unknown>("/api/remote");
    const connections = parseRemoteConnections(payload);
    if (isCurrent(generation) && sequence === refreshSequence.current) setItems(connections);
  };

  useEffect(() => {
    mounted.current = true;
    const generation = ++lifecycleGeneration.current;
    setLoading(true);
    refresh(generation)
      .catch(reason => { if (isCurrent(generation)) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (isCurrent(generation)) setLoading(false); });
    return () => { mounted.current = false; lifecycleGeneration.current += 1; refreshSequence.current += 1; };
  }, []);

  const save = async () => {
    const generation = lifecycleGeneration.current;
    if (!isCurrent(generation)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await post("/api/remote", fields);
      if (!isCurrent(generation)) return;
      await refresh(generation);
      if (isCurrent(generation)) setNotice(tr("连接已保存"));
    } catch (reason) {
      if (isCurrent(generation)) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (isCurrent(generation)) setBusy(false);
    }
  };

  return <section className="xn-operations" data-testid="remote-connections">
    <OperationHeader icon={<IconTerminal size={22} />} title={tr("SSH 工作区")} description={tr("选择远程任务目录，使用主机已有的 SSH 身份和已信任主机记录。")} />
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="xn-model-layout">
      <div className="xn-model-library" aria-busy={loading}>
        <div className="xn-operation-section-heading">
          <h3>{tr("已保存的连接")}</h3>
          <button type="button" aria-label={tr("刷新连接列表")} disabled={loading || busy} onClick={() => { const generation = lifecycleGeneration.current; void refresh(generation).catch(reason => { if (isCurrent(generation)) setError(reason instanceof Error ? reason.message : String(reason)); }); }}>
            <IconRefresh size={14} />
          </button>
        </div>
        {loading && <p role="status">{tr("正在加载连接…")}</p>}
        {!loading && !items.length && <p>{tr("还没有任何 SSH 连接，使用右侧表单添加第一个。")}</p>}
        {items.map(item => <article key={item.id} className="xn-operation-card">
          <h3>{item.id}</h3>
          <p>{item.user}@{item.host}:{item.port}</p>
          <code>{item.directory}</code>
          <div className="xn-operations-actions">
            <button type="button" disabled={busy} onClick={() => setFields({ id: item.id, host: item.host, user: item.user, port: item.port ?? 22, directory: item.directory ?? "." })}>{tr("编辑")}</button>
            <button type="button" className="xn-operation-primary" disabled={busy} onClick={() => onUse(item.id)}>{tr("用于新任务")}</button>
          </div>
        </article>)}
      </div>
      <form className="xn-operation-card xn-model-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
        <h3>{tr("连接详情")}</h3>
        {FIELDS.map(([key, label, placeholder]) => <label key={key}>{tr(label)}
          <input aria-label={tr(label)} placeholder={placeholder} required disabled={busy} value={fields[key]} onChange={event => setFields({ ...fields, [key]: event.target.value })} />
        </label>)}
        <label>{tr("端口")}
          <input type="number" min={1} max={65535} required aria-label={tr("端口")} disabled={busy} value={fields.port} onChange={event => setFields({ ...fields, port: Number(event.target.value) })} />
        </label>
        <div className="xn-operations-actions">
          <button className="xn-operation-primary" disabled={busy}>{tr("保存连接")}</button>
          <button type="button" disabled={busy} onClick={() => { setFields(blank()); setError(""); setNotice(""); }}>{tr("清空表单")}</button>
        </div>
      </form>
    </div>
  </section>;
}
