/**
 * The plugin-owned gateway process. `ensure()` starts it once against the
 * private configuration, adopts an instance an earlier run left behind, and
 * moves to the next port when the configured one is already taken.
 *
 * Readiness is the gateway's own authenticated `/v1/models`: a 200 proves the
 * listener is this pool, any other status means a different service holds the
 * port.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PyValueError } from "@xueness/contracts";
import { ensureLayout, PANEL_EXE, readRuntime, writeRuntime, type Layout } from "./layout.ts";

type Dict = Record<string, unknown>;
const READY_TIMEOUT_MS = 30_000;
const POLL_MS = 250;
const PORT_ATTEMPTS = 3;
const STATUS_PATHS = ["/status", "/v1/status"] as const;

type Probe = "ready" | "foreign" | "down";

async function probe(port: number, apiKey: string): Promise<Probe> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(3000),
    });
    await response.arrayBuffer();
    return response.status === 200 ? "ready" : "foreign";
  } catch { return "down"; }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms).unref(); });

export class Gateway {
  readonly layout: Layout;
  /** Not `#private`: handoff clones copy own properties onto a fresh prototype. */
  private child: ChildProcess | null = null;
  private port: number;
  private apiKey: string;
  private ready = false;
  private starting: Promise<void> | null = null;

  /**
   * The persisted identity is known before the process starts, so the provider
   * records can name their endpoint while the pool is still idle.
   */
  constructor(layout: Layout) {
    this.layout = layout;
    const runtime = readRuntime(layout);
    this.port = runtime.port;
    this.apiKey = runtime.apiKey;
  }

  /** The OpenAI-compatible base URL of this pool. */
  get baseUrl(): string { return `http://127.0.0.1:${this.port}/v1`; }

  /** The private bearer token this pool accepts. */
  get key(): string { return this.apiKey; }

  get listening(): number { return this.port; }

  /** The process this plugin started is alive; an adopted instance is not ours. */
  get running(): boolean { return this.child !== null && this.child.exitCode === null && this.child.signalCode === null; }

  /** Start the gateway if needed; concurrent callers share one attempt. */
  async ensure(): Promise<void> {
    if (this.ready && (this.running || this.child === null)) return;
    if (this.starting) return await this.starting;
    const attempt = this.#start();
    this.starting = attempt;
    try { await attempt; } finally { this.starting = null; }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => { if (!settled) { settled = true; resolve(); } };
      child.once("exit", done);
      try { child.kill(); } catch { done(); }
      setTimeout(done, 3000).unref();
    });
  }

  /** Restart only a child this Gateway owns, so it rereads the private auth directory. */
  async reloadOwned(restart = true): Promise<void> {
    if (!this.running) return;
    await this.stop();
    if (restart) await this.ensure();
  }

  /** The pool's account rows, or null when the gateway cannot answer. */
  async status(): Promise<Dict | null> {
    for (const path of STATUS_PATHS) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
          headers: { Authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) { await response.arrayBuffer(); continue; }
        const value: unknown = await response.json();
        return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Dict : null;
      } catch { return null; }
    }
    return null;
  }

  async #start(): Promise<void> {
    const exe = join(this.layout.assets, PANEL_EXE);
    if (!existsSync(exe)) throw new PyValueError("the bundled WorkBuddy gateway binary is missing");
    await this.stop();
    const apiKey = this.apiKey, base = this.port;
    // An instance from an earlier run already holds the persisted port and key.
    if (await probe(base, apiKey) === "ready") {
      this.port = base; this.ready = true;
      return;
    }
    for (let index = 0; index < PORT_ATTEMPTS; index += 1) {
      const port = base + index;
      if (port > 65535) break;
      ensureLayout(this.layout, port, apiKey);
      const child = spawn(exe, ["-config", join(this.layout.root, "config.json")], {
        cwd: this.layout.root, stdio: "ignore", windowsHide: true,
      });
      this.child = child;
      if (await this.#waitReady(child, port, apiKey) === "ready") {
        writeRuntime(this.layout, port, apiKey);
        this.port = port; this.ready = true;
        return;
      }
      this.child = null;
      try { child.kill(); } catch { /* already gone */ }
    }
    throw new PyValueError("the WorkBuddy gateway did not start");
  }

  async #waitReady(child: ChildProcess, port: number, apiKey: string): Promise<Probe> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) return "down";
      const outcome = await probe(port, apiKey);
      if (outcome !== "down") return outcome;
      await sleep(POLL_MS);
    }
    return "down";
  }
}
