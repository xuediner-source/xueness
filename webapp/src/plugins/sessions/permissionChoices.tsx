import type React from 'react';
import { ClipboardList, FilePenLine, Hand, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { PermissionMode } from './permissionModes';
const permissionChoiceMeta: Record<PermissionMode, {
  label: string;
  description: string;
  Icon: React.ComponentType<{ size?: number; className?: string }>;
}> = {
  plan: { label: "计划", description: "只读并先出计划。", Icon: ClipboardList },
  build: { label: "变更前确认", description: "改文件前先问我。", Icon: Hand },
  edit: { label: "自动编辑", description: "自动编辑文件，命令仍需确认。", Icon: FilePenLine },
  guarded: { label: '守护执行', description: '常规命令自动执行，已识别危险命令每次确认。', Icon: ShieldCheck },
  yolo: { label: "完全访问", description: "跳过全部审批与应用权限规则。", Icon: ShieldAlert },
};

/** 展示顺序。缺任一 PermissionMode 时下面的赋值无法通过类型检查。 */
const PERMISSION_DISPLAY_ORDER = ["plan", "build", "edit", "guarded", "yolo"] as const satisfies readonly PermissionMode[];
type _MissingPermissionMode = Exclude<PermissionMode, (typeof PERMISSION_DISPLAY_ORDER)[number]>;
const _permissionModesCovered: [_MissingPermissionMode] extends [never] ? true : never = true;
void _permissionModesCovered;

export const permissionChoices = PERMISSION_DISPLAY_ORDER.map((value) => ({
  value,
  ...permissionChoiceMeta[value],
}));
