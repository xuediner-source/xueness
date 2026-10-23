/** A kernel with the bundled file and shell plugins, a scratch workspace and a bridge over them. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolEnv, type ToolEnv } from "@xueness/engine-tools";
import { Context, PluginHost, type BundledPlugin, type Plugin } from "@xueness/kernel";
import { PermissionSession, type PermissionSettings } from "@xueness/permissions";
import { files } from "@xueness/plugin-files";
import { shell } from "@xueness/plugin-shell";
import { ToolBridge, type Approver, type ToolEventDiagnostic } from "@xueness/tool-bridge";

export interface Setup {
  kernel: Context;
  host: PluginHost;
  workspace: string;
  artifacts: string;
  env: ToolEnv;
  permissions: PermissionSession;
  bridge: ToolBridge;
  close(): Promise<void>;
}

export interface SetupOptions {
  settings?: PermissionSettings;
  approver?: Approver;
  plugins?: BundledPlugin[];
  config?: Record<string, Record<string, unknown>>;
  eventTimeoutMs?: number;
  onDiagnostic?: (entry: ToolEventDiagnostic) => void;
}

export async function setup(options: SetupOptions = {}): Promise<Setup> {
  const workspace = mkdtempSync(join(tmpdir(), "xueness-bridge-ws-"));
  const artifacts = mkdtempSync(join(tmpdir(), "xueness-bridge-art-"));
  const kernel = Context.create();
  const host = new PluginHost(kernel, [files, shell, ...(options.plugins ?? [])], options.config ? { config: options.config } : {});
  for (const status of await host.start()) {
    if (status.state !== "active") throw new Error(`${status.id} is ${status.state}: ${status.error ?? status.issues.join("; ")}`);
  }
  const env = createToolEnv({ cwd: workspace, artifactsDir: artifacts, owner: "session-1" });
  const permissions = new PermissionSession(options.settings ?? {});
  const bridge = new ToolBridge({
    kernel, permissions, env,
    ...(options.approver ? { approver: options.approver } : {}),
    ...(options.eventTimeoutMs !== undefined ? { eventTimeoutMs: options.eventTimeoutMs } : {}),
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
  });
  return {
    kernel, host, workspace, artifacts, env, permissions, bridge,
    async close() {
      await host.dispose();
      await kernel.dispose();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(artifacts, { recursive: true, force: true });
    },
  };
}

/** A bundled test plugin whose code agrees with its manifest. */
export function testPlugin(id: string, fields: Record<string, unknown>, apply: (ctx: Context) => void): BundledPlugin {
  const manifest = { apiVersion: 2, id, name: id, description: `${id} test plugin`, version: "1.0.0", defaultEnabled: true, ...fields };
  const plugin: Plugin<any> = { name: id, apply };
  return { manifest, plugin };
}

/** Wait for a condition without timers (tests may mock them). */
export async function until(condition: () => boolean, rounds = 200_000): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition not reached");
}
