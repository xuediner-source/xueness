/**
 * Plugin views that appear both as a settings section and as a workbench
 * panel (or the sidebar footer). Each is declared once so a view loaded in
 * one place renders without a second suspense in the other. Views only load
 * when a permitted section or panel mounts them.
 */
import { lazy } from "react";

export const CapabilitiesPanel = lazy(() => import('../../XuenessCapabilitiesPanel').then(module => ({ default: module.CapabilitiesPanel })));
export const DesktopUpdates = lazy(() => import("../updates/DesktopUpdates").then(module => ({ default: module.DesktopUpdates })));
export const ModelManager = lazy(() => import("../providers").then(module => ({ default: module.ModelManager })));
export const SubscriptionsPanel = lazy(() => import('../subscriptions').then(module => ({ default: module.SubscriptionsPanel })));
export const WorkbuddySettingsPanel = lazy(() => import('../workbuddy/WorkbuddySettings').then(module => ({ default: module.WorkbuddySettingsPanel })));
export const ModelMonitorPanel = lazy(() => import('../model_monitor').then(module => ({ default: module.ModelMonitorPanel })));
export const RemoteConnections = lazy(() => import("../remote").then(module => ({ default: module.RemoteConnections })));
export const XuenessMarketplace = lazy(() => import("../extensions").then(module => ({ default: module.XuenessMarketplace })));
export const XuenessAutomationsPanel = lazy(() => import("../automation").then(module => ({ default: module.XuenessAutomationsPanel })));
export const XuenessMcpTools = lazy(() => import("../mcp").then(module => ({ default: module.XuenessMcpTools })));
export const XuenessDiagnosticsPanel = lazy(() => import("../diagnostics").then(module => ({ default: module.XuenessDiagnosticsPanel })));
export const XuenessUsageSettings = lazy(() => import("../usage/XuenessUsageSettings").then(module => ({ default: module.XuenessUsageSettings })));
