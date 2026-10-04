import React, { useEffect, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import {
  applyPluginProfile,
  listPluginProfiles,
  type PluginProfileApplyResult,
  type PluginProfileRow,
} from "../../xuenessApi";
import { t as tr, tf } from "../../i18n";
import "../../styles/marketplace.css";

/** The tier the local lightweight runtime asks for; the name is backend data. */
export const LIGHTWEIGHT_TIER = "lightweight";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The lightweight hint appears only while another tier is selected: it offers one
 * click to the profile the local lightweight runtime is meant to run with.
 */
export function lightweightTierHint(profiles: PluginProfileRow[], active: string | null): PluginProfileRow | null {
  if (active === LIGHTWEIGHT_TIER) return null;
  return profiles.find(row => row.name === LIGHTWEIGHT_TIER) ?? null;
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
  const hint = lightweightTierHint(profiles, active);
  return <div className="xn-marketplace__grid" data-testid="plugin-profile-list">
    {profiles.map(row => {
      const current = row.active;
      return <div className="xn-marketplace__card" key={row.name} data-profile={row.name}>
        <div className="xn-marketplace__card-main">
          <div className="xn-marketplace__card-copy">
            <div className="xn-marketplace__card-title-row">
              <strong className="xn-marketplace__card-title">{row.name}</strong>
              <span className="xn-marketplace__version">{tf("{0} 个插件开启", [row.enabled.length])}</span>
            </div>
            <p className="xn-marketplace__description">{row.description || tr("未提供说明。")}</p>
            {row.extends.length > 0 && <p className="xn-marketplace__muted">{tf("继承 {0}", [row.extends.join(" → ")])}</p>}
          </div>
          <button
            type="button"
            className={current ? "xn-marketplace__button-secondary" : "xn-marketplace__button-primary"}
            disabled={disabled || current || busy !== null}
            onClick={() => onApply(row)}
          >
            {busy === row.name && <LoaderCircle size={13} className="is-spinning" aria-hidden="true" />}
            {current ? tr("当前档位") : tr("切换到此档位")}
          </button>
        </div>
      </div>;
    })}
    {hint && <p className="xn-marketplace__safety" data-testid="plugin-profile-hint">
      {tr("本地轻量档建议改用 minimal 之上的 lightweight 组合，只保留离线可用的能力。")}
      <button
        type="button"
        className="xn-marketplace__button-secondary"
        disabled={disabled || busy !== null}
        onClick={() => onApply(hint)}
      >
        {busy === hint.name && <LoaderCircle size={13} className="is-spinning" aria-hidden="true" />}
        {tf("切换到 {0}", [hint.name])}
      </button>
    </p>}
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
  return <section className="xn-marketplace" data-testid="plugin-profile-picker">
    <header className="xn-marketplace__header">
      <div>
        <h3>{tr("插件组合档位")}</h3>
        <p>{tr("profile 只是一张插件开关的数据清单：显式开关优先于档位，档位优先于默认值；切换不会改动工作区、审批或权限模式。")}</p>
      </div>
      <button type="button" className="xn-marketplace__refresh" disabled={loading || busy !== null} onClick={() => void load()}>
        {loading ? <LoaderCircle size={14} className="is-spinning" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}{tr("刷新")}
      </button>
    </header>
    <p className="xn-marketplace__count">{active ? tf("当前档位：{0}", [active]) : tr("当前未选择档位")}</p>
    {error && <p className="xn-marketplace__error" role="alert">{tr("档位操作失败：")}{error}</p>}
    {note && <p className="xn-marketplace__muted">{note}</p>}
    {profiles.length === 0 && !loading
      ? <p className="xn-marketplace__empty">{tr("没有可用的组合档位。")}</p>
      : <PluginProfileList profiles={profiles} active={active} busy={busy} disabled={loading} onApply={row => void apply(row)} />}
  </section>;
}
