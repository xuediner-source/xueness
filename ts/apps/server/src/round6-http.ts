/**
 * Round-6 owners: remote connections, the Telegram inbox and subscription
 * accounts. Besides their HTTP families this module hands the composer,
 * sessions and providers the readers they take from these plugins.
 */
import { createBotsHttp } from "@xueness/plugin-bots";
import type { ComposerRemotePort } from "@xueness/plugin-sessions";
import type { ExternalProfiles, ProfileStore } from "@xueness/plugin-providers";
import { connectionPhase, createRemoteHttp, preparedRemote, publicConnections, remoteConnection, SessionRemoteSummary } from "@xueness/plugin-remote";
import type { FileLockProvider, Session, SessionStore } from "@xueness/sessions";
import { createOptionalAccounts } from "./optional-integrations.ts";

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
  const optional = createOptionalAccounts(o);
  o.providers.external = optional.profiles;
  const handlers = [remoteHttp, botsHttp, ...optional.handlers];
  const composerRemote: ComposerRemotePort = { connections: () => publicConnections(stateDir), state: (id, digest) => connectionPhase(stateDir, id, digest) };
  return {
    routes: handlers.flatMap((handler) => handler.routes),
    owns: (method: string, parts: readonly string[]): boolean => handlers.some((handler) => handler.owns(method, parts)),
    async dispatch(method: string, parts: readonly string[], query: Record<string, string[]>, data: Record<string, unknown>): Promise<Reply> {
      for (const handler of handlers) if (handler.owns(method, parts)) return handler.dispatch(method, parts, query, data);
      return null;
    },
    composerRemote,
    preparedRemote: (prepared: Row) => preparedRemote(stateDir, prepared),
    checkRemote: (remote: Row) => remoteConnection(stateDir, remote.id, remote.digest),
    remoteSummary: (session: Session) => new SessionRemoteSummary(stateDir).for_session(session) as Row | null,
    bindSession: optional.bindSession,
    syncOptional: optional.sync,
    close(): Promise<void> { remoteHttp.close(); return optional.close(); },
  };
}
