import React from "react";
import { t as tr } from "../../i18n";
import { SettingsGroup, SettingsRow } from "../settings/SettingsPrimitives";
import type { SettingsMap } from "../../xuenessSettings";

export function SessionExperimentSettings({ values, disabled = false, onUpdate }: {
  values: SettingsMap; disabled?: boolean; onUpdate?: (key: string, value: unknown) => unknown;
}): React.ReactElement {
  const toggle = (key: string, label: string) => <input type="checkbox" role="switch" className="xn-settings-switch"
    aria-label={tr(label)} checked={values[key] === true} disabled={disabled || !onUpdate}
    onChange={event => { void onUpdate?.(key, event.currentTarget.checked); }} />;
  return <SettingsGroup title={tr("会话实验功能")} description={tr("实验功能默认关闭，可独立开启。") }>
    <SettingsRow label={tr("增量事件游标")} description={tr("启用带版本校验的事件分页接口；历史发生变化时要求重新同步。")}
      control={toggle("sessionsEventsCursorEnabled", "增量事件游标")} />
    <SettingsRow label={tr("结构化问题答复")} description={tr("显示独立答复表单，校验问题编号并防止重复提交；同时支持标准和轻量模式。")}
      control={toggle("sessionsAnswerQuestionEnabled", "结构化问题答复")} />
  </SettingsGroup>;
}
