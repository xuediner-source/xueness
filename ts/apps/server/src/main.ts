#!/usr/bin/env node
/**
 * xueness-web (Python `xueness.web.main`): the loopback Web UI and HTTP API.
 *
 *   node apps/server/src/main.ts [--port 8137] [--host 127.0.0.1] [--state DIR] [--web-runs DIR]
 *        [--workspace-root DIR]... [--allow-real-provider] [--project-root DIR]
 */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFrontDoor } from "./front-door.ts";
import { loopbackHost } from "./guards.ts";
import { routeFamilies } from "./manifests.ts";
import { createApplicationApi } from "./application-api.ts";
import { CliExit, Parser } from "./cli/argparse.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 8137;

/** `resolve_bind_host`: loopback unless XUENESS_ALLOW_REMOTE=1 is set explicitly. */
export function resolveBindHost(explicit?: string): string {
  const host = (explicit || process.env.XUENESS_HOST || "127.0.0.1").trim();
  if (loopbackHost(host)) return host;
  if (["1", "true", "yes", "on"].includes((process.env.XUENESS_ALLOW_REMOTE ?? "").trim().toLowerCase())) return host;
  throw new Error(`non-loopback bind ${JSON.stringify(host)} requires XUENESS_ALLOW_REMOTE=1 plus external auth/TLS`);
}

/** `XUENESS_ALLOW_REAL`: online runs are on unless the variable says otherwise. */
export function allowRealFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.XUENESS_ALLOW_REAL;
  return value === undefined || ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

const expand = (value: string): string => value === "~" || value.startsWith("~/") ? join(homedir(), value.slice(1)) : value;

/** `--workspace-root` checks: an existing directory that is neither `/` nor `/tmp`. */
function workspaceRoot(parser: Parser, value: string): string {
  let root: string;
  try { root = realpathSync(resolve(expand(value))); } catch { return parser.error(`--workspace-root must name an existing directory: ${value}`); }
  if (!statSync(root).isDirectory()) parser.error(`--workspace-root must name a directory, not a file: ${value}`);
  const broad = ["/", "/tmp"].map((path) => { try { return realpathSync(path); } catch { return path; } });
  if (broad.includes(root)) parser.error(`--workspace-root is too broad; choose a project directory: ${value}`);
  return root;
}

export async function main(argv: readonly string[]): Promise<number> {
  const projectDefault = resolve(join(here, "..", "..", "..", ".."));
  const parser = new Parser("xueness-web", "Xueness loopback-only Web UI");
  parser.add("--port", { type: "int", default: DEFAULT_PORT });
  parser.add("--host", { default: null, help: "bind interface (default 127.0.0.1; non-loopback needs XUENESS_ALLOW_REMOTE=1)" });
  parser.add("--state", { default: join(projectDefault, ".state") });
  parser.add("--web-runs", { default: join(projectDefault, ".web-runs") });
  parser.add("--workspace-root", { action: "append", default: [], metavar: "PATH", help: "allow an existing host workspace directory (repeatable)" });
  parser.add("--allow-real-provider", { action: "store_true", help: "legacy compatibility flag; online runs are enabled by default" });
  parser.add("--project-root", { default: projectDefault, help: "checkout holding webapp/dist (default: this repository)" });
  let host: string, port: number, roots: string[], args: Record<string, unknown>;
  try {
    args = parser.parse(argv);
    port = Number(args.port);
    if (port < 1 || port > 65535) parser.error("--port must be 1..65535");
    roots = (args.workspace_root as string[]).map((value) => workspaceRoot(parser, value));
    try { host = resolveBindHost(args.host == null ? undefined : String(args.host)); } catch (error) { return parser.error((error as Error).message); }
  } catch (error) {
    if (error instanceof CliExit) return error.code;
    throw error;
  }
  const projectRoot = resolve(String(args.project_root)), allowReal = allowRealFromEnv();
  const api = await createApplicationApi({ projectRoot, stateDir: resolve(expand(String(args.state))), webRuns: resolve(expand(String(args.web_runs))),
    workspaceRoots: roots, cwd: projectRoot, webappDir: join(projectRoot, "webapp", "dist"), allowReal });
  const server = createFrontDoor({ webappDir: join(projectRoot, "webapp", "dist"), families: routeFamilies(projectRoot), api });
  await new Promise<void>((ready, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => ready());
  });
  const scope = loopbackHost(host) ? "loopback only" : "container bind (host publish controls exposure)";
  process.stdout.write(`Xueness Web UI on http://${host}:${port} (${scope}, real provider ${allowReal ? "on" : "off"})\n`);
  return new Promise<number>((done) => {
    let stopping = false;
    const shutdown = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      server.close();
      server.closeAllConnections();
      // Like `release_owned_processes`: terminals, browsers, MCP servers and workers stop with the server.
      await api.close().catch(() => {});
      done(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
