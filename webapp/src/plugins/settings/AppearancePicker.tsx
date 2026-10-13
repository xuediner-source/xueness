import React from "react";
import { PanelLeft, PanelsTopLeft } from "lucide-react";
import { t as tr } from "../../i18n";
import { normalizeColorPalette, type ColorPalettePreference } from "./themeBoot";
import "./appearance.css";

const APPEARANCES = [
  { id: "xueness", name: "ZCode 工作台", description: "默认 · 项目侧栏、会话标签与工具停靠", Icon: PanelsTopLeft },
  { id: "claudex", name: "Codex 工作台", description: "图标导航、紧凑会话列表与居中首页", Icon: PanelLeft },
] as const;

export function AppearancePicker({ value, disabled, onChange }: {
  value: unknown;
  disabled: boolean;
  onChange: (value: ColorPalettePreference) => void;
}): React.JSX.Element {
  const selected = normalizeColorPalette(value);
  return <div className="xn-appearance-picker" role="radiogroup" aria-label={tr("外观")}>
    {APPEARANCES.map(({ id, name, description, Icon }) => <label key={id} className="xn-appearance-choice" data-selected={selected === id}>
      <input type="radio" name="xueness-appearance" value={id} checked={selected === id} disabled={disabled} onChange={() => onChange(id)} />
      <span className="xn-appearance-choice__icon"><Icon size={20} aria-hidden="true" /></span>
      <span className="xn-appearance-choice__copy"><strong>{tr(name)}</strong><span>{tr(description)}</span></span>
      <span className="xn-appearance-choice__check" aria-hidden="true" />
    </label>)}
  </div>;
}
