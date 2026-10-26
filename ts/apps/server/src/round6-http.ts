/**
 * Round-6 owners: remote connections, the Telegram inbox and subscription
 * accounts. Besides their HTTP families this module hands the composer,
 * sessions and providers the readers they take from these plugins.
 */
import { createBotsHttp } from "@xueness/plugin-bots";
import type { ComposerRemotePort } from "@xueness/plugin-sessions";
import type { ExternalProfiles, ProfileStore } from "@xueness/plugin-providers";
import { connectionPhase, createRemoteHttp, preparedRemote, publicConnections, remoteConnection, SessionRemoteSummary } from "@xueness/plugin-remote";
import { createSubscriptions } from "@xueness/plugin-subscriptions";
import { createWorkbuddy, PROFILE_PREFIX } from "@xueness/plugin-workbuddy";
import type { FileLockProvider, Session, SessionStore } from "@xueness/sessions";
import { packageInstalled } from "./plugin-state.ts";

type Row = Record<string, unknown>;
type Reply = [number, unknown, string?] | null;

export interface Round6Options {
  stateDir: string;
  projectDir: string;
  enabled(id: string): boolean;
  store: SessionStore;
  locks: FileLockProvider;
  /** Subscription records join the saved provider profiles through this store. */
  providers: ProfileStore;
  createRoots(): readonly string[];
  env: NodeJS.ProcessEnv;
}

export function createRound6(o: Round6Options) {
  const { stateDir, enabled } = o;
  const remoteHttp = createRemoteHttp({ stateDir, enabled, projectDir: o.projectDir, locks: o.locks });
  const botsHttp = createBotsHttp({ stateDir, enabled, store: o.store, createRoots: o.createRoots, env: o.env, locks: o.locks });
  const subscriptions = createSubscriptions({ stateDir, enabled: () => enabled("subscriptions"), installed: () => packageInstalled(stateDir, "subscriptions", "xueness-subscriptions"), env: o.env });
  const workbuddy = createWorkbuddy({ stateDir, enabled, env: o.env });
  // `ProfileStore.external` is one slot, and each view answers only for the ids
  // it owns, so the two are merged instead of one shadowing the other.
  const external: ExternalProfiles = {
    list: () => [...subscriptions.profiles.list(), ...workbuddy.profiles.list()],
    record: (id) => workbuddy.profiles.record(id) ?? subscriptions.profiles.record(id),
    resolve: (record, selection) => String(record.id ?? "").startsWith(PROFILE_PREFIX)
      ? workbuddy.profiles.resolve(record, selection)
      : subscriptions.profiles.resolve(record, selection),
    supplier: (record) => workbuddy.profiles.supplier(record) ?? subscriptions.profiles.supplier(record),
  };
  o.providers.external = external;
  const handlers = [remoteHttp, botsHttp, subscriptions.http, workbuddy.http];
  const composerRemote: ComposerRemotePort = { connections: () => publicConnections(stateDir), state: (id, digest) => connectionPhase(stateDir, id, digest) };
  return {
    routes: handlers.flatMap((handler) => handler.routes),
    owns: (method: string, parts: readonly string[]): boolean => handlers.some((handler) => handler.owns(method, parts)),
    async dispatch(method: string, parts: readonly string[], query: Record<string, unknown>, data: unknown): Promise<Reply> {
      for (const handler of handlers) if (handler.owns(method, parts)) return handler.dispatch(method, parts, query, data);
      return null;
    },
    composerRemote,
    preparedRemote: (prepared: Row) => preparedRemote(stateDir, prepared),
    checkRemote: (remote: Row) => remoteConnection(stateDir, remote.id, remote.digest),
    remoteSummary: (session: Session) => new SessionRemoteSummary(stateDir).for_session(session) as Row | null,
    subscriptions,
    close(): Promise<void> { remoteHttp.close(); workbuddy.close(); return subscriptions.close(); },
  };
}
