import React from "react";
import { PanelLeft, Sparkles } from "lucide-react";
import { t as tr } from "../../i18n";
import { normalizeColorPalette, type ColorPalettePreference } from "./themeBoot";
import "./appearance.css";

const APPEARANCES = [
  { id: "xueness", name: "Xueness", description: "中性配色，经典工作台", Icon: PanelLeft },
  { id: "claudex", name: "纸感", description: "温润纸色，简洁工作台", Icon: Sparkles },
] as const;

/** A miniature of the workbench drawn in the target appearance's own colours,
 * so the choice is made by looking rather than by reading. It follows the
 * current light/dark theme and is purely decorative (aria-hidden). */
function AppearancePreview({ palette }: { palette: ColorPalettePreference }): React.JSX.Element {
  return <span className="xn-appearance-preview" data-palette={palette} aria-hidden="true">
    <span className="xn-appearance-preview__side">
      <i className="xn-appearance-preview__brand" />
      <i /><i data-active="true" /><i />
    </span>
    <span className="xn-appearance-preview__sheet">
      <i className="xn-appearance-preview__bubble" />
      <i className="xn-appearance-preview__line" />
      <i className="xn-appearance-preview__line xn-appearance-preview__line--mid" />
      <i className="xn-appearance-preview__line xn-appearance-preview__line--short" />
      <span className="xn-appearance-preview__composer"><i /></span>
    </span>
  </span>;
}

export function AppearancePicker({ value, disabled, onChange }: {
  value: unknown;
  disabled: boolean;
  onChange: (value: ColorPalettePreference) => void;
}): React.JSX.Element {
  const selected = normalizeColorPalette(value);
  return <div className="xn-appearance-picker" role="radiogroup" aria-label={tr("外观")}>
    {APPEARANCES.map(({ id, name, description, Icon }) => <label key={id} className="xn-appearance-choice" data-selected={selected === id}>
      <input type="radio" name="xueness-appearance" value={id} checked={selected === id} disabled={disabled} onChange={() => onChange(id)} />
      <AppearancePreview palette={id} />
      <span className="xn-appearance-choice__row">
        <span className="xn-appearance-choice__icon"><Icon size={18} aria-hidden="true" /></span>
        <span className="xn-appearance-choice__copy"><strong>{tr(name)}</strong><span>{tr(description)}</span></span>
        <span className="xn-appearance-choice__check" aria-hidden="true" />
      </span>
    </label>)}
  </div>;
}
