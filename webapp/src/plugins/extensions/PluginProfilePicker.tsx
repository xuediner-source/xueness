import React, { useEffect, useState } from "react";
import { Check, Feather, Layers, LoaderCircle, RefreshCw, Zap } from "lucide-react";
import {
  applyPluginProfile,
  listPluginProfiles,
  type PluginProfileApplyResult,
  type PluginProfileRow,
} from "../../xuenessApi";
import { getLocale, t as tr, tf } from "../../i18n";
import "./PluginProfilePicker.css";

/** The tier the local lightweight runtime asks for; the name is backend data. */
export const LIGHTWEIGHT_TIER = "lightweight";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const builtInOrder = ["minimal", LIGHTWEIGHT_TIER, "standard"];

function profilePresentation(row: PluginProfileRow) {
  if (row.source === "built-in") {
    if (row.name === "minimal") return { name: tr("精简"), description: tr("保留会话、文件与命令行，专注基础任务。"), Icon: Feather };
    if (row.name === LIGHTWEIGHT_TIER) return { name: tr("本地轻量"), description: tr("在精简档位上加入 Git、记忆、命令与技能。"), Icon: Zap };
    if (row.name === "standard") return { name: tr("完整功能"), description: tr("开启默认功能，包含工作流、子代理与联网工具。"), Icon: Layers };
  }
  return { name: row.name, description: (getLocale() === "en" ? row.descriptionEn || row.description : row.description) || tr("未提供说明。"), Icon: Layers };
}

/** How many plugin switches a tier just moved; warnings are counted, not obeyed. */
export function profileChangeSummary(result: PluginProfileApplyResult): string {
  if (result.dryRun) return tf("预演：将切换 {0} 个插件开关", [result.changes.length]);
  return tf("已切换 {0} 个插件开关", [result.changes.length]);
}

export function PluginProfileList({
  profiles,
  active,
  busy,
  disabled = false,
  onApply,
}: {
  profiles: PluginProfileRow[];
  active: string | null;
  busy: string | null;
  disabled?: boolean;
  onApply(row: PluginProfileRow): void;
}): React.JSX.Element {
  const ordered = [...profiles].sort((a, b) => {
    const index = (row: PluginProfileRow) => row.source === "built-in" && builtInOrder.includes(row.name)
      ? builtInOrder.indexOf(row.name) : builtInOrder.length;
    return index(a) - index(b);
  });
  return <div className="xn-plugin-profiles__grid" data-testid="plugin-profile-list">
    {ordered.map(row => {
      const current = row.name === active;
      const { name, description, Icon } = profilePresentation(row);
      return <article className={`xn-plugin-profiles__card${current ? " is-current" : ""}`} key={row.name} data-profile={row.name}>
        <div className="xn-plugin-profiles__card-heading">
          <span className="xn-plugin-profiles__icon"><Icon size={19} aria-hidden="true" /></span>
          {current && <span className="xn-plugin-profiles__badge"><Check size={12} aria-hidden="true" />{tr("当前档位")}</span>}
          {!current && row.source === "built-in" && row.name === LIGHTWEIGHT_TIER && <span className="xn-plugin-profiles__badge">{tr("本地模型推荐")}</span>}
        </div>
        <h4>{name}</h4>
        <p className="xn-plugin-profiles__description">{description}</p>
        <div className="xn-plugin-profiles__card-footer">
          <span>{tf("{0} 个插件", [row.enabled.length])}</span>
          <button
            type="button"
            disabled={disabled || current || busy !== null}
            aria-label={tf("使用{0}档位", [name])}
            onClick={() => onApply(row)}
          >
            {busy === row.name && <LoaderCircle size={13} className="is-spinning" aria-hidden="true" />}
            {current ? tr("已选择") : tr("使用此档位")}
          </button>
        </div>
      </article>;
    })}
  </div>;
}

/**
 * Composition profile picker (extensions plugin feature).
 *
 * A profile is pure data — allowlisted plugin ids and booleans — so this panel only
 * asks the host to select one and reports what changed. It loads and acts solely
 * while the owning plugin is effective: with `enabled` false it renders nothing and
 * issues no request, keeping a disabled feature free of background work.
 */
export function PluginProfilePicker({
  enabled,
  onCatalogChanged,
}: {
  enabled: boolean;
  onCatalogChanged?: () => void;
}): React.JSX.Element | null {
  const [profiles, setProfiles] = useState<PluginProfileRow[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await listPluginProfiles();
      setProfiles(payload.profiles);
      setActive(payload.active);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled]);

  const apply = async (row: PluginProfileRow) => {
    setBusy(row.name);
    setError("");
    setNote("");
    try {
      const result = await applyPluginProfile(row.name);
      setNote(profileChangeSummary(result)
        + (result.warnings.length > 0 ? tf("；{0} 项提示", [result.warnings.length]) : ""));
      await load();
      onCatalogChanged?.();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(null);
    }
  };

  // Fail closed: a disabled owner shows nothing and asks the host for nothing.
  if (!enabled) return null;
  return <section className="xn-plugin-profiles" data-testid="plugin-profile-picker">
    <header className="xn-plugin-profiles__header">
      <div>
        <h3>{tr("插件组合档位")}</h3>
        <p>{tr("按使用场景选择功能组合，模型连接与推理参数保持不变。")}</p>
      </div>
      <button type="button" className="xn-plugin-profiles__refresh" disabled={loading || busy !== null} onClick={() => void load()}>
        {loading ? <LoaderCircle size={14} className="is-spinning" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}{tr("刷新")}
      </button>
    </header>
    {error && <p className="xn-plugin-profiles__error" role="alert">{tr("档位操作失败：")}{error}</p>}
    {note && <p className="xn-plugin-profiles__note" role="status">{note}</p>}
    {profiles.length === 0 && !loading
      ? <p className="xn-plugin-profiles__note" role="status">{tr("没有可用的组合档位。")}</p>
      : <PluginProfileList profiles={profiles} active={active} busy={busy} disabled={loading} onApply={row => void apply(row)} />}
    <p className="xn-plugin-profiles__footnote">{tr("手动设置的插件开关优先；切换不会改动工作区或审批权限。")}</p>
  </section>;
}
