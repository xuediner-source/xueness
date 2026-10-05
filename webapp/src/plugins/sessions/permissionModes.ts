/** 与 sessions/plan_mode.PERMISSION_MODES 对齐的唯一前端取值。 */
export const PERMISSION_MODES = ["build", "edit", "yolo", "plan"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}
