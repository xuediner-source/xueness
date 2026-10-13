import React, { useEffect, useRef, useState } from "react";
import { Check, Cpu, Feather, LoaderCircle, RefreshCw } from "lucide-react";
import { listRuntimeProfiles, selectRuntimeProfile, type RuntimeCatalog, type RuntimeProfile } from "../../xuenessApi";
import { t as tr, tf } from "../../i18n";
import "./runtimes.css";

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function profileIcon(id: string) {
  return id === "pi-lite" ? Feather : Cpu;
}

const CAPABILITY_LABELS: Record<string, string> = {
  "xueness-app-server": "完整会话工作台",
  "xueness-session": "持久会话",
  "xueness-events": "实时事件",
  commands: "命令与审批",
  stream: "流式输出",
  replay: "断线恢复",
  "xueness-agent-loop": "轻量 Agent 循环",
  tools: "工具调用",
};

export function runtimeCapabilityLabel(capability: string): string {
  return CAPABILITY_LABELS[capability] ?? capability;
}

export function RuntimeProfileCard({
  profile,
  disabled,
  onSelect,
}: {
  profile: RuntimeProfile;
  disabled: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const Icon = profileIcon(profile.id);
  return <article className={`xn-runtimes__card${profile.active ? " is-active" : ""}`} data-runtime={profile.id}>
    <div className="xn-runtimes__card-heading">
      <span className="xn-runtimes__icon"><Icon size={18} aria-hidden="true" /></span>
      {profile.active && <span className="xn-runtimes__badge"><Check size={12} aria-hidden="true" />{tr("当前模式")}</span>}
    </div>
    <h3>{tr(profile.name)}</h3>
    <p>{tr(profile.description)}</p>
    <div className="xn-runtimes__capabilities">
      {profile.capabilities.map(capability => <span key={capability}>{tr(runtimeCapabilityLabel(capability))}</span>)}
    </div>
    <button type="button" disabled={disabled || profile.active} onClick={onSelect}>
      {profile.active ? tr("已选择") : tr("使用此模式")}
    </button>
  </article>;
}

export function RuntimeSettingsPanel(): React.JSX.Element {
  const [catalog, setCatalog] = useState<RuntimeCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0);

  const load = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = ++sequence.current;
    setLoading(true);
    setError("");
    try {
      const next = await listRuntimeProfiles(controller.signal);
      if (mounted.current && !controller.signal.aborted && current === sequence.current) setCatalog(next);
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted && current === sequence.current) setError(errorText(reason));
    } finally {
      if (request.current === controller) request.current = null;
      if (mounted.current && !controller.signal.aborted && current === sequence.current) setLoading(false);
    }
  };

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      sequence.current += 1;
      request.current?.abort();
      request.current = null;
    };
  }, []);

  const choose = async (profile: RuntimeProfile) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const current = ++sequence.current;
    setBusy(profile.id);
    setError("");
    setNotice("");
    try {
      const next = await selectRuntimeProfile(profile.id, controller.signal);
      if (mounted.current && !controller.signal.aborted && current === sequence.current) {
        setCatalog(next);
        setNotice(tf("已切换到 {0}。新会话将使用该运行时。", [tr(profile.name)]));
      }
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted && current === sequence.current) setError(errorText(reason));
    } finally {
      if (request.current === controller) request.current = null;
      if (mounted.current && !controller.signal.aborted && current === sequence.current) setBusy(null);
    }
  };

  return <section className="xn-runtimes" data-testid="runtime-settings-panel">
    <header className="xn-runtimes__header">
      <div>
        <h2>{tr("运行时模式")}</h2>
        <p>{tr("用同一套 Xueness 工作台切换完整 Agent 交互或本地轻量模型循环。")}</p>
      </div>
      <button type="button" className="xn-runtimes__refresh" onClick={() => void load()} disabled={loading || busy !== null} aria-busy={loading}>
        {loading ? <LoaderCircle size={14} className="is-spinning" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
        {tr("刷新")}
      </button>
    </header>
    {error && <p className="xn-runtimes__error" role="alert">{tr("运行时操作失败：")}{error}</p>}
    {notice && <p className="xn-runtimes__notice" role="status">{notice}</p>}
    {loading && !catalog ? <p className="xn-runtimes__loading" role="status">{tr("正在加载运行时…")}</p> : (
      <div className="xn-runtimes__grid">
        {(catalog?.profiles ?? []).map(profile => <RuntimeProfileCard key={profile.id} profile={profile} disabled={loading || busy !== null} onSelect={() => void choose(profile)} />)}
      </div>
    )}
    <p className="xn-runtimes__footnote">{tr("完整模式保留完整的会话、工具和审批工作流；轻量模式优先服务本地部署模型，并通过同一 JSONL 协议传输。")}</p>
  </section>;
}
