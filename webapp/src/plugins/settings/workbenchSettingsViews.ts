/**
 * Plugin views that appear both as a settings section and as a workbench
 * panel (or the sidebar footer). Each is declared once so a view loaded in
 * one place renders without a second suspense in the other. Views only load
 * when a permitted section or panel mounts them.
 */
import { lazy } from "react";
import { optionalComponent } from "../extensions/optionalFrontend";

export const CapabilitiesPanel = lazy(() => import('../../XuenessCapabilitiesPanel').then(module => ({ default: module.CapabilitiesPanel })));
export const DesktopUpdates = lazy(() => import("../updates/DesktopUpdates").then(module => ({ default: module.DesktopUpdates })));
export const ModelManager = lazy(() => import("../providers").then(module => ({ default: module.ModelManager })));
// Marketplace plugins: their interface comes from the package the user downloaded (see optionalFrontend.ts).
export const SubscriptionsPanel = optionalComponent<{ onChanged?: () => void; onSelectModel?: (id: string) => void; embedded?: boolean }>('subscriptions', 'SubscriptionsPanel');
export const WorkbuddySettingsPanel = optionalComponent<Record<string, never>>('workbuddy', 'WorkbuddySettingsPanel');
export const ModelMonitorPanel = optionalComponent<{ embedded?: boolean }>('model_monitor', 'ModelMonitorPanel');
export type TavernSessionRef = { plugin: 'tavern'; id: string };
export const TavernPanel = optionalComponent<{ onStart(text: string): void; onStartSession?(text: string, ref: TavernSessionRef): Promise<boolean>; onOpenSession?(id: string): void; onOpenPanel?(): void }>('tavern', 'TavernPanel');
export const RemoteConnections = lazy(() => import("../remote").then(module => ({ default: module.RemoteConnections })));
export const XuenessMarketplace = lazy(() => import("../extensions").then(module => ({ default: module.XuenessMarketplace })));
export const XuenessAutomationsPanel = lazy(() => import("../automation").then(module => ({ default: module.XuenessAutomationsPanel })));
export const XuenessMcpTools = lazy(() => import("../mcp").then(module => ({ default: module.XuenessMcpTools })));
export const XuenessDiagnosticsPanel = lazy(() => import("../diagnostics").then(module => ({ default: module.XuenessDiagnosticsPanel })));
export const SwarmPanel = lazy(() => import("../swarm/SwarmPanel").then(module => ({ default: module.SwarmPanel })));
export const XuenessUsageSettings = lazy(() => import("../usage/XuenessUsageSettings").then(module => ({ default: module.XuenessUsageSettings })));
