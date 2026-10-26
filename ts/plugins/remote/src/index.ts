/**
 * The remote plugin on TS (Python `bundled_plugins/remote`): named SSH
 * connections, approval-gated `remote_exec`, the live connection owner behind
 * `/api/remote`, session-list summaries and the remote-session tool boundary.
 * The stdio `app-server` a remote host runs belongs to the CLI (roadmap step 9).
 */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
import { remoteExecTool } from "./tool.ts";
import type { SshRunner } from "./exec.ts";

export { digest, keepSavedSystem, loadConnections, persisted, posixOrThrow, saveConnections, sshArgv, sshEnv, validateConnection, WINDOWS_REMOTE_ERROR, type RemoteConnection } from "./store.ts";
export { COMMAND_TIMEOUT_SECONDS, posixQuote, prepareRemote, remoteCommand, runRemoteExec, type RemoteExecArgs, type SshRunner } from "./exec.ts";
export { cliLocalFailure, cliPayload } from "./handshake.ts";
export { REMOTE_EXEC_DESCRIPTION, remoteExecTool } from "./tool.ts";
export { RemoteError, SessionClient, TransportError } from "./client.ts";
export { ConnectionManager, getManager, RemoteKeyError, RemoteValueError, resetManagerForTests, type RemoteManager } from "./manager.ts";
export { lookup as connectionPhase, pluginEnabled, registerEnabled } from "./connection-state.ts";
export { SessionRemoteSummary, type RemoteSummary } from "./summary.ts";
export { createRemoteHttp, publicConnections, REMOTE_ROUTES, type RemoteHttpOptions } from "./http.ts";
export { REMOTE_ALLOWED_TOOLS, remoteDenied, remoteLocalTools, remoteSessionExtension } from "./session-guard.ts";
export { preparedRemote, remoteConnection } from "./prepared.ts";
export { AppProtocolError, type AppProtocolPort } from './app-protocol-types.ts';
export { createAppProtocolCore } from './app-protocol-core.ts';
export { createAppProtocolControls } from './app-protocol-controls.ts';
export { createAppProtocolMedia } from './app-protocol-media.ts';
export { createAppProtocolGoals } from './app-protocol-goal.ts';
export { createAppProtocolMemory } from './app-protocol-memory.ts';
export { AppProtocolDeferredReply, AppProtocolSubscriptions } from './app-protocol-subscriptions.ts';
export {
  CONTROLLER_TOMBSTONES, FINISHED_TASKS, HYDRATION_SCHEMA, WORKFLOW_EVENTS,
  hydrateBackgroundTask, hydrateConversation, hydrateMediaRestore, hydrateWorkflow, hydrateWorkspace,
  hydrationDigest, type BackgroundTaskView, type BackgroundTasksView, type ConversationView,
  type MediaRestoreView, type WorkflowView, type WorkspaceView,
} from './app-protocol-hydration.ts';
export {
  ESTABLISH_GRACE_MS, MAX_FORWARDS, PORT_FORWARD_SCHEMA, PortForwardManager,
  forwardArgv, validateForwardSpec, type ForwardSpec, type ForwardView, type PortForwardOptions,
} from './forwarding.ts';
export {
  connectionDiagnostics, describeDiagnostic, detectWsl, fromWslPosixPath, toWslPosixPath,
  type PathDiagnostic, type WslMode, type WslProbe,
} from './wsl.ts';

export { ProjectionSubscriber, type ProjectionCursor, type ProjectionFrame, type ProjectionKind, type SubscriptionState } from './projection-subscriber.ts';

export { DEFAULT_REPLAY_DEADLINE_SECONDS, outcomeUnknown, replayCommand, settledReceipt, RECEIPT_STATUSES, type CommittedReplay, type ReplayOutcome, type UnknownReplay } from './command-replay.ts';

export { createV4Facade, V4_PROTOCOL_NAME, V4_TO_NATIVE_ROUTES, v4HostCapabilities, type V4Facade, type V4FacadeOptions } from './v4-facade.ts';

export function createRemote(options: { stateDir: string; runner?: SshRunner }): BundledPlugin {
  return { manifest, plugin: definePlugin({ name: "remote", apply(ctx) { ctx.tool(remoteExecTool(options)); } }) };
}

export const remote = createRemote({ stateDir: "." });
export const remotePlugin = remote.plugin;
