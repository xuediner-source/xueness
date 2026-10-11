import React from "react";
import { t as tr } from "../../i18n";
import { SettingsGroup, SettingsRow } from "../settings/SettingsPrimitives";
import type { SettingsMap } from "../../xuenessSettings";

/** The `desktop.notifications` switch. Default on: an unset value keeps the
 * feature enabled, matching `desktop/src/notifications.cjs` and the bridge. */
export function DesktopNotificationSettings({ values, disabled = false, onUpdate }: {
  values: SettingsMap; disabled?: boolean; onUpdate?: (key: string, value: unknown) => unknown;
}): React.ReactElement {
  return <SettingsGroup title={tr("桌面通知")} description={tr("任务等待审批、需要回答或运行结束时发送系统通知；点击通知可回到对应会话。仅桌面端生效。")}>
    <SettingsRow label={tr("系统通知")} description={tr("等待审批、提问和运行完成或失败时提醒。")}
      control={<input type="checkbox" role="switch" className="xn-settings-switch"
        aria-label={tr("系统通知")} checked={values.desktopNotificationsEnabled !== false}
        disabled={disabled || !onUpdate}
        onChange={event => { void onUpdate?.("desktopNotificationsEnabled", event.currentTarget.checked); }} />} />
  </SettingsGroup>;
}
