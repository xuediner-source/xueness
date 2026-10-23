/** Resolve direct argv execution details that differ across platforms. */
import { existsSync } from "node:fs";
import { extname, win32 } from "node:path";

const DEFAULT_WINDOWS_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];
const WINDOWS_COMMAND_SHIMS = new Set([".cmd", ".bat"]);

export interface ResolvedExecutionCommand {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsVerbatimArguments?: boolean;
}

/**
 * Keep POSIX and executable argv calls shell-free. Windows batch shims are the
 * exception: Windows cannot spawn them directly without routing through cmd.
 */
export function resolveExecutionCommand(
  argv: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    exists?: (path: string) => boolean;
  },
): ResolvedExecutionCommand {
  const platform = options.platform ?? process.platform;
  const command = argv[0];
  if (!command || platform !== "win32") return { argv: [...argv], cwd: options.cwd, env: options.env };

  const file = resolveWindowsExecutable(command, options);
  if (!WINDOWS_COMMAND_SHIMS.has(extname(file).toLowerCase())) {
    return { argv: [file, ...argv.slice(1)], cwd: options.cwd, env: options.env };
  }

  const commandLine = `"${quoteCmdExecutable(file)} ${argv.slice(1).map(quoteCmdArgument).join(" ")}"`;
  const comspec = getWindowsEnvValue(options.env, "ComSpec") ?? "cmd.exe";
  return { argv: [comspec, "/d", "/s", "/c", commandLine], cwd: options.cwd, env: options.env, windowsVerbatimArguments: true };
}

function resolveWindowsExecutable(
  file: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; exists?: (path: string) => boolean },
): string {
  const exists = options.exists ?? existsSync;
  return windowsExecutableCandidates(file, options.env, options.cwd).find((candidate) => exists(candidate)) ?? file;
}

function windowsExecutableCandidates(file: string, env: NodeJS.ProcessEnv, cwd: string): string[] {
  const extensions = windowsPathExtensions(env);
  const candidates = extname(file) ? [file] : [file, ...extensions.map((extension) => `${file}${extension.toLowerCase()}`)];
  if (file.includes("\\") || file.includes("/") || win32.isAbsolute(file)) {
    const base = !win32.isAbsolute(file) ? win32.resolve(cwd, file) : win32.normalize(file);
    return candidates.map((candidate) => !win32.isAbsolute(candidate) ? win32.resolve(cwd, candidate) : win32.normalize(candidate));
  }
  const pathValue = getWindowsEnvValue(env, "PATH") ?? "";
  const directories = pathValue.split(win32.delimiter).filter(Boolean);
  return directories.flatMap((directory) => candidates.map((candidate) => win32.join(directory, candidate)));
}

function windowsPathExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = getWindowsEnvValue(env, "PATHEXT");
  const configured = raw?.split(";").map((entry) => entry.trim()).filter(Boolean);
  return configured?.length ? configured : DEFAULT_WINDOWS_PATHEXT;
}

function getWindowsEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function quoteCmdArgument(value: string): string {
  // First quote for the target program's Windows CRT parsing. Backslashes
  // before quotes need doubling plus an escape slash; trailing backslashes
  // double before the closing quote so they remain part of the argument.
  const crtValue = value
    .replace(/(\\*)"/g, (_match, slashes: string) => `${slashes}${slashes}\\"`)
    .replace(/(\\*)$/g, (_match, slashes: string) => `${slashes}${slashes}`);
  let result = `"${crtValue}"`;

  // cmd parses the initial /c command and the batch file's `%*` forwarding
  // command separately. Escape cmd metacharacters through both parse layers.
  const escapeCmdMeta = (text: string): string => text.replace(/([()%!^"<>&|])/g, "^$1");
  result = escapeCmdMeta(escapeCmdMeta(result));
  return result;
}

function quoteCmdExecutable(value: string): string {
  // The executable path is parsed once as part of cmd's command name, not
  // forwarded through `%*`. Keep its path quotes intact; only percent needs
  // escaping inside quotes because cmd expands environment variables there.
  let quoted = '"';
  for (const character of value) quoted += character === "%" ? '"^%"' : character;
  return `${quoted}"`;
}
