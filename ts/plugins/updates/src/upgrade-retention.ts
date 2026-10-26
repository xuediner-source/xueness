/**
 * F14.04 — upgrade / portable / plugin-skill migration retention checks.
 * Verifies that an isolated "old user state" directory keeps session and
 * config summaries, that credentials stay under the user state root, and that
 * default-optional plugin enablement rules survive a simulated upgrade.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const RETENTION_SCHEMA = "xueness.upgrade-retention.v1";

export interface UserStateSnapshot {
  sessionsSummary: { count: number; latestId: string | null };
  configSummary: { schemaVersion: number | null; defaultModel: string | null };
  credentials: { path: string; present: boolean; insideStateRoot: boolean };
  plugins: { id: string; enabled: boolean; optional: boolean }[];
}

export interface RetentionReport {
  schema: string;
  round: "F14.04";
  recordedAt: string;
  stateRoot: string;
  before: UserStateSnapshot;
  after: UserStateSnapshot;
  gates: {
    sessionsPreserved: boolean;
    configPreserved: boolean;
    credentialsInsideState: boolean;
    optionalPluginsUnchanged: boolean;
  };
  pass: boolean;
}

function readJson(path: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; }
  catch { return null; }
}

export function snapshotUserState(stateRoot: string): UserStateSnapshot {
  const root = resolve(stateRoot);
  const sessions = readJson(join(root, "sessions", "index.json"));
  const config = readJson(join(root, "config.json"));
  const credPath = join(root, "credentials", "providers.json");
  const pluginsDoc = readJson(join(root, "plugins.json"));
  const sessionList = Array.isArray(sessions?.sessions) ? sessions!.sessions as Array<{ id?: string }> : [];
  const plugins = Array.isArray(pluginsDoc?.plugins)
    ? (pluginsDoc!.plugins as Array<{ id: string; enabled?: boolean; optional?: boolean }>).map((p) => ({
      id: p.id, enabled: p.enabled === true, optional: p.optional === true,
    }))
    : [];
  return {
    sessionsSummary: {
      count: sessionList.length,
      latestId: sessionList.length ? String(sessionList[sessionList.length - 1]?.id ?? "") || null : null,
    },
    configSummary: {
      schemaVersion: typeof config?.schemaVersion === "number" ? config.schemaVersion : null,
      defaultModel: typeof config?.defaultModel === "string" ? config.defaultModel : null,
    },
    credentials: {
      path: credPath,
      present: existsSync(credPath),
      insideStateRoot: relative(root, credPath) === "" || (!relative(root, credPath).startsWith("..") && !isAbsolute(relative(root, credPath))),
    },
    plugins,
  };
}

/** Simulate a portable upgrade: rewrite config schema bump while preserving sessions/creds/plugins. */
export function simulateUpgrade(stateRoot: string): void {
  const root = resolve(stateRoot);
  const configPath = join(root, "config.json");
  const config = readJson(configPath) ?? {};
  const next = { ...config, schemaVersion: Number(config.schemaVersion ?? 0) + 1, upgradedAt: new Date().toISOString() };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n");
}

export function seedLegacyUserState(stateRoot: string): void {
  const root = resolve(stateRoot);
  mkdirSync(join(root, "sessions"), { recursive: true });
  mkdirSync(join(root, "credentials"), { recursive: true });
  writeFileSync(join(root, "sessions", "index.json"), JSON.stringify({
    sessions: [{ id: "ses-1" }, { id: "ses-2" }],
  }));
  writeFileSync(join(root, "config.json"), JSON.stringify({
    schemaVersion: 1, defaultModel: "GLM-5.3",
  }));
  writeFileSync(join(root, "credentials", "providers.json"), JSON.stringify({
    profiles: [{ id: "local", apiKey: "sk-test" }],
  }));
  writeFileSync(join(root, "plugins.json"), JSON.stringify({
    plugins: [
      { id: "remote", enabled: true, optional: false },
      { id: "os_cua", enabled: false, optional: true },
      { id: "network", enabled: true, optional: true },
    ],
  }));
}

export function buildRetentionReport(stateRoot: string, now = () => new Date()): RetentionReport {
  const before = snapshotUserState(stateRoot);
  simulateUpgrade(stateRoot);
  const after = snapshotUserState(stateRoot);
  const optionalBefore = before.plugins.filter((p) => p.optional).map((p) => `${p.id}:${p.enabled}`).sort();
  const optionalAfter = after.plugins.filter((p) => p.optional).map((p) => `${p.id}:${p.enabled}`).sort();
  const gates = {
    sessionsPreserved: before.sessionsSummary.count === after.sessionsSummary.count
      && before.sessionsSummary.latestId === after.sessionsSummary.latestId,
    configPreserved: before.configSummary.defaultModel === after.configSummary.defaultModel
      && (after.configSummary.schemaVersion ?? 0) >= (before.configSummary.schemaVersion ?? 0),
    credentialsInsideState: after.credentials.present && after.credentials.insideStateRoot,
    optionalPluginsUnchanged: JSON.stringify(optionalBefore) === JSON.stringify(optionalAfter),
  };
  return {
    schema: RETENTION_SCHEMA,
    round: "F14.04",
    recordedAt: now().toISOString(),
    stateRoot: resolve(stateRoot),
    before, after, gates,
    pass: gates.sessionsPreserved && gates.configPreserved && gates.credentialsInsideState && gates.optionalPluginsUnchanged,
  };
}
