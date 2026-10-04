import React from 'react';
import { XuenessComposerToolbar } from '../sessions/XuenessComposerToolbar';
import type { ComposerModel } from '../../xuenessComposer';
import type { RunChoices } from '../../xuenessBridge';
import type { WorkbenchSession } from '../../xuenessWorkbench';

/**
 * 轻量档极简工作台（providers 插件功能）。
 *
 * 参照 Pi coding agent 的单栏极简形态：选中本地轻量档时只保留与本地模型运行
 * 直接相关的界面。这里只拥有轻量档的展示策略（显示什么、隐藏什么、上下文
 * 用量如何从运行预算得出）；通用输入框与工具条组件仍归 sessions 插件，容器
 * 只负责在轻量/标准档之间切换挂载。
 */

export type LightweightContextUsage = { used: number; max: number };

/** 会话运行预算中的估算输入与输入预算；没有真实可用的数值时不编造用量。 */
export function lightweightContextUsage(
  budget: WorkbenchSession['runtime_budget'],
): LightweightContextUsage | undefined {
  const used = budget?.estimatedInputTokens;
  const max = budget?.inputBudgetTokens;
  const usable = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0;
  return usable(used) && usable(max) ? { used, max } : undefined;
}

/** 轻量极简布局只在 providers 插件生效且当前运行档位为轻量时启用。 */
export function lightweightLayoutActive(
  runtimeProfile: string | null | undefined,
  providersEffective: boolean,
): boolean {
  return providersEffective && runtimeProfile === 'lightweight';
}

export type LightweightComposerControlsProps = {
  /** Fail-closed：providers 插件未生效时不渲染任何轻量档界面。 */
  enabled: boolean;
  choices: RunChoices;
  onChange(patch: Partial<RunChoices>): void;
  models: ComposerModel[];
  loading: boolean;
  error: string;
  onReload(): void;
  onManageModels(): void;
  runtimeBudget?: WorkbenchSession['runtime_budget'];
  pauseReason?: string | null;
  disabled?: boolean;
};

/**
 * 轻量档输入框控制区：只保留模型名（菜单内含「标准 / 本地轻量」切换，用于
 * 切回标准档）与上下文用量。模式、浏览器、后台任务、思考强度等通用工具条
 * 全部隐藏；用量为估算读数，不打开用量面板。
 */
export function LightweightComposerControls({
  enabled,
  choices,
  onChange,
  models,
  loading,
  error,
  onReload,
  onManageModels,
  runtimeBudget,
  pauseReason,
  disabled = false,
}: LightweightComposerControlsProps): React.JSX.Element | null {
  if (!enabled) return null;
  return <XuenessComposerToolbar
    minimal
    choices={choices}
    onChange={onChange}
    models={models}
    loading={loading}
    error={error}
    onReload={onReload}
    onManageModels={onManageModels}
    contextUsage={lightweightContextUsage(runtimeBudget)}
    runtimeBudget={runtimeBudget}
    pauseReason={pauseReason}
    disabled={disabled}
  />;
}
