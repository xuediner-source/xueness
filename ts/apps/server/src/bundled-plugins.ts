/**
 * TypeScript plugins shipped with the server, dependencies first. Only the
 * plugins listed here load; `npm run check:plugins` keeps this list, the
 * `plugins/` directory and every plugin's manifest and imports in agreement.
 */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import { files } from "@xueness/plugin-files";
import { shell } from "@xueness/plugin-shell";
import { providers } from "@xueness/plugin-providers";
import { sessions } from "@xueness/plugin-sessions";
import { workflows } from "@xueness/plugin-workflows";
import { automation } from "@xueness/plugin-automation";
import { commands } from "@xueness/plugin-commands";
import { settings } from "@xueness/plugin-settings";
import { planning } from "@xueness/plugin-planning";
import { git } from "@xueness/plugin-git";
import { mcp } from "@xueness/plugin-mcp";
import { skills } from "@xueness/plugin-skills";
import { hooks } from "@xueness/plugin-hooks";
import { subagents } from "@xueness/plugin-subagents";
import { memory } from "@xueness/plugin-memory";
import { office } from "@xueness/plugin-office";
import { browser } from "@xueness/plugin-browser";
import { network } from "@xueness/plugin-network";
import { extensions } from "@xueness/plugin-extensions";
import { diagnostics } from "@xueness/plugin-diagnostics";
import { tools } from "@xueness/plugin-tools";
import { terminal } from "@xueness/plugin-terminal";
import { updates } from "@xueness/plugin-updates";
import { desktop } from "@xueness/plugin-desktop";
import { usage } from "@xueness/plugin-usage";
import modelMonitorManifest from "../../../plugins/model_monitor/manifest.json" with { type: "json" };
import { onboarding } from "@xueness/plugin-onboarding";
import { remote } from "@xueness/plugin-remote";
import { bots } from "@xueness/plugin-bots";
import subscriptionsManifest from "../../../plugins/subscriptions/manifest.json" with { type: "json" };
import workbuddyManifest from "../../../plugins/workbuddy/manifest.json" with { type: "json" };
import { nativeOps } from "@xueness/plugin-native_ops";
import { batchCalls } from "@xueness/plugin-batch_calls";
import { osCua } from "@xueness/plugin-os_cua";
import { contextLens } from "@xueness/plugin-context_lens";
import { deepseekHarness } from "@xueness/plugin-deepseek_harness";

// Metadata reserves each reviewed plugin's UI and route ownership. Executable
// sources and assets are absent from the desktop until a verified download.
const modelMonitor: BundledPlugin = { manifest: modelMonitorManifest, plugin: definePlugin({ name: "model_monitor", apply() {} }) };
const subscriptions: BundledPlugin = { manifest: subscriptionsManifest, plugin: definePlugin({ name: "subscriptions", apply() {} }) };
const workbuddy: BundledPlugin = { manifest: workbuddyManifest, plugin: definePlugin({ name: "workbuddy", apply() {} }) };

export const BUNDLED_TS_PLUGINS: readonly BundledPlugin[] = Object.freeze([files, shell, providers, sessions, commands, settings, planning, git, mcp, skills, hooks, subagents, memory, network, remote, workflows, office, browser, extensions, diagnostics, tools, terminal, updates, desktop, usage, modelMonitor, onboarding, bots, subscriptions, automation, workbuddy, nativeOps, batchCalls, osCua, deepseekHarness, contextLens]);
