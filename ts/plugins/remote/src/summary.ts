/** Read-only remote summary attached to a session index row. No SSH. */
import { isDict } from "@xueness/contracts";
import { isPyOSError, isPyValueError } from "@xueness/sessions";
import { forget_dir, lookup, pluginEnabled } from "./connection-state.ts";
import { digest, loadConnections, type RemoteConnection } from "./store.ts";

const CONNECTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const PHASES = new Set(["pending", "reconnecting", "connected", "disconnected"]);

export interface RemoteSummary {
  connectionId: string;
  configuration: "configured" | "changed" | "missing" | "unsupported" | "unavailable";
  connectionState: "pending" | "reconnecting" | "connected" | "disconnected" | "unknown";
}

function isReadError(error: unknown): boolean {
  if (isPyValueError(error) || isPyOSError(error) || error instanceof TypeError || error instanceof RangeError) return true;
  const name = error instanceof Error ? error.name : "";
  return name === "RemoteValueError" || name === "JSONDecodeError" || name === "UnicodeError" || name === "UnicodeDecodeError" || name === "RecursionError" || name === "PermissionError";
}

function systemOf(row: RemoteConnection): unknown {
  return Object.hasOwn(row, "system") ? row.system : "posix";
}

/**
 * One saved-configuration read per index request.
 * `for_session` is Python `SessionRemoteSummary.for_session`.
 */
export class SessionRemoteSummary {
  private enabled: boolean;
  private loaded = false;
  private connections: Map<string, [string, unknown]> | null = null;

  private readonly stateDir: unknown;
  constructor(stateDir: unknown) {
    this.stateDir = stateDir;
    this.enabled = typeof stateDir === "string" && stateDir.length > 0 && pluginEnabled(stateDir, "remote");
  }

  /** Projection stored on `row.remote` and `row.sidecar.remote`, or null when unbound. */
  for_session(session: { remote_connection?: unknown }): RemoteSummary | null {
    const binding = session?.remote_connection;
    if (!this.enabled || !isDict(binding) || !exactBinding(binding)) return null;
    if (!this.loaded) {
      if (typeof this.stateDir !== "string" || !pluginEnabled(this.stateDir, "remote")) {
        this.enabled = false;
        forget_dir(this.stateDir);
        return null;
      }
      this.loaded = true;
      try {
        this.connections = new Map(loadConnections(this.stateDir).map((row) => [row.id, [digest(row), systemOf(row)]]));
      } catch (error) {
        if (!isReadError(error)) throw error;
        this.connections = null;
      }
    }
    const configuration = this.configuration(binding);
    return { connectionId: binding.id, configuration, connectionState: this.connectionState(binding, configuration) };
  }

  private connectionState(binding: { id: string; digest: string }, configuration: RemoteSummary["configuration"]): RemoteSummary["connectionState"] {
    if (configuration !== "configured" || typeof this.stateDir !== "string") return "unknown";
    const observed = lookup(this.stateDir, binding.id, binding.digest);
    return observed != null && PHASES.has(observed) ? observed as RemoteSummary["connectionState"] : "unknown";
  }

  private configuration(binding: { id: string; digest: string }): RemoteSummary["configuration"] {
    if (this.connections == null) return "unavailable";
    const current = this.connections.get(binding.id);
    if (current == null) return "missing";
    const [saved, system] = current;
    if (system !== "posix") return "unsupported";
    return saved === binding.digest ? "configured" : "changed";
  }
}

function exactBinding(binding: Record<string, unknown>): binding is { id: string; digest: string } {
  const keys = Object.keys(binding);
  return keys.length === 2 && typeof binding.id === "string" && CONNECTION_ID.test(binding.id)
    && typeof binding.digest === "string" && DIGEST.test(binding.digest);
}
