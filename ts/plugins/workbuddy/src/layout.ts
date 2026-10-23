/**
 * The plugin-owned gateway instance: a private directory under the state root
 * holding the panel configuration, its credentials and its account state.
 *
 * Credentials are seeded once from the bundled `assets/auths` copy. They are
 * never overwritten afterwards: the gateway refreshes tokens in place, and a
 * later start must keep the refreshed values.
 */
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const PANEL_EXE = "workbuddy2api-panel.exe";
const DEFAULT_PORT = 7865;
const RUNTIME_FILE = "runtime.json";
const CONFIG_FILE = "config.json";

export interface Layout {
  /** `<stateDir>/workbuddy`: configuration, credentials and account state. */
  readonly root: string;
  /** The bundled gateway binary and the credential seed copies. */
  readonly assets: string;
  readonly auths: string;
  readonly data: string;
  readonly env: NodeJS.ProcessEnv;
}

export function workbuddyLayout(stateDir: string, env: NodeJS.ProcessEnv = process.env, assets?: string): Layout {
  const root = join(stateDir, "workbuddy");
  return { root, assets: assets ?? resolve(import.meta.dirname, "..", "assets"), auths: join(root, "auths"), data: join(root, "data"), env };
}

function configuredPort(env: NodeJS.ProcessEnv): number {
  const parsed = Number.parseInt(env["XUENESS_WORKBUDDY_PORT"] ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 1024 && parsed <= 65535 ? parsed : DEFAULT_PORT;
}

export interface Runtime {
  readonly port: number;
  readonly apiKey: string;
}

/** The persisted identity (port and API key) of this instance, or a fresh one on first run. */
export function readRuntime(layout: Layout): Runtime {
  try {
    const value = JSON.parse(readFileSync(join(layout.root, RUNTIME_FILE), "utf8")) as Record<string, unknown>;
    const port = value["port"];
    const apiKey = value["apiKey"];
    if (typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535
      && typeof apiKey === "string" && /^[0-9a-f]{32,128}$/u.test(apiKey)) return { port, apiKey };
  } catch { /* first run, or a corrupt file: start from a fresh identity */ }
  return { port: configuredPort(layout.env), apiKey: randomBytes(24).toString("hex") };
}

export function writeRuntime(layout: Layout, port: number, apiKey: string): void {
  mkdirSync(layout.root, { recursive: true, mode: 0o700 });
  const path = join(layout.root, RUNTIME_FILE);
  writeFileSync(`${path}.tmp`, `${JSON.stringify({ apiVersion: 1, port, apiKey }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

function seedCredentials(layout: Layout): void {
  mkdirSync(layout.auths, { recursive: true, mode: 0o700 });
  let names: string[];
  try { names = readdirSync(join(layout.assets, "auths")); } catch { return; }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const target = join(layout.auths, name);
    if (existsSync(target)) continue;
    try { copyFileSync(join(layout.assets, "auths", name), target); } catch { /* a missing seed file is not fatal */ }
  }
}

/**
 * `workbuddy2api-panel` settings. The schedule block keeps the accounts warm
 * the way the standalone panel does; the pool and sticky-session values match
 * the panel's own recommended defaults.
 */
function gatewayConfig(layout: Layout, port: number, apiKey: string): Record<string, unknown> {
  return {
    listen: `127.0.0.1:${port}`,
    api_key: apiKey,
    auth_dir: "./auths",
    state_file: "./data/state.json",
    server: { max_body_mb: 16 },
    cooldown: { soft_rate: "600s", soft_rate_max: "2h" },
    schedule: {
      checkin_hours: [9, 12, 15, 18, 21], travel_hours: [9, 21], activity_hours: [10], keepalive_hours: [22], blackcat_hours: [23],
      checkin_enabled: true, travel_enabled: true, activity_enabled: true, keepalive_enabled: true, blackcat_enabled: true,
      balance_refresh_enabled: true, balance_refresh_minutes: 5,
    },
    upstream: {
      timeout_seconds: 120, header_timeout_seconds: 120, idle_timeout_seconds: 300,
      user_agent: "", client_version: "", cli_version: "", client_name: "", device_token: "", device_token_file: "",
    },
    features: { sanitize_blacklist_fingerprints: true },
    prompt: { mode: "custom", file: "" },
    upstash: { url: "", token: "" },
    pool: { max_in_flight: 3, breaker_threshold: 3, breaker_cooldown: "30m", breaker_cooldown_max: "6h", idle_weight_per_hour: 0.5, idle_weight_max: 5.0 },
    session_sticky: { enabled: true, ttl: "30m", gc_interval: "5m" },
  };
}

/** Create the private directory, seed credentials and write the configuration for this port. */
export function ensureLayout(layout: Layout, port: number, apiKey: string): void {
  mkdirSync(layout.root, { recursive: true, mode: 0o700 });
  mkdirSync(layout.data, { recursive: true, mode: 0o700 });
  seedCredentials(layout);
  const path = join(layout.root, CONFIG_FILE);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(gatewayConfig(layout, port, apiKey), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
