import React from "react";
import { t as tr } from "../../i18n";
import { SettingsGroup, SettingsRow } from "../settings/SettingsPrimitives";
import type { SettingsMap } from "../../xuenessSettings";

export function SessionExperimentSettings({ values, disabled = false, onUpdate }: {
  values: SettingsMap; disabled?: boolean; onUpdate?: (key: string, value: unknown) => unknown;
}): React.ReactElement {
  const toggle = (key: string, label: string, checked: boolean) => <input type="checkbox" role="switch" className="xn-settings-switch"
    aria-label={tr(label)} aria-checked={checked} checked={checked} disabled={disabled || !onUpdate}
    onChange={event => { void onUpdate?.(key, event.currentTarget.checked); }} />;
  // `sessions.auto_title` is not an experiment: like the desktop notifications
  // switch it defaults on (`values.sessionsAutoTitleEnabled !== false`), so it
  // lives in its own group instead of the default-off experiments card.
  return <>
    <SettingsGroup title={tr("会话自动命名")} description={tr("首个回答完成后自动生成简短标题，手动重命名优先。")}>
      <SettingsRow label={tr("自动命名")} control={toggle("sessionsAutoTitleEnabled", "自动命名", values.sessionsAutoTitleEnabled !== false)} />
    </SettingsGroup>
    <SettingsGroup title={tr("会话实验功能")} description={tr("实验功能默认关闭，可独立开启。")}>
      <SettingsRow label={tr("立即停止模型与工具请求")} description={tr("停止时中断正在进行的请求并保留已收到的内容；关闭时等待当前请求结束。")}
        control={toggle("sessionsCancelPropagateEnabled", "立即停止模型与工具请求", values.sessionsCancelPropagateEnabled === true)} />
      <SettingsRow label={tr("增量事件游标")} description={tr("启用带版本校验的事件分页接口；历史发生变化时要求重新同步。")}
        control={toggle("sessionsEventsCursorEnabled", "增量事件游标", values.sessionsEventsCursorEnabled === true)} />
      <SettingsRow label={tr("结构化问题答复")} description={tr("显示独立答复表单，校验问题编号并防止重复提交；同时支持标准和轻量模式。")}
        control={toggle("sessionsAnswerQuestionEnabled", "结构化问题答复", values.sessionsAnswerQuestionEnabled === true)} />
    </SettingsGroup>
  </>;
}
