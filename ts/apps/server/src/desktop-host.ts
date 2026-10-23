#!/usr/bin/env node
/**
 * Desktop mode (Python `bundled_plugins/desktop/host.py`): the backend Electron starts.
 *
 *   node apps/server/src/desktop-host.ts [--project-root DIR] --data DIR [--assets DIR]
 *
 * `desktop/src/backend.cjs` speaks JSON lines over stdio. This process serves
 * the UI and API on a loopback port behind the desktop token, prints `ready`
 * with that origin, and relays the folder dialog, the permission guide and
 * update actions to Electron through `DesktopBridge`. It stops on `shutdown`,
 * at EOF, or on SIGTERM / SIGINT / SIGHUP; closing the API stops the
 * terminals, workers and MCP servers it started (`release_owned_processes`).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { isDict } from "@xueness/contracts";
import { createFrontDoor, type FrontDoor } from "./front-door.ts";
import { routeFamilies } from "./manifests.ts";
import { createApplicationApi, type DesktopBridgeLike } from "./application-api.ts";
import { CliExit, Parser } from "./cli/argparse.ts";

/** The 32-byte hex token `backend.cjs` generates. */
const DESKTOP_TOKEN = /^[0-9a-f]{64}$/;
const MAX_LINE = 65536;
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
type Row = Record<string, unknown>;

/** `DesktopBridge`: the private parent pipe for window-owned dialogs; no renderer-supplied paths. */
export class DesktopBridge implements DesktopBridgeLike {
  readonly #output: Writable;
  readonly #pending = new Map<string, (message: Row) => void>();
  #closed = false;

  constructor(output: Writable) { this.#output = output; }

  send(message: Row): void { this.#output.write(JSON.stringify(message) + "\n"); }

  #ask(build: (id: string) => Row, timeoutSeconds: number, timedOut: string): Promise<Row> {
    if (this.#closed) return Promise.reject(new Error("desktop host disconnected"));
    const id = randomUUID().replaceAll("-", "");
    return new Promise<Row>((answer, fail) => {
      const timer = setTimeout(() => { this.#pending.delete(id); fail(new Error(timedOut)); }, timeoutSeconds * 1000);
      this.#pending.set(id, (reply) => { clearTimeout(timer); this.#pending.delete(id); answer(reply); });
      try { this.send(build(id)); } catch (error) { clearTimeout(timer); this.#pending.delete(id); fail(error); }
    });
  }

  /** `choose_directory`: the chosen path, or null when the dialog was cancelled. */
  async chooseDirectory(initialRoot: string | null): Promise<string | null> {
    const result = await this.#ask((id) => ({ type: "dialog", id, initialRoot }), 600, "desktop directory picker timed out");
    if (result.error) throw new Error("desktop directory picker failed");
    const value = result.path;
    if (value != null && (typeof value !== "string" || [...value].length > 4096)) throw new Error("invalid desktop directory selection");
    return value ?? null;
  }

  /** Fixed feature actions (`update`, `permissions`); the caller validates the reply. */
  request(message: Row, timeoutSeconds = 30): Promise<Row> {
    return this.#ask((id) => ({ ...message, id }), timeoutSeconds, "desktop request timed out");
  }

  receive(message: Row): void {
    const answer = typeof message.id === "string" ? this.#pending.get(message.id) : undefined;
    answer?.(message);
  }

  close(): void {
    this.#closed = true;
    for (const answer of [...this.#pending.values()]) answer({ error: "disconnected" });
  }
}

export interface DesktopHostOptions {
  /** `--data DIR [--assets DIR] [--project-root DIR]`, as `backend.cjs` passes them. */
  argv: readonly string[];
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  input?: Readable;
  output?: Writable;
  /** Turn SIGTERM / SIGINT / SIGHUP into the same graceful stop as `shutdown`. */
  forwardSignals?: boolean;
  onListening?: (door: FrontDoor) => void;
}

const expand = (value: string): string => value === "~" || value.startsWith("~/") ? join(homedir(), value.slice(1)) : value;

export async function runDesktopHost(options: DesktopHostOptions): Promise<number> {
  const parser = new Parser("xueness-desktop-host");
  parser.add("--data", { required: true }).add("--assets", { default: null }).add("--project-root", { default: null });
  let args: Row;
  try { args = parser.parse(options.argv); } catch (error) { if (error instanceof CliExit) return error.code; throw error; }
  const env = options.env ?? process.env;
  // Popped like host.py: no child process inherits the parent's secret.
  const token = env.XUENESS_DESKTOP_TOKEN ?? "";
  delete env.XUENESS_DESKTOP_TOKEN;
  if (!DESKTOP_TOKEN.test(token)) throw new Error("desktop parent authentication is missing");
  env.XUENESS_DESKTOP_OWNER_PID = String(process.pid);
  const data = resolve(expand(String(args.data)));
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const project = join(data, "workspace");
  mkdirSync(project, { recursive: true });
  const projectRoot = resolve(args.project_root != null ? String(args.project_root) : options.projectRoot ?? DEFAULT_ROOT);
  const assets = args.assets != null ? resolve(String(args.assets)) : join(projectRoot, "webapp", "dist");
  const bridge = new DesktopBridge(options.output ?? process.stdout);
  const api = await createApplicationApi({ projectRoot, projectDir: project, stateDir: join(data, "state"), webRuns: join(data, "runs"),
    desktopToken: token, desktopBridge: bridge, webappDir: assets, allowReal: (env.XUENESS_ALLOW_REAL ?? "1") === "1", env });
  const door = createFrontDoor({ webappDir: assets, desktopToken: token, families: routeFamilies(projectRoot), api,
    describeBackend: () => ({ managed: true, mode: "desktop" }) });
  try {
    await new Promise<void>((ready, fail) => {
      door.once("error", fail);
      door.listen(0, "127.0.0.1", () => ready());
    });
  } catch (error) {
    await api.close().catch(() => {});
    throw error;
  }
  options.onListening?.(door);
  bridge.send({ type: "ready", url: `http://127.0.0.1:${(door.address() as AddressInfo).port}`, instance: randomBytes(16).toString("hex") });
  await new Promise<void>((stopped) => {
    const lines = createInterface({ input: options.input ?? process.stdin, crlfDelay: Infinity });
    let done = false;
    const stop = (): void => { if (done) return; done = true; lines.close(); stopped(); };
    lines.on("line", (line) => {
      if (line.length > MAX_LINE) return stop();
      let message: unknown;
      try { message = JSON.parse(line); } catch { return; }
      if (!isDict(message)) return;
      if (message.type === "shutdown") return stop();
      bridge.receive(message);
    });
    lines.once("close", stop);
    if (options.forwardSignals) for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, stop);
  });
  bridge.close();
  door.close();
  door.closeAllConnections();
  await api.close().catch(() => {});
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDesktopHost({ argv: process.argv.slice(2), forwardSignals: true }).then((code) => process.exit(code), (error: unknown) => {
    process.stderr.write(`desktop host: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
