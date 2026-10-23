/**
 * The composer and `/command` owners, bound to the feature plugins they read:
 * skills, git branches, saved models, command files and plugin manifests.
 * Plugins never import each other, so the front door supplies each reader.
 */
import { createCommandsApi, expandCommand, loadCommands } from "@xueness/plugin-commands";
import { BUNDLED_SKILLS_DIR, listAll, pythonCatalog, readSkill } from "@xueness/plugin-skills";
import { branchCatalog, GitError, switchBranch } from "@xueness/plugin-git";
import { composerModels, CONFIGURATION_GUIDANCE, resolveSavedProvider, type ProfileStore } from "@xueness/plugin-providers";
import { expandUser } from "@xueness/plugin-settings";
import { ComposerError, createComposerApi, type ComposerRemotePort } from "@xueness/plugin-sessions";
import type { SessionStore } from "@xueness/sessions";
import { loadManifests } from "./manifests.ts";

export interface ComposerFeatureOptions {
  projectRoot: string;
  projectDir: string;
  stateDir: string;
  webRuns: string;
  store: SessionStore;
  providers: ProfileStore;
  running: ReadonlySet<string>;
  enabled(id: string): boolean;
  allowedRoots(): readonly string[];
  defaultRoot(): string;
  allowReal: boolean;
  env: NodeJS.ProcessEnv;
  /** Skills shipped with the TypeScript skills plugin; `null` lists none, as Python does. */
  bundledSkills?: string | null;
  /** Saved SSH targets and their live phases, from the remote plugin. */
  remote?: ComposerRemotePort;
}

export function createComposerFeatures(o: ComposerFeatureOptions) {
  const manifests = loadManifests(o.projectRoot) as unknown as Record<string, unknown>[];
  const manifestCommands = new Set(manifests.flatMap((item) => Array.isArray(item.commands) ? item.commands.filter((name): name is string => typeof name === "string") : []));
  const ids = manifests.map((item) => String(item.id));
  const bundled = o.bundledSkills === undefined ? BUNDLED_SKILLS_DIR : o.bundledSkills;
  const commands = createCommandsApi({ stateDir: o.stateDir, webRuns: o.webRuns, projectDir: o.projectDir, enabled: o.enabled, allowedRoots: o.allowedRoots, manifestCommands, env: o.env });
  const composer = createComposerApi({ store: o.store, stateDir: o.stateDir, webRuns: o.webRuns, projectDir: o.projectDir, enabled: o.enabled,
    allowedRoots: o.allowedRoots, defaultRoot: o.defaultRoot, expandUser, allowReal: o.allowReal, running: o.running,
    // `plugin_runtime.catalog`: effective plugins in manifest order.
    plugins: () => manifests.filter((item) => o.enabled(String(item.id))).map((item) => ({ id: String(item.id), name: item.name, description: item.description })),
    allPluginIds: () => ids,
    skillsCatalog: () => pythonCatalog(listAll(o.stateDir, null, true, bundled).skills),
    readSkill: (sid) => readSkill(o.stateDir, sid, null, bundled),
    models: () => composerModels(o.providers, o.env),
    resolveModel: (providerId, model, effort) => resolveSavedProvider(o.providers, { providerId, model, reasoningEffort: effort }),
    configurationGuidance: CONFIGURATION_GUIDANCE,
    ...o.remote ? { remote: o.remote } : {},
    expand(text, root, language) {
      const [expanded, invocation] = expandCommand(loadCommands({ stateDir: o.stateDir, root, language, manifestCommands, env: o.env }), text, o.env);
      return { text: String(expanded), invocation };
    },
    async gitCatalog(root) {
      try { return await branchCatalog(root); } catch (error) { if (error instanceof GitError) return null; throw error; }
    },
    async switchBranch(root, branch) {
      try { return await switchBranch(root, branch); } catch (error) { throw error instanceof GitError ? new ComposerError(error.status, error.message) : error; }
    },
  });
  return { commands, composer };
}
