import React, { useEffect, useState } from "react";
import { post } from "../../xuenessApi";
import { t as tr } from "../../i18n";
import { OperationHeader } from "../shared";
import { IconTerminal } from "../../ui/icons";

type Connection = { id: string; host: string; user: string; port: number; directory: string; digest: string };
const blank = () => ({ id: "", host: "", user: "", port: 22, directory: "." });
export function RemoteConnections({ onUse }: { onUse: (id: string) => void }) {
  const [items, setItems] = useState<Connection[]>([]);
  const [fields, setFields] = useState(blank);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    const response = await fetch("/api/remote", { credentials: "same-origin", cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    setItems(payload.connections ?? []);
  };
  useEffect(() => { void refresh().catch(reason => setError(String(reason))); }, []);
  return <section className="xn-operations">
    <OperationHeader icon={<IconTerminal size={22} />} title={tr("SSH 工作区")} description={tr("选择远程任务目录，使用主机已有的 SSH 身份和已信任主机记录。")} />
    {error && <p role="alert">{error}</p>}
    <div className="xn-model-layout"><div className="xn-model-library">
      {items.map(item => <article key={item.id} className="xn-operation-card"><h3>{item.id}</h3><p>{item.user}@{item.host}:{item.port}</p><code>{item.directory}</code><div className="xn-operations-actions">
        <button type="button" disabled={busy} onClick={() => setFields({ id: item.id, host: item.host, user: item.user, port: item.port ?? 22, directory: item.directory ?? "." })}>{tr("编辑")}</button>
        <button type="button" className="xn-operation-primary" disabled={busy} onClick={() => onUse(item.id)}>{tr("用于新任务")}</button>
      </div></article>)}
      {!items.length && <p>{tr("添加第一个 SSH 连接")}</p>}
    </div><form className="xn-operation-card xn-model-editor" onSubmit={event => {
      event.preventDefault(); setBusy(true); setError("");
      void post("/api/remote", fields).then(refresh).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false));
    }}>
      {([['id','连接名称'],['host','主机地址'],['user','SSH 用户'],['directory','远程目录']] as const).map(([key,label]) => <label key={key}>{tr(label)}<input aria-label={tr(label)} required disabled={busy} value={fields[key]} onChange={event => setFields({ ...fields, [key]: event.target.value })} /></label>)}
      <label>{tr("端口")}<input type="number" min={1} max={65535} required aria-label={tr("端口")} disabled={busy} value={fields.port} onChange={event => setFields({ ...fields, port: Number(event.target.value) })} /></label>
      <button className="xn-operation-primary" disabled={busy}>{tr("保存连接")}</button>
    </form></div>
  </section>;
}
